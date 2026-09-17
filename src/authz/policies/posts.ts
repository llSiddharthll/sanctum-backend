/**
 * Content calendar policy: posts, reservations, post media and social accounts.
 *
 * Every child object is bound to its URL client AND the actor's agency (a
 * mismatch is indistinguishable from "does not exist" → 404). Client-level
 * scope (`assigned` / `organization`) comes from policies/clients.ts; `own` is
 * posts.createdBy / reservations.createdBy. post_media has no uploader column,
 * so media `own` resolves to the parent post's creator (TODO(schema):
 * post_media.uploaded_by).
 *
 * Also holds the post state machine and the approval-validity rule used by
 * "publish now" and the auto-publish job.
 */
import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLog,
  calendarReservations,
  contentPosts,
  postApprovals,
  postMedia,
  socialAccounts,
} from '../../db/schema.js';
import { env } from '../../env.js';
import { badRequest } from '../../lib/errors.js';
import { actorUserId, isClientSide, type Actor } from '../actor.js';
import { capabilities, check, type ObjectFacts } from '../engine.js';
import { clientFacts, clientScopeFilter } from './clients.js';

export type PostRow = typeof contentPosts.$inferSelect;
export type PostStatus = PostRow['status'];

/**
 * authorize() options whose 404-vs-403 view check works when the permission IS
 * the view permission (engine only 404s `.view` permissions when no `view` is
 * passed).
 */
export function viewOpt(permission: string, view: string): { view?: string } {
  return permission === view ? {} : { view };
}

/** Facts of the URL client (null → not in the actor's agency). */
export const postClientFacts = clientFacts;

function childFacts(client: ObjectFacts, ownerIds: Array<string | null | undefined>): ObjectFacts {
  return {
    agencyId: client.agencyId,
    clientId: client.clientId,
    assigned: client.assigned,
    ownerIds,
    projectId: null,
  };
}

// ---------------------------------------------------------------- posts

export interface LoadedPost {
  row: PostRow;
  facts: ObjectFacts;
}

/**
 * Load a post bound to (agency, URL client). Pass the already-loaded client
 * facts to avoid re-querying assignments.
 */
export async function postFacts(
  actor: Actor,
  clientId: string,
  postId: string,
  client?: ObjectFacts | null,
): Promise<LoadedPost | null> {
  const c = client === undefined ? await clientFacts(actor, clientId) : client;
  if (!c || c.clientId !== clientId) return null;
  const [row] = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.id, postId),
        eq(contentPosts.agencyId, actor.agencyId),
        eq(contentPosts.clientId, clientId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { row, facts: childFacts(c, [row.createdBy]) };
}

/** Facts for an already-loaded post row of the given client. */
export function postRowFacts(client: ObjectFacts, row: PostRow): ObjectFacts {
  return childFacts(client, [row.createdBy]);
}

/**
 * SQL predicate for content_posts rows visible under `permission`
 * (client scope ∪ own-created when the permission has an `own` grant).
 */
export async function postScopeFilter(actor: Actor, permission: string): Promise<SQL> {
  const byClient = await clientScopeFilter(actor, permission, contentPosts.clientId);
  const uid = actorUserId(actor);
  const tenant = eq(contentPosts.agencyId, actor.agencyId);
  if (!isClientSide(actor) && uid && actor.grants.hasScope(permission, 'own')) {
    return and(tenant, or(byClient, eq(contentPosts.createdBy, uid))) as SQL;
  }
  return and(tenant, byClient) as SQL;
}

// ---------------------------------------------------------------- state machine

/** Staff-initiated transitions. `approved` / `changes_requested` are client decisions. */
export const STAFF_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  draft: ['pending_approval'],
  pending_approval: ['draft'],
  approved: ['scheduled', 'pending_approval', 'posted', 'draft'],
  changes_requested: ['draft', 'pending_approval'],
  scheduled: ['posted', 'draft'],
  posted: [],
};

