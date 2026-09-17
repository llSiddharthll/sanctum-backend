import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  attendanceCheckoutRequests,
  attendancePolicy,
  attendanceRecords,
  holidays,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { conflict, forbidden, notFound, badRequest } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import {
  buildAgencyReports,
  emailEmployeeReports,
} from '../services/reports.js';
import { notify, notifyPermissionHolders } from '../services/notifications.js';
import { authenticate, getStaffActor, requires, requiresAny } from '../authz/http.js';
import { authorize, canOrg, check } from '../authz/engine.js';
import type { StaffActor } from '../authz/actor.js';
import {
  assertCanManageSubject,
  assertCancelAllowed,
  decideCondition,
  manageableUserIds,
  requestCapabilities,
  requireStaffSubject,
  resolveSubjectForRead,
  subjectFacts,
  subjectScopeFilter,
} from '../authz/policies/attendance.js';
import { leavesRouter } from './leaves.js';
import { regularizationsRouter } from './regularizations.js';
import { stopTimersForUser } from './timers.js';
import {
  dayKeyInTz,
  deriveDayStatus,
  checkFencing,
  distanceMeters,
  isWorkingDayKey,
  type ResolvedPolicy,
} from '../lib/attendance.js';
import {
  loadPolicy,
  serializeRecord,
  buildMonth,
  daysInRange,
  loadHolidayMap,
  loadLeaveDayMap,
  autoResetStalePunches,
  type CalendarDay,
} from '../services/attendance.js';

export const attendanceRouter = Router();
attendanceRouter.use(authenticate);

// Sub-routers (inherit authentication; each route declares its permission).
attendanceRouter.use('/leaves', leavesRouter);
attendanceRouter.use('/regularizations', regularizationsRouter);

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

/**
 * Policy as seen by the actor. Network allowlist and office coordinates are
 * `attendance.manage_policy` data; everyone else gets what the punch UX needs
 * (hours, workdays, whether IP/geo are enforced, whether an office fence
 * exists). Fencing itself is always validated server-side.
 */
function policyView(actor: StaffActor, policy: ResolvedPolicy) {
  const manage = canOrg(actor, 'attendance.manage_policy');
  const hasGeoFence =
    policy.geoLat != null && policy.geoLng != null && policy.geoRadiusM != null;
  const capabilities = { 'attendance.manage_policy': manage };
  if (manage) return { ...policy, hasGeoFence, capabilities };
  return {
    ...policy,
    allowedIps: [] as string[],
    geoLat: null,
    geoLng: null,
    geoRadiusM: null,
    hasGeoFence,
    capabilities,
  };
}

attendanceRouter.get(
  '/policy',
  requiresAny('attendance.check_in', 'attendance.view', 'attendance.manage_policy'),
  async (req, res) => {
    const actor = getStaffActor(req);
    ok(res, policyView(actor, await loadPolicy(actor.agencyId)));
  },
);

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

attendanceRouter.put('/policy', requires('attendance.manage_policy'), async (req, res) => {
  const actor = getStaffActor(req);
  if (!canOrg(actor, 'attendance.manage_policy')) throw forbidden();
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
    .where(eq(attendancePolicy.agencyId, actor.agencyId))
    .limit(1);
  if (existing) {
    await db
      .update(attendancePolicy)
      .set(patch)
      .where(eq(attendancePolicy.agencyId, actor.agencyId));
  } else {
    await db.insert(attendancePolicy).values({ agencyId: actor.agencyId, ...patch });
  }

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'attendance.policy.update',
    entityType: 'attendance_policy',
    entityId: actor.agencyId,
    metadata: { fields: Object.keys(body) },
    ip: req.ip,
  });
  ok(res, policyView(actor, await loadPolicy(actor.agencyId)));
});

// ============================================================
//  TODAY / PUNCH (own)
// ============================================================

