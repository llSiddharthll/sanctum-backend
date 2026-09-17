import { Router } from 'express';
import { z } from 'zod';
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contentPosts, postMedia } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { invalidState, notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { unarchivePost } from '../services/archive.js';
import { notifyClientReviewReady } from '../services/client-notify.js';
import { broadcastPortalRefresh } from '../realtime/io.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize, type ObjectFacts } from '../authz/engine.js';
import { actorAuditId, type Actor } from '../authz/actor.js';
import { clientFacts } from '../authz/policies/clients.js';
import {
  APPROVAL_RESET_ACTION,
  APPROVED_STATES,
  STAFF_TRANSITIONS,
  TRANSITION_PERMISSION,
  postCapabilities,
  viewOpt,
  postFacts,
  postRowFacts,
  type PostRow,
  type PostStatus,
} from '../authz/policies/posts.js';

// mergeParams so :clientId from the parent mount is available here.
// Mounted at /clients/:clientId/posts; the clients router no longer gates
// nested paths, so this router authenticates and authorizes itself.
export const postsRouter = Router({ mergeParams: true });
postsRouter.use(authenticate);

const POST_TYPES = ['reel', 'story', 'carousel', 'post'] as const;

function serializePost(
  p: PostRow,
  caps?: Record<string, boolean>,
) {
  return {
    id: p.id,
    clientId: p.clientId,
    postType: p.postType,
    caption: p.caption,
    platforms: safeArr(p.platformsJson),
    scheduledAt: toIso(p.scheduledAt),
    status: p.status,
    createdBy: p.createdBy,
    aiGenerationId: p.aiGenerationId,
    archivedAt: toIso(p.archivedAt),
    archivedMonth: p.archivedMonth,
    createdAt: toIso(p.createdAt),
    updatedAt: toIso(p.updatedAt),
    ...(caps ? { capabilities: caps } : {}),
  };
}

function safeArr(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function monthRange(month: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]) - 1;
  if (mon < 0 || mon > 11) return null;
  const from = new Date(Date.UTC(year, mon, 1));
  const to = new Date(Date.UTC(year, mon + 1, 1));
  return { from, to };
}

/** URL client in the actor's scope for `permission` (404 when not visible). */
export async function authorizeContentClient(
  actor: Actor,
  clientId: string,
  permission: string,
): Promise<ObjectFacts> {
  const facts = await clientFacts(actor, clientId);
  authorize(actor, permission, facts, viewOpt(permission, 'posts.view'));
  return facts!;
}

/** Load a post bound to the URL client and authorize `permission` on it. */
export async function authorizePost(
  actor: Actor,
  clientId: string,
  postId: string,
  permission: string,
): Promise<{ row: PostRow; facts: ObjectFacts; client: ObjectFacts }> {
  const client = await clientFacts(actor, clientId);
  const loaded = client ? await postFacts(actor, clientId, postId, client) : null;
  if (!loaded || !client) throw notFound('Post not found.');
  authorize(actor, permission, loaded.facts, viewOpt(permission, 'posts.view'));
  return { ...loaded, client };
}

/**
 * A content change on an approved/scheduled/posted post invalidates the client
 * approval: the post goes back to draft and must be re-approved. Returns true
 * when the status was reset.
 */
export async function resetApprovalIfNeeded(
  actor: Actor,
  post: PostRow,
  reason: string,
  ip?: string,
): Promise<boolean> {
  if (!APPROVED_STATES.has(post.status)) return false;
  await db
    .update(contentPosts)
    .set({ status: 'draft', updatedAt: new Date() })
    .where(and(eq(contentPosts.id, post.id), eq(contentPosts.agencyId, actor.agencyId)));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: APPROVAL_RESET_ACTION,
    entityType: 'post',
    entityId: post.id,
    metadata: { from: post.status, reason },
    ip,
  });
  return true;
}

// GET /clients/:clientId/posts?month=YYYY-MM&status=a,b&type=reel&archived=true
const listQuery = z.object({
  month: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  archived: z.enum(['true', 'false']).optional(),
});

