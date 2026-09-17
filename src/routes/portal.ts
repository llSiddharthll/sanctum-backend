import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  calendarReservations,
  clientAssignments,
  clients,
  contentPosts,
  documents,
  messages,
  messageThreads,
  portalTokens,
  postApprovals,
  postComments,
  postMedia,
  projectMembers,
  projects,
  threadParticipants,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { invalidState, notFound } from '../lib/errors.js';
import { portalLimiter } from '../middleware/rate-limit.js';
import { requirePortalToken } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import {
  notify,
  notifyMany,
  notifyPermissionHolders,
  usersWithPermission,
} from '../services/notifications.js';
import { notifyClientApproval } from '../services/client-notify.js';
import { broadcastNewMessage, broadcastPortalRefresh } from '../realtime/io.js';
import { getActor } from '../authz/http.js';
import { authorize, can, capabilities } from '../authz/engine.js';
import type { Actor, ClientSideActor, PortalLinkActor } from '../authz/actor.js';
import { createSession } from '../authz/sessions.js';
import {
  allowedProjectIds,
  assertPostDecidable,
  clientFileFilter,
  clientPostFilter,
  loadClientPost,
  portalVisibleStatuses,
  postFactsFromRow,
  requireClientSide,
} from '../authz/policies/client-portal.js';

/**
 * Share-link API (`Authorization: Bearer pzt_…`, no session). The token is
 * resolved to a `portal_link` actor by requirePortalToken; every route is then
 * authorized with the LINK ROLE's grants at the `client` scope:
 *   - resolve / post view      → posts.view (+ documents.view for documents)
 *   - comments read / create   → post_comments.view / post_comments.create
 *   - decision                 → posts.approve (share_link role; reviewer links 403)
 * `actorLabel` is free text typed by the visitor: stored as a display label only,
 * never as identity. Audit identity = actorType 'portal_link', actorId = token id.
 */
export const portalRouter = Router();
portalRouter.use(portalLimiter);
portalRouter.use(requirePortalToken);

function linkActor(req: Request): PortalLinkActor {
  const a = getActor(req);
  if (a.type !== 'portal_link') throw notFound('Invalid link.');
  return a;
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
  agencyId: string,
  clientId: string,
): Promise<{ name: string; ownerId: string | null }> {
  const [c] = await db
    .select({ name: clients.name, ownerId: clients.ownerId })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, agencyId)))
    .limit(1);
  return { name: c?.name ?? 'A client', ownerId: c?.ownerId ?? null };
}

/** Display name for a client-side actor's activity (never used as identity). */
export async function clientActorDisplayName(
  actor: ClientSideActor,
  label?: string | null,
): Promise<string> {
  if (actor.type === 'client') {
    const [u] = await db
      .select({ name: users.fullName })
      .from(users)
      .where(and(eq(users.id, actor.userId), eq(users.agencyId, actor.agencyId)))
      .limit(1);
    return u?.name?.trim() || 'Client';
  }
  // Share links have no verified identity: the brand name is authoritative and
  // any typed label is shown only as a quoted, unverified hint.
  const brief = await clientBrief(actor.agencyId, actor.clientId);
  const typed = label?.trim();
  return typed ? `${brief.name} (“${typed}” via share link)` : `${brief.name} (share link)`;
}

/**
 * Fan portal activity (approval / changes / comment) out to the agency by
 * CAPABILITY: holders of posts.publish, plus the brand's account owner.
 * Best-effort: never breaks the client's action.
 */
export async function notifyPortalActivity(opts: {
  agencyId: string;
  clientId: string;
  type: string;
  title: string;
  body: string | null;
  postId: string;
}): Promise<void> {
  try {
    const brief = await clientBrief(opts.agencyId, opts.clientId);
    const base = {
      agencyId: opts.agencyId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      entityType: 'post',
      entityId: opts.postId,
      // Deep-link straight to the post so the bell opens its detail + thread.
      link: `/clients/${opts.clientId}/calendar?post=${opts.postId}`,
    };
    await notifyPermissionHolders(opts.agencyId, 'posts.publish', base, {
      excludeUserId: brief.ownerId ?? undefined,
    });
    if (brief.ownerId) {
      const [owner] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, brief.ownerId),
            eq(users.agencyId, opts.agencyId),
            eq(users.kind, 'staff'),
            eq(users.status, 'active'),
          ),
        )
        .limit(1);
      if (owner) await notify({ ...base, userId: owner.id });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[portal:notify] failed:', (err as Error)?.message ?? err);
  }
}