/** Permission each transition target needs. */
export const TRANSITION_PERMISSION: Record<PostStatus, string | null> = {
  draft: 'posts.update',
  pending_approval: 'posts.submit_for_approval',
  scheduled: 'posts.schedule',
  posted: 'posts.publish',
  approved: null,
  changes_requested: null,
};

/** Statuses whose content was approved by the client; edits reset them to draft. */
export const APPROVED_STATES: ReadonlySet<PostStatus> = new Set(['approved', 'scheduled', 'posted']);

export const canSchedule = (s: PostStatus) => s === 'approved';
export const canPublish = (s: PostStatus) => s === 'approved' || s === 'scheduled';
export const canSubmit = (s: PostStatus) =>
  s === 'draft' || s === 'changes_requested' || s === 'approved';

export const POST_CAPABILITIES = [
  'posts.update',
  'posts.delete',
  'posts.submit_for_approval',
  'posts.schedule',
  'posts.publish',
  'media.upload',
  'post_comments.create',
] as const;

/** Per-post capability map (permission + scope, AND the state machine where relevant). */
export function postCapabilities(actor: Actor, facts: ObjectFacts, status: PostStatus) {
  const caps = capabilities(actor, facts, [...POST_CAPABILITIES]);
  caps['posts.submit_for_approval'] = !!caps['posts.submit_for_approval'] && canSubmit(status);
  caps['posts.schedule'] = !!caps['posts.schedule'] && canSchedule(status);
  caps['posts.publish'] = !!caps['posts.publish'] && canPublish(status);
  return caps;
}

/** Audit action written when an edit invalidates a client approval. */
export const APPROVAL_RESET_ACTION = 'post.approval_reset';

/**
 * Is the client approval behind an approved/scheduled/posted post still valid?
 * The newest approval-relevant event for the post decides: `post.approved`
 * (client logins + share links) → valid; `post.changes_requested` or an
 * approval reset (content edit, revert, re-submit) → invalid. Audit events are
 * ordered by time then insertion order (rowid), so same-second events resolve
 * correctly. Without any audit event, a post_approvals 'approved' row (legacy
 * share-link decision) is accepted. Posts scheduled without ever being
 * approved (legacy direct scheduling) are not valid.
 */
export async function postApprovalIsValid(agencyId: string, post: Pick<PostRow, 'id' | 'status'>): Promise<boolean> {
  if (post.status !== 'approved' && post.status !== 'scheduled' && post.status !== 'posted') {
    return false;
  }
  const [last] = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.agencyId, agencyId),
        eq(auditLog.entityId, post.id),
        inArray(auditLog.action, ['post.approved', 'post.changes_requested', APPROVAL_RESET_ACTION]),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(sql`rowid`))
    .limit(1);
  if (last) return last.action === 'post.approved';
  const [decision] = await db
    .select({ decision: postApprovals.decision })
    .from(postApprovals)
    .where(and(eq(postApprovals.agencyId, agencyId), eq(postApprovals.postId, post.id)))
    .orderBy(desc(postApprovals.createdAt), desc(sql`rowid`))
    .limit(1);
  return decision?.decision === 'approved';
}

// ---------------------------------------------------------------- reservations

