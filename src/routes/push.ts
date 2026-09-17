import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pushTokens } from '../db/schema.js';
import { ok } from '../lib/http.js';
import { forbidden } from '../lib/errors.js';
import { authenticate, getActor } from '../authz/http.js';
import { actorUserId } from '../authz/actor.js';

/**
 * Device push-token registry. Self-service: any authenticated USER (staff or
 * client user) may register/unregister this device's FCM token for themselves
 * — no permission key. Portal-link actors have no user identity → 403.
 */
export const pushRouter = Router();
pushRouter.use(authenticate);

function self(req: Request): { agencyId: string; userId: string } {
  const actor = getActor(req);
  const userId = actorUserId(actor);
  if (!userId) throw forbidden('Push registration needs a signed-in user.');
  return { agencyId: actor.agencyId, userId };
}

const registerSchema = z.object({
  token: z.string().min(10).max(4096),
  platform: z.string().max(20).optional(),
});

// POST /push/register — upsert this device's FCM token against the caller.
pushRouter.post('/register', async (req, res) => {
  const ctx = self(req);
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
  const ctx = self(req);
  const token = (req.query.token as string | undefined)?.trim();
  if (token) {
    await db
      .delete(pushTokens)
      .where(and(eq(pushTokens.token, token), eq(pushTokens.userId, ctx.userId)));
  }
  ok(res, { removed: true });
});
