/**
 * Attendance domain helpers: per-agency policy defaults, timezone-aware day
 * math, status derivation, and punch fencing (IP / geo).
 */
import type { AttendancePolicy } from '../db/schema.js';

export type AttendanceStatus =
  | 'present'
  | 'late'
  | 'half_day'
  | 'absent'
  | 'on_leave'
  | 'holiday'
  | 'weekly_off';

/** Resolved policy shape used across the app (camelCase, never null fields). */
export interface ResolvedPolicy {
  timezone: string;
  workdays: number[]; // 0=Sun..6=Sat
  /** Saturday occurrences (1..5) that are OFF even though Sat is a workday. */
  saturdayOffWeeks: number[];
  shiftStartMin: number;
  shiftEndMin: number;
  fullDayMinutes: number;
  halfDayMinutes: number;
  lateGraceMinutes: number;
  countOvertime: boolean;
  enforceIp: boolean;
  allowedIps: string[];
  enforceGeo: boolean;
  geoLat: number | null;
  geoLng: number | null;
  geoRadiusM: number | null;
}

export const DEFAULT_POLICY: ResolvedPolicy = {
  timezone: 'Asia/Kolkata',
  workdays: [1, 2, 3, 4, 5],
  saturdayOffWeeks: [],
  shiftStartMin: 540,
  shiftEndMin: 1080,
  fullDayMinutes: 480,
  halfDayMinutes: 240,
  lateGraceMinutes: 15,
  countOvertime: true,
  enforceIp: false,
  allowedIps: [],
  enforceGeo: false,
  geoLat: null,
  geoLng: null,
  geoRadiusM: null,
};

function csvToInts(csv: string | null | undefined, fallback: number[]): number[] {
  if (!csv) return fallback;
  const arr = csv
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return arr.length ? Array.from(new Set(arr)).sort() : fallback;
}

function csvToList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Merge a DB policy row (or null) with defaults. */
export function resolvePolicy(
  row: AttendancePolicy | null | undefined,
): ResolvedPolicy {
  if (!row) return { ...DEFAULT_POLICY };
  return {
    timezone: row.timezone || DEFAULT_POLICY.timezone,
    workdays: csvToInts(row.workdaysCsv, DEFAULT_POLICY.workdays),
    saturdayOffWeeks: csvToInts(row.saturdayOffWeeksCsv, []),
    shiftStartMin: row.shiftStartMin ?? DEFAULT_POLICY.shiftStartMin,
    shiftEndMin: row.shiftEndMin ?? DEFAULT_POLICY.shiftEndMin,
    fullDayMinutes: row.fullDayMinutes ?? DEFAULT_POLICY.fullDayMinutes,
    halfDayMinutes: row.halfDayMinutes ?? DEFAULT_POLICY.halfDayMinutes,
    lateGraceMinutes: row.lateGraceMinutes ?? DEFAULT_POLICY.lateGraceMinutes,
    countOvertime: row.countOvertime ?? DEFAULT_POLICY.countOvertime,
    enforceIp: row.enforceIp ?? false,
    allowedIps: csvToList(row.allowedIpsCsv),
    enforceGeo: row.enforceGeo ?? false,
    geoLat: row.geoLat ?? null,
    geoLng: row.geoLng ?? null,
    geoRadiusM: row.geoRadiusM ?? null,
  };
}

