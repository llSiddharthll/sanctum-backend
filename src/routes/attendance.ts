import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  attendancePolicy,
  attendanceRecords,
  holidays,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { conflict, forbidden, notFound, badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth, isPrivileged } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import { leavesRouter } from './leaves.js';
import { regularizationsRouter } from './regularizations.js';
import {
  dayKeyInTz,
  deriveDayStatus,
  checkFencing,
  isWorkingDayKey,
} from '../lib/attendance.js';
import {
  loadPolicy,
  serializeRecord,
  buildMonth,
  loadHolidayMap,
  loadLeaveDayMap,
  type CalendarDay,
} from '../services/attendance.js';

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);
attendanceRouter.use(requireModuleRW('attendance'));

// Sub-routers (inherit requireAuth + the attendance module gate above).
attendanceRouter.use('/leaves', leavesRouter);
attendanceRouter.use('/regularizations', regularizationsRouter);

function requirePrivileged(req: Request): void {
  const ctx = getAuth(req);
  if (!isPrivileged(ctx.role)) {
    throw forbidden('Only owners/admins can do that.');
  }
}

/** Resolve ?userId (admins only for others). */
function targetUserId(req: Request): string {
  const ctx = getAuth(req);
  const requested = (req.query.userId as string | undefined)?.trim();
  if (requested && requested !== ctx.userId) {
    if (!isPrivileged(ctx.role)) {
      throw forbidden('Only owners/admins can view others’ attendance.');
    }
    return requested;
  }
  return ctx.userId;
}

function summarize(days: CalendarDay[]) {
  const s = {
    present: 0,
    late: 0,
    halfDay: 0,
    absent: 0,
    onLeave: 0,
    holiday: 0,
    weeklyOff: 0,
    workingDays: 0,
    workedMinutes: 0,
    overtimeMinutes: 0,
  };
  for (const d of days) {
    if (d.isWorkday && d.status !== 'none') s.workingDays++;
    s.workedMinutes += d.workedMinutes ?? 0;
    s.overtimeMinutes += d.overtimeMinutes ?? 0;
    switch (d.status) {
      case 'present':
        s.present++;
        break;
      case 'late':
        s.present++;
        s.late++;
        break;
      case 'half_day':
        s.halfDay++;
        break;
      case 'absent':
        s.absent++;
        break;
      case 'on_leave':
        s.onLeave++;
        break;
      case 'holiday':
        s.holiday++;
        break;
      case 'weekly_off':
        s.weeklyOff++;
        break;
    }
  }
  return s;
}

// ============================================================
//  POLICY
// ============================================================
attendanceRouter.get('/policy', async (req, res) => {
  const ctx = getAuth(req);
  ok(res, await loadPolicy(ctx.agencyId));
});

const policySchema = z.object({
  timezone: z.string().min(1).max(64).optional(),
  workdays: z.array(z.number().int().min(0).max(6)).optional(),
  saturdayOffWeeks: z.array(z.number().int().min(1).max(5)).optional(),
  shiftStartMin: z.number().int().min(0).max(1439).optional(),
  shiftEndMin: z.number().int().min(0).max(1439).optional(),
  fullDayMinutes: z.number().int().min(0).max(1440).optional(),
  halfDayMinutes: z.number().int().min(0).max(1440).optional(),
  lateGraceMinutes: z.number().int().min(0).max(240).optional(),
  countOvertime: z.boolean().optional(),
  enforceIp: z.boolean().optional(),
  allowedIps: z.array(z.string().max(64)).optional(),
  enforceGeo: z.boolean().optional(),
  geoLat: z.number().min(-90).max(90).nullable().optional(),
  geoLng: z.number().min(-180).max(180).nullable().optional(),
  geoRadiusM: z.number().int().min(10).max(100000).nullable().optional(),
});

