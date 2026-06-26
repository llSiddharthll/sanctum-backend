import { Router } from 'express';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { ok, param } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getAuth } from '../middleware/tenant.js';
import { serializeNotification } from '../services/notifications.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

// GET /notifications?unreadOnly=true&limit=30
notificationsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const unreadOnly = req.query.unreadOnly === 'true';
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const filters = [eq(notifications.userId, ctx.userId)];
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
  const ctx = getAuth(req);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(
      and(eq(notifications.userId, ctx.userId), isNull(notifications.readAt)),
    );
  ok(res, { count: Number(row?.n ?? 0) });
});

// POST /notifications/:id/read
notificationsRouter.post('/:id/read', async (req, res) => {
  const ctx = getAuth(req);
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, param(req, 'id')),
        eq(notifications.userId, ctx.userId),
        isNull(notifications.readAt),
      ),
    );
  ok(res, { read: true });
});

// POST /notifications/read-all
notificationsRouter.post('/read-all', async (req, res) => {
  const ctx = getAuth(req);
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.userId, ctx.userId), isNull(notifications.readAt)),
    );
  ok(res, { read: true });
});
