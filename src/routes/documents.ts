import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, like, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  projects,
  documents,
  documentFolders,
  users,
  proposals,
  agreements,
  invoices,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { signDocumentUpload, deleteAsset } from '../services/storage.js';
import { uploadOrigin } from '../services/local-storage.js';
import { audit } from '../services/audit.js';
import { authenticate, getActor, requires } from '../authz/http.js';
import { authorize, requirePermission, type ObjectFacts } from '../authz/engine.js';
import type { StaffActor } from '../authz/actor.js';
import { requireInAgency } from '../authz/tenancy.js';
import {
  BUSINESS_CATEGORY_PERMISSION,
  OWNER_ONLY_CATEGORIES,
  assertDocumentStorage,
  canViewProject,
  documentCapabilities,
  documentFactsFrom,
  documentListFilter,
  folderCapabilities,
  folderFacts,
  folderFactsFrom,
  isAgencyStorageKey,
  projectLinkFilter,
  visibleDocument,
} from '../authz/policies/documents.js';

/**
 * Documents hub + folders (staff surface; client-side access goes through the
 * client portal routers).
 *
 * Permissions (docs/authorization/README.md §D.7, §G.2):
 *  - documents.view (hidden docs also need documents.view_hidden; project-bound
 *    docs need projects.view on the project)
 *  - documents.upload; business categories (proposal/agreement/contract/nda/
 *    invoice) additionally need proposals.create / agreements.create /
 *    invoices.create (otherwise 403 — we REJECT rather than silently store a
 *    plain document) and documents.hide_from_team (they are always hidden)
 *  - documents.update / documents.delete (own = uploader, organization)
 *  - documents.share_with_client to make a document/folder client-visible
 *  - documents.hide_from_team to hide a document (or move it into a hidden category)
 *  - folders.create / folders.update / folders.delete
 *  - storage keys must live under sanctum/<agencyId>/ (cross-tenant delete fix)
 */
export const documentsRouter = Router();
documentsRouter.use(authenticate);

const DOCUMENT_CATEGORIES = [
  'contract',
  'nda',
  'proposal',
  'agreement',
  'deliverable',
  'invoice',
  'report',
  'design',
  'ai_generated',
  'misc',
] as const;

/** Categories that spawn a Proposal record on upload. */
const PROPOSAL_CATEGORIES = new Set(['proposal']);
/** Categories that spawn an Agreement record on upload (needs a client). */
const AGREEMENT_CATEGORIES = new Set(['agreement', 'contract', 'nda']);
/** Categories that spawn an Invoice record on upload (needs a client). */
const INVOICE_CATEGORIES = new Set(['invoice']);
const RESOURCE_TYPES = ['image', 'raw', 'video'] as const;

/** This router is the agency (staff) surface. */
function staffActor(req: Request): StaffActor {
  const a = getActor(req);
  if (a.type !== 'staff') throw forbidden('Use the client portal for documents.');
  return a;
}

const documentSelection = {
  id: documents.id,
  agencyId: documents.agencyId,
  name: documents.name,
  category: documents.category,
  clientId: documents.clientId,
  projectId: documents.projectId,
  fileUrl: documents.fileUrl,
  publicId: documents.publicId,
  resourceType: documents.resourceType,
  format: documents.format,
  mimeType: documents.mimeType,
  sizeBytes: documents.sizeBytes,
  clientVisible: documents.clientVisible,
  hideFromTeam: documents.hideFromTeam,
  folderId: documents.folderId,
  archived: documents.archived,
  uploadedBy: documents.uploadedBy,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  clientName: clients.name,
  projectName: projects.name,
  uploadedByName: users.fullName,
};

type DocumentRow = {
  id: string;
  agencyId: string;
  name: string;
  category: string;
  clientId: string | null;
  projectId: string | null;
  fileUrl: string;
  publicId: string | null;
  resourceType: string;
  format: string | null;
  mimeType: string | null;
  sizeBytes: number;
  clientVisible: boolean;
  hideFromTeam: boolean;
  folderId: string | null;
  archived: boolean;
  uploadedBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  clientName: string | null;
  projectName: string | null;
  uploadedByName: string | null;
};