postsRouter.get('/', requires('posts.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  // posts.view has no `own` scope: seeing the client's calendar == the client in scope.
  const client = await authorizeContentClient(actor, clientId, 'posts.view');
  const q = listQuery.parse(req.query);

  const filters = [
    eq(contentPosts.agencyId, actor.agencyId),
    eq(contentPosts.clientId, clientId),
  ];

  // Active calendar excludes archived posts; ?archived=true returns ONLY the
  // month-wise archive (filter to one bucket with ?month=YYYY-MM).
  if (q.archived === 'true') {
    filters.push(isNotNull(contentPosts.archivedAt));
    if (q.month) filters.push(eq(contentPosts.archivedMonth, q.month));
  } else {
    filters.push(isNull(contentPosts.archivedAt));
    if (q.month) {
      const range = monthRange(q.month);
      if (!range) throw notFound('Invalid month.');
      filters.push(gte(contentPosts.scheduledAt, range.from));
      filters.push(lt(contentPosts.scheduledAt, range.to));
    }
  }
  if (q.status) {
    const statuses = q.status.split(',').filter(Boolean) as PostStatus[];
    if (statuses.length) filters.push(inArray(contentPosts.status, statuses));
  }
  if (q.type) {
    const types = q.type
      .split(',')
      .filter((x): x is (typeof POST_TYPES)[number] =>
        (POST_TYPES as readonly string[]).includes(x),
      );
    if (types.length) filters.push(inArray(contentPosts.postType, types));
  }

  const rows = await db
    .select()
    .from(contentPosts)
    .where(and(...filters))
    .orderBy(asc(contentPosts.scheduledAt));

  // Attach a single hero thumbnail (first media by position) per post so the
  // calendar/list can render previews without a per-post detail fetch.
  const heroByPost = new Map<
    string,
    { secureUrl: string; resourceType: 'image' | 'video'; archived: boolean }
  >();
  if (rows.length) {
    const mediaRows = await db
      .select({
        postId: postMedia.postId,
        secureUrl: postMedia.secureUrl,
        resourceType: postMedia.resourceType,
        position: postMedia.position,
        archived: postMedia.archived,
      })
      .from(postMedia)
      .where(
        and(
          eq(postMedia.agencyId, actor.agencyId),
          eq(postMedia.clientId, clientId),
          inArray(
            postMedia.postId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(asc(postMedia.position));
    for (const m of mediaRows) {
      if (!heroByPost.has(m.postId)) {
        heroByPost.set(m.postId, {
          secureUrl: m.secureUrl,
          resourceType: m.resourceType,
          archived: m.archived,
        });
      }
    }
  }

  const serialized = rows.map((p) => {
    const base = serializePost(p, postCapabilities(actor, postRowFacts(client, p), p.status));
    const hero = heroByPost.get(p.id);
    return hero
      ? {
          ...base,
          media: [
            {
              secureUrl: hero.secureUrl,
              resourceType: hero.resourceType,
              position: 0,
              archived: hero.archived,
            },
          ],
        }
      : base;
  });

  ok(res, serialized, 200, { meta: { month: q.month ?? null } });
});

// POST /clients/:clientId/posts — always starts as a draft. `status` stays in the
// schema for compatibility, but only 'draft' is accepted: scheduling requires
// client approval first (see /transition).
const createSchema = z.object({
  postType: z.enum(POST_TYPES),
  caption: z.string().max(5000).optional(),
  platforms: z.array(z.string()).default([]),
  scheduledAt: z.string().datetime().optional(),
  status: z.enum(['draft', 'scheduled', 'posted']).default('draft'),
});

postsRouter.post('/', requires('posts.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const client = await authorizeContentClient(actor, clientId, 'posts.create');
  const body = createSchema.parse(req.body);
  if (body.status !== 'draft') {
    throw invalidState(
      'New posts start as drafts. Send them for approval, then schedule once the client approves.',
    );
  }

  const id = newId('post');
  await db.insert(contentPosts).values({
    id,
    agencyId: actor.agencyId,
    clientId,
    postType: body.postType,
    caption: body.caption ?? null,
    platformsJson: JSON.stringify(body.platforms),
    scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
    status: 'draft',
    createdBy: actor.userId,
  });

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'post.create',
    entityType: 'post',
    entityId: id,
    ip: req.ip,
  });

  const [row] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, id), eq(contentPosts.agencyId, actor.agencyId)));
  broadcastPortalRefresh(clientId);
  created(res, serializePost(row!, postCapabilities(actor, postRowFacts(client, row!), row!.status)));
});