const DISCUSSION_PREFIX = 'Content discussion';

/**
 * Mirror a client's post comment into the brand's internal "Content discussion"
 * thread with SYSTEM attribution: the message has no sender user
 * (senderId = null, senderName = "<name> (client)"), so it is never authored as
 * an arbitrary owner. Participants = active staff working on the brand (account
 * owner, client assignments, brand project members) + organization-wide
 * posts.view holders.
 * TODO(authz): fold into services/client-discussion.ts (system sender option).
 */
export async function mirrorClientCommentAsSystem(opts: {
  agencyId: string;
  clientId: string;
  postId: string;
  authorName: string;
  body: string;
}): Promise<void> {
  const { agencyId, clientId, postId, authorName } = opts;
  try {
    const [brand] = await db
      .select({ name: clients.name, ownerId: clients.ownerId })
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.agencyId, agencyId)))
      .limit(1);
    if (!brand) return;
    const [assigned, brandProjects, orgViewers] = await Promise.all([
      db
        .select({ userId: clientAssignments.userId })
        .from(clientAssignments)
        .where(and(eq(clientAssignments.agencyId, agencyId), eq(clientAssignments.clientId, clientId))),
      db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.agencyId, agencyId), eq(projects.clientId, clientId))),
      usersWithPermission(agencyId, 'posts.view', { scope: 'organization' }),
    ]);
    const projIds = brandProjects.map((p) => p.id);
    const members = projIds.length
      ? await db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(and(eq(projectMembers.agencyId, agencyId), inArray(projectMembers.projectId, projIds)))
      : [];
    const candidates = [
      ...new Set([
        ...(brand.ownerId ? [brand.ownerId] : []),
        ...assigned.map((a) => a.userId),
        ...members.map((m) => m.userId),
        ...orgViewers,
      ]),
    ];
    if (!candidates.length) return;
    const staff = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.agencyId, agencyId),
            inArray(users.id, candidates),
            eq(users.kind, 'staff'),
            eq(users.status, 'active'),
          ),
        )
    ).map((s) => s.id);
    if (!staff.length) return;

    const [post] = await db
      .select({ caption: contentPosts.caption })
      .from(contentPosts)
      .where(and(eq(contentPosts.id, postId), eq(contentPosts.agencyId, agencyId)))
      .limit(1);
    const caption = (post?.caption ?? '').replace(/\s+/g, ' ').trim();

    const [existing] = await db
      .select({ id: messageThreads.id })
      .from(messageThreads)
      .where(
        and(
          eq(messageThreads.agencyId, agencyId),
          eq(messageThreads.clientId, clientId),
          like(messageThreads.subject, `${DISCUSSION_PREFIX}%`),
        ),
      )
      .limit(1);
    let threadId: string;
    if (existing) {
      threadId = existing.id;
      const current = await db
        .select({ userId: threadParticipants.userId })
        .from(threadParticipants)
        .where(and(eq(threadParticipants.agencyId, agencyId), eq(threadParticipants.threadId, threadId)));
      const have = new Set(current.map((c) => c.userId));
      const missing = staff.filter((u) => !have.has(u));
      if (missing.length) {
        await db
          .insert(threadParticipants)
          .values(missing.map((uid) => ({ id: newId('tpt'), agencyId, threadId, userId: uid })));
      }
    } else {
      threadId = newId('thr');
      await db.insert(messageThreads).values({
        id: threadId,
        agencyId,
        subject: `${DISCUSSION_PREFIX} · ${brand.name}`,
        clientId,
        createdBy: null,
      });
      await db
        .insert(threadParticipants)
        .values(staff.map((uid) => ({ id: newId('tpt'), agencyId, threadId, userId: uid })));
    }

    const text = caption
      ? `💬 ${authorName} (client) commented on “${caption.slice(0, 90)}”:\n${opts.body.trim()}`
      : `💬 ${authorName} (client) commented:\n${opts.body.trim()}`;
    const now = new Date();
    const id = newId('msg');
    await db.insert(messages).values({ id, agencyId, threadId, senderId: null, body: text, createdAt: now });
    await db
      .update(messageThreads)
      .set({ lastMessageAt: now, lastMessagePreview: text.slice(0, 140), updatedAt: now })
      .where(and(eq(messageThreads.id, threadId), eq(messageThreads.agencyId, agencyId)));
    const participants = (
      await db
        .select({ userId: threadParticipants.userId })
        .from(threadParticipants)
        .where(and(eq(threadParticipants.agencyId, agencyId), eq(threadParticipants.threadId, threadId)))
    ).map((p) => p.userId);
    broadcastNewMessage(participants, threadId, {
      id,
      threadId,
      senderId: null,
      senderName: `${authorName} (client)`,
      senderAvatarUrl: null,
      body: text,
      attachments: [],
      createdAt: now.toISOString(),
      editedAt: null,
      pinnedAt: null,
      pinnedBy: null,
    });
    await notifyMany(staff, {
      agencyId,
      type: 'client.discussion',
      title: `${brand.name}: ${authorName} commented`,
      body: opts.body.trim().slice(0, 120),
      entityType: 'thread',
      entityId: threadId,
      link: '/messages',
    });
  } catch {
    // Mirroring is best-effort — never break the client's comment on failure.
  }
}