function serializeDocument(actor: StaffActor, d: DocumentRow) {
  return {
    id: d.id,
    name: d.name,
    category: d.category,
    clientId: d.clientId,
    clientName: d.clientName,
    projectId: d.projectId,
    projectName: d.projectName,
    fileUrl: d.fileUrl,
    publicId: d.publicId,
    resourceType: d.resourceType,
    format: d.format,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    clientVisible: d.clientVisible,
    hideFromTeam: d.hideFromTeam,
    folderId: d.folderId,
    archived: d.archived,
    uploadedBy: d.uploadedBy,
    uploadedByName: d.uploadedByName,
    createdAt: toIso(d.createdAt),
    updatedAt: toIso(d.updatedAt),
    capabilities: documentCapabilities(actor, documentFactsFrom(d)),
  };
}

/** Joined row for a document id already authorized for the actor. */
async function loadDocumentRow(actor: StaffActor, documentId: string): Promise<DocumentRow> {
  const [row] = await db
    .select(documentSelection)
    .from(documents)
    .leftJoin(clients, eq(clients.id, documents.clientId))
    .leftJoin(projects, eq(projects.id, documents.projectId))
    .leftJoin(users, eq(users.id, documents.uploadedBy))
    .where(and(eq(documents.id, documentId), eq(documents.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) throw notFound('Document not found.');
  return row as DocumentRow;
}

/** A document the actor can see, authorized for `permission` (404 when invisible). */
async function authorizeDocument(actor: StaffActor, documentId: string, permission: string) {
  const loaded = await visibleDocument(actor, documentId);
  if (!loaded) throw notFound('Document not found.');
  authorize(actor, permission, loaded.facts, { view: 'documents.view' });
  return loaded;
}

/** Project references require projects.view on that project (404 otherwise). */
async function requireViewableProject(actor: StaffActor, projectId: string): Promise<void> {
  if (!(await canViewProject(actor, projectId))) throw notFound('Project not found.');
}

function serializeFolder(actor: StaffActor, f: typeof documentFolders.$inferSelect) {
  return {
    id: f.id,
    name: f.name,
    parentId: f.parentId,
    clientId: f.clientId,
    projectId: f.projectId,
    clientVisible: f.clientVisible,
    createdBy: f.createdBy,
    createdAt: toIso(f.createdAt),
    updatedAt: toIso(f.updatedAt),
    capabilities: folderCapabilities(actor, folderFactsFrom(f)),
  };
}

async function requireFolder(actor: StaffActor, folderId: string) {
  const loaded = await folderFacts(actor, folderId);
  if (!loaded) throw notFound('Folder not found.');
  return loaded;
}

/**
 * Walk up from `parentId` to the root; return true if `folderId` is encountered
 * (i.e. re-parenting `folderId` under `parentId` would create a cycle). Guards
 * against a runaway loop with a depth cap.
 */
async function wouldCreateCycle(
  actor: StaffActor,
  folderId: string,
  parentId: string,
): Promise<boolean> {
  let cursor: string | null = parentId;
  for (let depth = 0; cursor && depth < 100; depth += 1) {
    if (cursor === folderId) return true;
    const [row]: { parentId: string | null }[] = await db
      .select({ parentId: documentFolders.parentId })
      .from(documentFolders)
      .where(
        and(
          eq(documentFolders.id, cursor),
          eq(documentFolders.agencyId, actor.agencyId),
        ),
      )
      .limit(1);
    cursor = row?.parentId ?? null;
  }
  return false;
}

function auditBase(actor: StaffActor, req: Request) {
  return { agencyId: actor.agencyId, actorType: actor.type, actorId: actor.userId, ip: req.ip };
}

// ============================================================
//  GET /documents?category=&clientId=&projectId=&search= — documents.view
// ============================================================
const listQuery = z.object({
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  clientId: z.string().optional(),
  projectId: z.string().optional(),
  // folderId: omit = every folder (flat, e.g. search); 'root'|'' = root only
  // (folderId IS NULL); any other value = that folder.
  folderId: z.string().optional(),
  search: z.string().optional(),
});

/** True when a folder query param means "root" (documents with no folder). */
function isRootFolderParam(v: string | undefined): boolean {
  return v === '' || v === 'root';
}

documentsRouter.get('/', requires('documents.view'), async (req, res) => {
  const actor = staffActor(req);
  const q = listQuery.parse(req.query);

  // Tenant + hidden (documents.view_hidden) + project visibility, in SQL.
  const filters: SQL[] = await documentListFilter(actor);
  if (q.category) filters.push(eq(documents.category, q.category));
  if (q.clientId) filters.push(eq(documents.clientId, q.clientId));
  if (q.projectId) filters.push(eq(documents.projectId, q.projectId));
  if (q.folderId !== undefined) {
    filters.push(
      isRootFolderParam(q.folderId)
        ? isNull(documents.folderId)
        : eq(documents.folderId, q.folderId),
    );
  }
  if (q.search && q.search.trim()) {
    filters.push(like(documents.name, `%${q.search.trim()}%`));
  }

  const rows = await db
    .select(documentSelection)
    .from(documents)
    .leftJoin(clients, eq(clients.id, documents.clientId))
    .leftJoin(projects, eq(projects.id, documents.projectId))
    .leftJoin(users, eq(users.id, documents.uploadedBy))
    .where(and(...filters))
    .orderBy(desc(documents.createdAt));

  ok(res, (rows as DocumentRow[]).map((d) => serializeDocument(actor, d)));
});

// ============================================================
//  FOLDERS — organize documents (nestable). client_visible mirrors the
//  documents flag so a folder can be surfaced in the client portal. NOTE:
//  these are a DB/UI construct only — storage paths are unaffected.
// ============================================================
const folderListQuery = z.object({
  parentId: z.string().optional(),
  clientId: z.string().optional(),
  projectId: z.string().optional(),
});

// GET /documents/folders?parentId=&clientId=&projectId= — documents.view
// parentId omitted = every folder (e.g. a move picker); 'root'|'' = root level.
documentsRouter.get('/folders', requires('documents.view'), async (req, res) => {
  const actor = staffActor(req);
  const q = folderListQuery.parse(req.query);

  const filters: SQL[] = [
    eq(documentFolders.agencyId, actor.agencyId),
    await projectLinkFilter(actor, documentFolders.projectId),
  ];
  if (q.clientId) filters.push(eq(documentFolders.clientId, q.clientId));
  if (q.projectId) filters.push(eq(documentFolders.projectId, q.projectId));
  if (q.parentId !== undefined) {
    filters.push(
      isRootFolderParam(q.parentId)
        ? isNull(documentFolders.parentId)
        : eq(documentFolders.parentId, q.parentId),
    );
  }

  const rows = await db
    .select()
    .from(documentFolders)
    .where(and(...filters))
    .orderBy(asc(documentFolders.name));

  ok(res, rows.map((f) => serializeFolder(actor, f)));
});

const boolish = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((v) => Boolean(v));

const folderCreateSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().min(1).nullable().optional(),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  clientVisible: boolish.optional(),
});