// Read-only: stale punches from past days are settled on check-in/check-out
// (write paths), never here.
attendanceRouter.get(
  '/today',
  requiresAny('attendance.check_in', 'attendance.view'),
  async (req, res) => {
    const actor = getStaffActor(req);
    const policy = await loadPolicy(actor.agencyId);
    const now = new Date();
    const day = dayKeyInTz(now, policy.timezone);
    const [rec] = await db
      .select()
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.agencyId, actor.agencyId),
          eq(attendanceRecords.userId, actor.userId),
          eq(attendanceRecords.day, day),
        ),
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
  },
);

const punchSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  // Human-readable area resolved on the client (reverse-geocoded from coords).
  location: z.string().max(200).optional(),
});

// Check-out also accepts an optional reason, attached to a checkout REQUEST when
// the punch lands outside the office geofence (held for approval).
const checkOutSchema = punchSchema.extend({
  reason: z.string().trim().max(500).optional(),
});

attendanceRouter.post('/check-in', requires('attendance.check_in'), async (req, res) => {
  const actor = getStaffActor(req);
  authorize(actor, 'attendance.check_in', subjectFacts(actor.agencyId, actor.userId));
  const body = punchSchema.parse(req.body ?? {});
  const policy = await loadPolicy(actor.agencyId);

  // Settle any stale unclosed punches from previous days (after 12 AM).
  await autoResetStalePunches(actor.agencyId, actor.userId, policy.timezone);

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
      and(
        eq(attendanceRecords.agencyId, actor.agencyId),
        eq(attendanceRecords.userId, actor.userId),
        eq(attendanceRecords.day, day),
      ),
    )
    .limit(1);
  // Already checked in and STILL working (not checked out) → nothing to do.
  if (existing && existing.checkInAt && !existing.checkOutAt) {
    throw conflict('You are already checked in today.');
  }

  // Re-check-in: someone who checked out (often by mistake) can clock back in
  // the same day. We keep the ORIGINAL check-in time, wipe the (mistaken)
  // check-out, and re-open the day so worked time keeps accruing.
  const reopening = !!(existing && existing.checkInAt && existing.checkOutAt);
  const checkInAt = reopening ? existing!.checkInAt! : now;
  const derived = deriveDayStatus(policy, { checkInAt, checkOutAt: null });
  const values = {
    checkInAt,
    checkOutAt: null,
    checkOutIp: null,
    checkOutLat: null,
    checkOutLng: null,
    checkOutLocation: null,
    workedMinutes: 0,
    overtimeMinutes: 0,
    status: derived.status,
    isLate: derived.isLate,
    source: 'self' as const,
    checkInIp: req.ip ?? null,
    checkInLat: body.lat ?? null,
    checkInLng: body.lng ?? null,
    checkInLocation: body.location ?? null,
    updatedAt: now,
  };

  let row;
  if (existing) {
    [row] = await db
      .update(attendanceRecords)
      .set(values)
      .where(and(eq(attendanceRecords.id, existing.id), eq(attendanceRecords.agencyId, actor.agencyId)))
      .returning();
  } else {
    [row] = await db
      .insert(attendanceRecords)
      .values({
        id: newId('att'),
        agencyId: actor.agencyId,
        userId: actor.userId,
        day,
        ...values,
      })
      .returning();
  }

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'attendance.check_in',
    entityType: 'attendance',
    entityId: row!.id,
    metadata: { day, late: derived.isLate, reopened: reopening },
    ip: req.ip,
  });
  created(res, serializeRecord(row!));
});

