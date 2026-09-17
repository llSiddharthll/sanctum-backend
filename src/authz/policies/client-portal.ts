/**
 * Client-portal policy: facts + SQL filters for CLIENT-SIDE actors (logged-in
 * client users and share-link sessions/tokens). Every object is evaluated with
 * the `client` scope: facts { agencyId, clientId, projectId, clientVisible }.
 *
 * Rules (design §E.4, §G.2 "Client actors"):
 *  - the object must belong to the actor's brand (clientId);
 *  - project-bound objects must sit in a project the actor may see: the project
 *    must STILL belong to the brand (stale scope) and be in the selection when
 *    projectAccess.mode = 'selected' (empty selection = none, fail closed);
 *  - brand-level (project-less) objects are visible whenever the permission is
 *    held;
 *  - client-visible flags are respected (documents/folders `clientVisible`,
 *    post visible statuses, non-draft business documents).
 */
import { and, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  agreements,
  clients,
  contentPosts,
  documentFolders,
  documents,
  invoices,
  projects,
  proposals,
} from '../../db/schema.js';
import { forbidden, invalidState } from '../../lib/errors.js';
import { assertAgreementSignable, assertProposalRespondable } from './business.js';
import { isClientSide, type Actor, type ClientSideActor } from '../actor.js';
import type { ObjectFacts } from '../engine.js';

// ------------------------------------------------------------ actor helpers

/** Narrow to a client-side actor; staff / system principals get 403. */
export function requireClientSide(actor: Actor): ClientSideActor {
  if (!isClientSide(actor)) throw forbidden('Client access only.');
  return actor;
}

/** True when the client-side actor holds `permission` at the `client` scope. */
export function holdsClientPermission(actor: Actor, permission: string): boolean {
  return isClientSide(actor) && actor.grants.hasScope(permission, 'client');
}

/**
 * Project ids the actor may see: projects of the actor's brand in its agency,
 * intersected with the selection for mode='selected' ([] = none).
 */
export async function allowedProjectIds(actor: ClientSideActor): Promise<string[]> {
  if (actor.projectAccess.mode === 'selected' && actor.projectAccess.projectIds.length === 0) {
    return [];
  }
  const conds = [eq(projects.agencyId, actor.agencyId), eq(projects.clientId, actor.clientId)];
  if (actor.projectAccess.mode === 'selected') {
    conds.push(inArray(projects.id, actor.projectAccess.projectIds));
  }
  const rows = await db.select({ id: projects.id }).from(projects).where(and(...conds));
  return rows.map((r) => r.id);
}

/**
 * SQL predicate for a client-side list: `permission` held at client scope AND
 * the row's clientId is the actor's brand AND (when the resource has a project
 * column) the row is brand-level or bound to an allowed project.
 */
export function clientRowFilter(
  actor: ClientSideActor,
  permission: string,
  cols: { clientId: AnyColumn; projectId?: AnyColumn },
  allowedProjects: string[],
): SQL {
  if (!holdsClientPermission(actor, permission)) return sql`0`;
  const brand = eq(cols.clientId, actor.clientId);
  if (!cols.projectId) return brand;
  const project = allowedProjects.length
    ? or(isNull(cols.projectId), inArray(cols.projectId, allowedProjects))!
    : isNull(cols.projectId);
  return and(brand, project)!;
}

/**
 * Brand that a (possibly project-bound) object effectively belongs to: for
 * project-bound objects the PROJECT's brand, and only when it agrees with the
 * object's own clientId (if any). Mismatch → null (never visible to clients).
 */
function effectiveClientId(
  objectClientId: string | null,
  projectId: string | null,
  projectClientId: string | null,
): string | null {
  if (!projectId) return objectClientId;
  if (!projectClientId) return null;
  if (objectClientId && objectClientId !== projectClientId) return null;
  return projectClientId;
}

/** Brand of a project in the agency (null when absent). */
async function projectClientId(agencyId: string, projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const [p] = await db
    .select({ clientId: projects.clientId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.agencyId, agencyId)))
    .limit(1);
  return p?.clientId ?? null;
}

// ------------------------------------------------------------ projects

export async function clientProjectFacts(actor: Actor, projectId: string): Promise<ObjectFacts | null> {
  const [p] = await db
    .select({ id: projects.id, agencyId: projects.agencyId, clientId: projects.clientId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.agencyId, actor.agencyId)))
    .limit(1);
  if (!p) return null;
  return { agencyId: p.agencyId, clientId: p.clientId, projectId: p.id, clientVisible: true };
}

// ------------------------------------------------------------ documents / folders

export async function loadClientDocument(actor: Actor, id: string) {
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.agencyId, actor.agencyId)))
    .limit(1);
  if (!doc) return null;
  const facts: ObjectFacts = {
    agencyId: doc.agencyId,
    clientId: effectiveClientId(doc.clientId, doc.projectId, await projectClientId(doc.agencyId, doc.projectId)),
    projectId: doc.projectId,
    clientVisible: doc.clientVisible && !doc.archived,
  };
  return { row: doc, facts };
}

export async function loadClientFolder(actor: Actor, id: string) {
  const [folder] = await db
    .select()
    .from(documentFolders)
    .where(and(eq(documentFolders.id, id), eq(documentFolders.agencyId, actor.agencyId)))
    .limit(1);
  if (!folder) return null;
  const facts: ObjectFacts = {
    agencyId: folder.agencyId,
    clientId: effectiveClientId(folder.clientId, folder.projectId, await projectClientId(folder.agencyId, folder.projectId)),
    projectId: folder.projectId,
    clientVisible: folder.clientVisible,
  };
  return { row: folder, facts };
}