// POST /documents/folders — folders.create (+ documents.share_with_client when clientVisible)
documentsRouter.post('/folders', requires('folders.create'), async (req, res) => {
  const actor = staffActor(req);
  const body = folderCreateSchema.parse(req.body);

  if (body.clientVisible === true) requirePermission(actor, 'documents.share_with_client');
  if (body.clientId) await requireInAgency(clients, actor.agencyId, body.clientId, 'Client');
  if (body.projectId) await requireViewableProject(actor, body.projectId);
  if (body.parentId) await requireFolder(actor, body.parentId);

  const id = newId('folder');
  await db.insert(documentFolders).values({
    id,
    agencyId: actor.agencyId,
    name: body.name,
    parentId: body.parentId ?? null,
    clientId: body.clientId ?? null,
    projectId: body.projectId ?? null,
    ...(body.clientVisible !== undefined
      ? { clientVisible: body.clientVisible }
      : {}),
    createdBy: actor.userId,
  });

  const { row } = await requireFolder(actor, id);
  created(res, serializeFolder(actor, row));
});

const folderUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  parentId: z.string().min(1).nullable().optional(),
  clientVisible: boolish.optional(),
});

// PATCH /documents/folders/:id — folders.update (+ share_with_client to make it client-visible)
documentsRouter.patch('/folders/:id', requires('folders.update'), async (req, res) => {
  const actor = staffActor(req);
  const folderId = param(req, 'id');
  const folder = await requireFolder(actor, folderId);
  authorize(actor, 'folders.update', folder.facts, { view: 'documents.view' });
  const body = folderUpdateSchema.parse(req.body);

  if (body.clientVisible === true && !folder.row.clientVisible) {
    authorize(actor, 'documents.share_with_client', folder.facts, { view: 'documents.view' });
  }
  if (body.parentId) {
    if (body.parentId === folderId) {
      throw badRequest('A folder cannot be its own parent.');
    }
    await requireFolder(actor, body.parentId);
    if (await wouldCreateCycle(actor, folderId, body.parentId)) {
      throw badRequest('Cannot move a folder into one of its own subfolders.');
    }
  }

  const patch: Partial<typeof documentFolders.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) patch.name = body.name;
  if (body.parentId !== undefined) patch.parentId = body.parentId;
  if (body.clientVisible !== undefined) patch.clientVisible = body.clientVisible;

  await db
    .update(documentFolders)
    .set(patch)
    .where(
      and(
        eq(documentFolders.id, folderId),
        eq(documentFolders.agencyId, actor.agencyId),
      ),
    );

  const { row } = await requireFolder(actor, folderId);
  ok(res, serializeFolder(actor, row));
});

