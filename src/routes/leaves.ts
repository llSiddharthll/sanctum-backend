import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leaveRequests, leaveTypes, users } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { conflict, notFound, badRequest } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { notify, notifyPermissionHolders } from '../services/notifications.js';
import { loadPolicy, countLeaveDays, yearBounds } from '../services/attendance.js';
import { getStaffActor, requires, requiresAny } from '../authz/http.js';
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
export const leavesRouter = Router();

function serializeType(t: typeof leaveTypes.$inferSelect) {
  return {
    id: t.id,
    name: t.name,
    colorToken: t.colorToken,
    paid: t.paid,
    annualQuota: t.annualQuota,
    active: t.active,
    sortOrder: t.sortOrder,
  };
}

async function loadType(actor: StaffActor, id: string) {
  const [row] = await db
    .select()
    .from(leaveTypes)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) throw notFound('Leave type not found.');
  return row;
}

// ============================================================
//  LEAVE TYPES
// ============================================================
leavesRouter.get(
  '/types',
  requiresAny('leaves.request', 'leaves.view', 'leave_types.manage'),
  async (req, res) => {
    const actor = getStaffActor(req);
    const rows = await db
      .select()
      .from(leaveTypes)
      .where(eq(leaveTypes.agencyId, actor.agencyId))
      .orderBy(leaveTypes.sortOrder, leaveTypes.name);
    ok(res, rows.map(serializeType));
  },
);

const typeSchema = z.object({
  name: z.string().trim().min(1).max(60),
  colorToken: z.string().trim().max(20).optional(),
  paid: z.boolean().optional(),
  annualQuota: z.number().int().min(0).max(366).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

leavesRouter.post('/types', requires('leave_types.manage'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = typeSchema.parse(req.body);
  const [dupe] = await db
    .select({ id: leaveTypes.id })
    .from(leaveTypes)
    .where(and(eq(leaveTypes.agencyId, actor.agencyId), eq(leaveTypes.name, body.name)))
    .limit(1);
  if (dupe) throw conflict('A leave type with that name already exists.');

  const id = newId('lvt');
  await db.insert(leaveTypes).values({
    id,
    agencyId: actor.agencyId,
    name: body.name,
    colorToken: body.colorToken ?? 'pine',
    paid: body.paid ?? true,
    annualQuota: body.annualQuota ?? 0,
    active: body.active ?? true,
    sortOrder: body.sortOrder ?? 0,
  });
  const row = await loadType(actor, id);
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'leave_type.create',
    entityType: 'leave_type',
    entityId: id,
    metadata: { after: serializeType(row) },
    ip: req.ip,
  });
  created(res, serializeType(row));
});

leavesRouter.patch('/types/:id', requires('leave_types.manage'), async (req, res) => {
  const actor = getStaffActor(req);
  const id = param(req, 'id');
  const before = await loadType(actor, id);
  const body = typeSchema.partial().parse(req.body);
  const patch: Partial<typeof leaveTypes.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.colorToken !== undefined) patch.colorToken = body.colorToken;
  if (body.paid !== undefined) patch.paid = body.paid;
  if (body.annualQuota !== undefined) patch.annualQuota = body.annualQuota;
  if (body.active !== undefined) patch.active = body.active;
  if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
  if (Object.keys(patch).length) {
    await db
      .update(leaveTypes)
      .set(patch)
      .where(and(eq(leaveTypes.id, id), eq(leaveTypes.agencyId, actor.agencyId)));
  }
  // Re-read is tenant-scoped: a foreign id is a 404, never another agency's row.
  const row = await loadType(actor, id);
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'leave_type.update',
    entityType: 'leave_type',
    entityId: id,
    metadata: { before: serializeType(before), after: serializeType(row) },
    ip: req.ip,
  });
  ok(res, serializeType(row));
});

leavesRouter.delete('/types/:id', requires('leave_types.manage'), async (req, res) => {
  const actor = getStaffActor(req);
  const id = param(req, 'id');
  await loadType(actor, id);
  // Soft-delete (deactivate) so historical requests keep their type.
  await db
    .update(leaveTypes)
    .set({ active: false })
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.agencyId, actor.agencyId)));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'leave_type.deactivate',
    entityType: 'leave_type',
    entityId: id,
    ip: req.ip,
  });
  ok(res, { deactivated: true });
});

// ============================================================
//  LEAVE REQUESTS
// ============================================================
type LeaveRow = typeof leaveRequests.$inferSelect;

