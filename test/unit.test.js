const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseQuestions, textToHtml, clean } = require('../src/parse');
const rules = require('../src/rules');
const { importFile } = require('../src/importer');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
const plain = (q) => ({ stem: q.stem, options: q.options, suggested: q.suggested });

test('parses separate-line and inline options, answer lines become suggestions only', () => {
  const r = parseQuestions(textToHtml(`Title line
1. Slip of a 4-pole 50 Hz motor at 1440 rpm is
(A) 2%
(B) 4%
(C) 5%
(D) 6%
Answer: B
Q2. Unit of θ is (a) rad (b) m (c) s (d) A
3) X<sub>L</sub> of a 10 mH coil at ω = 100 rad/s is
A. 1 Ω  B. 10 Ω  C. 0.1 Ω  D. 100 Ω`));
  assert.equal(r.questions.length, 3);
  assert.deepEqual(plain(r.questions[0]), { stem: 'Slip of a 4-pole 50 Hz motor at 1440 rpm is', options: ['2%', '4%', '5%', '6%'], suggested: 1 });
  assert.deepEqual(r.questions[1].options, ['rad', 'm', 's', 'A']);
  assert.equal(r.questions[1].stem, 'Unit of θ is');
  assert.deepEqual(r.questions[2].options, ['1 Ω', '10 Ω', '0.1 Ω', '100 Ω']);
  assert.equal(r.questions[2].suggested, null);
  assert.match(r.questions[2].flags.join(' '), /No answer found/);
});

test('does not split "a.c. supply" or decimals into options/questions', () => {
  const r = parseQuestions(textToHtml('1. Which motor runs on a.c. supply and 2.5 A?\n(A) x\n(B) y\n(C) z\n(D) w'));
  assert.equal(r.questions.length, 1);
  assert.match(r.questions[0].stem, /a\.c\. supply and 2\.5 A/);
});

test('flags wrong option count and keeps 4 slots', () => {
  const r = parseQuestions(textToHtml('1. Pick one\n(A) p\n(B) q'));
  assert.deepEqual(r.questions[0].options, ['p', 'q', '', '']);
  assert.match(r.questions[0].flags[0], /Found 2 option/);
});

test('sanitizer strips scripts, handlers and non-data image URLs', () => {
  const out = clean('<b onclick="x()">V<sub>1</sub></b><script>alert(1)</script><img src="http://evil/x.png"><img src="data:image/png;base64,AAAA" onerror="x()">');
  assert.equal(out, '<b>V<sub>1</sub></b><img src="data:image/png;base64,AAAA" />');
});

test('scoring with negative marking and per-question override', () => {
  const qs = [{ id: 1, correct: 0, marks: null, negative: null }, { id: 2, correct: 1, marks: 2, negative: 0.66 }, { id: 3, correct: 2, marks: null, negative: null }];
  const s = rules.score(qs, { 1: { c: 0 }, 2: { c: 3 }, 3: { c: null, m: true } }, { marks_per_q: 1, negative_marks: 0.33 });
  assert.deepEqual(s, { attempted: 2, correct: 1, incorrect: 1, unanswered: 1, score: 0.34, max: 4 });
});

test('student validation and normalisation', () => {
  assert.deepEqual(rules.validateStudent({ name: ' Riya  Mahato ', roll: '125 0012 1045', code: 'ab12cd' }), { errors: [], name: 'Riya Mahato', roll: '12500121045', code: 'AB12CD' });
  assert.equal(rules.validateStudent({ name: '', roll: '', code: '' }).errors.length, 3);
  assert.equal(rules.validateStudent({ name: '<script>', roll: 'x', code: '1' }).errors.length, 3);
});

test('deadline never exceeds scheduled end; window checks', () => {
  const now = new Date('2026-11-26T10:00:00Z');
  assert.equal(rules.deadlineFor({ duration_min: 60, end_at: '2026-11-26T10:30:00Z' }, now).toISOString(), '2026-11-26T10:30:00.000Z');
  assert.equal(rules.deadlineFor({ duration_min: 60, end_at: null }, now).toISOString(), '2026-11-26T11:00:00.000Z');
  assert.equal(rules.examWindow({ status: 'draft' }, now).open, false);
  assert.equal(rules.examWindow({ status: 'published', start_at: '2026-11-26T11:00:00Z' }, now).open, false);
  assert.equal(rules.examWindow({ status: 'published', end_at: '2026-11-26T09:00:00Z' }, now).open, false);
  assert.equal(rules.examWindow({ status: 'published' }, now).open, true);
});

test('shuffle is a deterministic permutation', () => {
  const a = rules.shuffled([1, 2, 3, 4, 5, 6], 42);
  assert.deepEqual(a, rules.shuffled([1, 2, 3, 4, 5, 6], 42));
  assert.deepEqual(a.slice().sort(), [1, 2, 3, 4, 5, 6]);
});

test('imports Word paper: numbering, equations, symbols, subscripts, diagram', async () => {
  const r = await importFile(fx('paper.docx'), 'paper.docx');
  assert.equal(r.questions.length, 4);
  assert.deepEqual(r.questions[0].options, ['2%', '4%', '5%', '6%']);
  assert.equal(r.questions[0].suggested, 1);
  assert.match(r.questions[1].options[0], /\\frac\{\{V\}_\{m\}\}\{\\sqrt\{2\}\}/);
  assert.equal(r.questions[1].suggested, 0);
  assert.match(r.questions[2].stem, /θ between V<sub>1<\/sub> and I<sub>2<\/sub>/);
  assert.match(r.questions[2].stem, /<img [^>]*src="data:image\/png;base64,/);
  assert.deepEqual(r.questions[2].options, ['0°', '30°', '45°', '90°']);
  assert.deepEqual(r.questions[3].options, ['unity', 'zero lagging', 'zero leading', '0.5 lagging']);
  assert.match(r.notes.join(' '), /5 Word equation/);
});

test('imports Word auto-numbered nested lists', async () => {
  const r = await importFile(fx('list.docx'), 'list.docx');
  assert.equal(r.questions.length, 2);
  assert.deepEqual(r.questions[1].options, ['R/3', '3R', 'R', 'R²']);
  assert.match(r.questions[1].stem, /^Δ–Y/);
});

test('imports text PDF and OCRs scanned PDF', async () => {
  const t = await importFile(fx('text.pdf'), 'text.pdf');
  assert.equal(t.questions.length, 3);
  assert.equal(t.questions[0].options[0], '√(L/C)');
  const s = await importFile(fx('scanned.pdf'), 'scanned.pdf');
  assert.equal(s.questions.length, 3);
  assert.deepEqual(s.questions[1].options, ['short lines at full load', 'long lines at light load', 'cables only', 'DC lines']);
  assert.ok(s.questions.every((q) => q.flags.some((f) => /OCR/.test(f))));
});

test('rejects unsupported file types', async () => {
  await assert.rejects(importFile(Buffer.from('x'), 'paper.txt'), /Unsupported/);
});

test.after(() => setImmediate(() => process.exit(process.exitCode || 0))); // OCR worker keeps the loop alive
