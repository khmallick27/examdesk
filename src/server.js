const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { pool, q, migrate, audit } = require('./db');
const auth = require('./auth');
const rules = require('./rules');
const { clean } = require('./parse');
const { importFile } = require('./importer');
const { toXlsx, toPdf } = require('./export');

const PROD = process.env.NODE_ENV === 'production';
const GRACE_MS = 30_000;          // answers accepted this long after the deadline (network latency)
const STALE_MS = 60_000;          // a session silent this long may be resumed on another device
const WARN_TYPES = new Set(['tab_hidden', 'window_blur', 'fullscreen_exit', 'copy', 'paste', 'cut', 'context_menu', 'devtools_key', 'print_key']);
const INFO_TYPES = new Set(['offline', 'online', 'fullscreen_denied', 'fullscreen_enter']);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0)); // set to 1 behind Render/Railway/Nginx

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

// ---- rate limiting ----
// shortcut: in-memory counters are per process; move to Redis if you run more than one instance.
function limit(windowMs, max, key) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (n > max) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    next();
  };
}
// A whole computer lab can share one public IP, so per-IP limits are generous and paired with per-identity limits.
const ipLimit = limit(60_000, 600, (r) => r.ip);
const startLimit = limit(60_000, 8, (r) => `${r.ip}|${rules.normRoll(r.body && r.body.roll)}`);
const loginLimit = limit(15 * 60_000, 10, (r) => `${r.ip}|${String((r.body && r.body.email) || '').toLowerCase()}`);
const tokenLimit = limit(60_000, 240, (r) => r.get('authorization') || r.ip);

