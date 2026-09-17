import { Router } from 'express';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contentPosts, postMedia, usageCounters } from '../db/schema.js';
import { ok, created, param } from '../lib/http.js';
import { newId, currentPeriod } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { signMediaUpload, deleteAsset } from '../services/storage.js';
import { uploadOrigin } from '../services/local-storage.js';
import { audit } from '../services/audit.js';
import { broadcastPortalRefresh } from '../realtime/io.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize } from '../authz/engine.js';
import { assertPostMediaAsset, mediaFacts } from '../authz/policies/posts.js';
import { authorizeContentClient, authorizePost, resetApprovalIfNeeded } from './posts.js';

/**
 * Content-post media. Mounted at /api/v1/media (not under /clients), so the
 * client comes from the body and every object is re-bound to it here.
 */
export const mediaRouter = Router();
mediaRouter.use(authenticate);

// POST /media/sign — signed direct-upload params (Cloudinary or R2 per driver).
const signSchema = z.object({
  clientId: z.string().min(1),
  postId: z.string().optional(),
  resourceType: z.enum(['image', 'video']).default('image'),
  filename: z.string().optional(),
  contentType: z.string().optional(),
});

mediaRouter.post('/sign', requires('media.upload'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = signSchema.parse(req.body);
  if (body.postId) {
    // The post must belong to this client + agency, in scope for media.upload.
    await authorizePost(actor, body.clientId, body.postId, 'media.upload');
  } else {
    await authorizeContentClient(actor, body.clientId, 'media.upload');
  }

  const signed = await signMediaUpload({
    agencyId: actor.agencyId,
    clientId: body.clientId,
    postId: body.postId,
    resourceType: body.resourceType,
    filename: body.filename,
    contentType: body.contentType,
    uploadBase: uploadOrigin(req),
  });
  ok(res, signed);
});

// POST /media/posts/:postId — register an uploaded asset.
const registerSchema = z.object({
  clientId: z.string().min(1),
  cloudinaryPublicId: z.string().min(1).max(512),
  secureUrl: z.string().url().max(2048),
  resourceType: z.enum(['image', 'video']),
  format: z.string().max(16).optional(),
  bytes: z.number().int().nonnegative().default(0),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  position: z.number().int().nonnegative().default(0),
});

mediaRouter.post('/posts/:postId', requires('media.upload'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = registerSchema.parse(req.body);
  const { row: post } = await authorizePost(actor, body.clientId, param(req, 'postId'), 'media.upload');

  // The asset must live under THIS agency + client's post folder and be served
  // from a configured storage base (no foreign keys / arbitrary URLs).
  assertPostMediaAsset({
    agencyId: actor.agencyId,
    clientId: body.clientId,
    postId: post.id,
    key: body.cloudinaryPublicId,
    url: body.secureUrl,
  });

  const id = newId('med');
  await db.insert(postMedia).values({
    id,
    agencyId: actor.agencyId,
    clientId: body.clientId,
    postId: post.id,
    uploadedBy: actor.userId,
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
      agencyId: actor.agencyId,
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

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'post.media_add',
    entityType: 'post',
    entityId: post.id,
    metadata: { mediaId: id },
    ip: req.ip,
  });
  // New media changes approved content → back to draft for re-approval.
  const approvalReset = await resetApprovalIfNeeded(actor, post, 'media_add', req.ip);

  broadcastPortalRefresh(body.clientId);

  created(res, {
    id,
    cloudinaryPublicId: body.cloudinaryPublicId,
    secureUrl: body.secureUrl,
    resourceType: body.resourceType,
    bytes: body.bytes,
    position: body.position,
    approvalReset,
  });
});

// DELETE /media/:mediaId
mediaRouter.delete('/:mediaId', requires('media.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const loaded = await mediaFacts(actor, param(req, 'mediaId'));
  if (!loaded) throw notFound('Media not found.');
  authorize(actor, 'media.delete', loaded.facts, { view: 'posts.view' });
  const media = loaded.row;

  // Refuses keys outside this agency's storage prefix (never deletes foreign objects).
  await deleteAsset({
    publicId: media.cloudinaryPublicId,
    secureUrl: media.secureUrl,
    resourceType: media.resourceType,
    agencyId: actor.agencyId,
  });
  await db
    .delete(postMedia)
    .where(and(eq(postMedia.id, media.id), eq(postMedia.agencyId, actor.agencyId)));

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
        eq(usageCounters.agencyId, actor.agencyId),
        eq(usageCounters.period, period),
      ),
    );

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'post.media_delete',
    entityType: 'post',
    entityId: media.postId,
    metadata: { mediaId: media.id },
    ip: req.ip,
  });
  const [post] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, media.postId), eq(contentPosts.agencyId, actor.agencyId)))
    .limit(1);
  const approvalReset = post ? await resetApprovalIfNeeded(actor, post, 'media_delete', req.ip) : false;

  broadcastPortalRefresh(media.clientId);

  ok(res, { deleted: true, approvalReset });
});