export async function reservationFacts(
  actor: Actor,
  clientId: string,
  reservationId: string,
  client?: ObjectFacts | null,
): Promise<{ row: typeof calendarReservations.$inferSelect; facts: ObjectFacts } | null> {
  const c = client === undefined ? await clientFacts(actor, clientId) : client;
  if (!c || c.clientId !== clientId) return null;
  const [row] = await db
    .select()
    .from(calendarReservations)
    .where(
      and(
        eq(calendarReservations.id, reservationId),
        eq(calendarReservations.agencyId, actor.agencyId),
        eq(calendarReservations.clientId, clientId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { row, facts: childFacts(c, [row.createdBy]) };
}

// ---------------------------------------------------------------- media

export async function mediaFacts(
  actor: Actor,
  mediaId: string,
): Promise<{ row: typeof postMedia.$inferSelect; post: PostRow; facts: ObjectFacts } | null> {
  const [hit] = await db
    .select({ media: postMedia, post: contentPosts })
    .from(postMedia)
    .innerJoin(
      contentPosts,
      and(eq(contentPosts.id, postMedia.postId), eq(contentPosts.agencyId, postMedia.agencyId)),
    )
    .where(and(eq(postMedia.id, mediaId), eq(postMedia.agencyId, actor.agencyId)))
    .limit(1);
  if (!hit || hit.post.clientId !== hit.media.clientId) return null;
  const c = await clientFacts(actor, hit.media.clientId);
  if (!c) return null;
  return { row: hit.media, post: hit.post, facts: childFacts(c, [hit.post.createdBy]) };
}

/** Storage prefix every content-post asset of this client lives under (storage.ts / cloudinary.ts). */
export function postMediaPrefix(agencyId: string, clientId: string): string {
  return `agency/${agencyId}/client/${clientId}/post/`;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * Validate a client-reported uploaded asset before it is attached to a post:
 * the key must be under THIS agency + client's post folder (for this post or
 * the staging folder), and the URL must be served from a configured storage
 * base (Cloudinary cloud / R2 public base / local media base) for that key.
 */
export function assertPostMediaAsset(input: {
  agencyId: string;
  clientId: string;
  postId: string;
  key: string;
  url: string;
}): void {
  const reject = () => {
    throw badRequest('That file does not belong to this workspace.');
  };
  const key = input.key.replace(/^\/+/, '');
  const prefix = postMediaPrefix(input.agencyId, input.clientId);
  if (
    key.includes('..') ||
    key.includes('\0') ||
    !(key.startsWith(`${prefix}${input.postId}/`) || key.startsWith(`${prefix}_staging/`))
  ) {
    reject();
  }
  let u: URL;
  try {
    u = new URL(input.url);
  } catch {
    return reject();
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') reject();
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return reject();
  }
  if (!path.includes(`/${key}`)) reject();

  const href = `${u.origin}${path}`;
  const bases: string[] = [];
  if (env.CLOUDINARY_CLOUD_NAME) bases.push(`https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/`);
  if (env.R2_PUBLIC_BASE_URL) bases.push(`${trimSlash(env.R2_PUBLIC_BASE_URL)}/`);
  if (env.MEDIA_PUBLIC_BASE) bases.push(`${trimSlash(env.MEDIA_PUBLIC_BASE)}/`);
  const okBase = bases.some((b) => href.startsWith(b));
  // Local driver without MEDIA_PUBLIC_BASE serves from <origin>/files/<key>.
  const okLocal =
    env.STORAGE_DRIVER === 'local' && !env.MEDIA_PUBLIC_BASE && path.endsWith(`/files/${key}`);
  if (!okBase && !okLocal) reject();
}

// ---------------------------------------------------------------- social accounts

export async function socialAccountFacts(
  actor: Actor,
  clientId: string,
  accountId: string,
  client?: ObjectFacts | null,
): Promise<{ row: typeof socialAccounts.$inferSelect; facts: ObjectFacts } | null> {
  const c = client === undefined ? await clientFacts(actor, clientId) : client;
  if (!c || c.clientId !== clientId) return null;
  const [row] = await db
    .select()
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.id, accountId),
        eq(socialAccounts.agencyId, actor.agencyId),
        eq(socialAccounts.clientId, clientId),
      ),
    )
    .limit(1);
  if (!row || row.status === 'revoked') return null;
  return { row, facts: childFacts(c, [row.connectedBy]) };
}

/** True when the actor may see content for the client under any content permission. */
export function canSeeClientContent(actor: Actor, client: ObjectFacts): boolean {
  return check(actor, 'posts.view', client);
}

