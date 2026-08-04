import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pushTokens } from '../db/schema.js';
import { ok } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getAuth } from '../middleware/tenant.js';

/**
 * Device push-token registry. Any authenticated user may register/unregister
 * this device's FCM token (no module gate — every role should get notified).
 */
export const pushRouter = Router();
pushRouter.use(requireAuth);

const registerSchema = z.object({
  token: z.string().min(10).max(4096),
  platform: z.string().max(20).optional(),
});

// POST /push/register — upsert this device's FCM token against the caller.
pushRouter.post('/register', async (req, res) => {
  const ctx = getAuth(req);
  const body = registerSchema.parse(req.body);
  const platform = body.platform ?? 'android';
  await db
    .insert(pushTokens)
    .values({
      token: body.token,
      userId: ctx.userId,
      agencyId: ctx.agencyId,
      platform,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: pushTokens.token,
      set: { userId: ctx.userId, agencyId: ctx.agencyId, platform, updatedAt: new Date() },
    });
  ok(res, { registered: true });
});

// DELETE /push/register?token=… — detach on sign-out.
pushRouter.delete('/register', async (req, res) => {
  const ctx = getAuth(req);
  const token = (req.query.token as string | undefined)?.trim();
  if (token) {
    await db
      .delete(pushTokens)
      .where(and(eq(pushTokens.token, token), eq(pushTokens.userId, ctx.userId)));
  }
  ok(res, { removed: true });
});