attendanceRouter.put('/policy', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const body = policySchema.parse(req.body);

  const patch: Partial<typeof attendancePolicy.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  if (body.workdays !== undefined)
    patch.workdaysCsv = Array.from(new Set(body.workdays)).sort().join(',');
  if (body.saturdayOffWeeks !== undefined)
    patch.saturdayOffWeeksCsv = Array.from(new Set(body.saturdayOffWeeks))
      .sort()
      .join(',');
  if (body.shiftStartMin !== undefined) patch.shiftStartMin = body.shiftStartMin;
  if (body.shiftEndMin !== undefined) patch.shiftEndMin = body.shiftEndMin;
  if (body.fullDayMinutes !== undefined) patch.fullDayMinutes = body.fullDayMinutes;
  if (body.halfDayMinutes !== undefined) patch.halfDayMinutes = body.halfDayMinutes;
  if (body.lateGraceMinutes !== undefined)
    patch.lateGraceMinutes = body.lateGraceMinutes;
  if (body.countOvertime !== undefined) patch.countOvertime = body.countOvertime;
  if (body.enforceIp !== undefined) patch.enforceIp = body.enforceIp;
  if (body.allowedIps !== undefined)
    patch.allowedIpsCsv = body.allowedIps.map((s) => s.trim()).filter(Boolean).join(',');
  if (body.enforceGeo !== undefined) patch.enforceGeo = body.enforceGeo;
  if (body.geoLat !== undefined) patch.geoLat = body.geoLat;
  if (body.geoLng !== undefined) patch.geoLng = body.geoLng;
  if (body.geoRadiusM !== undefined) patch.geoRadiusM = body.geoRadiusM;

  const [existing] = await db
    .select({ agencyId: attendancePolicy.agencyId })
    .from(attendancePolicy)
    .where(eq(attendancePolicy.agencyId, ctx.agencyId))
    .limit(1);
  if (existing) {
    await db
      .update(attendancePolicy)
      .set(patch)
      .where(eq(attendancePolicy.agencyId, ctx.agencyId));
  } else {
    await db.insert(attendancePolicy).values({ agencyId: ctx.agencyId, ...patch });
  }

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'attendance.policy.update',
    entityType: 'attendance_policy',
    entityId: ctx.agencyId,
    ip: req.ip,
  });
  ok(res, await loadPolicy(ctx.agencyId));
});

// ============================================================
//  TODAY / PUNCH
// ============================================================
attendanceRouter.get('/today', async (req, res) => {
  const ctx = getAuth(req);
  const policy = await loadPolicy(ctx.agencyId);
  const now = new Date();
  const day = dayKeyInTz(now, policy.timezone);
  const [rec] = await db
    .select()
    .from(attendanceRecords)
    .where(
      and(eq(attendanceRecords.userId, ctx.userId), eq(attendanceRecords.day, day)),
    )
    .limit(1);
  ok(res, {
    day,
    serverNow: now.toISOString(),
    timezone: policy.timezone,
    shiftStartMin: policy.shiftStartMin,
    shiftEndMin: policy.shiftEndMin,
    fullDayMinutes: policy.fullDayMinutes,
    enforceGeo: policy.enforceGeo,
    record: rec ? serializeRecord(rec) : null,
  });
});

const punchSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

attendanceRouter.post('/check-in', async (req, res) => {
  const ctx = getAuth(req);
  const body = punchSchema.parse(req.body ?? {});
  const policy = await loadPolicy(ctx.agencyId);
  const now = new Date();
  const day = dayKeyInTz(now, policy.timezone);

  const fenceErr = checkFencing(policy, {
    ip: req.ip,
    lat: body.lat ?? null,
    lng: body.lng ?? null,
  });
  if (fenceErr) throw forbidden(fenceErr);

  const [existing] = await db
    .select()
    .from(attendanceRecords)
    .where(
      and(eq(attendanceRecords.userId, ctx.userId), eq(attendanceRecords.day, day)),
    )
    .limit(1);
  if (existing && existing.checkInAt) {
    throw conflict('You have already checked in today.');
  }

  const derived = deriveDayStatus(policy, { checkInAt: now, checkOutAt: null });
  const values = {
    checkInAt: now,
    status: derived.status,
    isLate: derived.isLate,
    source: 'self' as const,
    checkInIp: req.ip ?? null,
    checkInLat: body.lat ?? null,
    checkInLng: body.lng ?? null,
    updatedAt: now,
  };

  let row;
  if (existing) {
    [row] = await db
      .update(attendanceRecords)
      .set(values)
      .where(eq(attendanceRecords.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(attendanceRecords)
      .values({
        id: newId('att'),
        agencyId: ctx.agencyId,
        userId: ctx.userId,
        day,
        ...values,
      })
      .returning();
  }

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'attendance.check_in',
    entityType: 'attendance',
    entityId: row!.id,
    metadata: { day, late: derived.isLate },
    ip: req.ip,
  });
  created(res, serializeRecord(row!));
});