function serializeRequest(
  actor: StaffActor,
  r: LeaveRow,
  manageable: boolean,
  typeName?: string | null,
  typeColor?: string | null,
  userName?: string | null,
) {
  return {
    id: r.id,
    userId: r.userId,
    userName: userName ?? null,
    leaveTypeId: r.leaveTypeId,
    leaveTypeName: typeName ?? null,
    leaveTypeColor: typeColor ?? null,
    startDay: r.startDay,
    endDay: r.endDay,
    halfDayStart: r.halfDayStart,
    halfDayEnd: r.halfDayEnd,
    days: r.days,
    reason: r.reason,
    status: r.status,
    decidedBy: r.decidedBy,
    decidedAt: toIso(r.decidedAt),
    decisionNote: r.decisionNote,
    createdAt: toIso(r.createdAt),
    capabilities: requestCapabilities('leaves', actor, r, manageable),
  };
}

async function loadLeave(actor: StaffActor, id: string): Promise<LeaveRow> {
  const [lr] = await db
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.agencyId, actor.agencyId)))
    .limit(1);
  if (!lr) throw notFound('Leave request not found.');
  return lr;
}

/** Serialize one request with its type + requester name (tenant-scoped joins). */
async function serializeOne(actor: StaffActor, lr: LeaveRow, manageable: boolean) {
  const [t] = await db
    .select({ name: leaveTypes.name, colorToken: leaveTypes.colorToken })
    .from(leaveTypes)
    .where(and(eq(leaveTypes.id, lr.leaveTypeId), eq(leaveTypes.agencyId, actor.agencyId)))
    .limit(1);
  const [u] = await db
    .select({ name: users.fullName, email: users.email })
    .from(users)
    .where(and(eq(users.id, lr.userId), eq(users.agencyId, actor.agencyId)))
    .limit(1);
  return serializeRequest(actor, lr, manageable, t?.name, t?.colorToken, u?.name ?? u?.email);
}

async function isManageableSubject(actor: StaffActor, userId: string): Promise<boolean> {
  return (await manageableUserIds(actor, [userId])).has(userId);
}

/**
 * Days of `leaveTypeId` a user has booked in `year` with the given statuses
 * (requests starting within the year), optionally excluding one request.
 */
async function bookedDays(
  agencyId: string,
  userId: string,
  leaveTypeId: string,
  year: number,
  statuses: Array<'pending' | 'approved'>,
  excludeId?: string,
): Promise<number> {
  const { first, last } = yearBounds(year);
  const rows = await db
    .select({ id: leaveRequests.id, days: leaveRequests.days, startDay: leaveRequests.startDay })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.agencyId, agencyId),
        eq(leaveRequests.userId, userId),
        eq(leaveRequests.leaveTypeId, leaveTypeId),
        inArray(leaveRequests.status, statuses),
      ),
    );
  return rows
    .filter((r) => r.id !== excludeId && r.startDay >= first && r.startDay <= last)
    .reduce((sum, r) => sum + r.days, 0);
}

// GET / — own requests by default; ?scope=all|pending lists what the actor may
// view (own → own rows; organization → everyone's). ?userId (someone else)
// needs leaves.view at organization scope.
leavesRouter.get('/', requires('leaves.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const scope = (req.query.scope as string | undefined) ?? 'me';
  const filters = [eq(leaveRequests.agencyId, actor.agencyId)];

  if (scope === 'all' || scope === 'pending') {
    filters.push(subjectScopeFilter(actor, 'leaves.view', leaveRequests.userId));
    if (scope === 'pending') filters.push(eq(leaveRequests.status, 'pending'));
    const reqUser = (req.query.userId as string | undefined)?.trim();
    if (reqUser) {
      await resolveSubjectForRead(actor, 'leaves.view', reqUser);
      filters.push(eq(leaveRequests.userId, reqUser));
    }
  } else {
    filters.push(eq(leaveRequests.userId, actor.userId));
  }

  const rows = await db
    .select({
      r: leaveRequests,
      typeName: leaveTypes.name,
      typeColor: leaveTypes.colorToken,
      userName: users.fullName,
      userEmail: users.email,
    })
    .from(leaveRequests)
    .leftJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .leftJoin(users, eq(users.id, leaveRequests.userId))
    .where(and(...filters))
    .orderBy(desc(leaveRequests.createdAt))
    .limit(200);

  const manageable =
    canOrg(actor, 'leaves.approve') || canOrg(actor, 'leaves.cancel')
      ? await manageableUserIds(actor, rows.map((x) => (x.r as LeaveRow).userId))
      : new Set<string>();
  ok(
    res,
    rows.map((x) =>
      serializeRequest(
        actor,
        x.r,
        manageable.has((x.r as LeaveRow).userId),
        x.typeName,
        x.typeColor,
        x.userName ?? x.userEmail,
      ),
    ),
  );
});

