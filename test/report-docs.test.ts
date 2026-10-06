import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { BASE, signupAgency, createMemberSession, data, type Agent } from './helpers';
import { buildTeamReportPdf, buildTeamReportXlsx, minutesToHours } from '../src/services/report-docs.js';
import type { EmployeeReport } from '../src/services/reports.js';

/**
 * The monthly report has to be READABLE: a PDF for the phone and a spreadsheet
 * for anyone who wants to sort it. These assert the documents are real files
 * with the right numbers in them, and that the download route is permissioned.
 */
const row = (over: Partial<EmployeeReport> = {}): EmployeeReport => ({
  userId: 'usr_1',
  name: 'Asha Menon',
  email: 'asha@test.local',
  timeMinutes: 7_320,
  utilizationPct: 82,
  tasks: { open: 4, overdue: 1, completed: 17 },
  attendance: {
    present: 21,
    late: 2,
    halfDay: 1,
    absent: 1,
    onLeave: 2,
    holiday: 2,
    weeklyOff: 8,
    workingDays: 22,
    workedMinutes: 10_080,
    overtimeMinutes: 240,
  },
  ...over,
}) as EmployeeReport;

describe('monthly report documents', () => {
  const input = {
    agencyName: 'Creative Monk',
    periodLabel: '1 Sep 2026 → 30 Sep 2026',
    reports: [row(), row({ userId: 'usr_2', name: 'Ravi Shah', utilizationPct: 61 })],
  };

  it('builds a real PDF', async () => {
    const pdf = await buildTeamReportPdf(input);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.subarray(-800).toString('latin1')).toContain('%%EOF');
  });

  it('builds a spreadsheet with a header, every employee and a totals row', async () => {
    const xlsx = await buildTeamReportXlsx(input);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;

    expect(String(ws.getCell(1, 1).value)).toContain('Creative Monk');
    expect(String(ws.getCell(3, 1).value)).toBe('Employee');
    expect(String(ws.getCell(4, 1).value)).toBe('Asha Menon');
    expect(ws.getCell(4, 2).value).toBe(21); // present days
    expect(String(ws.getCell(5, 1).value)).toBe('Ravi Shah');

    const totalRow = ws.getRow(6);
    expect(String(totalRow.getCell(1).value)).toBe('Total');
    expect(totalRow.getCell(2).value).toBe(42); // 21 + 21 present
    expect(totalRow.getCell(10).value).toBe(72); // (82 + 61) / 2 average utilization
  });

  it('survives an empty team', async () => {
    const empty = { ...input, reports: [] };
    expect((await buildTeamReportPdf(empty)).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await buildTeamReportXlsx(empty)).length).toBeGreaterThan(0);
  });

  it('formats minutes the way the email does', () => {
    expect(minutesToHours(0)).toBe('0h');
    expect(minutesToHours(90)).toBe('1h 30m');
    expect(minutesToHours(120)).toBe('2h');
  });
});

describe('report download endpoints', () => {
  let owner: Agent;
  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  it('serves a PDF and an xlsx with download headers', async () => {
    const pdf = await owner.get(`${BASE}/attendance/team-report.pdf?from=2026-09-01&to=2026-09-30`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('team-report-2026-09.pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');

    const xlsx = await owner.get(`${BASE}/attendance/team-report.xlsx?from=2026-09-01&to=2026-09-30`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-disposition']).toContain('team-report-2026-09.xlsx');
  });

  it('refuses someone who cannot see the report', async () => {
    const { agent } = await createMemberSession(owner, { permissions: { attendance: 'view' } });
    expect((await agent.get(`${BASE}/attendance/team-report.pdf`)).status).toBe(403);
  });

  it('still emails the overview, now with both documents attached', async () => {
    const { testOutbox } = await import('../src/services/email.js');
    testOutbox.length = 0;
    const res = await owner
      .post(`${BASE}/attendance/email-reports`)
      .send({ from: '2026-09-01', to: '2026-09-30' });
    expect(res.status).toBe(200);
    expect(data(res).owners).toBeGreaterThan(0);

    const overview = testOutbox.find((m) => m.subject.startsWith('Team work summary'));
    expect(overview).toBeTruthy();
    const names = (overview!.attachments ?? []).map((a) => a.filename);
    expect(names).toEqual(['team-report-2026-09.pdf', 'team-report-2026-09.xlsx']);
    expect(overview!.text).toContain('attached as a PDF and a spreadsheet');
  });
});
