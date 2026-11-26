const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const COLLEGE = 'Ramkrishna Mahato Government Engineering College, Purulia';
const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: process.env.TZ_DISPLAY || 'Asia/Kolkata', hour12: false }) : '');
const pct = (r) => (r.max_score > 0 && r.score !== null ? ((Number(r.score) / Number(r.max_score)) * 100).toFixed(2) : '');

const COLUMNS = [
  ['S.No', 6], ['Student Name', 28], ['Roll No', 16], ['Start Time', 20], ['Submit Time', 20], ['Attempted', 10],
  ['Unanswered', 11], ['Correct', 9], ['Incorrect', 10], ['Marks', 9], ['Max', 7], ['%', 8], ['Warnings', 10], ['Status', 18],
];
const row = (r, i) => [i + 1, r.student_name, r.roll_no, fmt(r.started_at), fmt(r.submitted_at), r.attempted ?? '', r.unanswered ?? '',
  r.correct_count ?? '', r.incorrect_count ?? '', r.score === null ? '' : Number(r.score), r.max_score === null ? '' : Number(r.max_score),
  pct(r), r.warnings, r.status === 'submitted' ? (r.submit_mode === 'timeout' ? 'Auto-submitted (time)' : 'Submitted') : 'In progress'];

async function toXlsx(exam, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Results');
  ws.addRow([COLLEGE]).font = { bold: true, size: 13 };
  ws.addRow([`${exam.department} | ${exam.title} | ${exam.session_label} | ${exam.academic_year}`]);
  ws.addRow([`Exam code ${exam.code} | Exported ${fmt(new Date())}`]);
  ws.addRow([]);
  const head = ws.addRow(COLUMNS.map((c) => c[0]));
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3EAF5' } }; });
  COLUMNS.forEach((c, i) => { ws.getColumn(i + 1).width = c[1]; });
  rows.forEach((r, i) => ws.addRow(row(r, i)));
  ws.views = [{ state: 'frozen', ySplit: 5 }];
  return wb.xlsx.writeBuffer();
}

function toPdf(exam, rows, stream) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  doc.pipe(stream);
  doc.font('Helvetica-Bold').fontSize(14).text(COLLEGE, { align: 'center' });
  doc.font('Helvetica').fontSize(10).text(exam.department, { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(12).text(`${exam.title} - Result Sheet`, { align: 'center' });
  doc.font('Helvetica').fontSize(9).text(`${exam.session_label}  |  Academic Year ${exam.academic_year}  |  Code ${exam.code}  |  Generated ${fmt(new Date())}`, { align: 'center' });
  doc.moveDown(0.8);
  const widths = [26, 140, 80, 88, 88, 44, 50, 40, 46, 40, 34, 40, 44, 80];
  const draw = (cells, bold) => {
    const y = doc.y;
    if (y > doc.page.height - 50) { doc.addPage(); return draw(cells, bold); }
    let x = doc.page.margins.left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
    let h = 0;
    cells.forEach((c, i) => { h = Math.max(h, doc.heightOfString(String(c), { width: widths[i] - 4 })); });
    cells.forEach((c, i) => { doc.text(String(c), x + 2, y + 3, { width: widths[i] - 4 }); x += widths[i]; });
    doc.moveTo(doc.page.margins.left, y + h + 6).lineTo(x, y + h + 6).strokeColor('#bbbbbb').lineWidth(0.5).stroke();
    doc.y = y + h + 7;
  };
  draw(COLUMNS.map((c) => c[0]), true);
  rows.forEach((r, i) => draw(row(r, i), false));
  doc.moveDown(2).font('Helvetica').fontSize(9).text('Signature of Examiner: ____________________', doc.page.margins.left);
  doc.end();
}

module.exports = { toXlsx, toPdf };