// DELETE /documents/folders/:id — folders.delete. Removes the folder WITHOUT
// touching its files: contained documents and child folders return to root.
documentsRouter.delete('/folders/:id', requires('folders.delete'), async (req, res) => {
  const actor = staffActor(req);
  const folderId = param(req, 'id');
  const folder = await requireFolder(actor, folderId);
  authorize(actor, 'folders.delete', folder.facts, { view: 'documents.view' });

  await db
    .update(documents)
    .set({ folderId: null, updatedAt: new Date() })
    .where(
      and(eq(documents.folderId, folderId), eq(documents.agencyId, actor.agencyId)),
    );

  await db
    .update(documentFolders)
    .set({ parentId: null, updatedAt: new Date() })
    .where(
      and(
        eq(documentFolders.parentId, folderId),
        eq(documentFolders.agencyId, actor.agencyId),
      ),
    );

  await db
    .delete(documentFolders)
    .where(
      and(
        eq(documentFolders.id, folderId),
        eq(documentFolders.agencyId, actor.agencyId),
      ),
    );

  await audit({
    ...auditBase(actor, req),
    action: 'folder.delete',
    entityType: 'document_folder',
    entityId: folderId,
    metadata: { name: folder.row.name },
  });
  ok(res, { deleted: true });
});

// ============================================================
//  POST /documents/sign — documents.upload. Signed direct-upload params.
// ============================================================
const signSchema = z.object({
  folder: z.string().trim().max(200).optional(),
  filename: z.string().optional(),
  contentType: z.string().optional(),
});

documentsRouter.post('/sign', requires('documents.upload'), async (req, res) => {
  const actor = staffActor(req);
  const body = signSchema.parse(req.body ?? {});

  // Force a tenant-scoped folder so one agency cannot write into another's.
  const folder = `sanctum/${actor.agencyId}/documents`;

  const signed = await signDocumentUpload({
    agencyId: actor.agencyId,
    folder,
    filename: body.filename,
    contentType: body.contentType,
    uploadBase: uploadOrigin(req),
  });
  // Note: `folder` is fixed server-side; the optional body.folder is ignored
  // intentionally to keep uploads inside the tenant path.
  void body.folder;
  ok(res, signed);
});

// ============================================================
//  POST /documents — documents.upload. Save metadata for an uploaded asset
//  (publicId set) or an external link (no publicId).
// ============================================================
const createSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  clientId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  folderId: z.string().min(1).nullable().optional(),
  fileUrl: z.string().url(),
  publicId: z.string().optional(),
  resourceType: z.enum(RESOURCE_TYPES).optional(),
  format: z.string().max(40).optional(),
  mimeType: z.string().max(160).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  clientVisible: boolish.optional(),
  hideFromTeam: boolish.optional(),
});

