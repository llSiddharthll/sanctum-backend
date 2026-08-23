import { describe, it, expect } from 'vitest';
import { parseDate } from '../src/services/sheet-publish';

/** The calendar accepts many date formats people actually type. */
describe('sheet publish: parseDate', () => {
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  it('parses day-first, month-first, ISO, dotted, textual and 2-digit-year forms', () => {
    // All of these mean 1 September 2026.
    for (const s of [
      '2026-09-01',
      '2026/09/01',
      '2026.09.01',
      '01-09-2026',
      '1-9-2026',
      '01/09/2026',
      '01.09.2026',
      '1-9-26',
      '1 Sep 2026',
      '1 September 2026',
      '1st Sep 2026',
      '1-Sep-2026',
      'Sep 1 2026',
      'September 1, 2026',
      'Sep 1, 26',
    ]) {
      expect(iso(parseDate(s)), s).toBe('2026-09-01');
    }
  });

  it('keeps day-first numeric dates day-first (Indian default), not US MM-DD', () => {
    expect(iso(parseDate('02-09-2026'))).toBe('2026-09-02'); // 2 Sep, not 9 Feb
    expect(iso(parseDate('13/09/2026'))).toBe('2026-09-13'); // 13 can't be a month
  });

  it('disambiguates to US month-first only when the first field cannot be a day-as-month', () => {
    // 9-13-2026: 13 can't be a month → month-first → 13 Sep 2026.
    expect(iso(parseDate('9-13-2026'))).toBe('2026-09-13');
  });

  it('rejects blanks and impossible calendar dates (no silent roll-over)', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate('   ')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate('31-02-2026')).toBeNull(); // Feb 31 → invalid, not Mar 3
  });
});
