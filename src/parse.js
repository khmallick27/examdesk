// Turns document HTML (from .docx) or plain text (from PDF / OCR) into MCQs.
// Pure functions: no I/O. The correct answer is never decided here; a printed
// "Answer: B" line only becomes `suggested`, which faculty must confirm.
const sanitizeHtml = require('sanitize-html');

const SANITIZE = {
  allowedTags: ['b', 'i', 'u', 'strong', 'em', 'sub', 'sup', 'br', 'p', 'span', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'ul', 'ol', 'li'],
  allowedAttributes: { img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
  allowedSchemes: [],
  allowedSchemesByTag: { img: ['data'] },
  allowProtocolRelative: false,
  exclusiveFilter: (f) => f.tag === 'img' && !f.attribs.src, // image whose remote URL was stripped
};
const clean = (html) => sanitizeHtml(String(html || ''), SANITIZE).trim();

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntity(e) {
  const m = /^&(#x[0-9a-f]+|#\d+|\w+);$/i.exec(e);
  if (!m) return e;
  const k = m[1];
  if (k[0] === '#') return String.fromCodePoint(k[1].toLowerCase() === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  return ENT[k.toLowerCase()] ?? e;
}

// Visible text of an HTML fragment plus, for each text char, its index in the HTML.
function textMap(html) {
  let text = '';
  const map = [];
  const re = /<[^>]*>|&(?:#x[0-9a-f]+|#\d+|\w+);|[^<&]+|[<&]/gi;
  let m;
  while ((m = re.exec(html))) {
    const tok = m[0];
    if (tok[0] === '<' && tok.length > 1) continue;
    const chars = tok[0] === '&' ? decodeEntity(tok) : tok;
    for (let i = 0; i < chars.length; i++) { map.push(tok[0] === '&' ? m.index : m.index + i); text += chars[i]; }
  }
  map.push(html.length);
  return { text, map };
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const textToHtml = (txt) => String(txt).split(/\r?\n/).map((l) => `<p>${escapeHtml(l)}</p>`).join('');

// Word auto-numbered lists lose their numbers in HTML; write them back as text.
function numberLists(html) {
  const stack = [];
  let qn = 0;
  return html.replace(/<(\/?)(ol|ul|li)\b[^>]*>/gi, (tag, close, name) => {
    name = name.toLowerCase();
    if (name !== 'li') { close ? stack.pop() : stack.push({ type: name, n: 0 }); return tag; }
    if (close) return tag;
    const top = stack[stack.length - 1];
    if (!top || top.type !== 'ol') return tag;
    top.n++;
    const depth = stack.filter((s) => s.type === 'ol').length;
    return depth === 1 ? `${tag}Q${++qn}. ` : `${tag}(${String.fromCharCode(64 + Math.min(top.n, 26))}) `;
  });
}

function toBlocks(html) {
  const tables = [];
  html = html.replace(/<table[\s\S]*?<\/table>/gi, (t) => { tables.push(t); return `\u0000T${tables.length - 1}\u0000</p>`; });
  return html
    .split(/<\/(?:p|li|h[1-6]|div)>|<(?:p|li|ol|ul|div)\b[^>]*>|<br\s*\/?>/i)
    .map((b) => b.replace(/<\/?(?:p|li|ol|ul|h[1-6]|div)\b[^>]*>/gi, '').replace(/\u0000T(\d+)\u0000/g, (_, i) => tables[i]).trim())
    .filter(Boolean);
}

const Q_START = /^\s*(?:(?:Q(?:uestion)?\s*\.?\s*(?:No\.?\s*)?)(\d{1,3})\s*[.):\]-]?\s+|(\d{1,3})\s*[.)\]](?:\s+|(?=[A-Z])))/i; // OCR may drop the space: "3.A ..."; "2.5 A" is not a question number
const ANSWER = /^\s*(?:Ans(?:wer)?|Correct\s*(?:option|answer)?|Key)\s*[:.\-–=]?\s*(?:option\s*)?\(?\s*([A-Da-d])\s*\)?\s*\.?\s*$/i;
// "Answer: 5.2", "Ans: -0.33", "Answer: 4.95 to 5.05" (a range, as in GATE NAT keys).
const NAT_ANSWER = /^\s*(?:Ans(?:wer)?|Key)\s*[:.=–-]?\s*(-?\d+(?:\.\d+)?)(?:\s*(?:to|–|—|-)\s*(-?\d+(?:\.\d+)?))?\s*$/i;
const OPT =/(^|\s)\(?([A-Da-d])\s*[).]\s*/g;

// Option markers appearing in order (from letter `from`, 0 = A) inside one block. Returns [{at, end}] or [].
function optionMarkers(text, from = 0) {
  const found = [];
  let want = from;
  for (const m of text.matchAll(OPT)) {
    const letter = m[2].toUpperCase().charCodeAt(0) - 65;
    const paren = m[0].includes('(') || m[0].includes(')');
    if (letter !== want) continue;
    if (!paren && !/\.\s+$/.test(m[0])) continue; // "a.c. supply" is not an option
    found.push({ at: m.index + m[1].length, end: m.index + m[0].length });
    if (++want === 4) break;
  }
  if (!found.length) return [];
  // A single "A)" counts only when it opens the block (options one per line).
  if (found.length === 1 && text.slice(0, found[0].at).trim()) return [];
  return found;
}

function parseQuestions(html, { source = 'docx' } = {}) {
  const blocks = toBlocks(numberLists(String(html || '')));
  const questions = [];
  const warnings = [];
  let cur = null;
  let skipped = 0;

  const startQ = (stem) => { cur = { stem: [stem], options: [], suggested: null }; questions.push(cur); };

  for (const block of blocks) {
    const { text, map } = textMap(block);
    const slice = (a, b) => block.slice(map[a], b === undefined ? undefined : map[b]);
    if (!text.trim() && !/<img|<table/i.test(block)) continue;

    const ans = ANSWER.exec(text);
    if (ans && cur) { cur.suggested = ans[1].toUpperCase().charCodeAt(0) - 65; continue; }
    const nat = NAT_ANSWER.exec(text);
    if (nat && cur) { cur.nat = [Number(nat[1]), Number(nat[2] ?? nat[1])].sort((x, y) => x - y); continue; }

    const qs = Q_START.exec(text);
    let rest = block, restText = text, restMap = map, offset = 0;
    if (qs) {
      offset = qs[0].length;
      rest = slice(offset); startQ('');
    } else if (!cur) { skipped++; continue; }

    if (offset) ({ text: restText, map: restMap } = textMap(rest));
    const marks = cur.options.length < 4 ? optionMarkers(restText, cur.options.length) : [];
    const rslice = (a, b) => rest.slice(restMap[a], b === undefined ? undefined : restMap[b]);
    if (marks.length) {
      const before = rslice(0, marks[0].at);
      if (restText.slice(0, marks[0].at).trim()) cur.stem.push(before);
      marks.forEach((mk, i) => cur.options.push([rslice(mk.end, marks[i + 1]?.at)]));
    } else if (cur.options.length) {
      cur.options[cur.options.length - 1].push(rest);
    } else {
      cur.stem.push(rest);
    }
  }
  if (skipped) warnings.push(`${skipped} line(s) before the first question were ignored (title, instructions).`);

  return {
    warnings,
    questions: questions.map((q) => {
      const flags = [];
      // No options at all = GATE numerical answer type (NAT).
      const qtype = q.options.length ? 'mcq' : 'nat';
      let options = q.options.map((o) => clean(o.join('<br>')));
      if (qtype === 'mcq' && options.length !== 4) flags.push(`Found ${options.length} option(s); exactly 4 are required.`);
      if (qtype === 'nat') flags.push('No options found: imported as a Numerical Answer Type (NAT) question. Change the type if this is wrong.');
      options = options.slice(0, 4);
      while (qtype === 'mcq' && options.length < 4) options.push('');
      const stem = clean(q.stem.filter(Boolean).join('<br>'));
      const all = stem + options.join('');
      if (!stem) flags.push('Question text is empty.');
      if (/<img|<table/i.test(all)) flags.push('Contains a diagram/table: check it is complete and placed correctly.');
      if (/\\\(|\\\[/.test(all)) flags.push('Contains an equation converted from Word: check the rendered maths.');
      if (/�/.test(all)) flags.push('Contains unrecognised characters.');
      if (source === 'pdf') flags.push('Imported from PDF: subscripts, superscripts and figures may be lost.');
      if (source === 'ocr') flags.push('Read by OCR from a scanned page: verify every symbol and number.');
      const found = qtype === 'nat' ? !!q.nat : q.suggested !== null;
      flags.push(found ? 'Answer found in the document: confirm it before approving.' : 'No answer found in the document: set the correct answer.');
      // A printed NAT range pre-fills the key, but the question stays unapproved until faculty confirms it.
      return { qtype, stem, options, suggested: qtype === 'mcq' ? q.suggested : null, nat_min: q.nat ? q.nat[0] : null, nat_max: q.nat ? q.nat[1] : null, flags };
    }),
  };
}

module.exports = { parseQuestions, textToHtml, clean, textMap, optionMarkers };