documentsRouter.post('/', requires('documents.upload'), async (req, res) => {
  const actor = staffActor(req);
  const body = createSchema.parse(req.body);
  const category = body.category ?? 'misc';

  // Cross-module + visibility permissions (all checked before any write).
  const businessPermission = BUSINESS_CATEGORY_PERMISSION[category];
  if (businessPermission) {
    requirePermission(
      actor,
      businessPermission,
      `Uploading a ${category} creates a business record and needs the ${businessPermission} permission.`,
    );
  }
  if (body.clientVisible === true) requirePermission(actor, 'documents.share_with_client');
  const hideFromTeam = OWNER_ONLY_CATEGORIES.has(category) || body.hideFromTeam === true;
  if (hideFromTeam) requirePermission(actor, 'documents.hide_from_team');

  assertDocumentStorage(actor.agencyId, body.fileUrl, body.publicId);
  if (body.clientId !== undefined) await requireInAgency(clients, actor.agencyId, body.clientId, 'Client');
  if (body.projectId !== undefined) await requireViewableProject(actor, body.projectId);
  if (body.folderId) await requireFolder(actor, body.folderId);

  const id = newId('doc');
  await db.insert(documents).values({
    id,
    agencyId: actor.agencyId,
    name: body.name,
    ...(body.category !== undefined ? { category: body.category } : {}),
    clientId: body.clientId ?? null,
    projectId: body.projectId ?? null,
    folderId: body.folderId ?? null,
    fileUrl: body.fileUrl,
    publicId: body.publicId ?? null,
    ...(body.resourceType !== undefined
      ? { resourceType: body.resourceType }
      : {}),
    format: body.format ?? null,
    mimeType: body.mimeType ?? null,
    ...(body.sizeBytes !== undefined ? { sizeBytes: body.sizeBytes } : {}),
    ...(body.clientVisible !== undefined
      ? { clientVisible: body.clientVisible }
      : {}),
    hideFromTeam,
    uploadedBy: actor.userId,
  });

  // Convert proposal/agreement/invoice uploads into their Business records so
  // they surface in those tabs (permission verified above). Best-effort — a
  // failed conversion must never fail the upload itself.
  const conversion = await maybeConvertDocument(actor, category, body).catch(
    () => null,
  );
  if (conversion) {
    await audit({
      ...auditBase(actor, req),
      action: `document.convert_${conversion.type}`,
      entityType: 'document',
      entityId: id,
      metadata: { recordId: conversion.id, clientVisible: body.clientVisible === true },
    });
  }

  const row = await loadDocumentRow(actor, id);
  created(res, { ...serializeDocument(actor, row), converted: conversion });
});

/**
 * When a document is uploaded as a proposal/agreement/invoice, spawn the
 * matching Business record carrying the file so it surfaces in that tab.
 * Agreements + invoices require a client, so if none is given we skip (the doc
 * still exists, hidden). When the document is marked client-visible the record
 * is created as 'sent' so it also shows in the client's portal tab; otherwise
 * it stays 'draft' (agency-only). Returns a descriptor or null.
 */
async function maybeConvertDocument(
  actor: StaffActor,
  category: string,
  body: z.infer<typeof createSchema>,
): Promise<{ type: 'proposal' | 'agreement' | 'invoice'; id: string } | null> {
  const toClient = body.clientVisible === true;
  const now = toClient ? new Date() : null;

  if (PROPOSAL_CATEGORIES.has(category)) {
    const propId = newId('prop');
    await db.insert(proposals).values({
      id: propId,
      agencyId: actor.agencyId,
      clientId: body.clientId ?? null,
      title: body.name,
      status: toClient ? 'sent' : 'draft',
      sentAt: now,
      contentJson: JSON.stringify({ source: 'document', fileUrl: body.fileUrl }),
      fileUrl: body.fileUrl,
      createdBy: actor.userId,
    });
    return { type: 'proposal', id: propId };
  }
  if (AGREEMENT_CATEGORIES.has(category)) {
    if (!body.clientId) return null; // agreements need a client
    const agrId = newId('agr');
    await db.insert(agreements).values({
      id: agrId,
      agencyId: actor.agencyId,
      clientId: body.clientId,
      title: body.name,
      status: toClient ? 'sent' : 'draft',
      sentAt: now,
      termsJson: JSON.stringify({ source: 'document', fileUrl: body.fileUrl }),
      fileUrl: body.fileUrl,
      createdBy: actor.userId,
    });
    return { type: 'agreement', id: agrId };
  }
  if (INVOICE_CATEGORIES.has(category)) {
    if (!body.clientId) return null; // invoices require a client (NOT NULL)
    const invId = newId('inv');
    const year = new Date().getFullYear();
    const invoiceNumber = `INV-${year}-${String(Date.now() % 10000).padStart(4, '0')}`;
    await db.insert(invoices).values({
      id: invId,
      agencyId: actor.agencyId,
      clientId: body.clientId,
      invoiceNumber,
      status: toClient ? 'sent' : 'draft',
      issueDate: new Date(),
      fileUrl: body.fileUrl,
      createdBy: actor.userId,
      // Money fields default to 0 — a document invoice carries the file, not
      // computed line items. The agency can add items later if needed.
    });
    return { type: 'invoice', id: invId };
  }
  return null;
}