const small = express.json({ limit: '64kb' });
const large = express.json({ limit: '12mb' });
// One JSON parser for the API: large bodies only on faculty routes (question images), and req.body is always an object.
app.use('/api', (req, res, next) => (/^\/(exams|admin)\b/.test(req.path) ? large : small)(req, res, (err) => { if (err) return next(err); req.body ??= {}; next(); }));
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, status = 400, extra = {}) => res.status(status).json({ error: msg, ...extra });

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randCode = (n) => Array.from(crypto.randomBytes(n), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

// ================= Student API (public) =================
const PUBLIC_EXAM = 'id, title, session_label, academic_year, department, instructions, duration_min, marks_per_q, negative_marks, start_at, end_at, status';

app.get('/api/public/exam/:slug', ipLimit, asyncH(async (req, res) => {
  const { rows } = await q(`SELECT ${PUBLIC_EXAM}, (SELECT count(*)::int FROM questions WHERE exam_id = exams.id) AS n FROM exams WHERE slug=$1 AND status <> 'draft'`, [req.params.slug]);
  const e = rows[0];
  if (!e) return bad(res, 'Examination not found. Check the link.', 404);
  const w = rules.examWindow(e);
  res.json({ title: e.title, session: e.session_label, academicYear: e.academic_year, department: e.department, instructions: e.instructions,
    durationMin: e.duration_min, questions: e.n, marksPerQ: Number(e.marks_per_q), negative: Number(e.negative_marks),
    startAt: e.start_at, endAt: e.end_at, open: w.open, reason: w.reason || null, serverNow: new Date().toISOString() });
}));

app.post('/api/public/lookup', ipLimit, limit(60_000, 30, (r) => r.ip), asyncH(async (req, res) => {
  const code = String((req.body && req.body.code) || '').trim().toUpperCase();
  const { rows } = await q("SELECT slug FROM exams WHERE code=$1 AND status <> 'draft'", [code]);
  if (!rows[0]) return bad(res, 'Invalid examination code.', 404);
  res.json({ slug: rows[0].slug });
}));

app.post('/api/public/exam/:slug/start', ipLimit, startLimit, asyncH(async (req, res) => {
  const v = rules.validateStudent(req.body || {});
  if (v.errors.length) return bad(res, v.errors.join(' '));
  const { rows: er } = await q('SELECT * FROM exams WHERE slug=$1', [req.params.slug]);
  const exam = er[0];
  if (!exam || exam.code !== v.code) {
    if (exam) await audit(`student:${v.roll}`, 'invalid_code', `exam ${exam.id}`, req.ip);
    return bad(res, 'Invalid examination code for this examination.', 403);
  }
  const presented = req.body.token ? auth.sha256(String(req.body.token)) : null;
  const newToken = auth.token();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ex } = await client.query('SELECT * FROM attempts WHERE exam_id=$1 AND roll_no=$2 FOR UPDATE', [exam.id, v.roll]);
    let a = ex[0];
    if (a) {
      if (a.status === 'submitted') { await client.query('ROLLBACK'); return bad(res, 'This roll number has already submitted this examination. Re-attempts are not allowed.', 409, { code: 'ALREADY_SUBMITTED' }); }
      if (rules.normName(a.student_name).toLowerCase() !== v.name.toLowerCase()) {
        await client.query('ROLLBACK');
        await audit(`student:${v.roll}`, 'name_mismatch', `exam ${exam.id}: "${v.name}" vs "${a.student_name}"`, req.ip);
        return bad(res, 'This roll number is already registered for this examination under a different name. Contact the invigilator.', 409, { code: 'NAME_MISMATCH' });
      }
      const sameSession = presented && presented === a.session_token_hash;
      const fresh = Date.now() - new Date(a.last_seen_at).getTime() < STALE_MS;
      if (!sameSession && a.session_token_hash && fresh) {
        await client.query('INSERT INTO attempt_events(attempt_id, type, detail) VALUES ($1,$2,$3)', [a.id, 'concurrent_login_blocked', `${req.ip} ${String(req.get('user-agent')).slice(0, 120)}`]);
        await client.query('UPDATE attempts SET warnings = warnings + 1 WHERE id=$1', [a.id]);
        await client.query('COMMIT');
        return bad(res, 'This examination is already open on another device or browser. Only one session is allowed. If your device crashed, wait one minute and try again, or ask the invigilator.', 409, { code: 'ACTIVE_ELSEWHERE' });
      }
      await client.query('UPDATE attempts SET session_token_hash=$2, last_seen_at=now() WHERE id=$1', [a.id, auth.sha256(newToken)]);
      if (!sameSession) await client.query('INSERT INTO attempt_events(attempt_id, type, detail) VALUES ($1,$2,$3)', [a.id, 'session_resumed', `${req.ip} ${String(req.get('user-agent')).slice(0, 120)}`]);
    } else {
      const w = rules.examWindow(exam);
      if (!w.open) { await client.query('ROLLBACK'); return bad(res, w.reason, 403, { code: 'NOT_OPEN' }); }
      const { rows: qs } = await client.query('SELECT id FROM questions WHERE exam_id=$1 ORDER BY position, id', [exam.id]);
      const ids = qs.map((x) => x.id);
      const order = exam.shuffle ? rules.shuffled(ids, crypto.randomBytes(4).readUInt32LE()) : ids;
      const ins = await client.query(
        `INSERT INTO attempts(exam_id, receipt_no, student_name, roll_no, session_token_hash, question_order, deadline_at, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [exam.id, `RMGEC-${exam.id}-${randCode(8)}`, v.name, v.roll, auth.sha256(newToken), JSON.stringify(order), rules.deadlineFor(exam), req.ip, String(req.get('user-agent')).slice(0, 300)]);
      a = ins.rows[0];
    }
    await client.query('COMMIT');
    await audit(`student:${v.roll}`, ex[0] ? 'attempt_resume' : 'attempt_start', `exam ${exam.id} attempt ${a.id}`, req.ip);
    res.json({ token: newToken });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return bad(res, 'A session for this roll number was just started. Try again in a moment.', 409);
    throw e;
  } finally { client.release(); }
}));

// Bearer token -> attempt. Rotated tokens (opened elsewhere) fail here.
const attemptAuth = asyncH(async (req, res, next) => {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t) return bad(res, 'Not signed in to an examination.', 401);
  const { rows } = await q(
    `SELECT a.*, e.title, e.session_label, e.academic_year, e.department, e.marks_per_q, e.negative_marks, e.duration_min, e.status AS exam_status
     FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE a.session_token_hash=$1`, [auth.sha256(t)]);
  if (!rows[0]) return bad(res, 'This examination session is no longer valid (it may have been opened on another device). Re-enter your details to continue.', 401, { code: 'SESSION_REPLACED' });
  req.attempt = rows[0];
  next();
});

async function finalize(attemptId, mode) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT a.*, e.marks_per_q, e.negative_marks FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.id=$1 FOR UPDATE OF a', [attemptId]);
    const a = rows[0];
    if (!a || a.status === 'submitted') { await client.query('COMMIT'); return; }
    const { rows: qs } = await client.query('SELECT id, correct, marks, negative FROM questions WHERE exam_id=$1', [a.exam_id]);
    const s = rules.score(qs, a.answers, a);
    await client.query(
      `UPDATE attempts SET status='submitted', submit_mode=$2, submitted_at = CASE WHEN $2='manual' THEN now() ELSE LEAST(now(), deadline_at) END,
       attempted=$3, correct_count=$4, incorrect_count=$5, unanswered=$6, score=$7, max_score=$8, session_token_hash=session_token_hash WHERE id=$1`,
      [attemptId, mode, s.attempted, s.correct, s.incorrect, s.unanswered, s.score, s.max]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

const expired = (a) => Date.now() > new Date(a.deadline_at).getTime() + GRACE_MS;

async function receipt(attemptId) {
  const { rows } = await q(`SELECT a.receipt_no, a.student_name, a.roll_no, a.started_at, a.submitted_at, a.submit_mode, a.attempted, a.unanswered,
    a.answers, e.title, e.session_label, e.academic_year, e.department FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.id=$1`, [attemptId]);
  const r = rows[0];
  const marked = Object.values(r.answers || {}).filter((x) => x && x.m).length;
  delete r.answers;
  return { ...r, marked };
}

app.use('/api/attempt', tokenLimit, attemptAuth);

app.get('/api/attempt', asyncH(async (req, res) => {
  const a = req.attempt;
  if (a.status === 'active' && expired(a)) await finalize(a.id, 'timeout');
  else if (a.status === 'active') await q('UPDATE attempts SET last_seen_at=now() WHERE id=$1', [a.id]);
  const { rows: st } = await q('SELECT status FROM attempts WHERE id=$1', [a.id]);
  if (st[0].status === 'submitted') return res.json({ submitted: true, receipt: await receipt(a.id) });
  const { rows: qs } = await q('SELECT id, stem, options, marks, negative FROM questions WHERE exam_id=$1', [a.exam_id]); // never select `correct` here
  const byId = new Map(qs.map((x) => [x.id, x]));
  res.json({
    submitted: false,
    student: { name: a.student_name, roll: a.roll_no },
    exam: { title: a.title, session: a.session_label, academicYear: a.academic_year, department: a.department },
    deadline: a.deadline_at, serverNow: new Date().toISOString(),
    questions: a.question_order.map((id) => byId.get(id)).filter(Boolean).map((x) => ({
      id: x.id, stem: x.stem, options: x.options,
      marks: Number(x.marks ?? a.marks_per_q), negative: Number(x.negative ?? a.negative_marks) })),
    answers: a.answers,
  });
}));

app.post('/api/attempt/answers', asyncH(async (req, res) => {
  const a = req.attempt;
  if (a.status === 'submitted') return bad(res, 'Already submitted.', 409, { code: 'SUBMITTED' });
  if (expired(a)) { await finalize(a.id, 'timeout'); return bad(res, 'Time is over. Your examination has been submitted.', 409, { code: 'SUBMITTED' }); }
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 500) : [];
  const allowed = new Set(a.question_order);
  const patch = {};
  for (const it of items) {
    const qid = Number(it.qid);
    if (!allowed.has(qid)) return bad(res, 'Unknown question.');
    const c = it.c === null || it.c === undefined ? null : Number(it.c);
    if (c !== null && ![0, 1, 2, 3].includes(c)) return bad(res, 'Invalid option.');
    patch[qid] = { c, m: !!it.m, v: true };
  }
  await q("UPDATE attempts SET answers = answers || $2::jsonb, last_seen_at=now() WHERE id=$1 AND status='active'", [a.id, JSON.stringify(patch)]);
  res.json({ ok: true, saved: Object.keys(patch).length, serverNow: new Date().toISOString() });
}));

app.post('/api/attempt/heartbeat', asyncH(async (req, res) => {
  const a = req.attempt;
  if (a.status === 'active' && expired(a)) await finalize(a.id, 'timeout');
  else await q('UPDATE attempts SET last_seen_at=now() WHERE id=$1', [a.id]);
  const { rows } = await q('SELECT status FROM attempts WHERE id=$1', [a.id]);
  res.json({ status: rows[0].status, deadline: a.deadline_at, serverNow: new Date().toISOString() });
}));

app.post('/api/attempt/event', asyncH(async (req, res) => {
  const a = req.attempt;
  const type = String((req.body && req.body.type) || '');
  if (!WARN_TYPES.has(type) && !INFO_TYPES.has(type)) return bad(res, 'Unknown event.');
  if (a.status !== 'active') return res.json({ ok: true });
  const { rows } = await q('SELECT count(*)::int AS n FROM attempt_events WHERE attempt_id=$1', [a.id]);
  if (rows[0].n < 300) {
    await q('INSERT INTO attempt_events(attempt_id, type, detail) VALUES ($1,$2,$3)', [a.id, type, String(req.body.detail || '').slice(0, 200)]);
    if (WARN_TYPES.has(type)) await q('UPDATE attempts SET warnings = warnings + 1 WHERE id=$1', [a.id]);
  }
  const { rows: w } = await q('SELECT warnings FROM attempts WHERE id=$1', [a.id]);
  res.json({ ok: true, warnings: w[0].warnings });
}));

app.post('/api/attempt/submit', asyncH(async (req, res) => {
  const a = req.attempt;
  if (a.status === 'active') await finalize(a.id, Date.now() >= new Date(a.deadline_at).getTime() ? 'timeout' : 'manual');
  await audit(`student:${a.roll_no}`, 'attempt_submit', `exam ${a.exam_id} attempt ${a.id}`, req.ip);
  res.json({ submitted: true, receipt: await receipt(a.id) });
}));

// Server-side enforcement: submit attempts whose time ran out even if the browser is gone.
async function sweep() {
  const { rows } = await q(`SELECT id FROM attempts WHERE status='active' AND deadline_at < now() - $1 * interval '1 millisecond'`, [GRACE_MS]);
  for (const r of rows) await finalize(r.id, 'timeout');
  await q('DELETE FROM faculty_sessions WHERE expires_at < now()');
}

// ================= Faculty API =================
app.post('/api/auth/login', loginLimit, asyncH(async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const { rows } = await q('SELECT * FROM faculty WHERE email=$1 AND active', [email]);
  if (!rows[0] || !auth.verifyPassword(String(req.body.password || ''), rows[0].password_hash)) {
    await audit(email || '(blank)', 'login_failed', '', req.ip);
    return bad(res, 'Incorrect email or password.', 401);
  }
  await auth.createSession(res, rows[0].id, PROD);
  await audit(email, 'login', '', req.ip);
  res.json({ ok: true });
}));

const fac = auth.requireFaculty();
const admin = auth.requireFaculty('admin');
app.use(['/api/auth/me', '/api/auth/logout', '/api/auth/password', '/api/exams', '/api/admin'], ipLimit);

app.get('/api/auth/me', fac, (req, res) => res.json(req.faculty));
app.post('/api/auth/logout', fac, asyncH(async (req, res) => { await auth.destroySession(req, res); res.json({ ok: true }); }));
app.post('/api/auth/password', fac, asyncH(async (req, res) => {
  const { current, next: nw } = req.body || {};
  const { rows } = await q('SELECT password_hash FROM faculty WHERE id=$1', [req.faculty.id]);
  if (!auth.verifyPassword(String(current || ''), rows[0].password_hash)) return bad(res, 'Current password is incorrect.', 403);
  if (String(nw || '').length < 10) return bad(res, 'New password must be at least 10 characters.');
  await q('UPDATE faculty SET password_hash=$2 WHERE id=$1', [req.faculty.id, auth.hashPassword(String(nw))]);
  await q('DELETE FROM faculty_sessions WHERE faculty_id=$1', [req.faculty.id]);
  await audit(req.faculty.email, 'password_change', '', req.ip);
  res.json({ ok: true });
}));

async function ownExam(req, res) {
  const { rows } = await q('SELECT * FROM exams WHERE id=$1', [Number(req.params.id) || 0]);
  const e = rows[0];
  if (!e || (req.faculty.role !== 'admin' && e.owner_id !== req.faculty.id)) { bad(res, 'Examination not found.', 404); return null; }
  return e;
}
const attemptCount = async (examId) => (await q('SELECT count(*)::int AS n FROM attempts WHERE exam_id=$1', [examId])).rows[0].n;

function examFields(b) {
  const errors = [];
  const s = (v, max) => String(v ?? '').trim().slice(0, max);
  const out = {
    title: s(b.title, 200), session_label: s(b.session_label, 120), academic_year: s(b.academic_year, 20),
    department: s(b.department, 120) || 'Department of Electrical Engineering', instructions: s(b.instructions, 5000),
    duration_min: Number(b.duration_min), marks_per_q: Number(b.marks_per_q ?? 1), negative_marks: Number(b.negative_marks ?? 0),
    start_at: b.start_at ? new Date(b.start_at) : null, end_at: b.end_at ? new Date(b.end_at) : null, shuffle: !!b.shuffle,
  };
  if (!out.title) errors.push('Title is required.');
  if (!Number.isInteger(out.duration_min) || out.duration_min < 1 || out.duration_min > 600) errors.push('Duration must be 1-600 minutes.');
  if (!(out.marks_per_q > 0 && out.marks_per_q <= 100)) errors.push('Marks per question must be between 0 and 100.');
  if (!(out.negative_marks >= 0 && out.negative_marks <= out.marks_per_q)) errors.push('Negative marks must be between 0 and the marks per question.');
  for (const k of ['start_at', 'end_at']) if (out[k] && isNaN(out[k])) errors.push(`Invalid ${k.replace('_at', '')} time.`);
  if (out.start_at && out.end_at && out.end_at <= out.start_at) errors.push('End time must be after start time.');
  return { errors, out };
}

app.get('/api/exams', fac, asyncH(async (req, res) => {
  const { rows } = await q(`SELECT e.id, e.title, e.session_label, e.academic_year, e.code, e.slug, e.status, e.start_at, e.end_at, e.duration_min, f.name AS owner,
    (SELECT count(*)::int FROM questions WHERE exam_id=e.id) AS questions,
    (SELECT count(*)::int FROM attempts WHERE exam_id=e.id) AS attempts,
    (SELECT count(*)::int FROM attempts WHERE exam_id=e.id AND status='submitted') AS submitted
    FROM exams e JOIN faculty f ON f.id=e.owner_id WHERE $1 OR e.owner_id=$2 ORDER BY e.created_at DESC`, [req.faculty.role === 'admin', req.faculty.id]);
  res.json(rows);
}));

app.post('/api/exams', fac, asyncH(async (req, res) => {
  const { errors, out } = examFields(req.body || {});
  if (errors.length) return bad(res, errors.join(' '));
  for (let i = 0; i < 5; i++) {
    try {
      const { rows } = await q(`INSERT INTO exams(owner_id, title, session_label, academic_year, department, instructions, duration_min, marks_per_q, negative_marks, start_at, end_at, shuffle, code, slug)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [req.faculty.id, out.title, out.session_label, out.academic_year, out.department, out.instructions, out.duration_min, out.marks_per_q, out.negative_marks, out.start_at, out.end_at, out.shuffle, randCode(6), crypto.randomBytes(9).toString('base64url')]);
      await audit(req.faculty.email, 'exam_create', `exam ${rows[0].id}: ${out.title}`, req.ip);
      return res.json({ id: rows[0].id });
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  bad(res, 'Could not generate a unique code. Try again.', 500);
}));

app.get('/api/exams/:id', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  const { rows } = await q('SELECT * FROM questions WHERE exam_id=$1 ORDER BY position, id', [e.id]);
  res.json({ exam: e, questions: rows, attempts: await attemptCount(e.id) });
}));

