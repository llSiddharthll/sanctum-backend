import { Router, type Request } from 'express';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { ok, param } from '../lib/http.js';
import { forbidden } from '../lib/errors.js';
import { authenticate, getActor } from '../authz/http.js';
import { actorUserId } from '../authz/actor.js';
import { serializeNotification } from '../services/notifications.js';

/**
 * In-app notifications. Self-service: any authenticated USER (staff or client
 * user) reads and marks only their own notifications — no permission key.
 * Portal-link actors have no user identity → 403.
 */
export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

function self(req: Request): { agencyId: string; userId: string } {
  const actor = getActor(req);
  const userId = actorUserId(actor);
  if (!userId) throw forbidden('Notifications need a signed-in user.');
  return { agencyId: actor.agencyId, userId };
}

// GET /notifications?unreadOnly=true&limit=30
notificationsRouter.get('/', async (req, res) => {
  const ctx = self(req);
  const unreadOnly = req.query.unreadOnly === 'true';
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const filters = [eq(notifications.agencyId, ctx.agencyId), eq(notifications.userId, ctx.userId)];
  if (unreadOnly) filters.push(isNull(notifications.readAt));
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...filters))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  ok(res, rows.map(serializeNotification));
});

// GET /notifications/unread-count
notificationsRouter.get('/unread-count', async (req, res) => {
  const ctx = self(req);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(
      and(
        eq(notifications.agencyId, ctx.agencyId),
        eq(notifications.userId, ctx.userId),
        isNull(notifications.readAt),
      ),
    );
  ok(res, { count: Number(row?.n ?? 0) });
});

// POST /notifications/:id/read
notificationsRouter.post('/:id/read', async (req, res) => {
  const ctx = self(req);
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, param(req, 'id')),
        eq(notifications.agencyId, ctx.agencyId),
        eq(notifications.userId, ctx.userId),
        isNull(notifications.readAt),
      ),
    );
  ok(res, { read: true });
});

// POST /notifications/read-all
notificationsRouter.post('/read-all', async (req, res) => {
  const ctx = self(req);
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.agencyId, ctx.agencyId),
        eq(notifications.userId, ctx.userId),
        isNull(notifications.readAt),
      ),
    );
  ok(res, { read: true });
});
