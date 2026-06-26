import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contentPosts, postMedia } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { invalidState, notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth, requireClientAccess } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';

// mergeParams so :clientId from the parent mount is available here.
export const postsRouter = Router({ mergeParams: true });
postsRouter.use(requireAuth);
// Content posts are part of the Clients module (mounted outside clientsRouter,
// so the module gate must be re-applied here): GET=view, writes=manage.
postsRouter.use(requireModuleRW('clients'));

type PostStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'changes_requested'
  | 'scheduled'
  | 'posted';

// Legal staff-initiated status transitions (client-only statuses excluded here).
const TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  draft: ['pending_approval', 'scheduled'],
  pending_approval: ['draft', 'scheduled'],
  approved: ['scheduled', 'pending_approval'],
  changes_requested: ['draft', 'pending_approval'],
  scheduled: ['posted', 'draft'],
  posted: [],
};

const POST_TYPES = ['reel', 'story', 'carousel', 'post'] as const;

function serializePost(p: typeof contentPosts.$inferSelect) {
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
    createdAt: toIso(p.createdAt),
    updatedAt: toIso(p.updatedAt),
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

// GET /clients/:clientId/posts?month=YYYY-MM&status=a,b&type=reel
const listQuery = z.object({
  month: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
});

postsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const q = listQuery.parse(req.query);

  const filters = [
    eq(contentPosts.agencyId, ctx.agencyId),
    eq(contentPosts.clientId, clientId),
  ];

  if (q.month) {
    const range = monthRange(q.month);
    if (!range) throw notFound('Invalid month.');
    filters.push(gte(contentPosts.scheduledAt, range.from));
    filters.push(lt(contentPosts.scheduledAt, range.to));
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

  ok(res, rows.map(serializePost), 200, { meta: { month: q.month ?? null } });
});

// POST /clients/:clientId/posts
const createSchema = z.object({
  postType: z.enum(POST_TYPES),
  caption: z.string().max(5000).optional(),
  platforms: z.array(z.string()).default([]),
  scheduledAt: z.string().datetime().optional(),
  status: z.enum(['draft', 'scheduled']).default('draft'),
});

postsRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const body = createSchema.parse(req.body);

  const id = newId('post');
  await db.insert(contentPosts).values({
    id,
    agencyId: ctx.agencyId,
    clientId,
    postType: body.postType,
    caption: body.caption ?? null,
    platformsJson: JSON.stringify(body.platforms),
    scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
    status: body.status,
    createdBy: ctx.userId,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'post.create',
    entityType: 'post',
    entityId: id,
    ip: req.ip,
  });

  const [row] = await db
    .select()
    .from(contentPosts)
    .where(eq(contentPosts.id, id));
  created(res, serializePost(row!));
});

/** Fetch a post within the caller's tenant+client or throw 404. */
async function getScopedPost(
  ctx: ReturnType<typeof getAuth>,
  clientId: string,
  postId: string,
) {
  const [row] = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.id, postId),
        eq(contentPosts.agencyId, ctx.agencyId),
        eq(contentPosts.clientId, clientId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Post not found.');
  return row;
}

// GET /clients/:clientId/posts/:postId — detail + media.
postsRouter.get('/:postId', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const post = await getScopedPost(ctx, clientId, param(req, 'postId'));

  const media = await db
    .select()
    .from(postMedia)
    .where(
      and(
        eq(postMedia.agencyId, ctx.agencyId),
        eq(postMedia.postId, post.id),
      ),
    )
    .orderBy(asc(postMedia.position));

  ok(res, {
    ...serializePost(post),
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

postsRouter.patch('/:postId', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const post = await getScopedPost(ctx, clientId, param(req, 'postId'));
  const body = updateSchema.parse(req.body);

  const patch: Partial<typeof contentPosts.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.postType !== undefined) patch.postType = body.postType;
  if (body.caption !== undefined) patch.caption = body.caption;
  if (body.platforms !== undefined)
    patch.platformsJson = JSON.stringify(body.platforms);
  if (body.scheduledAt !== undefined)
    patch.scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;

  await db
    .update(contentPosts)
    .set(patch)
    .where(
      and(
        eq(contentPosts.id, post.id),
        eq(contentPosts.agencyId, ctx.agencyId),
      ),
    );

  const [row] = await db
    .select()
    .from(contentPosts)
    .where(eq(contentPosts.id, post.id));
  ok(res, serializePost(row!));
});

// DELETE /clients/:clientId/posts/:postId
postsRouter.delete('/:postId', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const post = await getScopedPost(ctx, clientId, param(req, 'postId'));

  await db
    .delete(contentPosts)
    .where(
      and(
        eq(contentPosts.id, post.id),
        eq(contentPosts.agencyId, ctx.agencyId),
      ),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'post.delete',
    entityType: 'post',
    entityId: post.id,
    ip: req.ip,
  });
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
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const post = await getScopedPost(ctx, clientId, param(req, 'postId'));
  const body = transitionSchema.parse(req.body);

  const allowed = TRANSITIONS[post.status as PostStatus] ?? [];
  if (!allowed.includes(body.to)) {
    throw invalidState(
      `Cannot transition from '${post.status}' to '${body.to}'.`,
    );
  }

  await db
    .update(contentPosts)
    .set({ status: body.to, updatedAt: new Date() })
    .where(
      and(
        eq(contentPosts.id, post.id),
        eq(contentPosts.agencyId, ctx.agencyId),
      ),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: `post.transition.${body.to}`,
    entityType: 'post',
    entityId: post.id,
    ip: req.ip,
  });

  const [row] = await db
    .select()
    .from(contentPosts)
    .where(eq(contentPosts.id, post.id));
  ok(res, serializePost(row!));
});
