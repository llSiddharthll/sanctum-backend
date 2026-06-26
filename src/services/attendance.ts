/**
 * Attendance data service: policy loading, holiday/leave overlays, and the
 * day-by-day month builder shared by the attendance + leave routers.
 */
import { and, eq, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  attendancePolicy,
  attendanceRecords,
  holidays,
  leaveRequests,
} from '../db/schema.js';
import {
  resolvePolicy,
  dayKeyInTz,
  weekdayForDayKey,
  isWorkingDayKey,
  type ResolvedPolicy,
} from '../lib/attendance.js';
import { toIso } from '../lib/http.js';

export async function loadPolicy(agencyId: string): Promise<ResolvedPolicy> {
  const [row] = await db
    .select()
    .from(attendancePolicy)
    .where(eq(attendancePolicy.agencyId, agencyId))
    .limit(1);
  return resolvePolicy(row ?? null);
}

/** Serialize a stored attendance record to the API shape. */
export function serializeRecord(r: typeof attendanceRecords.$inferSelect) {
  return {
    id: r.id,
    userId: r.userId,
    day: r.day,
    checkInAt: toIso(r.checkInAt),
    checkOutAt: toIso(r.checkOutAt),
    workedMinutes: r.workedMinutes,
    overtimeMinutes: r.overtimeMinutes,
    status: r.status,
    isLate: r.isLate,
    source: r.source,
    note: r.note,
  };
}

/** YYYY-MM -> day-key list + bounds. Throws on bad input. */
export function monthDays(month: string): {
  days: string[];
  first: string;
  last: string;
} {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error('month must be YYYY-MM');
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new Error('invalid month');
  const count = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const days: string[] = [];
  for (let d = 1; d <= count; d++) {
    days.push(`${m[1]}-${m[2]}-${String(d).padStart(2, '0')}`);
  }
  return { days, first: days[0], last: days[days.length - 1] };
}

/** Agency holidays within [first,last] as a day->name map. */
export async function loadHolidayMap(
  agencyId: string,
  first: string,
  last: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ day: holidays.day, name: holidays.name })
    .from(holidays)
    .where(
      and(
        eq(holidays.agencyId, agencyId),
        gte(holidays.day, first),
        lte(holidays.day, last),
      ),
    );
  return new Map(rows.map((r) => [r.day, r.name]));
}

/** Approved-leave days for a user within [first,last] as a day->typeId map. */
export async function loadLeaveDayMap(
  agencyId: string,
  userId: string,
  first: string,
  last: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select()
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.agencyId, agencyId),
        eq(leaveRequests.userId, userId),
        eq(leaveRequests.status, 'approved'),
        lte(leaveRequests.startDay, last),
        gte(leaveRequests.endDay, first),
      ),
    );
  const map = new Map<string, string>();
  for (const lr of rows) {
    for (const day of daysInRange(lr.startDay, lr.endDay)) {
      if (day >= first && day <= last) map.set(day, lr.leaveTypeId);
    }
  }
  return map;
}

/** Inclusive list of 'YYYY-MM-DD' between two day keys. */
export function daysInRange(start: string, end: string): string[] {
  const out: string[] = [];
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  const cur = new Date(Date.UTC(ys, ms - 1, ds));
  const stop = new Date(Date.UTC(ye, me - 1, de));
  while (cur <= stop) {
    out.push(
      `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}-${String(
        cur.getUTCDate(),
      ).padStart(2, '0')}`,
    );
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export interface CalendarDay {
  id: string | null;
  userId: string;
  day: string;
  weekday: number;
  isWorkday: boolean;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number;
  overtimeMinutes: number;
  status: string;
  isLate: boolean;
  source: string | null;
  note: string | null;
  holidayName?: string | null;
}

/** Build a day-by-day month view for one user (records + holiday/leave overlay). */
export async function buildMonth(
  agencyId: string,
  userId: string,
  policy: ResolvedPolicy,
  month: string,
): Promise<CalendarDay[]> {
  const { days, first, last } = monthDays(month);
  const [rows, holidayMap, leaveMap] = await Promise.all([
    db
      .select()
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.agencyId, agencyId),
          eq(attendanceRecords.userId, userId),
          gte(attendanceRecords.day, first),
          lte(attendanceRecords.day, last),
        ),
      ),
    loadHolidayMap(agencyId, first, last),
    loadLeaveDayMap(agencyId, userId, first, last),
  ]);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const todayKey = dayKeyInTz(new Date(), policy.timezone);

  return days.map((day): CalendarDay => {
    const weekday = weekdayForDayKey(day);
    const workday = isWorkingDayKey(policy, day);
    const holidayName = holidayMap.get(day) ?? null;
    const rec = byDay.get(day);

    if (rec && rec.checkInAt) {
      return {
        ...serializeRecord(rec),
        weekday,
        isWorkday: workday,
        holidayName,
      };
    }

    // Known classifications (holiday / leave / weekly-off) show regardless of
    // past/future; only present-vs-absent depends on the date being in the past.
    let status: string;
    if (holidayName) status = 'holiday';
    else if (leaveMap.has(day)) status = 'on_leave';
    else if (!workday) status = 'weekly_off';
    else if (day >= todayKey) status = 'none'; // today (unmarked) or future
    else status = 'absent';

    return {
      id: rec?.id ?? null,
      userId,
      day,
      weekday,
      isWorkday: workday,
      checkInAt: rec ? toIso(rec.checkInAt) : null,
      checkOutAt: rec ? toIso(rec.checkOutAt) : null,
      workedMinutes: rec?.workedMinutes ?? 0,
      overtimeMinutes: rec?.overtimeMinutes ?? 0,
      status,
      isLate: rec?.isLate ?? false,
      source: rec?.source ?? null,
      note: rec?.note ?? null,
      holidayName,
    };
  });
}

/** Count chargeable working days for a leave range (excludes weekly-offs + holidays). */
export async function countLeaveDays(
  agencyId: string,
  policy: ResolvedPolicy,
  startDay: string,
  endDay: string,
  halfDayStart: boolean,
  halfDayEnd: boolean,
): Promise<number> {
  const list = daysInRange(startDay, endDay);
  if (!list.length) return 0;
  const holidayMap = await loadHolidayMap(agencyId, startDay, endDay);
  let count = 0;
  for (const day of list) {
    if (!isWorkingDayKey(policy, day)) continue;
    if (holidayMap.has(day)) continue;
    count += 1;
  }
  if (count <= 0) return 0;
  // Half-day adjustments only apply if the boundary day is itself chargeable.
  const firstChargeable =
    isWorkingDayKey(policy, startDay) && !holidayMap.has(startDay);
  const lastChargeable =
    isWorkingDayKey(policy, endDay) && !holidayMap.has(endDay);
  if (halfDayStart && firstChargeable) count -= 0.5;
  if (halfDayEnd && lastChargeable && startDay !== endDay) count -= 0.5;
  return Math.max(0, count);
}

/** Year bounds ('YYYY-01-01'..'YYYY-12-31'). */
export function yearBounds(year: number): { first: string; last: string } {
  return { first: `${year}-01-01`, last: `${year}-12-31` };
}

export { inArray };
