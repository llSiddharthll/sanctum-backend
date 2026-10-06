/**
 * India's fixed-date public holidays.
 *
 * Only holidays that fall on the SAME date every year live here, so the list
 * can be generated for any year and stays correct without maintenance. The
 * movable ones — Holi, Eid, Dussehra, Diwali, Guru Nanak Jayanti, Good Friday —
 * follow lunar/liturgical calendars and shift every year; inventing those dates
 * would put wrong holidays in people's attendance, so they are added by hand
 * (the Holidays settings screen is built for exactly that).
 *
 * `national: true` marks the three gazetted national holidays that apply across
 * the whole country; the rest are the common fixed-date gazetted holidays most
 * agencies observe.
 */
export interface FixedHoliday {
  month: number; // 1-12
  day: number;
  name: string;
  national: boolean;
}

export const INDIAN_FIXED_HOLIDAYS: FixedHoliday[] = [
  { month: 1, day: 26, name: 'Republic Day', national: true },
  { month: 8, day: 15, name: 'Independence Day', national: true },
  { month: 10, day: 2, name: 'Gandhi Jayanti', national: true },
  { month: 4, day: 14, name: 'Dr. Ambedkar Jayanti', national: false },
  { month: 5, day: 1, name: 'Labour Day', national: false },
  { month: 12, day: 25, name: 'Christmas', national: false },
];

export interface GeneratedHoliday {
  day: string; // YYYY-MM-DD
  name: string;
  national: boolean;
}

/**
 * The fixed-date Indian holidays for `year`, as day keys.
 * `nationalOnly` narrows it to the three gazetted national holidays.
 */
export function indianHolidaysFor(
  year: number,
  opts: { nationalOnly?: boolean } = {},
): GeneratedHoliday[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  return INDIAN_FIXED_HOLIDAYS.filter((h) => (opts.nationalOnly ? h.national : true))
    .map((h) => ({
      day: `${year}-${pad(h.month)}-${pad(h.day)}`,
      name: h.name,
      national: h.national,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