// POST /portal/session — exchange the share link for a link-bound session.
// Authenticated by the link itself (requirePortalToken). The session carries
// ONLY the link role's grants (not the full client portal), is capped by the
// link's expiry, and dies when the link is revoked or expires.
portalRouter.post('/session', async (req, res) => {
  const actor = linkActor(req);
  const [tok] = await db
    .select({ expiresAt: portalTokens.expiresAt })
    .from(portalTokens)
    .where(eq(portalTokens.id, actor.tokenId))
    .limit(1);
  const session = await createSession({
    actorType: 'portal_link',
    agencyId: actor.agencyId,
    portalTokenId: actor.tokenId,
    notAfter: tok?.expiresAt ?? null,
    req,
  });

  const brief = await clientBrief(actor.agencyId, actor.clientId);
  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, actor.agencyId))
    .limit(1);

  await audit({
    agencyId: actor.agencyId,
    actorType: 'portal_link',
    actorId: actor.tokenId,
    action: 'portal_link.session.create',
    entityType: 'session',
    entityId: session.sessionId,
    metadata: { clientId: actor.clientId, expiresAt: session.expiresAt.toISOString() },
    ip: req.ip,
  });

  ok(res, {
    tokens: { access: session.access, refresh: session.refresh },
    expiresAt: session.expiresAt.toISOString(),
    client: { name: brief.name },
    agency: { name: agency?.name ?? 'Client Portal' },
  });
});

function postCapabilities(actor: Actor, post: typeof contentPosts.$inferSelect, visible: string[]) {
  const facts = postFactsFromRow(post, visible);
  const caps = capabilities(actor, facts, ['posts.approve', 'post_comments.create']);
  caps['posts.approve'] = caps['posts.approve'] === true && post.status === 'pending_approval';
  return caps;
}