// GET /clients/:clientId/posts/:postId — detail + media.
postsRouter.get('/:postId', requires('posts.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const { row: post, facts } = await authorizePost(actor, clientId, param(req, 'postId'), 'posts.view');

  const media = await db
    .select()
    .from(postMedia)
    .where(
      and(
        eq(postMedia.agencyId, actor.agencyId),
        eq(postMedia.clientId, clientId),
        eq(postMedia.postId, post.id),
      ),
    )
    .orderBy(asc(postMedia.position));

  ok(res, {
    ...serializePost(post, postCapabilities(actor, facts, post.status)),
    media: media.map((m) => ({
      id: m.id,
      cloudinaryPublicId: m.cloudinaryPublicId,
      secureUrl: m.secureUrl,
      resourceType: m.resourceType,
      format: m.format,
      bytes: m.bytes,
      width: m.width,
      height: m.height,
      position: m.position,
      archived: m.archived,
    })),
  });
});

// PATCH /clients/:clientId/posts/:postId
const updateSchema = z.object({
  postType: z.enum(POST_TYPES).optional(),
  caption: z.string().max(5000).nullable().optional(),
  platforms: z.array(z.string()).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
});

postsRouter.patch('/:postId', requires('posts.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const { row: post, facts } = await authorizePost(actor, clientId, param(req, 'postId'), 'posts.update');
  const body = updateSchema.parse(req.body);

  const patch: Partial<typeof contentPosts.$inferInsert> = {};
  // Only fields that actually change count (clients often send the whole post).
  let contentChanged = false;
  if (body.postType !== undefined && body.postType !== post.postType) {
    patch.postType = body.postType;
    contentChanged = true;
  }
  if (body.caption !== undefined && body.caption !== post.caption) {
    patch.caption = body.caption;
    contentChanged = true;
  }
  if (body.platforms !== undefined) {
    const next = JSON.stringify(body.platforms);
    if (next !== JSON.stringify(safeArr(post.platformsJson))) {
      patch.platformsJson = next;
      contentChanged = true;
    }
  }
  if (body.scheduledAt !== undefined) {
    const next = body.scheduledAt ? new Date(body.scheduledAt) : null;
    if ((next?.getTime() ?? null) !== (post.scheduledAt?.getTime() ?? null)) {
      patch.scheduledAt = next;
      // Moving the date of an approved/scheduled post is a scheduling decision.
      if (APPROVED_STATES.has(post.status) && post.status !== 'posted') {
        authorize(actor, 'posts.schedule', facts, { view: 'posts.view' });
      }
    }
  }

  let approvalReset = false;
  if (Object.keys(patch).length) {
    await db
      .update(contentPosts)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(contentPosts.id, post.id), eq(contentPosts.agencyId, actor.agencyId)));
    await audit({
      agencyId: actor.agencyId,
      actorType: actor.type,
      actorId: actor.userId,
      action: 'post.update',
      entityType: 'post',
      entityId: post.id,
      metadata: { fields: Object.keys(patch) },
      ip: req.ip,
    });
    // Edited content needs re-approval (the client approved the old version).
    if (contentChanged) {
      approvalReset = await resetApprovalIfNeeded(actor, post, 'content_edit', req.ip);
    }
  }

  const [row] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, post.id), eq(contentPosts.agencyId, actor.agencyId)));
  broadcastPortalRefresh(clientId);
  ok(res, {
    ...serializePost(row!, postCapabilities(actor, facts, row!.status)),
    approvalReset,
  });
});

// DELETE /clients/:clientId/posts/:postId
postsRouter.delete('/:postId', requires('posts.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const { row: post } = await authorizePost(actor, clientId, param(req, 'postId'), 'posts.delete');

  await db
    .delete(contentPosts)
    .where(
      and(
        eq(contentPosts.id, post.id),
        eq(contentPosts.agencyId, actor.agencyId),
        eq(contentPosts.clientId, clientId),
      ),
    );

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'post.delete',
    entityType: 'post',
    entityId: post.id,
    ip: req.ip,
  });
  broadcastPortalRefresh(clientId);
  ok(res, { deleted: true });
});

