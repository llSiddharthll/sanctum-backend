import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { postApprovals, postComments } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { audit } from '../services/audit.js';
import { broadcastPortalRefresh } from '../realtime/io.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorizePost } from './posts.js';

// Mounted under /clients/:clientId/posts/:postId — mergeParams pulls both ids.
// Authorizes itself: the post must belong to the URL client + agency and be in
// the actor's scope.
export const approvalsRouter = Router({ mergeParams: true });
approvalsRouter.use(authenticate);

// GET .../comments
approvalsRouter.get('/comments', requires('post_comments.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const { row: post } = await authorizePost(actor, clientId, param(req, 'postId'), 'post_comments.view');
  const rows = await db
    .select()
    .from(postComments)
    .where(
      and(
        eq(postComments.agencyId, actor.agencyId),
        eq(postComments.clientId, clientId),
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

// POST .../comments — staff comment (visible to the client portal).
const commentSchema = z.object({ body: z.string().min(1).max(2000) });

approvalsRouter.post('/comments', requires('post_comments.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const { row: post } = await authorizePost(actor, clientId, param(req, 'postId'), 'post_comments.create');
  const body = commentSchema.parse(req.body);

  const id = newId('cmt');
  await db.insert(postComments).values({
    id,
    agencyId: actor.agencyId,
    clientId,
    postId: post.id,
    authorType: 'user',
    authorUserId: actor.userId,
    body: body.body,
  });

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'post.comment',
    entityType: 'post',
    entityId: post.id,
    ip: req.ip,
  });
  broadcastPortalRefresh(clientId);
  created(res, { id, body: body.body, authorType: 'user' });
});

// GET .../approvals — approval history.
approvalsRouter.get('/approvals', requires('posts.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const { row: post } = await authorizePost(actor, clientId, param(req, 'postId'), 'posts.view');
  const rows = await db
    .select()
    .from(postApprovals)
    .where(
      and(
        eq(postApprovals.agencyId, actor.agencyId),
        eq(postApprovals.clientId, clientId),
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