attendanceRouter.post('/check-out', requires('attendance.check_in'), async (req, res) => {
  const actor = getStaffActor(req);
  authorize(actor, 'attendance.check_in', subjectFacts(actor.agencyId, actor.userId));
  const body = checkOutSchema.parse(req.body ?? {});
  const policy = await loadPolicy(actor.agencyId);

  // Settle any stale unclosed punches from previous days (after 12 AM).
  await autoResetStalePunches(actor.agencyId, actor.userId, policy.timezone);

  const now = new Date();
  const day = dayKeyInTz(now, policy.timezone);

  const [rec] = await db
    .select()
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.agencyId, actor.agencyId),
        eq(attendanceRecords.userId, actor.userId),
        eq(attendanceRecords.day, day),
      ),
    )
    .limit(1);
  if (!rec || !rec.checkInAt) throw conflict('You have not checked in today.');
  if (rec.checkOutAt) throw conflict('You have already checked out today.');

  // Out-of-office checkout → hold for approval. When geo is enforced and an
  // office fence (centre + radius) is configured, a checkout from OUTSIDE that
  // radius is NOT finalized immediately: it is captured as a pending request
  // that a `checkout_requests.approve` holder decides.
  const officeConfigured =
    policy.enforceGeo &&
    policy.geoLat != null &&
    policy.geoLng != null &&
    policy.geoRadiusM != null;

  if (officeConfigured) {
    // Sharing location is mandatory to determine whether you're at the office.
    if (body.lat == null || body.lng == null) {
      throw forbidden(
        'Location is required to check out. Please enable location access and try again.',
      );
    }
    const distanceM = Math.round(
      distanceMeters(body.lat, body.lng, policy.geoLat!, policy.geoLng!),
    );
    if (distanceM > policy.geoRadiusM!) {
      // Creating the hold-for-approval request is its own (own-scope) permission.
      authorize(
        actor,
        'checkout_requests.request',
        subjectFacts(actor.agencyId, actor.userId),
        { message: "You're outside the office and can't request an out-of-office checkout." },
      );
      // De-dupe: if a pending request already exists for today, echo it back
      // instead of stacking duplicates.
      const [dupe] = await db
        .select({ id: attendanceCheckoutRequests.id })
        .from(attendanceCheckoutRequests)
        .where(
          and(
            eq(attendanceCheckoutRequests.agencyId, actor.agencyId),
            eq(attendanceCheckoutRequests.userId, actor.userId),
            eq(attendanceCheckoutRequests.day, day),
            eq(attendanceCheckoutRequests.status, 'pending'),
          ),
        )
        .limit(1);
      if (dupe) {
        ok(
          res,
          {
            pending: true,
            alreadyRequested: true,
            distanceM,
            requestId: dupe.id,
            record: serializeRecord(rec),
          },
          202,
        );
        return;
      }

      const reqId = newId('cor');
      await db.insert(attendanceCheckoutRequests).values({
        id: reqId,
        agencyId: actor.agencyId,
        userId: actor.userId,
        day,
        requestedCheckOutAt: now,
        checkOutLat: body.lat,
        checkOutLng: body.lng,
        checkOutLocation: body.location ?? null,
        distanceM,
        reason: body.reason ?? null,
        status: 'pending',
      });

      await audit({
        agencyId: actor.agencyId,
        actorType: actor.type,
        actorId: actor.userId,
        action: 'attendance.checkout_request.create',
        entityType: 'attendance_checkout_request',
        entityId: reqId,
        metadata: { day, distanceM },
        ip: req.ip,
      });

      const me = await displayName(actor.agencyId, actor.userId);
      await notifyPermissionHolders(
        actor.agencyId,
        'checkout_requests.approve',
        {
          agencyId: actor.agencyId,
          type: 'attendance.checkout.requested',
          title: 'Out-of-office checkout',
          body: `${me ?? 'A member'} checked out ${distanceM}m from the office and needs approval.`,
          entityType: 'attendance_checkout_request',
          entityId: reqId,
          link: '/attendance',
        },
        { excludeUserId: actor.userId },
      );

      ok(
        res,
        {
          pending: true,
          distanceM,
          requestId: reqId,
          record: serializeRecord(rec),
        },
        202,
      );
      return;
    }
  }

  // Inside the office radius (or geo not enforced) → finalize the checkout now.
  const derived = deriveDayStatus(policy, {
    checkInAt: rec.checkInAt,
    checkOutAt: now,
  });
  const [row] = await db
    .update(attendanceRecords)
    .set({
      checkOutAt: now,
      checkOutIp: req.ip ?? null,
      checkOutLat: body.lat ?? null,
      checkOutLng: body.lng ?? null,
      checkOutLocation: body.location ?? null,
      workedMinutes: derived.workedMinutes,
      overtimeMinutes: derived.overtimeMinutes,
      status: derived.status,
      isLate: derived.isLate,
      updatedAt: now,
    })
    .where(and(eq(attendanceRecords.id, rec.id), eq(attendanceRecords.agencyId, actor.agencyId)))
    .returning();

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'attendance.check_out',
    entityType: 'attendance',
    entityId: rec.id,
    metadata: { day, workedMinutes: derived.workedMinutes },
    ip: req.ip,
  });

  // Auto-close the actor's OWN task timers left running — bill them only up to
  // checkout so a forgotten timer never over-counts.
  await stopTimersForUser(actor, actor.userId, now).catch(() => undefined);

  ok(res, serializeRecord(row!));
});

