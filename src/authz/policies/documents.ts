/**
 * Documents & folders policy.
 *  - documents: `own` = uploadedBy; hidden (hideFromTeam) documents additionally
 *    need `documents.view_hidden`; project-linked documents need `projects.view`
 *    on that project.
 *  - folders: organization-scope permissions; `own` = createdBy (informational).
 *
 * Staff surface only (routes/documents.ts). Client-side document access goes
 * through the client portal routers.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { db } from '../../db/client.js';
import { documentFolders, documents, projectMembers, projects } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import { actorUserId, isClientSide, type Actor } from '../actor.js';
import { canOrg, check, type ObjectFacts } from '../engine.js';
import { assertAgencyStorageKey } from '../tenancy.js';

/** Business/legal categories: always hidden from the team. */
export const OWNER_ONLY_CATEGORIES: ReadonlySet<string> = new Set([
  'proposal',
  'agreement',
  'contract',
  'nda',
  'invoice',
]);

/** Business record each business category creates on upload → required permission. */
export const BUSINESS_CATEGORY_PERMISSION: Readonly<Record<string, string>> = {
  proposal: 'proposals.create',
  agreement: 'agreements.create',
  contract: 'agreements.create',
  nda: 'agreements.create',
  invoice: 'invoices.create',
};

export const DOCUMENT_CAPABILITIES = [
  'documents.update',
  'documents.delete',
  'documents.share_with_client',
  'documents.hide_from_team',
] as const;

export const FOLDER_CAPABILITIES = ['folders.update', 'folders.delete'] as const;

// ------------------------------------------------------------------ projects

/**
 * Minimal `projects.view` evaluation for a project reference (organization →
 * any project in tenant; assigned → project member). Returns false when the
 * project doesn't exist in the actor's agency.
 */
export async function canViewProject(actor: Actor, projectId: string): Promise<boolean> {
  if (isClientSide(actor)) return false;
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.agencyId, actor.agencyId)))
    .limit(1);
  if (!p) return false;
  if (canOrg(actor, 'projects.view')) return true;
  const uid = actorUserId(actor);
  if (!uid || !actor.grants.hasScope('projects.view', 'assigned')) return false;
  const [m] = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.agencyId, actor.agencyId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, uid),
      ),
    )
    .limit(1);
  return !!m;
}

/**
 * SQL predicate for a nullable projectId column: project-less rows always pass;
 * project-bound rows need `projects.view` on the project.
 */
export async function projectLinkFilter(actor: Actor, projectIdColumn: SQLiteColumn): Promise<SQL> {
  if (canOrg(actor, 'projects.view')) return sql`1`;
  const uid = actorUserId(actor);
  if (!uid || isClientSide(actor) || !actor.grants.hasScope('projects.view', 'assigned')) {
    return isNull(projectIdColumn);
  }
  const rows = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.agencyId, actor.agencyId), eq(projectMembers.userId, uid)));
  const ids = rows.map((r) => r.id);
  return ids.length ? or(isNull(projectIdColumn), inArray(projectIdColumn, ids))! : isNull(projectIdColumn);
}

// ------------------------------------------------------------------ documents

export type DocumentRecord = typeof documents.$inferSelect;

export function documentFactsFrom(d: Pick<DocumentRecord, 'agencyId' | 'uploadedBy' | 'clientId' | 'projectId' | 'clientVisible'>): ObjectFacts {
  return {
    agencyId: d.agencyId,
    ownerIds: [d.uploadedBy],
    clientId: d.clientId,
    projectId: d.projectId,
    clientVisible: d.clientVisible,
  };
}

/**
 * Load a document the actor can SEE (null → 404): in tenant, `documents.view`,
 * `documents.view_hidden` when hidden, `projects.view` when project-bound.
 */
export async function visibleDocument(
  actor: Actor,
  documentId: string,
): Promise<{ row: DocumentRecord; facts: ObjectFacts } | null> {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) return null;
  const facts = documentFactsFrom(row);
  if (!check(actor, 'documents.view', facts)) return null;
  if (row.hideFromTeam && !check(actor, 'documents.view_hidden', facts)) return null;
  if (row.projectId && !(await canViewProject(actor, row.projectId))) return null;
  return { row, facts };
}

/** SQL filter for document lists (tenant + hidden + project visibility). */
export async function documentListFilter(actor: Actor): Promise<SQL[]> {
  const filters: SQL[] = [eq(documents.agencyId, actor.agencyId)];
  if (!canOrg(actor, 'documents.view')) filters.push(sql`0`);
  if (!canOrg(actor, 'documents.view_hidden')) filters.push(eq(documents.hideFromTeam, false));
  filters.push(await projectLinkFilter(actor, documents.projectId));
  return filters;
}

export function documentCapabilities(actor: Actor, facts: ObjectFacts): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of DOCUMENT_CAPABILITIES) out[p] = check(actor, p, facts);
  return out;
}

// ------------------------------------------------------------------ folders

export type FolderRecord = typeof documentFolders.$inferSelect;

export function folderFactsFrom(f: Pick<FolderRecord, 'agencyId' | 'createdBy' | 'clientId' | 'projectId' | 'clientVisible'>): ObjectFacts {
  return {
    agencyId: f.agencyId,
    ownerIds: [f.createdBy],
    clientId: f.clientId,
    projectId: f.projectId,
    clientVisible: f.clientVisible,
  };
}

export async function folderFacts(
  actor: Actor,
  folderId: string,
): Promise<{ row: FolderRecord; facts: ObjectFacts } | null> {
  const [row] = await db
    .select()
    .from(documentFolders)
    .where(and(eq(documentFolders.id, folderId), eq(documentFolders.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) return null;
  return { row, facts: folderFactsFrom(row) };
}

export function folderCapabilities(actor: Actor, facts: ObjectFacts): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of FOLDER_CAPABILITIES) out[p] = check(actor, p, facts);
  return out;
}

// ------------------------------------------------------------------ storage

/**
 * A storage key (Cloudinary public_id / R2 or local object key) is deletable by
 * this agency only when it lives under `sanctum/<agencyId>/` with no path
 * traversal. Uses tenancy.assertAgencyStorageKey plus a strict prefix check.
 */
export function isAgencyStorageKey(agencyId: string, key: string): boolean {
  const prefix = `sanctum/${agencyId}/`;
  if (!key.startsWith(prefix)) return false;
  if (key.split(/[\\/]/).some((seg) => seg === '..' || seg === '.')) return false;
  return true;
}

/**
 * Validate an uploaded file reference. When `publicId` (a storage key) is
 * given, both it and `fileUrl` must belong to this agency's storage prefix.
 * Without a `publicId` the document is an external link: it is stored as-is
 * and never deleted from storage.
 */
export function assertDocumentStorage(agencyId: string, fileUrl: string, publicId: string | null | undefined): void {
  if (!publicId) return;
  assertAgencyStorageKey(agencyId, publicId);
  assertAgencyStorageKey(agencyId, fileUrl);
  if (!isAgencyStorageKey(agencyId, publicId)) {
    throw badRequest('That file does not belong to this workspace.');
  }
}