// GET /balances?userId&year — `used` = approved days, `pending` = pending days,
// `remaining` = quota − used − pending (what can still be requested).
leavesRouter.get('/balances', requires('leaves.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const userId = await resolveSubjectForRead(
    actor,
    'leaves.view',
    req.query.userId as string | undefined,
  );
  const year = Number(req.query.year) || new Date().getFullYear();
  const { first, last } = yearBounds(year);

  const types = await db
    .select()
    .from(leaveTypes)
    .where(and(eq(leaveTypes.agencyId, actor.agencyId), eq(leaveTypes.active, true)))
    .orderBy(leaveTypes.sortOrder, leaveTypes.name);

  const used = new Map<string, number>();
  const pending = new Map<string, number>();
  const rows = await db
    .select({
      leaveTypeId: leaveRequests.leaveTypeId,
      days: leaveRequests.days,
      startDay: leaveRequests.startDay,
      status: leaveRequests.status,
    })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.agencyId, actor.agencyId),
        eq(leaveRequests.userId, userId),
        inArray(leaveRequests.status, ['approved', 'pending']),
      ),
    );
  for (const r of rows) {
    if (r.startDay >= first && r.startDay <= last) {
      const m = r.status === 'approved' ? used : pending;
      m.set(r.leaveTypeId, (m.get(r.leaveTypeId) ?? 0) + r.days);
    }
  }

  ok(res, {
    year,
    userId,
    balances: types.map((t) => {
      const u = used.get(t.id) ?? 0;
      const p = pending.get(t.id) ?? 0;
      return {
        leaveTypeId: t.id,
        name: t.name,
        colorToken: t.colorToken,
        paid: t.paid,
        annualQuota: t.annualQuota,
        used: u,
        pending: p,
        remaining: t.annualQuota > 0 ? Math.max(0, t.annualQuota - u - p) : null,
      };
    }),
  });
});

const applySchema = z.object({
  leaveTypeId: z.string().min(1),
  startDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  halfDayStart: z.boolean().optional(),
  halfDayEnd: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});

// POST / — request leave for YOURSELF (leaves.request is own-only).
leavesRouter.post('/', requires('leaves.request'), async (req, res) => {
  const actor = getStaffActor(req);
  authorize(actor, 'leaves.request', subjectFacts(actor.agencyId, actor.userId));
  const body = applySchema.parse(req.body);
  if (body.startDay > body.endDay) {
    throw badRequest('Start date must be on or before end date.');
  }

  const [type] = await db
    .select()
    .from(leaveTypes)
    .where(
      and(
        eq(leaveTypes.id, body.leaveTypeId),
        eq(leaveTypes.agencyId, actor.agencyId),
        eq(leaveTypes.active, true),
      ),
    )
    .limit(1);
  if (!type) throw notFound('Leave type not found.');

  const policy = await loadPolicy(actor.agencyId);
  const days = await countLeaveDays(
    actor.agencyId,
    policy,
    body.startDay,
    body.endDay,
    body.halfDayStart ?? false,
    body.halfDayEnd ?? false,
  );
  if (days <= 0) {
    throw badRequest('That range has no working days to take as leave.');
  }

  // Quota check (finite quotas only): approved AND pending requests count, so
  // pending requests can't be stacked over the balance.
  if (type.annualQuota > 0) {
    const booked = await bookedDays(
      actor.agencyId,
      actor.userId,
      type.id,
      Number(body.startDay.slice(0, 4)),
      ['approved', 'pending'],
    );
    if (booked + days > type.annualQuota) {
      throw conflict(
        `That exceeds your ${type.name} balance (${Math.max(0, type.annualQuota - booked)} day(s) left).`,
      );
    }
  }

  const id = newId('lvr');
  await db.insert(leaveRequests).values({
    id,
    agencyId: actor.agencyId,
    userId: actor.userId,
    leaveTypeId: type.id,
    startDay: body.startDay,
    endDay: body.endDay,
    halfDayStart: body.halfDayStart ?? false,
    halfDayEnd: body.halfDayEnd ?? false,
    days,
    reason: body.reason ?? null,
    status: 'pending',
  });

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'leave.request',
    entityType: 'leave_request',
    entityId: id,
    metadata: { type: type.name, days, startDay: body.startDay },
    ip: req.ip,
  });

  const out = await serializeOne(actor, await loadLeave(actor, id), false);

  // Notify the people who can approve it (never the requester).
  await notifyPermissionHolders(
    actor.agencyId,
    'leaves.approve',
    {
      agencyId: actor.agencyId,
      type: 'leave.requested',
      title: 'Leave request',
      body: `${out.userName ?? 'A member'} requested ${days} day(s) of ${type.name}.`,
      entityType: 'leave_request',
      entityId: id,
      link: '/attendance',
    },
    { excludeUserId: actor.userId },
  );

  created(res, out);
});

