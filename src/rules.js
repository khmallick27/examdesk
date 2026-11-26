// Exam rules shared by the API and the tests. Pure functions.

const normRoll = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function validateStudent({ name, roll, code }) {
  const errors = [];
  const n = normName(name), r = normRoll(roll), c = String(code || '').trim().toUpperCase();
  if (!/^[\p{L} .'-]{2,100}$/u.test(n)) errors.push('Enter your full name (letters only).');
  if (!/^[A-Z0-9/-]{3,30}$/.test(r)) errors.push('Enter a valid university roll number.');
  if (!/^[A-Z0-9]{4,12}$/.test(c)) errors.push('Enter the examination code given by your teacher.');
  return { errors, name: n, roll: r, code: c };
}

// Is the exam open for a NEW attempt right now?
function examWindow(exam, now = new Date()) {
  if (exam.status !== 'published') return { open: false, reason: exam.status === 'closed' ? 'This examination has been closed.' : 'This examination is not open yet.' };
  if (exam.start_at && now < new Date(exam.start_at)) return { open: false, reason: `This examination starts at ${new Date(exam.start_at).toISOString()}.`, startsAt: exam.start_at };
  if (exam.end_at && now >= new Date(exam.end_at)) return { open: false, reason: 'The examination window has ended.' };
  return { open: true };
}

// Deadline = start + duration, but never past the scheduled end.
function deadlineFor(exam, now = new Date()) {
  let d = new Date(now.getTime() + exam.duration_min * 60000);
  if (exam.end_at && new Date(exam.end_at) < d) d = new Date(exam.end_at);
  return d;
}

// NAT answers: optional minus, up to 7 digits, up to 2 decimals. Kept as text so "5.50" displays as typed.
const NAT_RE = /^-?\d{1,7}(\.\d{1,2})?$/;

const num = (v, dflt) => (v === null || v === undefined ? Number(dflt) : Number(v));

// answers: { [questionId]: { c: 0..3 | null, m: bool } }
function score(questions, answers, exam) {
  let attempted = 0, correct = 0, incorrect = 0, total = 0, max = 0;
  for (const q of questions) {
    const marks = num(q.marks, exam.marks_per_q);
    const nat = q.qtype === 'nat';
    const neg = nat ? 0 : num(q.negative, exam.negative_marks); // GATE: no negative marking for NAT
    max += marks;
    const a = answers[q.id];
    if (!a || a.c === null || a.c === undefined) continue;
    attempted++;
    const right = nat ? Number(a.c) >= Number(q.nat_min) && Number(a.c) <= Number(q.nat_max) : a.c === q.correct;
    if (right) { correct++; total += marks; } else { incorrect++; total -= neg; }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { attempted, correct, incorrect, unanswered: questions.length - attempted, score: r2(total), max: r2(max) };
}

function shuffled(ids, seed) {
  // Deterministic per attempt so a resumed session sees the same order.
  const a = ids.slice();
  let s = seed >>> 0 || 1;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

module.exports = { NAT_RE, normRoll, normName, validateStudent, examWindow, deadlineFor, score, shuffled };
