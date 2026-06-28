import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contentPosts, postApprovals, postComments } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth, requireClientAccess } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import { broadcastPortalRefresh } from '../realtime/io.js';

// Mounted under /clients/:clientId/posts/:postId — mergeParams pulls both ids.
export const approvalsRouter = Router({ mergeParams: true });
approvalsRouter.use(requireAuth);
// Part of the Clients module (mounted outside clientsRouter): re-apply the gate.
approvalsRouter.use(requireModuleRW('clients'));

async function scopedPost(
  ctx: ReturnType<typeof getAuth>,
  clientId: string,
  postId: string,
) {
  await requireClientAccess(ctx, clientId);
  const [post] = await db
    .select({ id: contentPosts.id })
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.id, postId),
        eq(contentPosts.agencyId, ctx.agencyId),
        eq(contentPosts.clientId, clientId),
      ),
    )
    .limit(1);
  if (!post) throw notFound('Post not found.');
  return post;
}

// GET .../comments
approvalsRouter.get('/comments', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  const post = await scopedPost(ctx, clientId, param(req, 'postId'));
  const rows = await db
    .select()
    .from(postComments)
    .where(
      and(
        eq(postComments.agencyId, ctx.agencyId),
        eq(postComments.postId, post.id),
      ),
    )
    .orderBy(asc(postComments.createdAt));
  ok(
    res,
    rows.map((c) => ({
      id: c.id,
      body: c.body,
      authorType: c.authorType,
      authorUserId: c.authorUserId,
      authorLabel: c.authorLabel,
      createdAt: toIso(c.createdAt),
    })),
  );
});

// POST .../comments — staff comment.
const commentSchema = z.object({ body: z.string().min(1).max(2000) });

approvalsRouter.post('/comments', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  const post = await scopedPost(ctx, clientId, param(req, 'postId'));
  const body = commentSchema.parse(req.body);

  const id = newId('cmt');
  await db.insert(postComments).values({
    id,
    agencyId: ctx.agencyId,
    clientId,
    postId: post.id,
    authorType: 'user',
    authorUserId: ctx.userId,
    body: body.body,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'post.comment',
    entityType: 'post',
    entityId: post.id,
    ip: req.ip,
  });
  // Live-refresh any open client portal so the agency reply appears instantly.
  broadcastPortalRefresh(clientId);
  created(res, { id, body: body.body, authorType: 'user' });
});

// GET .../approvals — approval history.
approvalsRouter.get('/approvals', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  const post = await scopedPost(ctx, clientId, param(req, 'postId'));
  const rows = await db
    .select()
    .from(postApprovals)
    .where(
      and(
        eq(postApprovals.agencyId, ctx.agencyId),
        eq(postApprovals.postId, post.id),
      ),
    )
    .orderBy(asc(postApprovals.createdAt));
  ok(
    res,
    rows.map((a) => ({
      id: a.id,
      decision: a.decision,
      note: a.note,
      actorLabel: a.actorLabel,
      createdAt: toIso(a.createdAt),
    })),
  );
});
