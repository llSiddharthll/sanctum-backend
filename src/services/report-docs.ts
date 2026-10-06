/**
 * Monthly report documents: a laid-out PDF to read (on a phone, with no
 * spreadsheet app) and an .xlsx to work with. Both are built from the same
 * EmployeeReport rows the emails already use, so they can never disagree.
 *
 * Deliberately dependency-light: pdfkit draws the table by hand rather than
 * pulling in a headless browser.
 */
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import type { EmployeeReport } from './reports.js';

const INK = '#1C1917';
const MUTED = '#78716C';
const RULE = '#E7E5E4';
const BRAND = '#EF7E1A';

export function minutesToHours(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Columns shared by the PDF table and the spreadsheet, in one place. */
const COLUMNS: Array<{
  header: string;
  width: number;
  value: (r: EmployeeReport) => string | number;
  numeric?: boolean;
}> = [
  { header: 'Employee', width: 120, value: (r) => r.name },
  { header: 'Present', width: 48, value: (r) => r.attendance.present, numeric: true },
  { header: 'Late', width: 38, value: (r) => r.attendance.late, numeric: true },
  { header: 'Half', width: 38, value: (r) => r.attendance.halfDay, numeric: true },
  { header: 'Absent', width: 48, value: (r) => r.attendance.absent, numeric: true },
  { header: 'Leave', width: 44, value: (r) => r.attendance.onLeave, numeric: true },
  { header: 'Worked', width: 58, value: (r) => minutesToHours(r.attendance.workedMinutes) },
  { header: 'Overtime', width: 58, value: (r) => minutesToHours(r.attendance.overtimeMinutes) },
  { header: 'Logged', width: 58, value: (r) => minutesToHours(r.timeMinutes) },
  { header: 'Util %', width: 44, value: (r) => r.utilizationPct, numeric: true },
  { header: 'Done', width: 40, value: (r) => r.tasks.completed, numeric: true },
  { header: 'Open', width: 40, value: (r) => r.tasks.open, numeric: true },
  { header: 'Overdue', width: 52, value: (r) => r.tasks.overdue, numeric: true },
];

export interface ReportDocInput {
  agencyName: string;
  periodLabel: string;
  reports: EmployeeReport[];
}

/** Totals row — the numbers a boss actually scans for. */
function totals(reports: EmployeeReport[]) {
  const sum = (f: (r: EmployeeReport) => number) => reports.reduce((n, r) => n + f(r), 0);
  return {
    staff: reports.length,
    present: sum((r) => r.attendance.present),
    absent: sum((r) => r.attendance.absent),
    late: sum((r) => r.attendance.late),
    onLeave: sum((r) => r.attendance.onLeave),
    workedMinutes: sum((r) => r.attendance.workedMinutes),
    overtimeMinutes: sum((r) => r.attendance.overtimeMinutes),
    loggedMinutes: sum((r) => r.timeMinutes),
    tasksDone: sum((r) => r.tasks.completed),
    tasksOpen: sum((r) => r.tasks.open),
    tasksOverdue: sum((r) => r.tasks.overdue),
    utilizationPct: reports.length
      ? Math.round(sum((r) => r.utilizationPct) / reports.length)
      : 0,
  };
}

export async function buildTeamReportPdf(input: ReportDocInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const t = totals(input.reports);

  // Header
  doc.fillColor(BRAND).fontSize(9).font('Helvetica-Bold').text(input.agencyName.toUpperCase());
  doc.fillColor(INK).fontSize(20).font('Helvetica-Bold').text('Team work summary', { lineGap: 2 });
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(input.periodLabel);
  doc.moveDown(0.8);

  // Summary strip
  const strip: Array<[string, string]> = [
    ['Staff', String(t.staff)],
    ['Present days', String(t.present)],
    ['Absent days', String(t.absent)],
    ['Late', String(t.late)],
    ['On leave', String(t.onLeave)],
    ['Hours worked', minutesToHours(t.workedMinutes)],
    ['Hours logged', minutesToHours(t.loggedMinutes)],
    ['Avg utilization', `${t.utilizationPct}%`],
    ['Tasks done', String(t.tasksDone)],
    ['Overdue', String(t.tasksOverdue)],
  ];
  const stripTop = doc.y;
  const cellW = (doc.page.width - 72) / strip.length;
  strip.forEach(([label, value], i) => {
    const x = 36 + i * cellW;
    doc.fillColor(MUTED).fontSize(7.5).font('Helvetica').text(label.toUpperCase(), x, stripTop, {
      width: cellW - 6,
    });
    doc.fillColor(INK).fontSize(13).font('Helvetica-Bold').text(value, x, stripTop + 11, {
      width: cellW - 6,
    });
  });
  doc.y = stripTop + 34;
  doc.moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).strokeColor(RULE).stroke();
  doc.moveDown(0.6);

  // Table
  const startX = 36;
  const drawRow = (
    cells: Array<string | number>,
    opts: { bold?: boolean; fill?: string } = {},
  ) => {
    const y = doc.y;
    const rowH = 18;
    if (y + rowH > doc.page.height - 48) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 });
    }
    const top = doc.y;
    if (opts.fill) {
      doc.rect(startX, top - 3, doc.page.width - 72, rowH).fill(opts.fill);
    }
    let x = startX;
    COLUMNS.forEach((col, i) => {
      doc
        .fillColor(opts.bold ? INK : '#44403C')
        .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8.5)
        .text(String(cells[i] ?? ''), x + 3, top, {
          width: col.width - 6,
          align: col.numeric ? 'right' : 'left',
          lineBreak: false,
        });
      x += col.width;
    });
    doc.y = top + rowH;
    doc.moveTo(startX, doc.y - 4).lineTo(doc.page.width - 36, doc.y - 4).strokeColor(RULE).stroke();
  };

  drawRow(COLUMNS.map((c) => c.header), { bold: true, fill: '#FAFAF9' });
  if (!input.reports.length) {
    doc.fillColor(MUTED).fontSize(10).font('Helvetica').text('No staff to report for this period.', startX, doc.y + 6);
  }
  for (const r of input.reports) drawRow(COLUMNS.map((c) => c.value(r)));

  if (input.reports.length) {
    drawRow(
      [
        'Total',
        t.present,
        t.late,
        '',
        t.absent,
        t.onLeave,
        minutesToHours(t.workedMinutes),
        minutesToHours(t.overtimeMinutes),
        minutesToHours(t.loggedMinutes),
        t.utilizationPct,
        t.tasksDone,
        t.tasksOpen,
        t.tasksOverdue,
      ],
      { bold: true },
    );
  }

  doc
    .fillColor(MUTED)
    .fontSize(7.5)
    .font('Helvetica')
    .text(
      `Generated by Sanctum · ${new Date().toISOString().slice(0, 10)} · Utilization = time logged ÷ expected capacity.`,
      36,
      doc.page.height - 42,
      { width: doc.page.width - 72 },
    );

  doc.end();
  return done;
}