// ============================================================
//  PATCH /documents/:id — documents.update (own / organization)
//    clientVisible false→true: documents.share_with_client
//    hideFromTeam change, or moving into a hidden category: documents.hide_from_team
//    projectId: projects.view on the project
// ============================================================
const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  folderId: z.string().min(1).nullable().optional(),
  clientVisible: boolish.optional(),
  hideFromTeam: boolish.optional(),
});

documentsRouter.patch('/:id', requires('documents.update'), async (req, res) => {
  const actor = staffActor(req);
  const documentId = param(req, 'id');
  const { row: doc, facts } = await authorizeDocument(actor, documentId, 'documents.update');
  const body = updateSchema.parse(req.body);

  const check403 = (permission: string, f: ObjectFacts = facts) =>
    authorize(actor, permission, f, { view: 'documents.view' });

  if (body.clientVisible === true && !doc.clientVisible) check403('documents.share_with_client');

  const nextCategory = body.category ?? doc.category;
  const intoHiddenCategory = OWNER_ONLY_CATEGORIES.has(nextCategory) && !doc.hideFromTeam;
  let nextHidden = doc.hideFromTeam;
  if (intoHiddenCategory) {
    check403('documents.hide_from_team');
    nextHidden = true;
  }
  if (body.hideFromTeam !== undefined && body.hideFromTeam !== doc.hideFromTeam) {
    check403('documents.hide_from_team');
    // Business/legal categories are always hidden.
    nextHidden = body.hideFromTeam || OWNER_ONLY_CATEGORIES.has(nextCategory);
  }

  if (body.clientId) await requireInAgency(clients, actor.agencyId, body.clientId, 'Client');
  if (body.projectId) await requireViewableProject(actor, body.projectId);
  if (body.folderId) await requireFolder(actor, body.folderId);

  const patch: Partial<typeof documents.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) patch.name = body.name;
  if (body.category !== undefined) patch.category = body.category;
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.projectId !== undefined) patch.projectId = body.projectId;
  if (body.folderId !== undefined) patch.folderId = body.folderId;
  if (body.clientVisible !== undefined) patch.clientVisible = body.clientVisible;
  if (nextHidden !== doc.hideFromTeam) patch.hideFromTeam = nextHidden;

  await db
    .update(documents)
    .set(patch)
    .where(
      and(eq(documents.id, documentId), eq(documents.agencyId, actor.agencyId)),
    );

  if (patch.clientVisible !== undefined && patch.clientVisible !== doc.clientVisible) {
    await audit({
      ...auditBase(actor, req),
      action: patch.clientVisible ? 'document.share_with_client' : 'document.unshare_with_client',
      entityType: 'document',
      entityId: documentId,
    });
  }
  if (patch.hideFromTeam !== undefined) {
    await audit({
      ...auditBase(actor, req),
      action: patch.hideFromTeam ? 'document.hide_from_team' : 'document.unhide_from_team',
      entityType: 'document',
      entityId: documentId,
    });
  }

  const row = await loadDocumentRow(actor, documentId);
  ok(res, serializeDocument(actor, row));
});

// ============================================================
//  DELETE /documents/:id — documents.delete (own / organization).
//  Storage objects are deleted only for keys under this agency's prefix.
// ============================================================
documentsRouter.delete('/:id', requires('documents.delete'), async (req, res) => {
  const actor = staffActor(req);
  const documentId = param(req, 'id');
  const { row: doc } = await authorizeDocument(actor, documentId, 'documents.delete');

  await db
    .delete(documents)
    .where(
      and(eq(documents.id, documentId), eq(documents.agencyId, actor.agencyId)),
    );

  // Best-effort: never fail the delete if the storage provider errors. Legacy
  // rows may carry foreign keys (pre-validation) — those are never touched.
  let storageDeleted = false;
  if (doc.publicId && isAgencyStorageKey(actor.agencyId, doc.publicId)) {
    try {
      await deleteAsset({
        publicId: doc.publicId,
        secureUrl: doc.fileUrl,
        resourceType: doc.resourceType as 'image' | 'raw' | 'video',
        agencyId: actor.agencyId,
      });
      storageDeleted = true;
    } catch {
      // non-fatal — reconciliation can clean up later
    }
  }

  await audit({
    ...auditBase(actor, req),
    action: 'document.delete',
    entityType: 'document',
    entityId: documentId,
    metadata: { name: doc.name, category: doc.category, storageDeleted },
  });
  ok(res, { deleted: true });
});