// ---- Timezone-aware day math (no external deps; uses Intl) ----

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Local calendar day ('YYYY-MM-DD') for an instant in the given timezone. */
export function dayKeyInTz(date: Date, timezone: string): string {
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Minutes since local midnight for an instant in the given timezone. */
export function minutesIntoDayInTz(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (h % 24) * 60 + m;
}

/** Weekday number (0=Sun..6=Sat) for an instant in the given timezone. */
export function weekdayInTz(date: Date, timezone: string): number {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(date);
  return WEEKDAY_INDEX[wd] ?? date.getUTCDay();
}

/** Weekday (0=Sun..6=Sat) for a 'YYYY-MM-DD' day key (timezone-independent). */
export function weekdayForDayKey(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWorkday(policy: ResolvedPolicy, weekday: number): boolean {
  return policy.workdays.includes(weekday);
}

/** Which occurrence of its weekday a day is within its month (1st..5th). */
export function weekdayOccurrence(day: string): number {
  const dom = Number(day.slice(8, 10));
  return Math.floor((dom - 1) / 7) + 1;
}

/**
 * Is a given 'YYYY-MM-DD' a WORKING day under the policy? Applies the flat
 * weekday list, then carves out the configured "even/odd Saturdays off"
 * (e.g. 2nd & 4th Saturday) when Saturday is otherwise a workday.
 */
export function isWorkingDayKey(policy: ResolvedPolicy, day: string): boolean {
  const weekday = weekdayForDayKey(day);
  if (!policy.workdays.includes(weekday)) return false;
  if (
    weekday === 6 &&
    policy.saturdayOffWeeks.length > 0 &&
    policy.saturdayOffWeeks.includes(weekdayOccurrence(day))
  ) {
    return false;
  }
  return true;
}

export function workedMinutesBetween(
  inAt: Date | null,
  outAt: Date | null,
): number {
  if (!inAt || !outAt) return 0;
  const ms = outAt.getTime() - inAt.getTime();
  return ms > 0 ? Math.round(ms / 60000) : 0;
}

/** Is the check-in late (past shift start + grace)? */
export function isLateCheckIn(
  policy: ResolvedPolicy,
  checkInAt: Date | null,
): boolean {
  if (!checkInAt) return false;
  const mins = minutesIntoDayInTz(checkInAt, policy.timezone);
  return mins > policy.shiftStartMin + policy.lateGraceMinutes;
}

export interface DerivedDay {
  status: AttendanceStatus;
  isLate: boolean;
  workedMinutes: number;
  overtimeMinutes: number;
}

/**
 * Derive a worked/punched day's status. `weeklyOff`/`holiday`/`onLeave`
 * short-circuit. For an in-progress day (no checkout), status is present/late
 * by check-in time; on checkout it settles into present / half_day by hours.
 */
export function deriveDayStatus(
  policy: ResolvedPolicy,
  opts: {
    checkInAt: Date | null;
    checkOutAt: Date | null;
    weeklyOff?: boolean;
    holiday?: boolean;
    onLeave?: boolean;
  },
): DerivedDay {
  if (opts.onLeave) {
    return { status: 'on_leave', isLate: false, workedMinutes: 0, overtimeMinutes: 0 };
  }
  if (opts.holiday) {
    return { status: 'holiday', isLate: false, workedMinutes: 0, overtimeMinutes: 0 };
  }
  if (opts.weeklyOff) {
    return { status: 'weekly_off', isLate: false, workedMinutes: 0, overtimeMinutes: 0 };
  }
  if (!opts.checkInAt) {
    return { status: 'absent', isLate: false, workedMinutes: 0, overtimeMinutes: 0 };
  }

  const isLate = isLateCheckIn(policy, opts.checkInAt);
  const worked = workedMinutesBetween(opts.checkInAt, opts.checkOutAt);
  const overtime =
    policy.countOvertime && worked > policy.fullDayMinutes
      ? worked - policy.fullDayMinutes
      : 0;

  // In progress (no checkout yet).
  if (!opts.checkOutAt) {
    return {
      status: isLate ? 'late' : 'present',
      isLate,
      workedMinutes: worked,
      overtimeMinutes: 0,
    };
  }

  let status: AttendanceStatus;
  if (worked >= policy.fullDayMinutes) status = isLate ? 'late' : 'present';
  else if (worked >= policy.halfDayMinutes) status = 'half_day';
  else status = 'half_day';

  return { status, isLate, workedMinutes: worked, overtimeMinutes: overtime };
}

// ---- Fencing ----

/** IPv4 CIDR / exact match. Returns true if `ip` is allowed by the list. */
export function ipAllowed(ip: string | undefined, allowed: string[]): boolean {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, ''); // unwrap IPv4-mapped IPv6
  for (const entry of allowed) {
    if (!entry.includes('/')) {
      if (entry === clean) return true;
      continue;
    }
    if (ipv4InCidr(clean, entry)) return true;
  }
  return false;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const ipN = ipToInt(ip);
  const baseN = ipToInt(base);
  if (ipN === null || baseN === null || !Number.isInteger(bits)) return false;
  if (bits <= 0) return true;
  if (bits > 32) return false;
  const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

/** Haversine distance in meters between two lat/lng points. */
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Validate a punch against the policy's fencing. Returns an error string or null. */
export function checkFencing(
  policy: ResolvedPolicy,
  ctx: { ip?: string; lat?: number | null; lng?: number | null },
): string | null {
  if (policy.enforceIp && !ipAllowed(ctx.ip, policy.allowedIps)) {
    return 'You can only check in from an approved network.';
  }
  if (policy.enforceGeo) {
    // Sharing your location is mandatory when geo enforcement is on.
    if (ctx.lat == null || ctx.lng == null) {
      return 'Location is required to check in. Please enable location access and try again.';
    }
    // A geo-fence (centre + radius) is an OPTIONAL extra restriction: only
    // enforce distance when one is actually configured.
    if (
      policy.geoLat != null &&
      policy.geoLng != null &&
      policy.geoRadiusM != null
    ) {
      const dist = distanceMeters(
        ctx.lat,
        ctx.lng,
        policy.geoLat,
        policy.geoLng,
      );
      if (dist > policy.geoRadiusM) {
        return 'You are too far from the approved location to check in.';
      }
    }
  }
  return null;
}

/** Format minutes as "8h 30m" / "45m" / "0m". */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