// GET /portal/resolve — branding + visible posts (posts.view) + client-visible
// documents (documents.view) for this link.
portalRouter.get('/resolve', async (req, res) => {
  const actor = linkActor(req);

  const [agency] = await db
    .select()
    .from(agencies)
    .where(eq(agencies.id, actor.agencyId))
    .limit(1);
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, actor.clientId), eq(clients.agencyId, actor.agencyId)))
    .limit(1);
  if (!client) throw notFound('Client not found.');

  const visible = await portalVisibleStatuses(actor.agencyId, actor.clientId);
  const posts = await db
    .select()
    .from(contentPosts)
    .where(clientPostFilter(actor, visible))
    .orderBy(asc(contentPosts.scheduledAt));

  const ids = posts.map((p) => p.id);
  const media = ids.length
    ? await db
        .select()
        .from(postMedia)
        .where(and(eq(postMedia.agencyId, actor.agencyId), inArray(postMedia.postId, ids)))
        .orderBy(asc(postMedia.position))
    : [];
  const mediaByPost = new Map<string, typeof media>();
  for (const m of media) {
    const list = mediaByPost.get(m.postId) ?? [];
    list.push(m);
    mediaByPost.set(m.postId, list);
  }

  const allowed = await allowedProjectIds(actor);
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
        eq(documents.agencyId, actor.agencyId),
        eq(documents.archived, false),
        clientFileFilter(
          actor,
          { clientId: documents.clientId, projectId: documents.projectId, clientVisible: documents.clientVisible },
          allowed,
        ),
      ),
    )
    .orderBy(asc(documents.name));

  const reservationRows = can(actor, 'posts.view')
    ? await db
        .select()
        .from(calendarReservations)
        .where(
          and(
            eq(calendarReservations.agencyId, actor.agencyId),
            eq(calendarReservations.clientId, actor.clientId),
          ),
        )
    : [];

  const canApprove = can(actor, 'posts.approve');
  const canComment = can(actor, 'post_comments.create');
  ok(res, {
    agency: agency
      ? { name: agency.name, logoUrl: agency.logoUrl, brandColor: agency.brandColor }
      : null,
    client: {
      id: client.id,
      name: client.name,
      logoUrl: client.logoUrl,
      brandColor: client.brandColor,
      handles: client.handlesJson ? JSON.parse(client.handlesJson) : null,
    },
    portal: {
      visibleStatuses: visible,
      // From the link role's grants (share_link vs share_link_reviewer).
      canApprove,
      canComment,
      portalRole: canApprove ? 'approver' : 'reviewer',
    },
    posts: posts.map((post) => ({
      id: post.id,
      postType: post.postType,
      caption: post.caption,
      platforms: safeArr(post.platformsJson),
      scheduledAt: toIso(post.scheduledAt),
      status: post.status,
      media: (mediaByPost.get(post.id) ?? []).map((m) => ({
        resourceType: m.resourceType,
        secureUrl: m.secureUrl,
        width: m.width,
        height: m.height,
        position: m.position,
        archived: m.archived,
      })),
      capabilities: postCapabilities(actor, post, visible),
    })),
    reservations: reservationRows.map((r) => ({
      id: r.id,
      date: toIso(r.date),
      label: r.label,
    })),
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

/** Load a post the link may see (posts.view, client scope) or 404. */
async function visiblePost(actor: PortalLinkActor, postId: string) {
  const loaded = await loadClientPost(actor, postId);
  authorize(actor, 'posts.view', loaded?.facts);
  return loaded!;
}

// GET /portal/posts/:postId
portalRouter.get('/posts/:postId', async (req, res) => {
  const actor = linkActor(req);
  const { row: post } = await visiblePost(actor, param(req, 'postId'));
  const visible = await portalVisibleStatuses(actor.agencyId, actor.clientId);
  const media = await db
    .select()
    .from(postMedia)
    .where(and(eq(postMedia.agencyId, actor.agencyId), eq(postMedia.postId, post.id)))
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
      archived: m.archived,
    })),
    capabilities: postCapabilities(actor, post, visible),
  });
});

// POST /portal/posts/:postId/decision — approve / request changes (posts.approve).
const decisionSchema = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  note: z.string().max(2000).optional(),
  actorLabel: z.string().max(120).optional(),
});