app.put('/api/exams/:id', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  const { errors, out } = examFields({ ...e, ...req.body });
  if (errors.length) return bad(res, errors.join(' '));
  if ((Number(out.marks_per_q) !== Number(e.marks_per_q) || Number(out.negative_marks) !== Number(e.negative_marks) || out.shuffle !== e.shuffle) && await attemptCount(e.id))
    return bad(res, 'Marking scheme and shuffling cannot change after students have started.', 409);
  await q(`UPDATE exams SET title=$2, session_label=$3, academic_year=$4, department=$5, instructions=$6, duration_min=$7, marks_per_q=$8, negative_marks=$9,
    start_at=$10, end_at=$11, shuffle=$12, updated_at=now() WHERE id=$1`,
  [e.id, out.title, out.session_label, out.academic_year, out.department, out.instructions, out.duration_min, out.marks_per_q, out.negative_marks, out.start_at, out.end_at, out.shuffle]);
  await audit(req.faculty.email, 'exam_update', `exam ${e.id}`, req.ip);
  res.json({ ok: true });
}));

app.delete('/api/exams/:id', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  // Results are deleted with the exam (ON DELETE CASCADE), so only a closed exam may go.
  if (e.status !== 'closed' && await attemptCount(e.id)) return bad(res, 'Close the examination before deleting it. Download the results first: deleting removes them permanently.', 409);
  await q('DELETE FROM exams WHERE id=$1', [e.id]);
  await audit(req.faculty.email, 'exam_delete', `exam ${e.id}: ${e.title}`, req.ip);
  res.json({ ok: true });
}));