async function displayName(agencyId: string, userId: string): Promise<string | null> {
  const [u] = await db
    .select({ name: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.agencyId, agencyId)))
    .limit(1);
  return u?.name ?? u?.email ?? null;
}

// ============================================================
//  CALENDAR / SUMMARY (own; someone else needs attendance.view organization)
// ============================================================
attendanceRouter.get('/calendar', requires('attendance.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const month = (req.query.month as string | undefined) ?? '';
  const userId = await resolveSubjectForRead(actor, 'attendance.view', req.query.userId as string | undefined);
  const policy = await loadPolicy(actor.agencyId);
  let days: CalendarDay[];
  try {
    days = await buildMonth(actor.agencyId, userId, policy, month);
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

attendanceRouter.get('/summary', requires('attendance.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const month = (req.query.month as string | undefined) ?? '';
  const userId = await resolveSubjectForRead(actor, 'attendance.view', req.query.userId as string | undefined);
  const policy = await loadPolicy(actor.agencyId);
  let days: CalendarDay[];
  try {
    days = await buildMonth(actor.agencyId, userId, policy, month);
  } catch {
    throw badRequest('month must be YYYY-MM.');
  }
  ok(res, { month, userId, summary: summarize(days) });
});

// ============================================================
//  HOLIDAYS (agency-wide)
// ============================================================
attendanceRouter.get(
  '/holidays',
  requiresAny('attendance.check_in', 'attendance.view', 'leaves.request', 'holidays.manage'),
  async (req, res) => {
    const actor = getStaffActor(req);
    const year = Number(req.query.year) || new Date().getFullYear();
    const rows = await db
      .select()
      .from(holidays)
      .where(eq(holidays.agencyId, actor.agencyId))
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
  },
);

const holidaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string().trim().min(1).max(120),
  recurring: z.boolean().optional(),
});

attendanceRouter.post('/holidays', requires('holidays.manage'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = holidaySchema.parse(req.body);

  const [existing] = await db
    .select({ id: holidays.id })
    .from(holidays)
    .where(and(eq(holidays.agencyId, actor.agencyId), eq(holidays.day, body.day)))
    .limit(1);
  if (existing) throw conflict('A holiday already exists on that date.');

  const id = newId('hol');
  await db.insert(holidays).values({
    id,
    agencyId: actor.agencyId,
    day: body.day,
    name: body.name,
    recurring: body.recurring ?? false,
    createdBy: actor.userId,
  });
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
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

attendanceRouter.delete('/holidays/:id', requires('holidays.manage'), async (req, res) => {
  const actor = getStaffActor(req);
  const id = param(req, 'id');
  const [h] = await db
    .select()
    .from(holidays)
    .where(and(eq(holidays.id, id), eq(holidays.agencyId, actor.agencyId)))
    .limit(1);
  if (!h) throw notFound('Holiday not found.');
  await db
    .delete(holidays)
    .where(and(eq(holidays.id, id), eq(holidays.agencyId, actor.agencyId)));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'attendance.holiday.delete',
    entityType: 'holiday',
    entityId: id,
    metadata: { day: h.day, name: h.name },
    ip: req.ip,
  });
  ok(res, { deleted: true });
});

// ============================================================
//  MARK / override someone ELSE's day (never own; target manageable)
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

attendanceRouter.post('/mark', requires('attendance.mark'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = markSchema.parse(req.body);
  if (body.userId === actor.userId) {
    throw forbidden("You can't mark or override your own attendance.");
  }
  await requireStaffSubject(actor, body.userId);
  authorize(actor, 'attendance.mark', subjectFacts(actor.agencyId, body.userId));
  await assertCanManageSubject(actor, body.userId);
  const policy = await loadPolicy(actor.agencyId);

  const [existing] = await db
    .select()
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.agencyId, actor.agencyId),
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
      .where(and(eq(attendanceRecords.id, existing.id), eq(attendanceRecords.agencyId, actor.agencyId)))
      .returning();
  } else {
    [row] = await db
      .insert(attendanceRecords)
      .values({
        id: newId('att'),
        agencyId: actor.agencyId,
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
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'attendance.mark',
    entityType: 'attendance',
    entityId: row!.id,
    metadata: {
      userId: body.userId,
      day: body.day,
      status,
      before: existing
        ? { status: existing.status, checkInAt: toIso(existing.checkInAt), checkOutAt: toIso(existing.checkOutAt) }
        : null,
    },
    ip: req.ip,
  });
  ok(res, serializeRecord(row!));
});

