// File -> MCQs. .docx via mammoth (Word equations converted to LaTeX first),
// text PDFs via poppler's pdftotext, scanned PDFs / images via tesseract OCR.
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { parseQuestions, textToHtml } = require('./parse');

const run = promisify(execFile);

// ---- Word OMML equations -> LaTeX (mammoth drops OMML otherwise) ----
const wval = (el) => el && (el.getAttribute('w:val') || el.getAttribute('m:val') || el.getAttribute('val'));
const kids = (n, name) => Array.from(n.childNodes || []).filter((c) => c.nodeType === 1 && (!name || c.localName === name));
const kid = (n, name) => kids(n, name)[0];
function omml(n) {
  if (!n) return '';
  const all = () => kids(n).map(omml).join('');
  switch (n.localName) {
    case 't': return n.textContent;
    case 'r': { const pr = kid(n, 'rPr'); const plain = pr && wval(kid(pr, 'sty')) === 'p'; const t = kids(n, 't').map(omml).join(''); return plain && t.trim() ? `\\mathrm{${t}}` : t; }
    case 'f': return `\\frac{${omml(kid(n, 'num'))}}{${omml(kid(n, 'den'))}}`;
    case 'sSup': return `{${omml(kid(n, 'e'))}}^{${omml(kid(n, 'sup'))}}`;
    case 'sSub': return `{${omml(kid(n, 'e'))}}_{${omml(kid(n, 'sub'))}}`;
    case 'sSubSup': return `{${omml(kid(n, 'e'))}}_{${omml(kid(n, 'sub'))}}^{${omml(kid(n, 'sup'))}}`;
    case 'rad': { const d = omml(kid(n, 'deg')); return d ? `\\sqrt[${d}]{${omml(kid(n, 'e'))}}` : `\\sqrt{${omml(kid(n, 'e'))}}`; }
    case 'd': {
      const pr = kid(n, 'dPr');
      const ch = (name, dflt) => { const c = pr && kid(pr, name); const v = c && (c.getAttribute('m:val') || c.getAttribute('val')); return v === null || v === undefined || v === '' ? dflt : v; };
      const esc = (s) => (s === '{' ? '\\{' : s === '}' ? '\\}' : s || '.');
      return `\\left${esc(ch('begChr', '('))}${kids(n, 'e').map(omml).join(',')}\\right${esc(ch('endChr', ')'))}`;
    }
    case 'func': return `\\operatorname{${omml(kid(n, 'fName'))}}${omml(kid(n, 'e'))}`;
    case 'bar': return `\\overline{${omml(kid(n, 'e'))}}`;
    case 'acc': return `\\hat{${omml(kid(n, 'e'))}}`;
    case 'nary': {
      const pr = kid(n, 'naryPr'); const c = pr && kid(pr, 'chr');
      const sym = { '∑': '\\sum', '∏': '\\prod', '∮': '\\oint' }[c && (c.getAttribute('m:val') || c.getAttribute('val'))] || '\\int';
      return `${sym}_{${omml(kid(n, 'sub'))}}^{${omml(kid(n, 'sup'))}}${omml(kid(n, 'e'))}`;
    }
    case 'rPr': case 'ctrlPr': case 'fPr': case 'dPr': case 'radPr': case 'sSupPr': case 'sSubPr': case 'naryPr': case 'oMathParaPr': return '';
    default: return all();
  }
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const roman = (n) => [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  .reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, '');
const letter = (n) => String.fromCharCode(97 + ((n - 1) % 26));

// Word list numbering ("1.", "(A)", "a)") is not text, and mammoth drops its format.
// Write the label Word would display into each numbered paragraph so the parser can see it.
async function materializeNumbering(zip, doc) {
  const nf = zip.file('word/numbering.xml');
  if (!nf) return;
  const ndoc = new DOMParser().parseFromString(await nf.async('string'), 'text/xml');
  const abs = {};
  for (const a of Array.from(ndoc.getElementsByTagName('w:abstractNum'))) {
    const lv = {};
    for (const l of kids(a, 'lvl')) lv[l.getAttribute('w:ilvl')] = { fmt: wval(kid(l, 'numFmt')) || 'decimal', text: wval(kid(l, 'lvlText')) || '', start: Number(wval(kid(l, 'start')) || 1) };
    abs[a.getAttribute('w:abstractNumId')] = lv;
  }
  const nums = {};
  for (const n of Array.from(ndoc.getElementsByTagName('w:num'))) {
    const over = {};
    for (const o of kids(n, 'lvlOverride')) { const s = kid(o, 'startOverride'); if (s) over[o.getAttribute('w:ilvl')] = Number(wval(s)); }
    nums[n.getAttribute('w:numId')] = { lv: abs[wval(kid(n, 'abstractNumId'))] || {}, over };
  }
  const counters = {};
  for (const p of Array.from(doc.getElementsByTagName('w:p'))) {
    const pPr = kid(p, 'pPr'); const numPr = pPr && kid(pPr, 'numPr');
    if (!numPr) continue;
    const numId = wval(kid(numPr, 'numId')); const ilvl = wval(kid(numPr, 'ilvl')) || '0';
    const def = nums[numId]; const lvl = def && def.lv[ilvl];
    if (!lvl || numId === '0' || lvl.fmt === 'bullet' || lvl.fmt === 'none') continue;
    const c = (counters[numId] ||= {});
    c[ilvl] = (c[ilvl] ?? ((def.over[ilvl] ?? lvl.start) - 1)) + 1;
    for (const k of Object.keys(c)) if (Number(k) > Number(ilvl)) delete c[k]; // deeper levels restart
    const show = (n, fmt) => ({ upperLetter: letter(n).toUpperCase(), lowerLetter: letter(n), upperRoman: roman(n).toUpperCase(), lowerRoman: roman(n) }[fmt] ?? String(n));
    const label = lvl.text.replace(/%(\d)/g, (_, d) => { const L = String(Number(d) - 1); const ld = def.lv[L] || lvl; return show(c[L] ?? ld.start, ld.fmt); });
    const r = doc.createElementNS(W, 'w:r'); const t = doc.createElementNS(W, 'w:t');
    t.setAttribute('xml:space', 'preserve'); t.appendChild(doc.createTextNode(`${label} `)); r.appendChild(t);
    pPr.removeChild(numPr);
    p.insertBefore(r, pPr.nextSibling);
  }
}

async function preprocessDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) return { buffer, count: 0 };
  const doc = new DOMParser().parseFromString(await file.async('string'), 'text/xml');
  await materializeNumbering(zip, doc);
  let count = 0;
  // Outermost math only (oMathPara wraps oMath).
  const maths = Array.from(doc.getElementsByTagName('m:oMathPara')).concat(
    Array.from(doc.getElementsByTagName('m:oMath')).filter((m) => m.parentNode.localName !== 'oMathPara'));
  for (const m of maths) {
    const latex = omml(m).replace(/\s+/g, ' ').trim();
    const r = doc.createElementNS(W, 'w:r');
    const t = doc.createElementNS(W, 'w:t');
    t.setAttribute('xml:space', 'preserve');
    t.appendChild(doc.createTextNode(` \\(${latex}\\) `));
    r.appendChild(t);
    // A display equation sits directly in the body: wrap it in a paragraph.
    if (m.parentNode.localName === 'body') { const p = doc.createElementNS(W, 'w:p'); p.appendChild(r); m.parentNode.replaceChild(p, m); } else m.parentNode.replaceChild(r, m);
    count++;
  }
  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), count };
}