async function editableQuestions(e, res) {
  if (e.status !== 'draft') { bad(res, 'Unpublish the examination before editing questions.', 409); return false; }
  if (await attemptCount(e.id)) { bad(res, 'Questions are locked because students have attempted this examination.', 409); return false; }
  return true;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
app.post('/api/exams/:id/import', fac, upload.single('file'), asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  if (!(await editableQuestions(e, res))) return;
  if (!req.file) return bad(res, 'Choose a file to upload.');
  const result = await importFile(req.file.buffer, req.file.originalname);
  if (!result.questions.length) return bad(res, 'No questions were recognised. Number questions as "1." or "Q1." and options as (A) (B) (C) (D).', 422, { notes: result.notes });
  const { rows } = await q('SELECT COALESCE(max(position),0) AS p FROM questions WHERE exam_id=$1', [e.id]);
  let pos = rows[0].p;
  const source = path.extname(req.file.originalname).slice(1).toLowerCase();
  for (const x of result.questions) {
    // correct stays NULL: the printed answer is only a suggestion until faculty confirms it.
    await q('INSERT INTO questions(exam_id, position, stem, options, suggested, flags, source) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [e.id, ++pos, x.stem, JSON.stringify(x.options), x.suggested, JSON.stringify(x.flags), source]);
  }
  await audit(req.faculty.email, 'questions_import', `exam ${e.id}: ${result.questions.length} from ${req.file.originalname}`, req.ip);
  res.json({ added: result.questions.length, notes: result.notes });
}));