attendanceRouter.post('/check-out', async (req, res) => {
  const ctx = getAuth(req);
  const policy = await loadPolicy(ctx.agencyId);
  const now = new Date();
  const day = dayKeyInTz(now, policy.timezone);

  const [rec] = await db
    .select()
    .from(attendanceRecords)
    .where(
      and(eq(attendanceRecords.userId, ctx.userId), eq(attendanceRecords.day, day)),
    )
    .limit(1);
  if (!rec || !rec.checkInAt) throw conflict('You have not checked in today.');
  if (rec.checkOutAt) throw conflict('You have already checked out today.');

  const derived = deriveDayStatus(policy, {
    checkInAt: rec.checkInAt,
    checkOutAt: now,
  });
  const [row] = await db
    .update(attendanceRecords)
    .set({
      checkOutAt: now,
      workedMinutes: derived.workedMinutes,
      overtimeMinutes: derived.overtimeMinutes,
      status: derived.status,
      isLate: derived.isLate,
      updatedAt: now,
    })
    .where(eq(attendanceRecords.id, rec.id))
    .returning();

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'attendance.check_out',
    entityType: 'attendance',
    entityId: rec.id,
    metadata: { day, workedMinutes: derived.workedMinutes },
    ip: req.ip,
  });
  ok(res, serializeRecord(row!));
});

// ============================================================
//  CALENDAR / SUMMARY
// ============================================================
attendanceRouter.get('/calendar', async (req, res) => {
  const ctx = getAuth(req);
  const month = (req.query.month as string | undefined) ?? '';
  const userId = targetUserId(req);
  const policy = await loadPolicy(ctx.agencyId);
  let days: CalendarDay[];
  try {
    days = await buildMonth(ctx.agencyId, userId, policy, month);
  } catch {
    throw badRequest('month must be YYYY-MM.');
  }
  ok(res, {
    month,
    userId,
    timezone: policy.timezone,
    today: dayKeyInTz(new Date(), policy.timezone),
    days,
  });
});

attendanceRouter.get('/summary', async (req, res) => {
  const ctx = getAuth(req);
  const month = (req.query.month as string | undefined) ?? '';
  const userId = targetUserId(req);
  const policy = await loadPolicy(ctx.agencyId);
  let days: CalendarDay[];
  try {
    days = await buildMonth(ctx.agencyId, userId, policy, month);
  } catch {
    throw badRequest('month must be YYYY-MM.');
  }
  ok(res, { month, userId, summary: summarize(days) });
});

// ============================================================
//  HOLIDAYS (admin-managed, agency-wide)
// ============================================================
attendanceRouter.get('/holidays', async (req, res) => {
  const ctx = getAuth(req);
  const year = Number(req.query.year) || new Date().getFullYear();
  const rows = await db
    .select()
    .from(holidays)
    .where(eq(holidays.agencyId, ctx.agencyId))
    .orderBy(holidays.day);
  ok(
    res,
    rows
      .filter((h) => h.day.startsWith(String(year)))
      .map((h) => ({
        id: h.id,
        day: h.day,
        name: h.name,
        recurring: h.recurring,
        createdAt: toIso(h.createdAt),
      })),
  );
});

const holidaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string().trim().min(1).max(120),
  recurring: z.boolean().optional(),
});

attendanceRouter.post('/holidays', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const body = holidaySchema.parse(req.body);

  const [existing] = await db
    .select({ id: holidays.id })
    .from(holidays)
    .where(and(eq(holidays.agencyId, ctx.agencyId), eq(holidays.day, body.day)))
    .limit(1);
  if (existing) throw conflict('A holiday already exists on that date.');

  const id = newId('hol');
  await db.insert(holidays).values({
    id,
    agencyId: ctx.agencyId,
    day: body.day,
    name: body.name,
    recurring: body.recurring ?? false,
    createdBy: ctx.userId,
  });
  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'attendance.holiday.create',
    entityType: 'holiday',
    entityId: id,
    metadata: { day: body.day, name: body.name },
    ip: req.ip,
  });
  created(res, {
    id,
    day: body.day,
    name: body.name,
    recurring: body.recurring ?? false,
  });
});

attendanceRouter.delete('/holidays/:id', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const id = param(req, 'id');
  await db
    .delete(holidays)
    .where(and(eq(holidays.id, id), eq(holidays.agencyId, ctx.agencyId)));
  ok(res, { deleted: true });
});

