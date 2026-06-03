import { Router } from 'express';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contentPosts, postMedia, usageCounters } from '../db/schema.js';
import { ok, created } from '../lib/http.js';
import { newId, currentPeriod } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { getAuth, requireClientAccess } from '../middleware/tenant.js';
import { signUpload, destroyAsset } from '../services/cloudinary.js';

export const mediaRouter = Router();
mediaRouter.use(requireAuth);

// POST /media/sign — Cloudinary signed upload signature.
const signSchema = z.object({
  clientId: z.string().min(1),
  postId: z.string().optional(),
  resourceType: z.enum(['image', 'video']).default('image'),
});

mediaRouter.post('/sign', async (req, res) => {
  const ctx = getAuth(req);
  const body = signSchema.parse(req.body);
  await requireClientAccess(ctx, body.clientId);

  // If a postId is given, verify it belongs to this client+agency.
  if (body.postId) {
    const [post] = await db
      .select({ id: contentPosts.id })
      .from(contentPosts)
      .where(
        and(
          eq(contentPosts.id, body.postId),
          eq(contentPosts.agencyId, ctx.agencyId),
          eq(contentPosts.clientId, body.clientId),
        ),
      )
      .limit(1);
    if (!post) throw notFound('Post not found.');
  }

  const signed = signUpload({
    agencyId: ctx.agencyId,
    clientId: body.clientId,
    postId: body.postId,
    resourceType: body.resourceType,
  });
  ok(res, signed);
});

// POST /media/posts/:postId — register an uploaded asset.
const registerSchema = z.object({
  clientId: z.string().min(1),
  cloudinaryPublicId: z.string().min(1),
  secureUrl: z.string().url(),
  resourceType: z.enum(['image', 'video']),
  format: z.string().optional(),
  bytes: z.number().int().nonnegative().default(0),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  position: z.number().int().nonnegative().default(0),
});

mediaRouter.post('/posts/:postId', async (req, res) => {
  const ctx = getAuth(req);
  const body = registerSchema.parse(req.body);
  await requireClientAccess(ctx, body.clientId);

  const [post] = await db
    .select({ id: contentPosts.id })
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.id, req.params.postId),
        eq(contentPosts.agencyId, ctx.agencyId),
        eq(contentPosts.clientId, body.clientId),
      ),
    )
    .limit(1);
  if (!post) throw notFound('Post not found.');

  const id = newId('med');
  await db.insert(postMedia).values({
    id,
    agencyId: ctx.agencyId,
    clientId: body.clientId,
    postId: post.id,
    cloudinaryPublicId: body.cloudinaryPublicId,
    secureUrl: body.secureUrl,
    resourceType: body.resourceType,
    format: body.format ?? null,
    bytes: body.bytes,
    width: body.width ?? null,
    height: body.height ?? null,
    position: body.position,
  });

  // Increment storage counter for the current period (upsert).
  const period = currentPeriod();
  await db
    .insert(usageCounters)
    .values({
      agencyId: ctx.agencyId,
      period,
      storageBytesUsed: body.bytes,
    })
    .onConflictDoUpdate({
      target: [usageCounters.agencyId, usageCounters.period],
      set: {
        storageBytesUsed: sql`${usageCounters.storageBytesUsed} + ${body.bytes}`,
        updatedAt: new Date(),
      },
    });

  created(res, {
    id,
    cloudinaryPublicId: body.cloudinaryPublicId,
    secureUrl: body.secureUrl,
    resourceType: body.resourceType,
    bytes: body.bytes,
    position: body.position,
  });
});

// DELETE /media/:mediaId
mediaRouter.delete('/:mediaId', async (req, res) => {
  const ctx = getAuth(req);
  const [media] = await db
    .select()
    .from(postMedia)
    .where(
      and(
        eq(postMedia.id, req.params.mediaId),
        eq(postMedia.agencyId, ctx.agencyId),
      ),
    )
    .limit(1);
  if (!media) throw notFound('Media not found.');

  // Ensure the caller can access this client (member assignment check).
  await requireClientAccess(ctx, media.clientId);

  await destroyAsset(media.cloudinaryPublicId, media.resourceType);
  await db.delete(postMedia).where(eq(postMedia.id, media.id));

  // Decrement storage counter (floor at 0).
  const period = currentPeriod();
  await db
    .update(usageCounters)
    .set({
      storageBytesUsed: sql`MAX(0, ${usageCounters.storageBytesUsed} - ${media.bytes})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(usageCounters.agencyId, ctx.agencyId),
        eq(usageCounters.period, period),
      ),
    );

  ok(res, { deleted: true });
});