function questionFields(b) {
  const options = Array.isArray(b.options) ? b.options.slice(0, 4).map(clean) : ['', '', '', ''];
  while (options.length < 4) options.push('');
  const correct = b.correct === null || b.correct === undefined || b.correct === '' ? null : Number(b.correct);
  const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const out = { stem: clean(b.stem), options, correct, approved: !!b.approved, marks: numOrNull(b.marks), negative: numOrNull(b.negative) };
  const errors = [];
  if (correct !== null && ![0, 1, 2, 3].includes(correct)) errors.push('Correct answer must be A, B, C or D.');
  for (const k of ['marks', 'negative']) if (out[k] !== null && !(out[k] >= 0 && out[k] <= 100)) errors.push(`Invalid ${k}.`);
  if (out.approved) {
    if (!out.stem) errors.push('Question text is empty.');
    if (options.some((o) => !o)) errors.push('All four options are required.');
    if (correct === null) errors.push('Select the correct answer before approving.');
  }
  return { errors, out };
}

app.post('/api/exams/:id/questions', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  if (!(await editableQuestions(e, res))) return;
  const { errors, out } = questionFields(req.body || {});
  if (errors.length) return bad(res, errors.join(' '));
  const { rows } = await q(`INSERT INTO questions(exam_id, position, stem, options, correct, approved, marks, negative)
    VALUES ($1, (SELECT COALESCE(max(position),0)+1 FROM questions WHERE exam_id=$1), $2,$3,$4,$5,$6,$7) RETURNING *`,
  [e.id, out.stem, JSON.stringify(out.options), out.correct, out.approved, out.marks, out.negative]);
  res.json(rows[0]);
}));