portalRouter.post('/posts/:postId/decision', async (req, res) => {
  const actor = linkActor(req);
  const loaded = await loadClientPost(actor, param(req, 'postId'));
  authorize(actor, 'posts.approve', loaded?.facts, {
    view: 'posts.view',
    message: 'This link can review and comment, but cannot approve content.',
  });
  const post = loaded!.row;
  const body = decisionSchema.parse(req.body);
  assertPostDecidable(post);

  const newStatus = body.decision === 'approved' ? 'approved' : 'changes_requested';
  const updated = await db
    .update(contentPosts)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(
      and(
        eq(contentPosts.id, post.id),
        eq(contentPosts.agencyId, actor.agencyId),
        eq(contentPosts.clientId, actor.clientId),
        eq(contentPosts.status, 'pending_approval'),
      ),
    )
    .returning({ id: contentPosts.id });
  if (!updated.length) throw invalidState('This post was already decided.');

  const label = body.actorLabel?.trim() || null;
  await db.insert(postApprovals).values({
    id: newId('apr'),
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    postId: post.id,
    portalTokenId: actor.tokenId,
    decision: body.decision,
    note: body.note ?? null,
    actorLabel: label, // display label only (unverified)
    ip: req.ip ?? null,
  });

  await audit({
    agencyId: actor.agencyId,
    actorType: 'portal_link',
    actorId: actor.tokenId,
    action: `post.${body.decision}`,
    entityType: 'post',
    entityId: post.id,
    metadata: { displayLabel: label },
    ip: req.ip,
  });

  const brief = await clientBrief(actor.agencyId, actor.clientId);
  const who = label ? `${brief.name} (“${label}” via share link)` : `${brief.name} (share link)`;
  const captionSnippet = (post.caption ?? '').trim().slice(0, 80);
  await notifyPortalActivity({
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    type: body.decision === 'approved' ? 'post.approved' : 'post.changes',
    title: body.decision === 'approved' ? `${who} approved a post` : `${who} requested changes`,
    body: body.note?.trim() || (captionSnippet ? `“${captionSnippet}”` : null),
    postId: post.id,
  });

  if (body.decision === 'approved') {
    void notifyClientApproval({
      agencyId: actor.agencyId,
      clientId: actor.clientId,
      caption: post.caption,
      reviewer: label,
    }).catch(() => {});
  }
  broadcastPortalRefresh(actor.clientId);

  ok(res, {
    postId: post.id,
    decision: body.decision,
    newStatus,
    note: body.note ?? null,
    actorLabel: label,
    decidedAt: new Date().toISOString(),
  });
});

// POST /portal/posts/:postId/comments — client comment (post_comments.create).
const commentSchema = z.object({
  body: z.string().min(1).max(2000),
  actorLabel: z.string().max(120).optional(),
});

portalRouter.post('/posts/:postId/comments', async (req, res) => {
  const actor = linkActor(req);
  const loaded = await loadClientPost(actor, param(req, 'postId'));
  authorize(actor, 'post_comments.create', loaded?.facts, { view: 'posts.view' });
  const post = loaded!.row;
  const body = commentSchema.parse(req.body);
  const label = body.actorLabel?.trim() || null;

  const id = newId('cmt');
  await db.insert(postComments).values({
    id,
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    postId: post.id,
    authorType: 'client',
    portalTokenId: actor.tokenId,
    authorLabel: label, // display label only (unverified)
    body: body.body,
  });

  await audit({
    agencyId: actor.agencyId,
    actorType: 'portal_link',
    actorId: actor.tokenId,
    action: 'post.comment',
    entityType: 'post',
    entityId: post.id,
    metadata: { commentId: id, displayLabel: label },
    ip: req.ip,
  });

  const name = await clientActorDisplayName(requireClientSide(actor), label);
  await notifyPortalActivity({
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    type: 'post.comment',
    title: `${name} commented`,
    body: body.body.trim().slice(0, 120),
    postId: post.id,
  });
  await mirrorClientCommentAsSystem({
    agencyId: actor.agencyId,
    clientId: actor.clientId,
    postId: post.id,
    authorName: name,
    body: body.body,
  });

  broadcastPortalRefresh(actor.clientId);
  created(res, {
    id,
    body: body.body,
    authorType: 'client',
    actorLabel: label,
  });
});

// GET /portal/posts/:postId/comments — the thread (post_comments.view).
portalRouter.get('/posts/:postId/comments', async (req, res) => {
  const actor = linkActor(req);
  const loaded = await loadClientPost(actor, param(req, 'postId'));
  authorize(actor, 'post_comments.view', loaded?.facts, { view: 'posts.view' });
  const post = loaded!.row;
  // Staff replies are attributed to the agency brand (not an internal name).
  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, actor.agencyId))
    .limit(1);
  const teamName = agency?.name ?? 'The team';
  const rows = await db
    .select({
      id: postComments.id,
      body: postComments.body,
      authorType: postComments.authorType,
      authorLabel: postComments.authorLabel,
      createdAt: postComments.createdAt,
    })
    .from(postComments)
    .where(and(eq(postComments.agencyId, actor.agencyId), eq(postComments.postId, post.id)))
    .orderBy(asc(postComments.createdAt));
  ok(
    res,
    rows.map((c) => ({
      id: c.id,
      body: c.body,
      authorType: c.authorType,
      authorLabel: c.authorLabel,
      authorName: c.authorType === 'client' ? c.authorLabel || 'You' : teamName,
      createdAt: toIso(c.createdAt),
    })),
  );
});
