import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clientAssignments, users } from '../db/schema.js';
import { ok, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { conflict, notFound } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getAuth, requireClientAccess } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

// GET /team — list users in the agency.
usersRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.agencyId, ctx.agencyId));
  ok(
    res,
    rows.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      role: u.role,
      status: u.status,
      lastLoginAt: toIso(u.lastLoginAt),
    })),
  );
});

// PATCH /team/:userId — change role / enable-disable (owner/admin).
const patchSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

usersRouter.patch(
  '/:userId',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    const body = patchSchema.parse(req.body);
    const [target] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.id, param(req, 'userId')),
          eq(users.agencyId, ctx.agencyId),
        ),
      )
      .limit(1);
    if (!target) throw notFound('User not found.');
    if (target.role === 'owner') {
      throw conflict('Cannot modify the owner.');
    }

    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (body.role !== undefined) patch.role = body.role;
    if (body.status !== undefined) patch.status = body.status;

    await db.update(users).set(patch).where(eq(users.id, target.id));
    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'team.update',
      entityType: 'user',
      entityId: target.id,
      ip: req.ip,
    });
    ok(res, { updated: true });
  },
);

// ---- Client assignments (owner/admin) ----

// GET /team/clients/:clientId/assignments
usersRouter.get(
  '/clients/:clientId/assignments',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    await requireClientAccess(ctx, param(req, 'clientId'));
    const rows = await db
      .select({
        id: clientAssignments.id,
        userId: clientAssignments.userId,
      })
      .from(clientAssignments)
      .where(
        and(
          eq(clientAssignments.agencyId, ctx.agencyId),
          eq(clientAssignments.clientId, param(req, 'clientId')),
        ),
      );
    ok(res, rows);
  },
);

// POST /team/clients/:clientId/assignments  { userId }
const assignSchema = z.object({ userId: z.string().min(1) });

usersRouter.post(
  '/clients/:clientId/assignments',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    await requireClientAccess(ctx, param(req, 'clientId'));
    const body = assignSchema.parse(req.body);

    // The assignee must belong to this agency.
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.id, body.userId), eq(users.agencyId, ctx.agencyId)),
      )
      .limit(1);
    if (!user) throw notFound('User not found.');

    await db
      .insert(clientAssignments)
      .values({
        id: newId('asn'),
        agencyId: ctx.agencyId,
        clientId: param(req, 'clientId'),
        userId: body.userId,
        assignedBy: ctx.userId,
      })
      .onConflictDoNothing();

    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'client.assign',
      entityType: 'client',
      entityId: param(req, 'clientId'),
      metadata: { userId: body.userId },
      ip: req.ip,
    });
    ok(res, { assigned: true });
  },
);

// DELETE /team/clients/:clientId/assignments/:userId
usersRouter.delete(
  '/clients/:clientId/assignments/:userId',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    await requireClientAccess(ctx, param(req, 'clientId'));
    await db
      .delete(clientAssignments)
      .where(
        and(
          eq(clientAssignments.agencyId, ctx.agencyId),
          eq(clientAssignments.clientId, param(req, 'clientId')),
          eq(clientAssignments.userId, param(req, 'userId')),
        ),
      );
    ok(res, { unassigned: true });
  },
);