app.put('/api/exams/:id/questions/:qid', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  if (!(await editableQuestions(e, res))) return;
  const { errors, out } = questionFields(req.body || {});
  if (errors.length) return bad(res, errors.join(' '));
  const { rows } = await q(`UPDATE questions SET stem=$3, options=$4, correct=$5, approved=$6, marks=$7, negative=$8 WHERE id=$2 AND exam_id=$1 RETURNING *`,
    [e.id, Number(req.params.qid), out.stem, JSON.stringify(out.options), out.correct, out.approved, out.marks, out.negative]);
  if (!rows[0]) return bad(res, 'Question not found.', 404);
  res.json(rows[0]);
}));

app.delete('/api/exams/:id/questions/:qid', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  if (!(await editableQuestions(e, res))) return;
  await q('DELETE FROM questions WHERE id=$2 AND exam_id=$1', [e.id, Number(req.params.qid)]);
  res.json({ ok: true });
}));

// Explicit faculty action: copy printed answers into the key for questions that have one, and approve those that are complete.
app.post('/api/exams/:id/accept-suggested', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  if (!(await editableQuestions(e, res))) return;
  const { rowCount } = await q(`UPDATE questions SET correct=suggested, approved = (stem <> '' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(options) o WHERE o = ''))
    WHERE exam_id=$1 AND suggested IS NOT NULL AND correct IS NULL`, [e.id]);
  await audit(req.faculty.email, 'answer_key_accept_suggested', `exam ${e.id}: ${rowCount} questions`, req.ip);
  res.json({ updated: rowCount });
}));

app.post('/api/exams/:id/publish', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  const { rows } = await q('SELECT * FROM questions WHERE exam_id=$1 ORDER BY position, id', [e.id]);
  const problems = [];
  if (!rows.length) problems.push('Add at least one question.');
  rows.forEach((x, i) => {
    const n = `Q${i + 1}`;
    if (!x.stem) problems.push(`${n}: question text is empty.`);
    if (x.options.some((o) => !o)) problems.push(`${n}: all four options are required.`);
    if (x.correct === null) problems.push(`${n}: correct answer not set.`);
    else if (!x.approved) problems.push(`${n}: not approved by faculty.`);
  });
  if (e.end_at && new Date(e.end_at) <= new Date()) problems.push('The scheduled end time is in the past.');
  if (problems.length) return bad(res, 'The examination cannot be published yet.', 422, { problems });
  await q("UPDATE exams SET status='published', updated_at=now() WHERE id=$1", [e.id]);
  await audit(req.faculty.email, 'exam_publish', `exam ${e.id}`, req.ip);
  res.json({ ok: true, code: e.code, slug: e.slug });
}));

