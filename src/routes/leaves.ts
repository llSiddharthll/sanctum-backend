import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leaveRequests, leaveTypes, users } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { conflict, forbidden, notFound, badRequest } from '../lib/errors.js';
import { getAuth, isPrivileged } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import {
  notify,
  notifyMany,
  agencyApprovers,
} from '../services/notifications.js';
import { loadPolicy, countLeaveDays, yearBounds } from '../services/attendance.js';

export const leavesRouter = Router();

function requirePrivileged(req: Request): void {
  if (!isPrivileged(getAuth(req).role)) {
    throw forbidden('Only owners/admins can do that.');
  }
}

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

// ============================================================
//  LEAVE TYPES
// ============================================================
leavesRouter.get('/types', async (req, res) => {
  const ctx = getAuth(req);
  const rows = await db
    .select()
    .from(leaveTypes)
    .where(eq(leaveTypes.agencyId, ctx.agencyId))
    .orderBy(leaveTypes.sortOrder, leaveTypes.name);
  ok(res, rows.map(serializeType));
});

const typeSchema = z.object({
  name: z.string().trim().min(1).max(60),
  colorToken: z.string().trim().max(20).optional(),
  paid: z.boolean().optional(),
  annualQuota: z.number().int().min(0).max(366).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

leavesRouter.post('/types', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const body = typeSchema.parse(req.body);
  const [dupe] = await db
    .select({ id: leaveTypes.id })
    .from(leaveTypes)
    .where(and(eq(leaveTypes.agencyId, ctx.agencyId), eq(leaveTypes.name, body.name)))
    .limit(1);
  if (dupe) throw conflict('A leave type with that name already exists.');

  const id = newId('lvt');
  await db.insert(leaveTypes).values({
    id,
    agencyId: ctx.agencyId,
    name: body.name,
    colorToken: body.colorToken ?? 'pine',
    paid: body.paid ?? true,
    annualQuota: body.annualQuota ?? 0,
    active: body.active ?? true,
    sortOrder: body.sortOrder ?? 0,
  });
  const [row] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, id));
  created(res, serializeType(row!));
});

leavesRouter.patch('/types/:id', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const id = param(req, 'id');
  const body = typeSchema.partial().parse(req.body);
  const patch: Partial<typeof leaveTypes.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.colorToken !== undefined) patch.colorToken = body.colorToken;
  if (body.paid !== undefined) patch.paid = body.paid;
  if (body.annualQuota !== undefined) patch.annualQuota = body.annualQuota;
  if (body.active !== undefined) patch.active = body.active;
  if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
  await db
    .update(leaveTypes)
    .set(patch)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.agencyId, ctx.agencyId)));
  const [row] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, id));
  if (!row) throw notFound('Leave type not found.');
  ok(res, serializeType(row));
});

leavesRouter.delete('/types/:id', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const id = param(req, 'id');
  // Soft-delete (deactivate) so historical requests keep their type.
  await db
    .update(leaveTypes)
    .set({ active: false })
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.agencyId, ctx.agencyId)));
  ok(res, { deactivated: true });
});

// ============================================================
//  LEAVE REQUESTS
// ============================================================
function serializeRequest(
  r: typeof leaveRequests.$inferSelect,
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
  };
}

// GET /  — list (mine by default; ?scope=all|pending and ?userId for admins)
leavesRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const scope = (req.query.scope as string | undefined) ?? 'me';
  const filters = [eq(leaveRequests.agencyId, ctx.agencyId)];

  if (scope === 'all' || scope === 'pending') {
    if (!isPrivileged(ctx.role)) throw forbidden('Admins only.');
    if (scope === 'pending') filters.push(eq(leaveRequests.status, 'pending'));
    const reqUser = (req.query.userId as string | undefined)?.trim();
    if (reqUser) filters.push(eq(leaveRequests.userId, reqUser));
  } else {
    filters.push(eq(leaveRequests.userId, ctx.userId));
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

  ok(
    res,
    rows.map((x) =>
      serializeRequest(x.r, x.typeName, x.typeColor, x.userName ?? x.userEmail),
    ),
  );
});

