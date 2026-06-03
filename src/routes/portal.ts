import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  clients,
  contentPosts,
  postApprovals,
  postComments,
  postMedia,
} from '../db/schema.js';
import { ok, created, toIso } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { invalidState, notFound } from '../lib/errors.js';
import { portalLimiter } from '../middleware/rate-limit.js';
import { requirePortalToken } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import type { PortalContext } from '../types/index.js';

export const portalRouter = Router();
portalRouter.use(portalLimiter);
portalRouter.use(requirePortalToken);

function getPortal(req: import('express').Request): PortalContext {
  if (!req.portal) throw notFound('Invalid link.');
  return req.portal;
}

function safeArr(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// GET /portal/resolve — branding + visible (non-draft) posts for this client.
portalRouter.get('/resolve', async (req, res) => {
  const p = getPortal(req);

  const [agency] = await db
    .select()
    .from(agencies)
    .where(eq(agencies.id, p.agencyId))
    .limit(1);
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, p.clientId))
    .limit(1);
  if (!client) throw notFound('Client not found.');

  const visible = client.portalVisibleStatuses
    .split(',')
    .filter(Boolean);

  const posts = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.agencyId, p.agencyId),
        eq(contentPosts.clientId, p.clientId),
        ne(contentPosts.status, 'draft'),
      ),
    )
    .orderBy(asc(contentPosts.scheduledAt));

  const filtered = posts.filter((post) => visible.includes(post.status));

  // Attach media per post.
  const result = [];
  for (const post of filtered) {
    const media = await db
      .select()
      .from(postMedia)
      .where(
        and(
          eq(postMedia.agencyId, p.agencyId),
          eq(postMedia.postId, post.id),
        ),
      )
      .orderBy(asc(postMedia.position));
    result.push({
      id: post.id,
      postType: post.postType,
      caption: post.caption,
      platforms: safeArr(post.platformsJson),
      scheduledAt: toIso(post.scheduledAt),
      status: post.status,
      media: media.map((m) => ({
        resourceType: m.resourceType,
        secureUrl: m.secureUrl,
        width: m.width,
        height: m.height,
        position: m.position,
      })),
    });
  }

  ok(res, {
    agency: agency
      ? {
          name: agency.name,
          logoUrl: agency.logoUrl,
          brandColor: agency.brandColor,
        }
      : null,
    client: {
      id: client.id,
      name: client.name,
      logoUrl: client.logoUrl,
      brandColor: client.brandColor,
      handles: client.handlesJson ? JSON.parse(client.handlesJson) : null,
    },
    portal: { visibleStatuses: visible, canApprove: true, canComment: true },
    posts: result,
  });
});

/** Resolve a post within the token's scope (non-draft) or throw 404. */
async function scopedPost(p: PortalContext, postId: string) {
  const [post] = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.id, postId),
        eq(contentPosts.agencyId, p.agencyId),
        eq(contentPosts.clientId, p.clientId),
        ne(contentPosts.status, 'draft'),
      ),
    )
    .limit(1);
  if (!post) throw notFound('Post not found.');
  return post;
}

// GET /portal/posts/:postId
portalRouter.get('/posts/:postId', async (req, res) => {
  const p = getPortal(req);
  const post = await scopedPost(p, req.params.postId);
  const media = await db
    .select()
    .from(postMedia)
    .where(
      and(eq(postMedia.agencyId, p.agencyId), eq(postMedia.postId, post.id)),
    )
    .orderBy(asc(postMedia.position));
  ok(res, {
    id: post.id,
    postType: post.postType,
    caption: post.caption,
    platforms: safeArr(post.platformsJson),
    scheduledAt: toIso(post.scheduledAt),
    status: post.status,
    media: media.map((m) => ({
      resourceType: m.resourceType,
      secureUrl: m.secureUrl,
      width: m.width,
      height: m.height,
      position: m.position,
    })),
  });
});

// POST /portal/posts/:postId/decision — approve / request_changes.
const decisionSchema = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  note: z.string().max(2000).optional(),
  actorLabel: z.string().max(120).optional(),
});

portalRouter.post('/posts/:postId/decision', async (req, res) => {
  const p = getPortal(req);
  const post = await scopedPost(p, req.params.postId);
  const body = decisionSchema.parse(req.body);

  // Only approvable while awaiting review.
  if (!['pending_approval', 'approved', 'changes_requested'].includes(post.status)) {
    throw invalidState(`Post is '${post.status}' and cannot be decided.`);
  }

  await db.insert(postApprovals).values({
    id: newId('apr'),
    agencyId: p.agencyId,
    clientId: p.clientId,
    postId: post.id,
    portalTokenId: p.tokenId,
    decision: body.decision,
    note: body.note ?? null,
    actorLabel: body.actorLabel ?? null,
    ip: req.ip ?? null,
  });

  const newStatus =
    body.decision === 'approved' ? 'approved' : 'changes_requested';
  await db
    .update(contentPosts)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(
      and(
        eq(contentPosts.id, post.id),
        eq(contentPosts.agencyId, p.agencyId),
        eq(contentPosts.clientId, p.clientId),
      ),
    );

  await audit({
    agencyId: p.agencyId,
    actorType: 'client_token',
    actorId: p.tokenId,
    action: `post.${body.decision}`,
    entityType: 'post',
    entityId: post.id,
    metadata: { actorLabel: body.actorLabel ?? null },
    ip: req.ip,
  });

  ok(res, {
    postId: post.id,
    decision: body.decision,
    newStatus,
    note: body.note ?? null,
    actorLabel: body.actorLabel ?? null,
    decidedAt: new Date().toISOString(),
  });
});

// POST /portal/posts/:postId/comments — client comment.
const commentSchema = z.object({
  body: z.string().min(1).max(2000),
  actorLabel: z.string().max(120).optional(),
});

portalRouter.post('/posts/:postId/comments', async (req, res) => {
  const p = getPortal(req);
  const post = await scopedPost(p, req.params.postId);
  const body = commentSchema.parse(req.body);

  const id = newId('cmt');
  await db.insert(postComments).values({
    id,
    agencyId: p.agencyId,
    clientId: p.clientId,
    postId: post.id,
    authorType: 'client',
    portalTokenId: p.tokenId,
    authorLabel: body.actorLabel ?? null,
    body: body.body,
  });

  await audit({
    agencyId: p.agencyId,
    actorType: 'client_token',
    actorId: p.tokenId,
    action: 'post.comment',
    entityType: 'post',
    entityId: post.id,
    ip: req.ip,
  });

  created(res, {
    id,
    body: body.body,
    authorType: 'client',
    actorLabel: body.actorLabel ?? null,
  });
});

// GET /portal/posts/:postId/comments
portalRouter.get('/posts/:postId/comments', async (req, res) => {
  const p = getPortal(req);
  const post = await scopedPost(p, req.params.postId);
  const rows = await db
    .select()
    .from(postComments)
    .where(
      and(
        eq(postComments.agencyId, p.agencyId),
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
      authorLabel: c.authorLabel,
      createdAt: toIso(c.createdAt),
    })),
  );
});