// ============================================================
//  TEAM — who's in today + monthly rollups
// ============================================================
function activeStaffOf(agencyId: string) {
  return db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.agencyId, agencyId), eq(users.status, 'active'), eq(users.kind, 'staff')));
}

attendanceRouter.get('/whos-in', requires('attendance.view_live'), async (req, res) => {
  const actor = getStaffActor(req);
  if (!canOrg(actor, 'attendance.view_live')) throw forbidden();
  const policy = await loadPolicy(actor.agencyId);
  const today = dayKeyInTz(new Date(), policy.timezone);

  const members = await activeStaffOf(actor.agencyId);

  const recs = await db
    .select()
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.agencyId, actor.agencyId),
        eq(attendanceRecords.day, today),
      ),
    );
  const byUser = new Map(recs.map((r) => [r.userId, r]));
  const holidayMap = await loadHolidayMap(actor.agencyId, today, today);
  const isHoliday = holidayMap.has(today);
  const workday = isWorkingDayKey(policy, today);

  const rows = await Promise.all(
    members.map(async (m) => {
      const rec = byUser.get(m.id);
      let status: string;
      if (rec) status = rec.status;
      else if (isHoliday) status = 'holiday';
      else {
        const leaveMap = await loadLeaveDayMap(actor.agencyId, m.id, today, today);
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
        checkInLocation: rec?.checkInLocation ?? null,
        checkOutLocation: rec?.checkOutLocation ?? null,
      };
    }),
  );
  ok(res, { day: today, members: rows });
});

// Organization view with attendance.view_reports or attendance.view (org);
// an own-scope attendance.view holder gets only their own row.
attendanceRouter.get(
  '/team-summary',
  requiresAny('attendance.view_reports', 'attendance.view'),
  async (req, res) => {
    const actor = getStaffActor(req);
    const month = (req.query.month as string | undefined) ?? '';
    const policy = await loadPolicy(actor.agencyId);

    const allRows = canOrg(actor, 'attendance.view_reports') || canOrg(actor, 'attendance.view');
    const members = (await activeStaffOf(actor.agencyId)).filter(
      (m) => allRows || check(actor, 'attendance.view', subjectFacts(actor.agencyId, m.id)),
    );

    let rows;
    try {
      rows = await Promise.all(
        members.map(async (m) => ({
          userId: m.id,
          name: m.fullName ?? m.email,
          summary: summarize(await buildMonth(actor.agencyId, m.id, policy, month)),
        })),
      );
    } catch {
      throw badRequest('month must be YYYY-MM.');
    }
    ok(res, { month, members: rows });
  },
);