/**
 * SQL filter for documents/folders visible to the actor: clientVisible AND
 * (brand-level with clientId = brand, OR bound to an allowed project, whose
 * brand is re-checked through `allowedProjects`, with no conflicting clientId).
 * Fixes the old `clientId = brand OR projectId ∈ scope` leak.
 */
export function clientFileFilter(
  actor: ClientSideActor,
  cols: { clientId: AnyColumn; projectId: AnyColumn; clientVisible: AnyColumn },
  allowedProjects: string[],
): SQL {
  if (!holdsClientPermission(actor, 'documents.view')) return sql`0`;
  const brandLevel = and(isNull(cols.projectId), eq(cols.clientId, actor.clientId))!;
  const inProject = allowedProjects.length
    ? and(
        inArray(cols.projectId, allowedProjects),
        or(isNull(cols.clientId), eq(cols.clientId, actor.clientId)),
      )!
    : undefined;
  return and(eq(cols.clientVisible, true), inProject ? or(brandLevel, inProject) : brandLevel)!;
}

// ------------------------------------------------------------ posts

/** Statuses the brand exposes in the portal (+ changes_requested, always). */
export async function portalVisibleStatuses(agencyId: string, clientId: string): Promise<string[]> {
  const [c] = await db
    .select({ visible: clients.portalVisibleStatuses })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, agencyId)))
    .limit(1);
  const visible = (c?.visible ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'draft');
  // A "Request changes" action must never make the post vanish for the client.
  if (!visible.includes('changes_requested')) visible.push('changes_requested');
  return visible;
}

type PostRow = typeof contentPosts.$inferSelect;

export function postFactsFromRow(post: PostRow, visibleStatuses: string[]): ObjectFacts {
  return {
    agencyId: post.agencyId,
    clientId: post.clientId,
    projectId: null, // posts are brand-level (no project column)
    clientVisible:
      post.status !== 'draft' && !post.archivedAt && visibleStatuses.includes(post.status),
  };
}

export async function loadClientPost(actor: Actor, postId: string) {
  const [post] = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.id, postId), eq(contentPosts.agencyId, actor.agencyId)))
    .limit(1);
  if (!post) return null;
  const visible = isClientSide(actor)
    ? await portalVisibleStatuses(actor.agencyId, actor.clientId)
    : [];
  return { row: post, facts: postFactsFromRow(post, visible) };
}

/** SQL filter for the client calendar. */
export function clientPostFilter(actor: ClientSideActor, visibleStatuses: string[]): SQL {
  if (!holdsClientPermission(actor, 'posts.view') || !visibleStatuses.length) return sql`0`;
  return and(
    eq(contentPosts.agencyId, actor.agencyId),
    eq(contentPosts.clientId, actor.clientId),
    inArray(contentPosts.status, visibleStatuses as PostRow['status'][]),
    isNull(contentPosts.archivedAt),
  )!;
}

// ------------------------------------------------------------ proposals / agreements / invoices

export async function loadClientProposal(actor: Actor, id: string) {
  const [p] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, id), eq(proposals.agencyId, actor.agencyId)))
    .limit(1);
  if (!p) return null;
  const facts: ObjectFacts = {
    agencyId: p.agencyId,
    clientId: p.clientId,
    projectId: null, // proposals are brand-level (no project column)
    clientVisible: p.status !== 'draft',
  };
  return { row: p, facts };
}

export async function loadClientAgreement(actor: Actor, id: string) {
  const [a] = await db
    .select()
    .from(agreements)
    .where(and(eq(agreements.id, id), eq(agreements.agencyId, actor.agencyId)))
    .limit(1);
  if (!a) return null;
  const facts: ObjectFacts = {
    agencyId: a.agencyId,
    clientId: effectiveClientId(a.clientId, a.projectId, await projectClientId(a.agencyId, a.projectId)),
    projectId: a.projectId,
    clientVisible: a.status !== 'draft',
  };
  return { row: a, facts };
}

export async function loadClientInvoice(actor: Actor, id: string) {
  const [i] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.agencyId, actor.agencyId)))
    .limit(1);
  if (!i) return null;
  const facts: ObjectFacts = {
    agencyId: i.agencyId,
    clientId: effectiveClientId(i.clientId, i.projectId, await projectClientId(i.agencyId, i.projectId)),
    projectId: i.projectId,
    clientVisible: i.status !== 'draft',
  };
  return { row: i, facts };
}

// ------------------------------------------------------------ state guards
// Proposal / agreement guards live in policies/business.ts (shared with the
// public document links); the boolean forms below feed `capabilities`.

type AgreementRow = typeof agreements.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;

function passes(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

export const proposalRespondable = (p: Pick<ProposalRow, 'status' | 'validUntil'>): boolean =>
  passes(() => assertProposalRespondable(p));

export const agreementSignable = (a: Pick<AgreementRow, 'status' | 'signedAt' | 'expirationDate'>): boolean =>
  passes(() => assertAgreementSignable(a));

/** Client post decisions (approve / request changes) only from pending_approval. */
export function assertPostDecidable(post: Pick<PostRow, 'status'>): void {
  if (post.status !== 'pending_approval') {
    throw invalidState(`This post is '${post.status}' and cannot be decided.`);
  }
}