app.post('/api/exams/:id/unpublish', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  if (await attemptCount(e.id)) return bad(res, 'Students have already started; close the examination instead.', 409);
  await q("UPDATE exams SET status='draft', updated_at=now() WHERE id=$1", [e.id]);
  await audit(req.faculty.email, 'exam_unpublish', `exam ${e.id}`, req.ip);
  res.json({ ok: true });
}));

app.post('/api/exams/:id/close', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  await q("UPDATE exams SET status='closed', updated_at=now() WHERE id=$1", [e.id]);
  const { rows } = await q("SELECT id FROM attempts WHERE exam_id=$1 AND status='active'", [e.id]);
  for (const r of rows) await finalize(r.id, 'closed');
  await audit(req.faculty.email, 'exam_close', `exam ${e.id}: ${rows.length} active attempts submitted`, req.ip);
  res.json({ ok: true, forcedSubmissions: rows.length });
}));

app.post('/api/exams/:id/reopen', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  if (e.status !== 'closed') return bad(res, 'Only a closed examination can be reopened.', 409);
  await q("UPDATE exams SET status='published', updated_at=now() WHERE id=$1", [e.id]);
  await audit(req.faculty.email, 'exam_reopen', `exam ${e.id}`, req.ip);
  res.json({ ok: true });
}));

async function resultRows(examId) {
  await sweep();
  const { rows } = await q(`SELECT id, receipt_no, student_name, roll_no, started_at, submitted_at, submit_mode, status, attempted, unanswered, correct_count, incorrect_count,
    score, max_score, warnings, ip, last_seen_at, deadline_at FROM attempts WHERE exam_id=$1 ORDER BY roll_no`, [examId]);
  return rows;
}

app.get('/api/exams/:id/results', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  const rows = await resultRows(e.id);
  const { rows: ev } = await q(`SELECT ae.attempt_id, ae.type, count(*)::int AS n FROM attempt_events ae JOIN attempts a ON a.id=ae.attempt_id
    WHERE a.exam_id=$1 GROUP BY 1,2`, [e.id]);
  const evBy = {};
  for (const x of ev) (evBy[x.attempt_id] ||= {})[x.type] = x.n;
  res.json({ exam: { id: e.id, title: e.title, session_label: e.session_label, academic_year: e.academic_year, code: e.code, slug: e.slug, status: e.status },
    attempts: rows.map((r) => ({ ...r, events: evBy[r.id] || {} })) });
}));

app.get('/api/exams/:id/attempts/:aid/events', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  const { rows } = await q(`SELECT ae.type, ae.detail, ae.at FROM attempt_events ae JOIN attempts a ON a.id=ae.attempt_id
    WHERE a.exam_id=$1 AND a.id=$2 ORDER BY ae.at`, [e.id, Number(req.params.aid)]);
  res.json(rows);
}));

// Invigilator override when a student's device genuinely failed.
app.post('/api/exams/:id/attempts/:aid/release', fac, asyncH(async (req, res) => {
  const e = await ownExam(req, res); if (!e) return;
  const { rowCount } = await q(`UPDATE attempts SET session_token_hash=NULL, last_seen_at = now() - interval '1 hour' WHERE id=$2 AND exam_id=$1 AND status='active'`, [e.id, Number(req.params.aid)]);
  if (!rowCount) return bad(res, 'Attempt not found or already submitted.', 404);
  await q("INSERT INTO attempt_events(attempt_id, type, detail) VALUES ($1,'session_released',$2)", [Number(req.params.aid), `by ${req.faculty.email}`]);
  await audit(req.faculty.email, 'attempt_release', `exam ${e.id} attempt ${req.params.aid}`, req.ip);
  res.json({ ok: true });
}));

app.get('/api/exams/:id/results.:fmt', fac, asyncH(async (req, res) => {
  if (!['xlsx', 'pdf'].includes(req.params.fmt)) return bad(res, 'Not found', 404);
  const e = await ownExam(req, res); if (!e) return;
  const rows = await resultRows(e.id);
  const name = `${e.title.replace(/[^\w-]+/g, '_').slice(0, 60)}_results`;
  await audit(req.faculty.email, 'results_export', `exam ${e.id} ${req.params.fmt}`, req.ip);
  if (req.params.fmt === 'xlsx') {
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}.xlsx"` });
    return res.send(Buffer.from(await toXlsx(e, rows)));
  }
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}.pdf"` });
  toPdf(e, rows, res);
}));