// ============================================================
//  RANGE REPORT — per-employee attendance + time + tasks + utilization over a
//  [from,to] range. Defaults to 1st-of-current-month → today.
// ============================================================
function resolveRange(
  fromRaw: unknown,
  toRaw: unknown,
  maxDays: number,
): { from: string; to: string } {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const okDay = (v: unknown) =>
    typeof v === 'string' && DAY.test(v) ? v : null;
  const now = new Date();
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(
    2,
    '0',
  )}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = okDay(fromRaw) ?? monthStart;
  const to = okDay(toRaw) ?? today;
  if (from > to) throw badRequest('from must be on or before to.');
  if (daysInRange(from, to).length > maxDays) {
    throw badRequest(`The range can span at most ${maxDays} days.`);
  }
  return { from, to };
}

attendanceRouter.get('/team-report', requires('attendance.view_reports'), async (req, res) => {
  const actor = getStaffActor(req);
  const { from, to } = resolveRange(req.query.from, req.query.to, 366);
  const reports = await buildAgencyReports(actor, from, to);
  // Cross-module data: time & utilization need time_logs.view, task counts
  // need tasks.view (organization). Masked to null otherwise.
  const seeTime = canOrg(actor, 'time_logs.view');
  const seeTasks = canOrg(actor, 'tasks.view');
  const members = reports.map((r) => ({
    ...r,
    timeMinutes: seeTime ? r.timeMinutes : null,
    utilizationPct: seeTime ? r.utilizationPct : null,
    tasks: seeTasks ? r.tasks : null,
  }));
  ok(res, { from, to, members });
});

// POST /attendance/email-reports {from?,to?} — email each employee their report
// + a combined overview to report holders. Range ≤ 31 days.
attendanceRouter.post(
  '/email-reports',
  requires('attendance.email_reports', 'attendance.view_reports'),
  async (req, res) => {
    const actor = getStaffActor(req);
    const body = (req.body ?? {}) as { from?: unknown; to?: unknown };
    const { from, to } = resolveRange(body.from, body.to, 31);
    const result = await emailEmployeeReports(actor, from, to);
    await audit({
      agencyId: actor.agencyId,
      actorType: actor.type,
      actorId: actor.userId,
      action: 'attendance.reports.emailed',
      entityType: 'agency',
      entityId: actor.agencyId,
      metadata: { from, to, ...result },
      ip: req.ip,
    });
    ok(res, { from, to, ...result });
  },
);

// ============================================================
//  CHECKOUT REQUESTS — out-of-office checkouts awaiting approval
// ============================================================
type CheckoutRow = typeof attendanceCheckoutRequests.$inferSelect;

function serializeCheckoutRequest(
  actor: StaffActor,
  r: CheckoutRow,
  manageable: boolean,
  userName?: string | null,
) {
  return {
    id: r.id,
    userId: r.userId,
    userName: userName ?? null,
    day: r.day,
    requestedCheckOutAt: toIso(r.requestedCheckOutAt),
    checkOutLat: r.checkOutLat,
    checkOutLng: r.checkOutLng,
    checkOutLocation: r.checkOutLocation,
    distanceM: r.distanceM,
    reason: r.reason,
    status: r.status,
    decidedBy: r.decidedBy,
    decidedAt: toIso(r.decidedAt),
    decisionNote: r.decisionNote,
    createdAt: toIso(r.createdAt),
    capabilities: requestCapabilities('checkout_requests', actor, r, manageable),
  };
}