// ---- OCR ----
let workerPromise = null;
function ocrWorker() {
  // shortcut: one shared worker serialises OCR jobs; fine for a few faculty uploads, use a pool if many upload at once.
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    const langPath = path.dirname(require.resolve('@tesseract.js-data/eng/package.json')) + '/4.0.0';
    workerPromise = createWorker('eng', 1, { langPath, gzip: true, cachePath: os.tmpdir() });
  }
  return workerPromise;
}
async function ocr(images) {
  const w = await ocrWorker();
  const parts = [];
  let conf = 0;
  for (const img of images) { const { data } = await w.recognize(img); parts.push(data.text); conf += data.confidence; }
  return { text: parts.join('\n'), confidence: images.length ? conf / images.length : 0 };
}

async function withTmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'examdesk-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function importFile(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  const notes = [];
  if (ext === '.docx') {
    const conv = await preprocessDocx(buffer);
    if (conv.count) notes.push(`${conv.count} Word equation(s) converted to LaTeX; check them in the preview.`);
    const { value } = await mammoth.convertToHtml({ buffer: conv.buffer });
    return finish(parseQuestions(value, { source: 'docx' }), notes);
  }
  if (ext === '.pdf') {
    return withTmp(async (dir) => {
      const pdf = path.join(dir, 'in.pdf');
      await fs.writeFile(pdf, buffer);
      const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', pdf, '-'], { maxBuffer: 50 * 1024 * 1024 });
      if (stdout.replace(/\s/g, '').length > 40) return finish(parseQuestions(textToHtml(stdout), { source: 'pdf' }), notes);
      // No text layer: a scanned paper. Rasterise and OCR (page cap keeps the server responsive).
      await run('pdftoppm', ['-r', '200', '-png', '-l', '20', pdf, path.join(dir, 'p')]);
      const pages = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(dir, f));
      const { text, confidence } = await ocr(pages);
      notes.push(`Scanned PDF: ${pages.length} page(s) read by OCR (mean confidence ${confidence.toFixed(0)}%).`);
      return finish(parseQuestions(textToHtml(text), { source: 'ocr' }), notes);
    });
  }
  if (['.png', '.jpg', '.jpeg'].includes(ext)) {
    const { text, confidence } = await ocr([buffer]);
    notes.push(`Image read by OCR (confidence ${confidence.toFixed(0)}%).`);
    return finish(parseQuestions(textToHtml(text), { source: 'ocr' }), notes);
  }
  const err = new Error('Unsupported file type. Upload .docx, .pdf, .png or .jpg.');
  err.status = 400;
  throw err;
}

function finish(result, notes) {
  return { questions: result.questions, notes: notes.concat(result.warnings) };
}

module.exports = { importFile, preprocessDocx, omml };