const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});

// POST /:id/decide — approve/reject someone else's pending leave (never own;
// the subject must be manageable). Quota is re-checked at approval.
leavesRouter.post('/:id/decide', requires('leaves.approve'), async (req, res) => {
  const actor = getStaffActor(req);
  const id = param(req, 'id');
  const body = decideSchema.parse(req.body);

  const lr = await loadLeave(actor, id);
  const manageable = await isManageableSubject(actor, lr.userId);
  authorize(actor, 'leaves.approve', subjectFacts(actor.agencyId, lr.userId), {
    view: 'leaves.view',
    condition: () => decideCondition(actor, lr, manageable),
  });
  if (lr.status !== 'pending') throw conflict('This request was already decided.');

  if (body.decision === 'approved') {
    const [type] = await db
      .select()
      .from(leaveTypes)
      .where(and(eq(leaveTypes.id, lr.leaveTypeId), eq(leaveTypes.agencyId, actor.agencyId)))
      .limit(1);
    if (type && type.annualQuota > 0) {
      const approved = await bookedDays(
        actor.agencyId,
        lr.userId,
        type.id,
        Number(lr.startDay.slice(0, 4)),
        ['approved'],
        lr.id,
      );
      if (approved + lr.days > type.annualQuota) {
        throw conflict(
          `Approving this exceeds the ${type.name} balance (${Math.max(0, type.annualQuota - approved)} day(s) left).`,
        );
      }
    }
  }

  const now = new Date();
  await db
    .update(leaveRequests)
    .set({
      status: body.decision,
      decidedBy: actor.userId,
      decidedAt: now,
      decisionNote: body.note ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(leaveRequests.id, id),
        eq(leaveRequests.agencyId, actor.agencyId),
        eq(leaveRequests.status, 'pending'),
      ),
    );

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: `leave.${body.decision}`,
    entityType: 'leave_request',
    entityId: id,
    metadata: { subjectUserId: lr.userId, days: lr.days, startDay: lr.startDay },
    ip: req.ip,
  });

  await notify({
    agencyId: actor.agencyId,
    userId: lr.userId,
    type: `leave.${body.decision}`,
    title: `Leave ${body.decision}`,
    body:
      body.decision === 'approved'
        ? `Your leave (${lr.startDay} → ${lr.endDay}) was approved.`
        : `Your leave (${lr.startDay} → ${lr.endDay}) was rejected.${body.note ? ` ${body.note}` : ''}`,
    entityType: 'leave_request',
    entityId: id,
    link: '/attendance',
  });

  ok(res, await serializeOne(actor, await loadLeave(actor, id), manageable));
});

// POST /:id/cancel — own: pending only. Someone else's pending request:
// leaves.cancel (organization) + manageable. APPROVED leave: leaves.cancel +
// leaves.approve on it (never own) + manageable.
leavesRouter.post('/:id/cancel', requires('leaves.cancel'), async (req, res) => {
  const actor = getStaffActor(req);
  const id = param(req, 'id');
  const lr = await loadLeave(actor, id);
  const manageable = await isManageableSubject(actor, lr.userId);
  assertCancelAllowed('leaves', actor, lr, manageable);

  await db
    .update(leaveRequests)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.agencyId, actor.agencyId)));

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'leave.cancelled',
    entityType: 'leave_request',
    entityId: id,
    metadata: { subjectUserId: lr.userId, previousStatus: lr.status, startDay: lr.startDay },
    ip: req.ip,
  });

  if (lr.userId !== actor.userId) {
    await notify({
      agencyId: actor.agencyId,
      userId: lr.userId,
      type: 'leave.cancelled',
      title: 'Leave cancelled',
      body: `Your leave (${lr.startDay} → ${lr.endDay}) was cancelled.`,
      entityType: 'leave_request',
      entityId: id,
      link: '/attendance',
    });
  }
  ok(res, { cancelled: true });
});