// POST /clients/:clientId/posts/:postId/transition
const transitionSchema = z.object({
  to: z.enum([
    'draft',
    'pending_approval',
    'approved',
    'changes_requested',
    'scheduled',
    'posted',
  ]),
});

postsRouter.post('/:postId/transition', async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const body = transitionSchema.parse(req.body);
  // approved / changes_requested are client decisions → no staff permission.
  const permission = TRANSITION_PERMISSION[body.to] ?? 'posts.approve';
  const { row: post, facts } = await authorizePost(actor, clientId, param(req, 'postId'), permission);

  const allowed = STAFF_TRANSITIONS[post.status] ?? [];
  if (!allowed.includes(body.to)) {
    const hint =
      body.to === 'scheduled'
        ? ' Only client-approved posts can be scheduled.'
        : body.to === 'posted'
          ? ' Only approved or scheduled posts can be marked as posted.'
          : '';
    throw invalidState(`Cannot transition from '${post.status}' to '${body.to}'.${hint}`);
  }

  await db
    .update(contentPosts)
    .set({ status: body.to, updatedAt: new Date() })
    .where(
      and(
        eq(contentPosts.id, post.id),
        eq(contentPosts.agencyId, actor.agencyId),
        eq(contentPosts.status, post.status),
      ),
    );

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: `post.transition.${body.to}`,
    entityType: 'post',
    entityId: post.id,
    metadata: { from: post.status },
    ip: req.ip,
  });
  // Leaving an approved state (e.g. re-submitting or reverting) voids the approval.
  if (APPROVED_STATES.has(post.status) && (body.to === 'draft' || body.to === 'pending_approval')) {
    await audit({
      agencyId: actor.agencyId,
      actorType: actor.type,
      actorId: actor.userId,
      action: APPROVAL_RESET_ACTION,
      entityType: 'post',
      entityId: post.id,
      metadata: { from: post.status, reason: `transition_${body.to}` },
      ip: req.ip,
    });
  }

  // Email the client when content becomes reviewable. Revisions of a post they
  // sent back ("changes addressed") always notify; a fresh send only notifies
  // when it's the FIRST pending post — so sending a batch emails them once.
  if (body.to === 'pending_approval') {
    const wasChanges = post.status === 'changes_requested';
    let shouldEmail = wasChanges;
    if (!wasChanges) {
      const [{ n }] = await db
        .select({ n: count() })
        .from(contentPosts)
        .where(
          and(
            eq(contentPosts.agencyId, actor.agencyId),
            eq(contentPosts.clientId, clientId),
            eq(contentPosts.status, 'pending_approval'),
            ne(contentPosts.id, post.id),
          ),
        );
      shouldEmail = Number(n) === 0;
    }
    if (shouldEmail) {
      void notifyClientReviewReady({
        agencyId: actor.agencyId,
        clientId,
        createdBy: actor.userId,
        kind: wasChanges ? 'changes' : 'new',
      }).catch(() => {});
    }
  }

  broadcastPortalRefresh(clientId);

  const [row] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, post.id), eq(contentPosts.agencyId, actor.agencyId)));
  ok(res, serializePost(row!, postCapabilities(actor, facts, row!.status)));
});

// POST /clients/:clientId/posts/:id/unarchive — restore an archived post of THIS
// client to the active calendar.
postsRouter.post('/:id/unarchive', requires('posts.restore'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const { row: post, facts } = await authorizePost(actor, clientId, param(req, 'id'), 'posts.restore');
  if (!post.archivedAt) throw notFound('Archived post not found.');
  const restored = await unarchivePost(actor.agencyId, post.id, post.clientId);
  if (!restored) throw notFound('Archived post not found.');
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'post.restore',
    entityType: 'post',
    entityId: post.id,
    ip: req.ip,
  });
  broadcastPortalRefresh(clientId);
  const [row] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, post.id), eq(contentPosts.agencyId, actor.agencyId)));
  ok(res, serializePost(row!, postCapabilities(actor, facts, row!.status)));
});
