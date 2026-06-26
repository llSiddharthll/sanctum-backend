import { Router } from 'express';
import type { Request } from 'express';
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
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { getAuth, isPrivileged } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import {
  notify,
  notifyMany,
  agencyApprovers,
} from '../services/notifications.js';
import { loadPolicy } from '../services/attendance.js';
import { deriveDayStatus } from '../lib/attendance.js';

export const regularizationsRouter = Router();

function requirePrivileged(req: Request): void {
  if (!isPrivileged(getAuth(req).role)) {
    throw forbidden('Only owners/admins can do that.');
  }
}

function serialize(
  r: typeof attendanceRegularizations.$inferSelect,
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
  };
}

// GET / — list (mine by default; ?scope=all|pending & ?userId for admins)
regularizationsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const scope = (req.query.scope as string | undefined) ?? 'me';
  const filters = [eq(attendanceRegularizations.agencyId, ctx.agencyId)];
  if (scope === 'all' || scope === 'pending') {
    if (!isPrivileged(ctx.role)) throw forbidden('Admins only.');
    if (scope === 'pending')
      filters.push(eq(attendanceRegularizations.status, 'pending'));
    const reqUser = (req.query.userId as string | undefined)?.trim();
    if (reqUser) filters.push(eq(attendanceRegularizations.userId, reqUser));
  } else {
    filters.push(eq(attendanceRegularizations.userId, ctx.userId));
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
  ok(res, rows.map((x) => serialize(x.r, x.userName ?? x.userEmail)));
});

const raiseSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(['missed_punch', 'late', 'short_hours', 'half_day', 'wrong_status']),
  requestedCheckInAt: z.coerce.date().optional(),
  requestedCheckOutAt: z.coerce.date().optional(),
  requestedStatus: z.enum(['present', 'half_day', 'on_leave']).optional(),
  reason: z.string().trim().min(3).max(500),
});

regularizationsRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = raiseSchema.parse(req.body);

  const [dupe] = await db
    .select({ id: attendanceRegularizations.id })
    .from(attendanceRegularizations)
    .where(
      and(
        eq(attendanceRegularizations.agencyId, ctx.agencyId),
        eq(attendanceRegularizations.userId, ctx.userId),
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
    agencyId: ctx.agencyId,
    userId: ctx.userId,
    day: body.day,
    type: body.type,
    requestedCheckInAt: body.requestedCheckInAt ?? null,
    requestedCheckOutAt: body.requestedCheckOutAt ?? null,
    requestedStatus: body.requestedStatus ?? null,
    reason: body.reason,
    status: 'pending',
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'attendance.regularization.request',
    entityType: 'attendance_regularization',
    entityId: id,
    metadata: { day: body.day, type: body.type },
    ip: req.ip,
  });

  const [me] = await db
    .select({ name: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);
  const approvers = await agencyApprovers(ctx.agencyId, ctx.userId);
  await notifyMany(approvers, {
    agencyId: ctx.agencyId,
    type: 'regularization.requested',
    title: 'Regularization request',
    body: `${me?.name ?? me?.email ?? 'A member'} requested a fix for ${body.day}.`,
    entityType: 'attendance_regularization',
    entityId: id,
    link: '/attendance',
  });

  const [row] = await db
    .select()
    .from(attendanceRegularizations)
    .where(eq(attendanceRegularizations.id, id));
  created(res, serialize(row!, me?.name ?? me?.email));
});

const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});

regularizationsRouter.post('/:id/decide', async (req, res) => {
  requirePrivileged(req);
  const ctx = getAuth(req);
  const id = param(req, 'id');
  const body = decideSchema.parse(req.body);

  const [reg] = await db
    .select()
    .from(attendanceRegularizations)
    .where(
      and(
        eq(attendanceRegularizations.id, id),
        eq(attendanceRegularizations.agencyId, ctx.agencyId),
      ),
    )
    .limit(1);
  if (!reg) throw notFound('Request not found.');
  if (reg.status !== 'pending') throw conflict('This request was already decided.');

  // On approval, apply the requested change to the member's day.
  if (body.decision === 'approved') {
    const policy = await loadPolicy(ctx.agencyId);
    const [existing] = await db
      .select()
      .from(attendanceRecords)
      .where(
        and(
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
    const status = reg.requestedStatus ?? derived.status;
    const now = new Date();

    if (existing) {
      await db
        .update(attendanceRecords)
        .set({
          checkInAt,
          checkOutAt,
          status,
          isLate: derived.isLate,
          workedMinutes: derived.workedMinutes,
          overtimeMinutes: derived.overtimeMinutes,
          source: 'regularized',
          note: reg.reason,
          updatedAt: now,
        })
        .where(eq(attendanceRecords.id, existing.id));
    } else {
      await db.insert(attendanceRecords).values({
        id: newId('att'),
        agencyId: ctx.agencyId,
        userId: reg.userId,
        day: reg.day,
        checkInAt,
        checkOutAt,
        status,
        isLate: derived.isLate,
        workedMinutes: derived.workedMinutes,
        overtimeMinutes: derived.overtimeMinutes,
        source: 'regularized',
        note: reg.reason,
      });
    }
  }

  await db
    .update(attendanceRegularizations)
    .set({
      status: body.decision,
      decidedBy: ctx.userId,
      decidedAt: new Date(),
      decisionNote: body.note ?? null,
      updatedAt: new Date(),
    })
    .where(eq(attendanceRegularizations.id, id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: `attendance.regularization.${body.decision}`,
    entityType: 'attendance_regularization',
    entityId: id,
    ip: req.ip,
  });

  await notify({
    agencyId: ctx.agencyId,
    userId: reg.userId,
    type: `regularization.${body.decision}`,
    title: `Regularization ${body.decision}`,
    body: `Your request for ${reg.day} was ${body.decision}.${body.note ? ` ${body.note}` : ''}`,
    entityType: 'attendance_regularization',
    entityId: id,
    link: '/attendance',
  });

  const [row] = await db
    .select()
    .from(attendanceRegularizations)
    .where(eq(attendanceRegularizations.id, id));
  ok(res, serialize(row!));
});

regularizationsRouter.post('/:id/cancel', async (req, res) => {
  const ctx = getAuth(req);
  const id = param(req, 'id');
  const [reg] = await db
    .select()
    .from(attendanceRegularizations)
    .where(
      and(
        eq(attendanceRegularizations.id, id),
        eq(attendanceRegularizations.agencyId, ctx.agencyId),
      ),
    )
    .limit(1);
  if (!reg) throw notFound('Request not found.');
  if (reg.userId !== ctx.userId && !isPrivileged(ctx.role)) {
    throw forbidden('You can only cancel your own requests.');
  }
  if (reg.status !== 'pending') {
    throw conflict('Only pending requests can be cancelled.');
  }
  await db
    .update(attendanceRegularizations)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(attendanceRegularizations.id, id));
  ok(res, { cancelled: true });
});