async function loadCheckoutRequest(actor: StaffActor, id: string): Promise<CheckoutRow> {
  const [row] = await db
    .select()
    .from(attendanceCheckoutRequests)
    .where(
      and(
        eq(attendanceCheckoutRequests.id, id),
        eq(attendanceCheckoutRequests.agencyId, actor.agencyId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Request not found.');
  return row;
}

async function isManageableSubject(actor: StaffActor, userId: string): Promise<boolean> {
  return (await manageableUserIds(actor, [userId])).has(userId);
}

// GET /checkout-requests — mine by default; ?scope=all|pending lists what the
// actor may view (own → own rows; organization → everyone's).
attendanceRouter.get('/checkout-requests', requires('checkout_requests.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const scope = (req.query.scope as string | undefined) ?? 'me';
  const filters = [eq(attendanceCheckoutRequests.agencyId, actor.agencyId)];
  if (scope === 'all' || scope === 'pending') {
    filters.push(subjectScopeFilter(actor, 'checkout_requests.view', attendanceCheckoutRequests.userId));
    if (scope === 'pending') filters.push(eq(attendanceCheckoutRequests.status, 'pending'));
    const reqUser = (req.query.userId as string | undefined)?.trim();
    if (reqUser) {
      await resolveSubjectForRead(actor, 'checkout_requests.view', reqUser);
      filters.push(eq(attendanceCheckoutRequests.userId, reqUser));
    }
  } else {
    filters.push(eq(attendanceCheckoutRequests.userId, actor.userId));
  }
  const rows = await db
    .select({
      r: attendanceCheckoutRequests,
      userName: users.fullName,
      userEmail: users.email,
    })
    .from(attendanceCheckoutRequests)
    .leftJoin(users, eq(users.id, attendanceCheckoutRequests.userId))
    .where(and(...filters))
    .orderBy(desc(attendanceCheckoutRequests.createdAt))
    .limit(200);
  const manageable =
    canOrg(actor, 'checkout_requests.approve') || canOrg(actor, 'checkout_requests.cancel')
      ? await manageableUserIds(actor, rows.map((x) => (x.r as CheckoutRow).userId))
      : new Set<string>();
  ok(
    res,
    rows.map((x) =>
      serializeCheckoutRequest(actor, x.r, manageable.has((x.r as CheckoutRow).userId), x.userName ?? x.userEmail),
    ),
  );
});

const decideCheckoutSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
  // When approving, credit the whole shift regardless of the actual punch-out
  // time (e.g. a shoot that wrapped off-site). Defaults ON per the agency
  // policy that an approved out-of-office day counts as full-time work.
  creditFullDay: z.boolean().optional().default(true),
});

// POST /checkout-requests/:id/decide — approve (finalize the checkout) / reject.
attendanceRouter.post(
  '/checkout-requests/:id/decide',
  requires('checkout_requests.approve'),
  async (req, res) => {
    const actor = getStaffActor(req);
    const id = param(req, 'id');
    const body = decideCheckoutSchema.parse(req.body);

    const reqRow = await loadCheckoutRequest(actor, id);
    const manageable = await isManageableSubject(actor, reqRow.userId);
    authorize(actor, 'checkout_requests.approve', subjectFacts(actor.agencyId, reqRow.userId), {
      view: 'checkout_requests.view',
      condition: () => decideCondition(actor, reqRow, manageable),
    });
    if (reqRow.status !== 'pending') throw conflict('This request was already decided.');

    const now = new Date();

    // On approval, finalize the checkout on the member's day record: stamp the
    // requested checkout time + out-of-office coords and recompute worked time.
    if (body.decision === 'approved') {
      const policy = await loadPolicy(actor.agencyId);
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.agencyId, actor.agencyId),
            eq(attendanceRecords.userId, reqRow.userId),
            eq(attendanceRecords.day, reqRow.day),
          ),
        )
        .limit(1);

      if (existing && existing.checkInAt && !existing.checkOutAt) {
        const derived = deriveDayStatus(policy, {
          checkInAt: existing.checkInAt,
          checkOutAt: reqRow.requestedCheckOutAt,
        });
        // Full-time credit: count the whole shift even if the off-site punch-out
        // landed early (the field work still happened). Lateness is preserved.
        const workedMinutes = body.creditFullDay
          ? policy.fullDayMinutes
          : derived.workedMinutes;
        const status = body.creditFullDay
          ? derived.isLate
            ? 'late'
            : 'present'
          : derived.status;
        await db
          .update(attendanceRecords)
          .set({
            checkOutAt: reqRow.requestedCheckOutAt,
            checkOutLat: reqRow.checkOutLat,
            checkOutLng: reqRow.checkOutLng,
            checkOutLocation: reqRow.checkOutLocation,
            workedMinutes,
            overtimeMinutes: body.creditFullDay ? 0 : derived.overtimeMinutes,
            status,
            isLate: derived.isLate,
            updatedAt: now,
          })
          .where(and(eq(attendanceRecords.id, existing.id), eq(attendanceRecords.agencyId, actor.agencyId)));
      }
    }

    await db
      .update(attendanceCheckoutRequests)
      .set({
        status: body.decision,
        decidedBy: actor.userId,
        decidedAt: now,
        decisionNote: body.note ?? null,
      })
      .where(
        and(
          eq(attendanceCheckoutRequests.id, id),
          eq(attendanceCheckoutRequests.agencyId, actor.agencyId),
          eq(attendanceCheckoutRequests.status, 'pending'),
        ),
      );

    await audit({
      agencyId: actor.agencyId,
      actorType: actor.type,
      actorId: actor.userId,
      action: `attendance.checkout_request.${body.decision}`,
      entityType: 'attendance_checkout_request',
      entityId: id,
      metadata: {
        subjectUserId: reqRow.userId,
        day: reqRow.day,
        creditFullDay: body.decision === 'approved' ? body.creditFullDay : undefined,
      },
      ip: req.ip,
    });

    await notify({
      agencyId: actor.agencyId,
      userId: reqRow.userId,
      type: `attendance.checkout.${body.decision}`,
      title: `Checkout ${body.decision}`,
      body: `Your out-of-office checkout for ${reqRow.day} was ${body.decision}.${
        body.decision === 'approved' && body.creditFullDay
          ? ' Credited as a full day.'
          : ''
      }${body.note ? ` ${body.note}` : ''}`,
      entityType: 'attendance_checkout_request',
      entityId: id,
      link: '/attendance',
    });

    const row = await loadCheckoutRequest(actor, id);
    ok(res, serializeCheckoutRequest(actor, row, manageable));
  },
);

// POST /checkout-requests/:id/cancel — withdraw a pending request (own; or
// someone else's with organization scope when they're manageable).
attendanceRouter.post(
  '/checkout-requests/:id/cancel',
  requires('checkout_requests.cancel'),
  async (req, res) => {
    const actor = getStaffActor(req);
    const id = param(req, 'id');
    const reqRow = await loadCheckoutRequest(actor, id);
    const manageable = await isManageableSubject(actor, reqRow.userId);
    assertCancelAllowed('checkout_requests', actor, reqRow, manageable);
    await db
      .update(attendanceCheckoutRequests)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(attendanceCheckoutRequests.id, id),
          eq(attendanceCheckoutRequests.agencyId, actor.agencyId),
        ),
      );
    await audit({
      agencyId: actor.agencyId,
      actorType: actor.type,
      actorId: actor.userId,
      action: 'attendance.checkout_request.cancelled',
      entityType: 'attendance_checkout_request',
      entityId: id,
      metadata: { subjectUserId: reqRow.userId, day: reqRow.day },
      ip: req.ip,
    });
    ok(res, { cancelled: true });
  },
);