// ============================================================
//  ADMIN — mark / override a user's day
// ============================================================
const markSchema = z.object({
  userId: z.string().min(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z
    .enum(['present', 'late', 'half_day', 'absent', 'on_leave', 'holiday', 'weekly_off'])
    .optional(),
  checkInAt: z.coerce.date().optional(),
  checkOutAt: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
});

attendanceRouter.post('/mark', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const body = markSchema.parse(req.body);
  const policy = await loadPolicy(ctx.agencyId);

  const [member] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, body.userId), eq(users.agencyId, ctx.agencyId)))
    .limit(1);
  if (!member) throw notFound('Member not found.');

  const [existing] = await db
    .select()
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.userId, body.userId),
        eq(attendanceRecords.day, body.day),
      ),
    )
    .limit(1);

  const checkInAt = body.checkInAt ?? existing?.checkInAt ?? null;
  const checkOutAt = body.checkOutAt ?? existing?.checkOutAt ?? null;
  const derived = deriveDayStatus(policy, {
    checkInAt,
    checkOutAt,
    onLeave: body.status === 'on_leave',
    holiday: body.status === 'holiday',
    weeklyOff: body.status === 'weekly_off',
  });
  const status = body.status ?? derived.status;
  const now = new Date();

  let row;
  if (existing) {
    [row] = await db
      .update(attendanceRecords)
      .set({
        checkInAt,
        checkOutAt,
        status,
        isLate: derived.isLate,
        workedMinutes: derived.workedMinutes,
        overtimeMinutes: derived.overtimeMinutes,
        source: 'admin',
        note: body.note ?? existing.note,
        updatedAt: now,
      })
      .where(eq(attendanceRecords.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(attendanceRecords)
      .values({
        id: newId('att'),
        agencyId: ctx.agencyId,
        userId: body.userId,
        day: body.day,
        checkInAt,
        checkOutAt,
        status,
        isLate: derived.isLate,
        workedMinutes: derived.workedMinutes,
        overtimeMinutes: derived.overtimeMinutes,
        source: 'admin',
        note: body.note ?? null,
      })
      .returning();
  }

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'attendance.mark',
    entityType: 'attendance',
    entityId: row!.id,
    metadata: { userId: body.userId, day: body.day, status },
    ip: req.ip,
  });
  ok(res, serializeRecord(row!));
});

// ============================================================
//  TEAM — who's in today + monthly rollups (admin)
// ============================================================
attendanceRouter.get('/whos-in', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const policy = await loadPolicy(ctx.agencyId);
  const today = dayKeyInTz(new Date(), policy.timezone);

  const members = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.agencyId, ctx.agencyId), eq(users.status, 'active')));

  const recs = await db
    .select()
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.agencyId, ctx.agencyId),
        eq(attendanceRecords.day, today),
      ),
    );
  const byUser = new Map(recs.map((r) => [r.userId, r]));
  const holidayMap = await loadHolidayMap(ctx.agencyId, today, today);
  const isHoliday = holidayMap.has(today);
  const workday = isWorkingDayKey(policy, today);

  const rows = await Promise.all(
    members.map(async (m) => {
      const rec = byUser.get(m.id);
      let status: string;
      if (rec) status = rec.status;
      else if (isHoliday) status = 'holiday';
      else {
        const leaveMap = await loadLeaveDayMap(ctx.agencyId, m.id, today, today);
        if (leaveMap.has(today)) status = 'on_leave';
        else if (!workday) status = 'weekly_off';
        else status = 'absent';
      }
      return {
        userId: m.id,
        name: m.fullName ?? m.email,
        status,
        checkInAt: rec ? toIso(rec.checkInAt) : null,
        checkOutAt: rec ? toIso(rec.checkOutAt) : null,
        workedMinutes: rec?.workedMinutes ?? 0,
        isLate: rec?.isLate ?? false,
      };
    }),
  );
  ok(res, { day: today, members: rows });
});

attendanceRouter.get('/team-summary', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const month = (req.query.month as string | undefined) ?? '';
  const policy = await loadPolicy(ctx.agencyId);

  const members = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.agencyId, ctx.agencyId), eq(users.status, 'active')));

  let rows;
  try {
    rows = await Promise.all(
      members.map(async (m) => ({
        userId: m.id,
        name: m.fullName ?? m.email,
        summary: summarize(await buildMonth(ctx.agencyId, m.id, policy, month)),
      })),
    );
  } catch {
    throw badRequest('month must be YYYY-MM.');
  }
  ok(res, { month, members: rows });
});