export async function buildTeamReportXlsx(input: ReportDocInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sanctum';
  wb.created = new Date();
  const ws = wb.addWorksheet(input.periodLabel.slice(0, 28) || 'Report');

  ws.mergeCells(1, 1, 1, COLUMNS.length);
  const title = ws.getCell(1, 1);
  title.value = `${input.agencyName} — team work summary — ${input.periodLabel}`;
  title.font = { bold: true, size: 13 };
  ws.getRow(1).height = 22;

  const header = ws.getRow(3);
  COLUMNS.forEach((c, i) => {
    header.getCell(i + 1).value = c.header;
    ws.getColumn(i + 1).width = Math.max(10, Math.round(c.width / 6));
  });
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
  header.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  ws.views = [{ state: 'frozen', ySplit: 3 }];
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: COLUMNS.length } };

  input.reports.forEach((r) => {
    ws.addRow(COLUMNS.map((c) => c.value(r)));
  });

  if (input.reports.length) {
    const t = totals(input.reports);
    const row = ws.addRow([
      'Total',
      t.present,
      t.late,
      '',
      t.absent,
      t.onLeave,
      minutesToHours(t.workedMinutes),
      minutesToHours(t.overtimeMinutes),
      minutesToHours(t.loggedMinutes),
      t.utilizationPct,
      t.tasksDone,
      t.tasksOpen,
      t.tasksOverdue,
    ]);
    row.font = { bold: true };
    row.border = { top: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** File-name stem, e.g. `team-report-2026-09`. */
export function reportFileStem(from: string): string {
  return `team-report-${from.slice(0, 7)}`;
}
