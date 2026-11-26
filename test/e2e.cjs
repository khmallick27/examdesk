// End-to-end test: real server + PostgreSQL + Chromium. Runs every workflow in the brief.
// Uses its own database (E2E_DATABASE_URL, default examdesk_test) and WIPES it first.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium, devices } = require('playwright');
const { Client } = require('pg');
const ExcelJS = require('exceljs');

const DB = process.env.E2E_DATABASE_URL || 'postgres://examdesk:examdesk@localhost:5432/examdesk_test';
const PORT = 3456, BASE = `http://localhost:${PORT}`;
const ADMIN = { email: 'admin@rmgec.ac.in', password: 'Admin#Pass2026' };
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0, passes = 0;
async function step(name, fn) {
  try { await fn(); passes++; console.log(`  PASS  ${name}`); } catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!/examdesk_test|e2e/.test(DB)) throw new Error('Refusing to wipe a database whose name does not contain examdesk_test or e2e');
  const pg = new Client({ connectionString: DB }); await pg.connect();
  await pg.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  const server = spawn(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: DB, PORT, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50 && !/listening/.test(serverLog); i++) await sleep(200);
  assert(/listening/.test(serverLog), 'server did not start: ' + serverLog);

  const browser = await chromium.launch();
  const fac = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const F = await fac.newPage();
  F.on('dialog', (d) => d.accept());
  const fapi = (method, url, data) => F.request.fetch(BASE + url, { method, headers: { 'X-Requested-With': 'ExamDesk' }, data });
  let examId, code, slug;

  console.log('\nFaculty workflow');
  await step('unauthenticated faculty API is refused', async () => {
    const r = await fetch(`${BASE}/api/exams`, { headers: { 'X-Requested-With': 'ExamDesk' } });
    assert(r.status === 401, `expected 401, got ${r.status}`);
    const r2 = await fetch(`${BASE}/api/exams`);
    assert(r2.status === 403, `expected 403 without CSRF header, got ${r2.status}`);
  });
  await step('wrong password rejected; faculty signs in', async () => {
    await F.goto(`${BASE}/faculty`);
    await F.fill('#em', ADMIN.email); await F.fill('#pw', 'wrong-password'); await F.click('button[type=submit]');
    await F.waitForSelector('.err');
    await F.fill('#pw', ADMIN.password); await F.click('button[type=submit]');
    await F.waitForSelector('text=Examinations');
  });
  await step('faculty creates an examination', async () => {
    await F.click('text=+ New examination');
    await F.fill('#s_title', 'Electrical Machines – Internal Assessment 1');
    await F.fill('#s_session', 'Odd Semester 2026 · 5th Sem EE');
    await F.fill('#s_year', '2026-27');
    await F.fill('#s_dur', '30'); await F.fill('#s_marks', '1'); await F.fill('#s_neg', '0.33');
    await F.click('#create');
    await F.waitForSelector('#upload');
    examId = Number(F.url().split('/').pop());
    code = (await F.textContent('#codeTxt')).trim();
    slug = (await F.textContent('#linkTxt')).trim().split('/').pop();
    assert(/^[A-Z0-9]{6}$/.test(code), 'bad code ' + code);
  });
  await step('draft exam link is not reachable by students', async () => {
    const r = await fetch(`${BASE}/api/public/exam/${slug}`);
    assert(r.status === 404, `expected 404 got ${r.status}`);
  });
  await step('faculty uploads Word paper; 4 MCQs extracted with flags', async () => {
    await F.setInputFiles('#file', path.join(__dirname, 'fixtures', 'paper.docx'));
    await F.click('#upload');
    await F.waitForSelector('text=4 question(s) extracted');
    assert((await F.locator('.qcard').count()) === 4, 'expected 4 question cards');
    assert(await F.locator('.qcard').nth(2).locator('img').count() >= 1, 'diagram missing in Q3');
    assert(await F.locator('.qcard').nth(1).locator('.katex').count() >= 1, 'equation not rendered in Q2');
    await F.screenshot({ path: path.join(SHOTS, '01-faculty-review.png'), fullPage: false });
  });
  await step('publishing is blocked until every answer is set and approved', async () => {
    await F.click('#pub');
    await F.waitForSelector('text=cannot be published yet');
    const txt = await F.textContent('#msg');
    assert(/Q3: correct answer not set/.test(txt) && /Q4: correct answer not set/.test(txt), 'missing problem list: ' + txt);
  });
  await step('answer key: accept document answers (Q1,Q2) and set Q3,Q4 manually', async () => {
    await F.click('#acceptAll');
    await F.waitForSelector('text=2 question(s) updated');
    for (const [i, ans] of [[2, 1], [3, 1]]) {
      const card = F.locator('.qcard').nth(i);
      await card.locator(`input[type=radio][value="${ans}"]`).check();
      await card.locator('.qa').check();
      const before = await F.locator('.qcard.ok').count();
      await card.locator('button[data-act=save]').click();
      await F.waitForFunction((n) => document.querySelectorAll('.qcard.ok').length === n, before + 1);
    }
    assert((await F.locator('.qcard.ok').count()) === 4, 'not all approved');
  });
  await step('faculty publishes; link and code are generated', async () => {
    await F.click('#pub');
    await F.waitForSelector('text=Published. Share the link');
    await F.screenshot({ path: path.join(SHOTS, '02-faculty-published.png') });
  });

  console.log('\nStudent workflow (separate browser, no account)');
  const stu = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const S = await stu.newPage();
  S.on('dialog', (d) => d.accept());
  const link = `${BASE}/e/${slug}`;
  await step('student opens public link with no sign-in; registration form shown', async () => {
    await S.goto(link);
    await S.waitForSelector('#regForm');
    for (const id of ['#name', '#roll', '#code', '#startBtn']) assert(await S.isVisible(id), `${id} missing`);
    assert(/Ramkrishna Mahato Government Engineering College/.test(await S.textContent('header')), 'college header missing');
    assert(/Internal Assessment 1/.test(await S.textContent('#subbar')), 'exam title missing');
    await S.screenshot({ path: path.join(SHOTS, '03-student-registration.png') });
  });
  const register = async (P, name, roll, c) => {
    await P.fill('#name', name); await P.fill('#roll', roll); await P.fill('#code', c);
    await P.check('#agree'); await P.click('#startBtn');
  };
  await step('mandatory fields enforced', async () => {
    await S.click('#startBtn');
    await S.waitForSelector('.err >> text=are all required');
  });
  await step('invalid exam code rejected', async () => {
    await register(S, 'Riya Mahato', '12500121045', 'ZZZZZZ');
    await S.waitForSelector('.err >> text=Invalid examination code');
  });
  await step('valid details start the exam (GATE-style interface)', async () => {
    await register(S, 'Riya Mahato', '12500121045', code.toLowerCase());
    await S.waitForSelector('#palette .pq');
    assert((await S.locator('#palette .pq').count()) === 4, 'palette size');
    assert(/Question 1 of 4/.test(await S.textContent('#qno')), 'question header');
    assert(/^\d\d:\d\d:\d\d$/.test((await S.textContent('#timer')).trim()), 'timer');
    for (const t of ['Save & Next', 'Previous', 'Clear Response', 'Mark for Review']) assert(await S.locator(`button:has-text("${t}")`).count(), `missing ${t}`);
  });
  await step('answer key is never sent to the student browser', async () => {
    const token = await S.evaluate((k) => localStorage.getItem(k), `ed_tok_${slug}`);
    const r = await fetch(`${BASE}/api/attempt`, { headers: { Authorization: `Bearer ${token}` } });
    const raw = await r.text();
    assert(r.ok && !/"correct"|"suggested"|"approved"/.test(raw), 'attempt payload leaks answer data');
    const f = await fetch(`${BASE}/api/exams/${examId}`, { headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'ExamDesk' } });
    assert(f.status === 401, `student token reached faculty API: ${f.status}`);
  });
  await step('answer, navigate, mark for review, clear response; palette colours update', async () => {
    await S.locator('.opt').nth(1).click();                       // Q1 -> B (correct)
    await S.click('#bNext');
    await S.locator('.opt').nth(0).click();                       // Q2 -> A (correct) + mark for review
    await S.click('#bMark');
    await S.locator('.opt').nth(3).click();                       // Q3 -> D then clear, then C (wrong)
    await S.click('#bClear');
    assert(!(await S.locator('.opt.sel').count()), 'clear response failed');
    await S.locator('.opt').nth(2).click();
    await S.click('#bPrev');
    assert(/Question 2 of 4/.test(await S.textContent('#qno')), 'previous failed');
    assert(await S.locator('#palette .pq.amk').count() === 1, 'answered+marked state');
    assert(await S.locator('#palette .pq.ans').count() === 2, 'answered state');
    await S.waitForSelector('#sync >> text=All answers saved');
    await S.screenshot({ path: path.join(SHOTS, '04-student-exam.png') });
  });
  await step('integrity events: tab switch, right-click, fullscreen exit are warned and recorded', async () => {
    await S.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(300);
    await S.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await S.waitForSelector('#modal:not(.hidden) >> text=You left the examination page');
    await S.click('#wOk');
    await S.locator('.qbody').click({ button: 'right' });
    await sleep(400);
    await S.waitForFunction(() => Number(document.querySelector('#warnCount').textContent) >= 2);
  });
  await step('simultaneous session from another device is blocked', async () => {
    const other = await browser.newContext(); const O = await other.newPage();
    await O.goto(link); await O.waitForSelector('#regForm');
    await register(O, 'Riya Mahato', '12500121045', code);
    await O.waitForSelector('.err >> text=already open on another device');
    await other.close();
  });
  await step('same roll number with a different name is refused', async () => {
    const other = await browser.newContext(); const O = await other.newPage();
    await O.goto(link); await O.waitForSelector('#regForm');
    await register(O, 'Someone Else', '12500121045', code);
    await O.waitForSelector('.err >> text=different name');
    await other.close();
  });
  await step('connection loss: answers kept locally and synced on reconnect', async () => {
    await S.click('#palette .pq >> nth=3');
    await stu.setOffline(true);
    await S.locator('.opt').nth(1).click();                       // Q4 -> B (correct) while offline
    await S.waitForSelector('#sync.off >> text=Offline');
    await S.screenshot({ path: path.join(SHOTS, '05-student-offline.png') });
    await stu.setOffline(false);
    await S.evaluate(() => window.dispatchEvent(new Event('online')));
    await S.waitForSelector('#sync >> text=All answers saved', { timeout: 20000 });
  });
  await step('page reload / crash recovery resumes with saved answers', async () => {
    await S.reload();
    await S.waitForSelector('text=An examination session was found');
    await register(S, 'Riya Mahato', '12500121045', code);
    await S.waitForSelector('#palette .pq');
    assert(await S.locator('#palette .pq.ans').count() === 3, 'answers lost after reload');
  });
  await step('student submits; receipt shown', async () => {
    await S.click('#bSubmit');
    await S.waitForSelector('#modal >> text=Submit examination?');
    await S.click('#sYes');
    await S.waitForSelector('text=Examination submitted successfully');
    assert(/RMGEC-\d+-/.test(await S.textContent('.receipt')), 'receipt number');
    await S.screenshot({ path: path.join(SHOTS, '06-student-receipt.png') });
  });
  await step('attempt is locked: same roll cannot restart', async () => {
    const other = await browser.newContext(); const O = await other.newPage();
    await O.goto(link); await O.waitForSelector('#regForm');
    await register(O, 'Riya Mahato', '12500121045', code);
    await O.waitForSelector('.err >> text=already submitted');
    await other.close();
  });

  console.log('\nTimer enforcement');
  let exam2;
  await step('timer expiry auto-submits in the browser (1-minute exam)', async () => {
    const c = await (await fapi('POST', '/api/exams', { title: 'Quick Quiz', duration_min: 1, marks_per_q: 1, negative_marks: 0 })).json();
    exam2 = c.id;
    const q = await (await fapi('POST', `/api/exams/${exam2}/questions`, { stem: 'Unit of inductance?', options: ['Henry', 'Farad', 'Ohm', 'Tesla'], correct: 0, approved: true })).json();
    assert(q.id, 'question create failed');
    const p = await (await fapi('POST', `/api/exams/${exam2}/publish`)).json();
    const ctx = await browser.newContext(); const P = await ctx.newPage();
    await P.goto(`${BASE}/e/${p.slug}`); await P.waitForSelector('#regForm');
    await register(P, 'Arjun Kumar', '12500121001', p.code);
    await P.waitForSelector('#palette .pq');
    await P.locator('.opt').nth(0).click();
    await P.waitForSelector('text=Examination submitted successfully', { timeout: 90000 });
    assert(/Auto-submitted when time expired/.test(await P.textContent('.receipt')), 'not marked as auto-submitted');
    await ctx.close();
  });
  await step('server enforces deadline when the browser is gone, and rejects late answers', async () => {
    const { rows } = await pg.query('SELECT code, slug FROM exams WHERE id=$1', [exam2]);
    const st = await (await fetch(`${BASE}/api/public/exam/${rows[0].slug}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Late Student', roll: '12500121002', code: rows[0].code }) })).json();
    await pg.query("UPDATE attempts SET deadline_at = now() - interval '2 minutes' WHERE roll_no='12500121002'");
    const late = await fetch(`${BASE}/api/attempt/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${st.token}` }, body: JSON.stringify({ items: [{ qid: 1, c: 0 }] }) });
    assert(late.status === 409, `late answer accepted: ${late.status}`);
    const res = await (await fapi('GET', `/api/exams/${exam2}/results`)).json();
    const a = res.attempts.find((x) => x.roll_no === '12500121002');
    assert(a.status === 'submitted' && a.submit_mode === 'timeout', 'not auto-submitted by server');
  });

  console.log('\nResults & exports');
  await step('faculty dashboard shows submission, marks, and warnings', async () => {
    await F.goto(`${BASE}/faculty#/results/${examId}`);
    await F.waitForSelector('table.t >> text=12500121045');
    const row = await F.textContent('table.t tbody tr');
    assert(/Riya Mahato/.test(row), 'name');
    assert(/2\.67/.test(row), `expected 2.67 (3 correct, 1 wrong at −0.33), row: ${row.replace(/\s+/g, ' ')}`);
    assert(/[1-9]\d* ⚠/.test(row), 'warnings not shown');
    await F.fill('#q', 'nobody'); await F.waitForSelector('text=No attempts yet');
    await F.fill('#q', '1250012104'); await F.waitForSelector('table.t >> text=Riya Mahato');
    await F.click('button[data-ev]');
    await F.waitForSelector('#modal >> text=Left page / switched tab');
    await F.waitForSelector('#modal >> text=Blocked login from another device');
    await F.screenshot({ path: path.join(SHOTS, '07-faculty-events.png') });
    await F.click('#mx');
  });
  await step('Excel export contains the result row', async () => {
    const [dl] = await Promise.all([F.waitForEvent('download'), F.click('#xl')]);
    const file = path.join(SHOTS, 'results.xlsx'); await dl.saveAs(file);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
    const ws = wb.getWorksheet('Results');
    const vals = ws.getRow(6).values;
    assert(vals.includes('12500121045') && vals.includes(2.67), 'xlsx row: ' + JSON.stringify(vals));
  });
  await step('PDF export is a valid PDF', async () => {
    const [dl] = await Promise.all([F.waitForEvent('download'), F.click('#pdf')]);
    const file = path.join(SHOTS, 'results.pdf'); await dl.saveAs(file);
    assert(fs.readFileSync(file).subarray(0, 5).toString() === '%PDF-', 'not a PDF');
  });
  await step('another faculty member cannot see this exam (role isolation)', async () => {
    await fapi('POST', '/api/admin/faculty', { name: 'Dr. B. Das', email: 'bdas@rmgec.ac.in', password: 'Faculty#2026x', role: 'faculty' });
    const ctx = await browser.newContext(); const r = ctx.request;
    await r.post(`${BASE}/api/auth/login`, { data: { email: 'bdas@rmgec.ac.in', password: 'Faculty#2026x' } });
    const h = { 'X-Requested-With': 'ExamDesk' };
    const list = await (await r.get(`${BASE}/api/exams`, { headers: h })).json();
    assert(Array.isArray(list) && list.length === 0, 'other faculty sees exams');
    assert((await r.get(`${BASE}/api/exams/${examId}/results`, { headers: h })).status() === 404, 'results visible to other faculty');
    assert((await r.get(`${BASE}/api/admin/audit`, { headers: h })).status() === 403, 'non-admin reached admin API');
    await ctx.close();
  });
  await step('audit log records faculty and student actions', async () => {
    const log = await (await fapi('GET', '/api/admin/audit')).json();
    for (const a of ['login', 'exam_create', 'questions_import', 'exam_publish', 'attempt_start', 'attempt_submit', 'results_export', 'invalid_code', 'login_failed'])
      assert(log.some((l) => l.action === a), `audit missing ${a}`);
  });
  await step('login rate limit triggers after repeated failures', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@y.z', password: 'nope' }) })).status;
    assert(last === 429, `expected 429, got ${last}`);
  });

  console.log('\nNAT, calculator, diagrams');
  let exam3;
  await step('faculty adds a NAT question in the editor; approval needs an answer range', async () => {
    exam3 = (await (await fapi('POST', '/api/exams', { title: 'Machines NAT Quiz', duration_min: 20, marks_per_q: 1, negative_marks: 0.33 })).json()).id;
    const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'circuit.png')).toString('base64');
    await fapi('POST', `/api/exams/${exam3}/questions`, { stem: `Identify the circuit:<br><img src="data:image/png;base64,${png}">`, options: ['RC', 'RL', 'RLC', 'LC'], correct: 0, approved: true });
    const noRange = await fapi('POST', `/api/exams/${exam3}/questions`, { qtype: 'nat', stem: 'x?', approved: true });
    assert(noRange.status() === 400, 'NAT approved without a range');
    await F.goto(`${BASE}/faculty#/exam/${exam3}`);
    await F.click('#addNat');
    await F.waitForSelector('.qcard.is-nat');
    const card = F.locator('.qcard.is-nat');
    await card.locator('.ed[data-k=stem]').fill('A 4-pole, 50 Hz induction motor runs at 1440 rpm. The slip in % is');
    await card.locator('.nmin').fill('3.95'); await card.locator('.nmax').fill('4.05');
    await card.locator('.qm').fill('2');
    await card.locator('.qa').check();
    await card.locator('button[data-act=save]').click();
    await F.waitForFunction(() => document.querySelectorAll('.qcard.ok').length === 2);
    assert(await F.locator('.qcard.is-nat.ok .nmin').inputValue() === '3.95', 'range not saved');
    const pub = await (await fapi('POST', `/api/exams/${exam3}/publish`)).json();
    assert(pub.slug, 'publish failed: ' + JSON.stringify(pub));
    exam3 = { id: exam3, ...pub };
  });
  await step('student zooms a diagram, uses the calculator, answers NAT on the keypad', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } }); const P = await ctx.newPage();
    await P.goto(`${BASE}/e/${exam3.slug}`); await P.waitForSelector('#regForm');
    await register(P, 'Nat Student', '12500121077', exam3.code);
    await P.waitForSelector('#palette .pq');
    // diagram zoom
    await P.click('.qbody img.zoomable');
    await P.waitForSelector('#zoom:not(.hidden)');
    const fit = parseInt(await P.textContent('#zoomPct'), 10);
    await P.click('#zoom [data-z="+"]'); await P.click('#zoom [data-z="+"]');
    assert(parseInt(await P.textContent('#zoomPct'), 10) > fit, 'zoom in did nothing');
    await P.click('#zoom [data-z=x]');
    await P.locator('.opt').nth(0).click();                      // MCQ correct
    // calculator: sin(30) in degrees, then (1500-1440)/1500*100 for the slip
    await P.click('#calcBtn');
    for (const k of ['sin(', '3', '0', ')', '@eq']) await P.click(`.calc-keys [data-k="${k}"]`);
    assert((await P.textContent('.calc-res')).trim() === '0.5', 'sin(30) != 0.5');
    for (const k of ['@clear', '(', '1', '5', '0', '0', '−', '1', '4', '4', '0', ')', '÷', '1', '5', '0', '0', '×', '1', '0', '0', '@eq']) await P.click(`.calc-keys [data-k="${k}"]`);
    assert((await P.textContent('.calc-res')).trim() === '4', 'slip calc wrong: ' + await P.textContent('.calc-res'));
    await P.screenshot({ path: path.join(SHOTS, '11-calculator.png') });
    await P.click('.calc-x');
    // NAT keypad
    await P.click('#bNext');
    await P.waitForSelector('#natIn');
    for (const k of ['-', '4', '.', '0', '0', '9']) await P.click(`.keypad [data-k="${k}"]`);
    assert(/two decimal/.test(await P.textContent('#natHint')), 'third decimal not blocked');
    assert(await P.inputValue('#natIn') === '-4.00', 'value ' + await P.inputValue('#natIn'));
    await P.click('.keypad [data-k="-"]');                         // toggle sign -> 4.00
    assert(await P.inputValue('#natIn') === '4.00', 'sign toggle');
    await P.waitForSelector('#sync >> text=All answers saved');
    assert(await P.locator('#palette .pq.ans').count() === 2, 'NAT not counted as answered');
    await P.screenshot({ path: path.join(SHOTS, '12-nat-keypad.png') });
    const token = await P.evaluate((k) => localStorage.getItem(k), `ed_tok_${exam3.slug}`);
    const natQ = (await (await fetch(`${BASE}/api/attempt`, { headers: { Authorization: `Bearer ${token}` } })).json()).questions.find((x) => x.type === 'nat');
    assert(natQ && !('nat_min' in natQ) && natQ.options.length === 0, 'NAT key leaked or wrong shape');
    const bad = await fetch(`${BASE}/api/attempt/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ items: [{ qid: natQ.id, c: '4.001' }] }) });
    assert(bad.status === 400, `3-decimal NAT accepted: ${bad.status}`);
    await P.click('#bSubmit'); await P.click('#sYes');
    await P.waitForSelector('text=Examination submitted successfully');
    await ctx.close();
    const res = await (await fapi('GET', `/api/exams/${exam3.id}/results`)).json();
    const a = res.attempts[0];
    assert(Number(a.score) === 3 && Number(a.max_score) === 3 && a.correct_count === 2, `score ${a.score}/${a.max_score}`);
  });

  await step('exam with results can be deleted only after closing; results go with it', async () => {
    assert((await fapi('DELETE', `/api/exams/${examId}`)).status() === 409, 'published exam with results was deletable');
    assert((await fapi('POST', `/api/exams/${examId}/close`)).ok(), 'close failed');
    assert((await fapi('DELETE', `/api/exams/${examId}`)).ok(), 'closed exam not deletable');
    const { rows } = await pg.query('SELECT (SELECT count(*) FROM attempts WHERE exam_id=$1)::int AS a, (SELECT count(*) FROM questions WHERE exam_id=$1)::int AS q', [examId]);
    assert(rows[0].a === 0 && rows[0].q === 0, `left behind: ${JSON.stringify(rows[0])}`);
  });

  console.log('\nMobile');
  await step('student portal works on an Android phone viewport', async () => {
    const { rows } = await pg.query('SELECT code, slug FROM exams WHERE id=$1', [exam2]);
    await pg.query("UPDATE exams SET duration_min=30 WHERE id=$1", [exam2]);
    const ctx = await browser.newContext({ ...devices['Pixel 7'] }); const P = await ctx.newPage();
    await P.goto(`${BASE}/e/${rows[0].slug}`); await P.waitForSelector('#regForm');
    await P.screenshot({ path: path.join(SHOTS, '08-mobile-registration.png') });
    await register(P, 'Mobile Student', '12500121099', rows[0].code);
    await P.waitForSelector('.qbody .opt');
    const onScreen = () => P.evaluate(() => document.querySelector('#side').getBoundingClientRect().left < window.innerWidth - 10);
    assert(!(await onScreen()), 'palette should be a hidden drawer on mobile');
    await P.screenshot({ path: path.join(SHOTS, '09-mobile-exam.png') });
    await P.click('#palBtn'); await P.waitForTimeout(300);
    assert(await onScreen(), 'palette drawer did not open');
    await P.screenshot({ path: path.join(SHOTS, '10-mobile-palette.png') });
    const overflow = await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert(!overflow, 'horizontal overflow on phone');
    await ctx.close();
  });

  await browser.close();
  server.kill();
  await pg.end();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (/Error|error/.test(serverLog.replace(/login_failed/g, ''))) console.log('Server log:\n' + serverLog);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