// ---- admin ----
app.get('/api/admin/faculty', admin, asyncH(async (req, res) => {
  res.json((await q('SELECT id, email, name, department, role, active, created_at FROM faculty ORDER BY name')).rows);
}));
app.post('/api/admin/faculty', admin, asyncH(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Valid email required.');
  if (!String(b.name || '').trim()) return bad(res, 'Name required.');
  if (String(b.password || '').length < 10) return bad(res, 'Initial password must be at least 10 characters.');
  try {
    await q('INSERT INTO faculty(email, name, department, role, password_hash) VALUES ($1,$2,$3,$4,$5)',
      [email, String(b.name).trim(), String(b.department || 'Department of Electrical Engineering').trim(), b.role === 'admin' ? 'admin' : 'faculty', auth.hashPassword(String(b.password))]);
  } catch (e) { if (e.code === '23505') return bad(res, 'That email already has an account.', 409); throw e; }
  await audit(req.faculty.email, 'faculty_create', email, req.ip);
  res.json({ ok: true });
}));
app.patch('/api/admin/faculty/:fid', admin, asyncH(async (req, res) => {
  const fid = Number(req.params.fid);
  if (fid === req.faculty.id && req.body.active === false) return bad(res, 'You cannot deactivate your own account.');
  if (typeof req.body.active === 'boolean') { await q('UPDATE faculty SET active=$2 WHERE id=$1', [fid, req.body.active]); if (!req.body.active) await q('DELETE FROM faculty_sessions WHERE faculty_id=$1', [fid]); }
  if (req.body.password) {
    if (String(req.body.password).length < 10) return bad(res, 'Password must be at least 10 characters.');
    await q('UPDATE faculty SET password_hash=$2 WHERE id=$1', [fid, auth.hashPassword(String(req.body.password))]);
    await q('DELETE FROM faculty_sessions WHERE faculty_id=$1', [fid]);
  }
  await audit(req.faculty.email, 'faculty_update', `faculty ${fid}`, req.ip);
  res.json({ ok: true });
}));
app.get('/api/admin/audit', admin, asyncH(async (req, res) => {
  res.json((await q('SELECT actor, action, detail, ip, at FROM audit_log ORDER BY id DESC LIMIT 500')).rows);
}));

// ---- pages & static ----
const pub = path.join(__dirname, '..', 'public');
app.use('/vendor/katex', express.static(path.join(path.dirname(require.resolve('katex/package.json')), 'dist'), { maxAge: '7d' }));
app.use(express.static(pub, { maxAge: PROD ? '1h' : 0 }));
app.get('/e/:slug', (req, res) => res.sendFile(path.join(pub, 'exam.html')));
app.get('/faculty', (req, res) => res.sendFile(path.join(pub, 'faculty.html')));
app.get('/healthz', asyncH(async (req, res) => { await q('SELECT 1'); res.json({ ok: true }); }));
app.use('/api', (req, res) => bad(res, 'Not found', 404));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return bad(res, err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB.' : err.message);
  if (err.type === 'entity.too.large') return bad(res, 'Request too large.', 413);
  if (err.type === 'entity.parse.failed') return bad(res, 'Malformed request.');
  if (err.status && err.status < 500) return bad(res, err.message, err.status);
  console.error(err);
  bad(res, 'Server error. Please try again.', 500);
});

async function bootstrapAdmin() {
  const { rows } = await q('SELECT count(*)::int AS n FROM faculty');
  if (rows[0].n) return;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!email || pw.length < 10) {
    if (PROD) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ chars) for the first start.');
    const gen = crypto.randomBytes(9).toString('base64url');
    await q("INSERT INTO faculty(email, name, role, password_hash) VALUES ('admin@examdesk.local','Administrator','admin',$1)", [auth.hashPassword(gen)]);
    console.log(`[dev] Created admin@examdesk.local with password ${gen}`);
    return;
  }
  await q("INSERT INTO faculty(email, name, role, password_hash) VALUES ($1,'Administrator','admin',$2)", [email, auth.hashPassword(pw)]);
  console.log(`Created administrator ${email}`);
}

async function main() {
  await migrate();
  await bootstrapAdmin();
  setInterval(() => sweep().catch((e) => console.error('sweep', e)), 15_000).unref();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`ExamDesk listening on http://localhost:${port}`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, main, sweep };
