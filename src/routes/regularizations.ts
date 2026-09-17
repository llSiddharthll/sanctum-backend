import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  attendanceRecords,
  attendanceRegularizations,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { notify, notifyPermissionHolders } from '../services/notifications.js';
import { loadPolicy } from '../services/attendance.js';
import { dayKeyInTz, deriveDayStatus } from '../lib/attendance.js';
import { getStaffActor, requires } from '../authz/http.js';
import { authorize, canOrg } from '../authz/engine.js';
import type { StaffActor } from '../authz/actor.js';
import {
  assertCancelAllowed,
  decideCondition,
  manageableUserIds,
  requestCapabilities,
  resolveSubjectForRead,
  subjectFacts,
  subjectScopeFilter,
} from '../authz/policies/attendance.js';

// Mounted under /attendance (which authenticates). Every route declares its
// permission.
export const regularizationsRouter = Router();

type RegRow = typeof attendanceRegularizations.$inferSelect;

function serialize(
  actor: StaffActor,
  r: RegRow,
  manageable: boolean,
  userName?: string | null,
) {
  return {
    id: r.id,
    userId: r.userId,
    userName: userName ?? null,
    day: r.day,
    type: r.type,
    requestedCheckInAt: toIso(r.requestedCheckInAt),
    requestedCheckOutAt: toIso(r.requestedCheckOutAt),
    requestedStatus: r.requestedStatus,
    reason: r.reason,
    status: r.status,
    decidedBy: r.decidedBy,
    decidedAt: toIso(r.decidedAt),
    decisionNote: r.decisionNote,
    createdAt: toIso(r.createdAt),
    capabilities: requestCapabilities('regularizations', actor, r, manageable),
  };
}

async function loadReg(actor: StaffActor, id: string): Promise<RegRow> {
  const [reg] = await db
    .select()
    .from(attendanceRegularizations)
    .where(
      and(
        eq(attendanceRegularizations.id, id),
        eq(attendanceRegularizations.agencyId, actor.agencyId),
      ),
    )
    .limit(1);
  if (!reg) throw notFound('Request not found.');
  return reg;
}

async function nameOf(agencyId: string, userId: string): Promise<string | null> {
  const [u] = await db
    .select({ name: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.agencyId, agencyId)))
    .limit(1);
  return u?.name ?? u?.email ?? null;
}

async function isManageableSubject(actor: StaffActor, userId: string): Promise<boolean> {
  return (await manageableUserIds(actor, [userId])).has(userId);
}

// GET / — own requests by default; ?scope=all|pending lists what the actor may
// view (own → own rows; organization → everyone's).
regularizationsRouter.get('/', requires('regularizations.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const scope = (req.query.scope as string | undefined) ?? 'me';
  const filters = [eq(attendanceRegularizations.agencyId, actor.agencyId)];
  if (scope === 'all' || scope === 'pending') {
    filters.push(
      subjectScopeFilter(actor, 'regularizations.view', attendanceRegularizations.userId),
    );
    if (scope === 'pending')
      filters.push(eq(attendanceRegularizations.status, 'pending'));
    const reqUser = (req.query.userId as string | undefined)?.trim();
    if (reqUser) {
      await resolveSubjectForRead(actor, 'regularizations.view', reqUser);
      filters.push(eq(attendanceRegularizations.userId, reqUser));
    }
  } else {
    filters.push(eq(attendanceRegularizations.userId, actor.userId));
  }
  const rows = await db
    .select({
      r: attendanceRegularizations,
      userName: users.fullName,
      userEmail: users.email,
    })
    .from(attendanceRegularizations)
    .leftJoin(users, eq(users.id, attendanceRegularizations.userId))
    .where(and(...filters))
    .orderBy(desc(attendanceRegularizations.createdAt))
    .limit(200);
  const manageable =
    canOrg(actor, 'regularizations.approve') || canOrg(actor, 'regularizations.cancel')
      ? await manageableUserIds(actor, rows.map((x) => (x.r as RegRow).userId))
      : new Set<string>();
  ok(
    res,
    rows.map((x) => serialize(actor, x.r, manageable.has((x.r as RegRow).userId), x.userName ?? x.userEmail)),
  );
});

const raiseSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(['missed_punch', 'late', 'short_hours', 'half_day', 'wrong_status']),
  requestedCheckInAt: z.coerce.date().optional(),
  requestedCheckOutAt: z.coerce.date().optional(),
  requestedStatus: z.enum(['present', 'half_day', 'on_leave']).optional(),
  reason: z.string().trim().min(3).max(500),
});

// POST / — raise a fix request for YOUR OWN past (or today's) day.
regularizationsRouter.post('/', requires('regularizations.request'), async (req, res) => {
  const actor = getStaffActor(req);
  authorize(actor, 'regularizations.request', subjectFacts(actor.agencyId, actor.userId));
  const body = raiseSchema.parse(req.body);

  const policy = await loadPolicy(actor.agencyId);
  if (body.day > dayKeyInTz(new Date(), policy.timezone)) {
    throw badRequest("You can't regularize a future day.");
  }

  const [dupe] = await db
    .select({ id: attendanceRegularizations.id })
    .from(attendanceRegularizations)
    .where(
      and(
        eq(attendanceRegularizations.agencyId, actor.agencyId),
        eq(attendanceRegularizations.userId, actor.userId),
        eq(attendanceRegularizations.day, body.day),
        eq(attendanceRegularizations.status, 'pending'),
      ),
    )
    .limit(1);
  if (dupe) {
    throw conflict('You already have a pending request for that day.');
  }

  const id = newId('reg');
  await db.insert(attendanceRegularizations).values({
    id,
    agencyId: actor.agencyId,
    userId: actor.userId,
    day: body.day,
    type: body.type,
    requestedCheckInAt: body.requestedCheckInAt ?? null,
    requestedCheckOutAt: body.requestedCheckOutAt ?? null,
    requestedStatus: body.requestedStatus ?? null,
    reason: body.reason,
    status: 'pending',
  });

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'attendance.regularization.request',
    entityType: 'attendance_regularization',
    entityId: id,
    metadata: { day: body.day, type: body.type },
    ip: req.ip,
  });

  const me = await nameOf(actor.agencyId, actor.userId);
  await notifyPermissionHolders(
    actor.agencyId,
    'regularizations.approve',
    {
      agencyId: actor.agencyId,
      type: 'regularization.requested',
      title: 'Regularization request',
      body: `${me ?? 'A member'} requested a fix for ${body.day}.`,
      entityType: 'attendance_regularization',
      entityId: id,
      link: '/attendance',
    },
    { excludeUserId: actor.userId },
  );

  created(res, serialize(actor, await loadReg(actor, id), false, me));
});

const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});