// GET /balances?userId&year
leavesRouter.get('/balances', async (req, res) => {
  const ctx = getAuth(req);
  const reqUser = (req.query.userId as string | undefined)?.trim();
  const userId =
    reqUser && reqUser !== ctx.userId
      ? (isPrivileged(ctx.role)
          ? reqUser
          : (() => {
              throw forbidden('Admins only.');
            })())
      : ctx.userId;
  const year = Number(req.query.year) || new Date().getFullYear();
  const { first, last } = yearBounds(year);

  const types = await db
    .select()
    .from(leaveTypes)
    .where(and(eq(leaveTypes.agencyId, ctx.agencyId), eq(leaveTypes.active, true)))
    .orderBy(leaveTypes.sortOrder, leaveTypes.name);

  // Sum approved days by type for requests starting within the year.
  const used = new Map<string, number>();
  const approvedRows = await db
    .select({
      leaveTypeId: leaveRequests.leaveTypeId,
      days: leaveRequests.days,
      startDay: leaveRequests.startDay,
    })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.agencyId, ctx.agencyId),
        eq(leaveRequests.userId, userId),
        eq(leaveRequests.status, 'approved'),
      ),
    );
  for (const r of approvedRows) {
    if (r.startDay >= first && r.startDay <= last) {
      used.set(r.leaveTypeId, (used.get(r.leaveTypeId) ?? 0) + r.days);
    }
  }

  ok(res, {
    year,
    userId,
    balances: types.map((t) => {
      const u = used.get(t.id) ?? 0;
      return {
        leaveTypeId: t.id,
        name: t.name,
        colorToken: t.colorToken,
        paid: t.paid,
        annualQuota: t.annualQuota,
        used: u,
        remaining: t.annualQuota > 0 ? Math.max(0, t.annualQuota - u) : null,
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

leavesRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
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
        eq(leaveTypes.agencyId, ctx.agencyId),
        eq(leaveTypes.active, true),
      ),
    )
    .limit(1);
  if (!type) throw notFound('Leave type not found.');

  const policy = await loadPolicy(ctx.agencyId);
  const days = await countLeaveDays(
    ctx.agencyId,
    policy,
    body.startDay,
    body.endDay,
    body.halfDayStart ?? false,
    body.halfDayEnd ?? false,
  );
  if (days <= 0) {
    throw badRequest('That range has no working days to take as leave.');
  }

  // Quota check (only when the type has a finite quota).
  if (type.annualQuota > 0) {
    const year = Number(body.startDay.slice(0, 4));
    const { first, last } = yearBounds(year);
    const approvedRows = await db
      .select({ days: leaveRequests.days, startDay: leaveRequests.startDay })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.agencyId, ctx.agencyId),
          eq(leaveRequests.userId, ctx.userId),
          eq(leaveRequests.leaveTypeId, type.id),
          eq(leaveRequests.status, 'approved'),
        ),
      );
    const used = approvedRows
      .filter((r) => r.startDay >= first && r.startDay <= last)
      .reduce((sum, r) => sum + r.days, 0);
    if (used + days > type.annualQuota) {
      throw conflict(
        `That exceeds your ${type.name} balance (${type.annualQuota - used} day(s) left).`,
      );
    }
  }

  const id = newId('lvr');
  await db.insert(leaveRequests).values({
    id,
    agencyId: ctx.agencyId,
    userId: ctx.userId,
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
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'leave.request',
    entityType: 'leave_request',
    entityId: id,
    metadata: { type: type.name, days, startDay: body.startDay },
    ip: req.ip,
  });

  // Notify approvers.
  const [me] = await db
    .select({ name: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);
  const approvers = await agencyApprovers(ctx.agencyId, ctx.userId);
  await notifyMany(approvers, {
    agencyId: ctx.agencyId,
    type: 'leave.requested',
    title: 'Leave request',
    body: `${me?.name ?? me?.email ?? 'A member'} requested ${days} day(s) of ${type.name}.`,
    entityType: 'leave_request',
    entityId: id,
    link: '/attendance',
  });

  const [row] = await db.select().from(leaveRequests).where(eq(leaveRequests.id, id));
  created(res, serializeRequest(row!, type.name, type.colorToken, me?.name ?? me?.email));
});

const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});

leavesRouter.post('/:id/decide', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const id = param(req, 'id');
  const body = decideSchema.parse(req.body);

  const [lr] = await db
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.agencyId, ctx.agencyId)))
    .limit(1);
  if (!lr) throw notFound('Leave request not found.');
  if (lr.status !== 'pending') throw conflict('This request was already decided.');

  await db
    .update(leaveRequests)
    .set({
      status: body.decision,
      decidedBy: ctx.userId,
      decidedAt: new Date(),
      decisionNote: body.note ?? null,
      updatedAt: new Date(),
    })
    .where(eq(leaveRequests.id, id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: `leave.${body.decision}`,
    entityType: 'leave_request',
    entityId: id,
    ip: req.ip,
  });

  await notify({
    agencyId: ctx.agencyId,
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

  const [row] = await db.select().from(leaveRequests).where(eq(leaveRequests.id, id));
  ok(res, serializeRequest(row!));
});

leavesRouter.post('/:id/cancel', async (req, res) => {
  const ctx = getAuth(req);
  const id = param(req, 'id');
  const [lr] = await db
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.agencyId, ctx.agencyId)))
    .limit(1);
  if (!lr) throw notFound('Leave request not found.');
  if (lr.userId !== ctx.userId && !isPrivileged(ctx.role)) {
    throw forbidden('You can only cancel your own requests.');
  }
  if (lr.status === 'cancelled' || lr.status === 'rejected') {
    throw conflict('This request can no longer be cancelled.');
  }
  await db
    .update(leaveRequests)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(leaveRequests.id, id));
  ok(res, { cancelled: true });
});
