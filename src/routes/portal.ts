import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, ne, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  clients,
  contentPosts,
  documents,
  postApprovals,
  postComments,
  postMedia,
  projects,
} from '../db/schema.js';
import { ok, created, toIso } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { invalidState, notFound } from '../lib/errors.js';
import { portalLimiter } from '../middleware/rate-limit.js';
import { requirePortalToken } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import { agencyApprovers, notifyMany } from '../services/notifications.js';
import { notifyClientApproval } from '../services/client-notify.js';
import { broadcastPortalRefresh } from '../realtime/io.js';
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

/** Client name + account owner (for attributing portal activity). */
async function clientBrief(
  clientId: string,
): Promise<{ name: string; ownerId: string | null }> {
  const [c] = await db
    .select({ name: clients.name, ownerId: clients.ownerId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  return { name: c?.name ?? 'A client', ownerId: c?.ownerId ?? null };
}

/**
 * Fan a portal activity (approval / changes / comment) out to the agency as an
 * in-app notification — owners/admins plus the client's account owner. Live
 * delivery rides Socket.IO; Turso is the source of truth. Best-effort: a notify
 * failure must never break the client's portal action.
 */
async function notifyPortalActivity(opts: {
  agencyId: string;
  clientId: string;
  ownerId: string | null;
  type: string;
  title: string;
  body: string | null;
  postId: string;
}): Promise<void> {
  try {
    const approvers = await agencyApprovers(opts.agencyId);
    const recipients = new Set(approvers);
    if (opts.ownerId) recipients.add(opts.ownerId);
    if (recipients.size === 0) return;
    await notifyMany([...recipients], {
      agencyId: opts.agencyId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      entityType: 'post',
      entityId: opts.postId,
      // Deep-link straight to the post so the bell opens its detail + thread.
      link: `/clients/${opts.clientId}/calendar?post=${opts.postId}`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[portal:notify] failed:', (err as Error)?.message ?? err);
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
  // Always surface posts the client themselves sent back for changes, so a
  // "Request changes" action doesn't make the post vanish from their own
  // portal — they need to keep tracking it until the agency revises it. (The
  // stored config historically omitted this status.)
  if (!visible.includes('changes_requested')) visible.push('changes_requested');

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

  // Client-facing documents: flagged clientVisible AND belonging to this client
  // directly (clientId) or via a project owned by this client. Internal-only
  // documents (clientVisible=false) are never exposed to the portal.
  const docRows = await db
    .select({
      id: documents.id,
      name: documents.name,
      category: documents.category,
      fileUrl: documents.fileUrl,
      resourceType: documents.resourceType,
      format: documents.format,
      sizeBytes: documents.sizeBytes,
      projectId: documents.projectId,
      projectName: projects.name,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .leftJoin(projects, eq(projects.id, documents.projectId))
    .where(
      and(
        eq(documents.agencyId, p.agencyId),
        eq(documents.clientVisible, true),
        or(
          eq(documents.clientId, p.clientId),
          eq(projects.clientId, p.clientId),
        ),
      ),
    )
    .orderBy(asc(documents.name));

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
    documents: docRows.map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      fileUrl: d.fileUrl,
      resourceType: d.resourceType,
      format: d.format,
      sizeBytes: d.sizeBytes,
      projectId: d.projectId,
      projectName: d.projectName,
      createdAt: toIso(d.createdAt),
    })),
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

  // Real-time notification to the agency (owners/admins + account owner).
  const brief = await clientBrief(p.clientId);
  const who = body.actorLabel?.trim() || brief.name;
  const captionSnippet = (post.caption ?? '').trim().slice(0, 80);
  await notifyPortalActivity({
    agencyId: p.agencyId,
    clientId: p.clientId,
    ownerId: brief.ownerId,
    type: body.decision === 'approved' ? 'post.approved' : 'post.changes',
    title:
      body.decision === 'approved'
        ? `${who} approved a post`
        : `${who} requested changes`,
    body: body.note?.trim() || (captionSnippet ? `“${captionSnippet}”` : null),
    postId: post.id,
  });

  // Email the client a receipt for their approval (best-effort).
  if (body.decision === 'approved') {
    void notifyClientApproval({
      agencyId: p.agencyId,
      clientId: p.clientId,
      caption: post.caption,
      reviewer: body.actorLabel ?? null,
    }).catch(() => {});
  }
  // Keep any other open portal sessions for this client in sync.
  broadcastPortalRefresh(p.clientId);

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

  // Real-time notification to the agency (owners/admins + account owner).
  const brief = await clientBrief(p.clientId);
  const who = body.actorLabel?.trim() || brief.name;
  await notifyPortalActivity({
    agencyId: p.agencyId,
    clientId: p.clientId,
    ownerId: brief.ownerId,
    type: 'post.comment',
    title: `${who} commented`,
    body: body.body.trim().slice(0, 120),
    postId: post.id,
  });

  broadcastPortalRefresh(p.clientId);
  created(res, {
    id,
    body: body.body,
    authorType: 'client',
    actorLabel: body.actorLabel ?? null,
  });
});

// GET /portal/posts/:postId/comments — the two-way thread visible to the client.
portalRouter.get('/posts/:postId/comments', async (req, res) => {
  const p = getPortal(req);
  const post = await scopedPost(p, req.params.postId);
  // Staff replies are attributed to the agency brand (not an internal name).
  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, p.agencyId))
    .limit(1);
  const teamName = agency?.name ?? 'The team';
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
      // Resolved display name for the portal UI: the reviewer's own label for
      // client comments, the agency brand for staff replies.
      authorName:
        c.authorType === 'client'
          ? c.authorLabel || 'You'
          : teamName,
      createdAt: toIso(c.createdAt),
    })),
  );
});