// POST /:id/decide — approve/reject someone else's pending request (never own;
// the subject must be manageable).
regularizationsRouter.post(
  '/:id/decide',
  requires('regularizations.approve'),
  async (req, res) => {
    const actor = getStaffActor(req);
    const id = param(req, 'id');
    const body = decideSchema.parse(req.body);

    const reg = await loadReg(actor, id);
    const manageable = await isManageableSubject(actor, reg.userId);
    authorize(actor, 'regularizations.approve', subjectFacts(actor.agencyId, reg.userId), {
      view: 'regularizations.view',
      condition: () => decideCondition(actor, reg, manageable),
    });
    if (reg.status !== 'pending') throw conflict('This request was already decided.');

    // On approval, apply the requested change to the member's day.
    if (body.decision === 'approved') {
      const policy = await loadPolicy(actor.agencyId);
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.agencyId, actor.agencyId),
            eq(attendanceRecords.userId, reg.userId),
            eq(attendanceRecords.day, reg.day),
          ),
        )
        .limit(1);

      const checkInAt = reg.requestedCheckInAt ?? existing?.checkInAt ?? null;
      const checkOutAt = reg.requestedCheckOutAt ?? existing?.checkOutAt ?? null;
      const derived = deriveDayStatus(policy, {
        checkInAt,
        checkOutAt,
        onLeave: reg.requestedStatus === 'on_leave',
      });
      const rawStatus = reg.requestedStatus ?? derived.status;
      // Approving a regularization credits a FULL working day — present, full-day
      // minutes, on-time — unless it's explicitly a leave/absence request.
      const isWorkingDay = rawStatus !== 'on_leave' && rawStatus !== 'absent';
      const status = isWorkingDay ? 'present' : rawStatus;
      const workedMinutes = isWorkingDay
        ? policy.fullDayMinutes
        : derived.workedMinutes;
      const isLate = isWorkingDay ? false : derived.isLate;
      const overtimeMinutes = isWorkingDay ? 0 : derived.overtimeMinutes;
      const now = new Date();

      if (existing) {
        await db
          .update(attendanceRecords)
          .set({
            checkInAt,
            checkOutAt,
            status,
            isLate,
            workedMinutes,
            overtimeMinutes,
            source: 'regularized',
            note: reg.reason,
            updatedAt: now,
          })
          .where(
            and(eq(attendanceRecords.id, existing.id), eq(attendanceRecords.agencyId, actor.agencyId)),
          );
      } else {
        await db.insert(attendanceRecords).values({
          id: newId('att'),
          agencyId: actor.agencyId,
          userId: reg.userId,
          day: reg.day,
          checkInAt,
          checkOutAt,
          status,
          isLate,
          workedMinutes,
          overtimeMinutes,
          source: 'regularized',
          note: reg.reason,
        });
      }
    }

    const now = new Date();
    await db
      .update(attendanceRegularizations)
      .set({
        status: body.decision,
        decidedBy: actor.userId,
        decidedAt: now,
        decisionNote: body.note ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(attendanceRegularizations.id, id),
          eq(attendanceRegularizations.agencyId, actor.agencyId),
          eq(attendanceRegularizations.status, 'pending'),
        ),
      );

    await audit({
      agencyId: actor.agencyId,
      actorType: actor.type,
      actorId: actor.userId,
      action: `attendance.regularization.${body.decision}`,
      entityType: 'attendance_regularization',
      entityId: id,
      metadata: { subjectUserId: reg.userId, day: reg.day },
      ip: req.ip,
    });

    await notify({
      agencyId: actor.agencyId,
      userId: reg.userId,
      type: `regularization.${body.decision}`,
      title: `Regularization ${body.decision}`,
      body: `Your request for ${reg.day} was ${body.decision}.${body.note ? ` ${body.note}` : ''}`,
      entityType: 'attendance_regularization',
      entityId: id,
      link: '/attendance',
    });

    ok(res, serialize(actor, await loadReg(actor, id), manageable));
  },
);

// POST /:id/cancel — pending only; own, or someone else's with organization
// scope when they're manageable.
regularizationsRouter.post('/:id/cancel', requires('regularizations.cancel'), async (req, res) => {
  const actor = getStaffActor(req);
  const id = param(req, 'id');
  const reg = await loadReg(actor, id);
  const manageable = await isManageableSubject(actor, reg.userId);
  assertCancelAllowed('regularizations', actor, reg, manageable);
  await db
    .update(attendanceRegularizations)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(
      and(
        eq(attendanceRegularizations.id, id),
        eq(attendanceRegularizations.agencyId, actor.agencyId),
      ),
    );
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'attendance.regularization.cancelled',
    entityType: 'attendance_regularization',
    entityId: id,
    metadata: { subjectUserId: reg.userId, day: reg.day },
    ip: req.ip,
  });
  ok(res, { cancelled: true });
});
