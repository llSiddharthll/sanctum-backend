import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  projects,
  documents,
  documentFolders,
  users,
  proposals,
  agreements,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';
import { signDocumentUpload, destroyAsset } from '../services/cloudinary.js';

export const documentsRouter = Router();
documentsRouter.use(requireAuth);
documentsRouter.use(requireModuleRW('documents'));

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

/**
 * Business/legal categories are OWNER-ONLY: any document tagged with one of
 * these auto-hides from the team, regardless of the manual toggle.
 */
const OWNER_ONLY_CATEGORIES = new Set([
  'proposal',
  'agreement',
  'contract',
  'nda',
  'invoice',
]);
/** Categories that spawn a Proposal record on upload. */
const PROPOSAL_CATEGORIES = new Set(['proposal']);
/** Categories that spawn an Agreement record on upload (needs a client). */
const AGREEMENT_CATEGORIES = new Set(['agreement', 'contract', 'nda']);
const RESOURCE_TYPES = ['image', 'raw', 'video'] as const;

const documentSelection = {
  id: documents.id,
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
  uploadedBy: documents.uploadedBy,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  clientName: clients.name,
  projectName: projects.name,
  uploadedByName: users.fullName,
};

type DocumentRow = {
  id: string;
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
  uploadedBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  clientName: string | null;
  projectName: string | null;
  uploadedByName: string | null;
};

function serializeDocument(d: DocumentRow) {
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
    uploadedBy: d.uploadedBy,
    uploadedByName: d.uploadedByName,
    createdAt: toIso(d.createdAt),
    updatedAt: toIso(d.updatedAt),
  };
}

/** Verify a client belongs to the caller's agency, or throw 404. */
async function requireAgencyClient(
  ctx: ReturnType<typeof getAuth>,
  clientId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);
  if (!row) throw notFound('Client not found.');
}

/** Verify a project belongs to the caller's agency, or throw 404. */
async function requireAgencyProject(
  ctx: ReturnType<typeof getAuth>,
  projectId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.agencyId, ctx.agencyId)))
    .limit(1);
  if (!row) throw notFound('Project not found.');
}

/** Verify a folder belongs to the caller's agency, returning it, or throw 404. */
async function requireAgencyFolder(
  ctx: ReturnType<typeof getAuth>,
  folderId: string,
): Promise<typeof documentFolders.$inferSelect> {
  const [row] = await db
    .select()
    .from(documentFolders)
    .where(
      and(
        eq(documentFolders.id, folderId),
        eq(documentFolders.agencyId, ctx.agencyId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Folder not found.');
  return row;
}

function serializeFolder(f: typeof documentFolders.$inferSelect) {
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
  };
}

/**
 * Walk up from `parentId` to the root; return true if `folderId` is encountered
 * (i.e. re-parenting `folderId` under `parentId` would create a cycle). Guards
 * against a runaway loop with a depth cap.
 */
async function wouldCreateCycle(
  ctx: ReturnType<typeof getAuth>,
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
          eq(documentFolders.agencyId, ctx.agencyId),
        ),
      )
      .limit(1);
    cursor = row?.parentId ?? null;
  }
  return false;
}

/** Fetch a document scoped to the caller's agency (with joins), or throw 404. */
async function getScopedDocument(
  ctx: ReturnType<typeof getAuth>,
  documentId: string,
  opts?: { allowHidden?: boolean },
): Promise<DocumentRow> {
  const [row] = await db
    .select(documentSelection)
    .from(documents)
    .leftJoin(clients, eq(clients.id, documents.clientId))
    .leftJoin(projects, eq(projects.id, documents.projectId))
    .leftJoin(users, eq(users.id, documents.uploadedBy))
    .where(
      and(eq(documents.id, documentId), eq(documents.agencyId, ctx.agencyId)),
    )
    .limit(1);
  if (!row) throw notFound('Document not found.');
  const r = row as DocumentRow;
  // Owner-only docs are invisible to staff on read/edit/delete too.
  if (!opts?.allowHidden && r.hideFromTeam && ctx.role !== 'owner') {
    throw notFound('Document not found.');
  }
  return r;
}

// ============================================================
//  GET /documents?category=&clientId=&projectId=&search=
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

documentsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const q = listQuery.parse(req.query);

  const filters = [eq(documents.agencyId, ctx.agencyId)];
  // Owner-only docs (business/legal or manually hidden) are invisible to staff.
  if (ctx.role !== 'owner') filters.push(eq(documents.hideFromTeam, false));
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

  ok(res, (rows as DocumentRow[]).map(serializeDocument));
});

// ============================================================
//  FOLDERS — organize documents (nestable). client_visible mirrors the
//  documents flag so a folder can be surfaced in the client portal. NOTE:
//  these are a DB/UI construct only — Cloudinary paths are unaffected.
// ============================================================
const folderListQuery = z.object({
  parentId: z.string().optional(),
  clientId: z.string().optional(),
  projectId: z.string().optional(),
});

// GET /documents/folders?parentId=&clientId=&projectId= — folders at a level.
// parentId omitted = every folder (e.g. a move picker); 'root'|'' = root level.
documentsRouter.get('/folders', async (req, res) => {
  const ctx = getAuth(req);
  const q = folderListQuery.parse(req.query);

  const filters = [eq(documentFolders.agencyId, ctx.agencyId)];
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

  ok(res, rows.map(serializeFolder));
});

const folderCreateSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().min(1).nullable().optional(),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  clientVisible: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .transform((v) => Boolean(v))
    .optional(),
});

// POST /documents/folders — create a folder at a level.
documentsRouter.post('/folders', async (req, res) => {
  const ctx = getAuth(req);
  const body = folderCreateSchema.parse(req.body);

  if (body.clientId) await requireAgencyClient(ctx, body.clientId);
  if (body.projectId) await requireAgencyProject(ctx, body.projectId);
  if (body.parentId) await requireAgencyFolder(ctx, body.parentId);

  const id = newId('folder');
  await db.insert(documentFolders).values({
    id,
    agencyId: ctx.agencyId,
    name: body.name,
    parentId: body.parentId ?? null,
    clientId: body.clientId ?? null,
    projectId: body.projectId ?? null,
    ...(body.clientVisible !== undefined
      ? { clientVisible: body.clientVisible }
      : {}),
    createdBy: ctx.userId,
  });

  const row = await requireAgencyFolder(ctx, id);
  created(res, serializeFolder(row));
});

const folderUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  parentId: z.string().min(1).nullable().optional(),
  clientVisible: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .transform((v) => Boolean(v))
    .optional(),
});

// PATCH /documents/folders/:id — rename, MOVE (parentId), toggle visibility.
documentsRouter.patch('/folders/:id', async (req, res) => {
  const ctx = getAuth(req);
  const folderId = param(req, 'id');
  await requireAgencyFolder(ctx, folderId);
  const body = folderUpdateSchema.parse(req.body);

  if (body.parentId) {
    if (body.parentId === folderId) {
      throw badRequest('A folder cannot be its own parent.');
    }
    await requireAgencyFolder(ctx, body.parentId);
    if (await wouldCreateCycle(ctx, folderId, body.parentId)) {
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
        eq(documentFolders.agencyId, ctx.agencyId),
      ),
    );

  const row = await requireAgencyFolder(ctx, folderId);
  ok(res, serializeFolder(row));
});

// DELETE /documents/folders/:id — remove the folder WITHOUT touching its files.
// Contained documents return to root (folderId=null) and child folders return
// to root (parentId=null) so nothing is orphaned or hidden by the delete.
documentsRouter.delete('/folders/:id', async (req, res) => {
  const ctx = getAuth(req);
  const folderId = param(req, 'id');
  await requireAgencyFolder(ctx, folderId);

  await db
    .update(documents)
    .set({ folderId: null, updatedAt: new Date() })
    .where(
      and(eq(documents.folderId, folderId), eq(documents.agencyId, ctx.agencyId)),
    );

  await db
    .update(documentFolders)
    .set({ parentId: null, updatedAt: new Date() })
    .where(
      and(
        eq(documentFolders.parentId, folderId),
        eq(documentFolders.agencyId, ctx.agencyId),
      ),
    );

  await db
    .delete(documentFolders)
    .where(
      and(
        eq(documentFolders.id, folderId),
        eq(documentFolders.agencyId, ctx.agencyId),
      ),
    );

  ok(res, { deleted: true });
});

// ============================================================
//  POST /documents/sign — Cloudinary signed direct-upload params
// ============================================================
const signSchema = z.object({
  folder: z.string().trim().max(200).optional(),
});

documentsRouter.post('/sign', async (req, res) => {
  const ctx = getAuth(req);
  const body = signSchema.parse(req.body ?? {});

  // Force a tenant-scoped folder so one agency cannot write into another's.
  const folder = `sanctum/${ctx.agencyId}/documents`;

  const signed = signDocumentUpload({ agencyId: ctx.agencyId, folder });
  // Note: `folder` is fixed server-side; the optional body.folder is ignored
  // intentionally to keep uploads inside the tenant path.
  void body.folder;
  ok(res, signed);
});

// ============================================================
//  POST /documents — save metadata for an uploaded asset
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
  clientVisible: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .transform((v) => Boolean(v))
    .optional(),
  hideFromTeam: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .transform((v) => Boolean(v))
    .optional(),
});

documentsRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = createSchema.parse(req.body);

  if (body.clientId !== undefined) await requireAgencyClient(ctx, body.clientId);
  if (body.projectId !== undefined)
    await requireAgencyProject(ctx, body.projectId);
  if (body.folderId) await requireAgencyFolder(ctx, body.folderId);

  const category = body.category ?? 'misc';
  // Owner-only visibility: business/legal categories always hide from the team;
  // otherwise only the OWNER may manually hide (staff uploads stay visible).
  const hideFromTeam =
    OWNER_ONLY_CATEGORIES.has(category) ||
    (ctx.role === 'owner' && body.hideFromTeam === true);

  const id = newId('doc');
  await db.insert(documents).values({
    id,
    agencyId: ctx.agencyId,
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
    uploadedBy: ctx.userId,
  });

  // Convert proposal/agreement uploads into their respective Business records so
  // they surface in the Proposals / Agreements tabs. Best-effort — a failed
  // conversion must never fail the upload itself.
  const conversion = await maybeConvertDocument(ctx, category, body).catch(
    () => null,
  );

  const row = await getScopedDocument(ctx, id, { allowHidden: true });
  created(res, { ...serializeDocument(row), converted: conversion });
});

/**
 * When a document is uploaded as a proposal/agreement, spawn the matching
 * Business record carrying the file. Agreements require a client, so if none is
 * given we skip (the doc still exists, owner-only). Returns a small descriptor
 * or null when nothing was created.
 */
async function maybeConvertDocument(
  ctx: ReturnType<typeof getAuth>,
  category: string,
  body: z.infer<typeof createSchema>,
): Promise<{ type: 'proposal' | 'agreement'; id: string } | null> {
  if (PROPOSAL_CATEGORIES.has(category)) {
    const propId = newId('prop');
    await db.insert(proposals).values({
      id: propId,
      agencyId: ctx.agencyId,
      clientId: body.clientId ?? null,
      title: body.name,
      status: 'draft',
      contentJson: JSON.stringify({ source: 'document', fileUrl: body.fileUrl }),
      fileUrl: body.fileUrl,
      createdBy: ctx.userId,
    });
    return { type: 'proposal', id: propId };
  }
  if (AGREEMENT_CATEGORIES.has(category)) {
    if (!body.clientId) return null; // agreements need a client
    const agrId = newId('agr');
    await db.insert(agreements).values({
      id: agrId,
      agencyId: ctx.agencyId,
      clientId: body.clientId,
      title: body.name,
      status: 'draft',
      termsJson: JSON.stringify({ source: 'document', fileUrl: body.fileUrl }),
      fileUrl: body.fileUrl,
      createdBy: ctx.userId,
    });
    return { type: 'agreement', id: agrId };
  }
  return null;
}

// ============================================================
//  PATCH /documents/:id
// ============================================================
const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  folderId: z.string().min(1).nullable().optional(),
  clientVisible: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .transform((v) => Boolean(v))
    .optional(),
});

documentsRouter.patch('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const documentId = param(req, 'id');
  await getScopedDocument(ctx, documentId);
  const body = updateSchema.parse(req.body);

  if (body.clientId) await requireAgencyClient(ctx, body.clientId);
  if (body.projectId) await requireAgencyProject(ctx, body.projectId);
  if (body.folderId) await requireAgencyFolder(ctx, body.folderId);

  const patch: Partial<typeof documents.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) patch.name = body.name;
  if (body.category !== undefined) patch.category = body.category;
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.projectId !== undefined) patch.projectId = body.projectId;
  if (body.folderId !== undefined) patch.folderId = body.folderId;
  if (body.clientVisible !== undefined) patch.clientVisible = body.clientVisible;

  await db
    .update(documents)
    .set(patch)
    .where(
      and(eq(documents.id, documentId), eq(documents.agencyId, ctx.agencyId)),
    );

  const row = await getScopedDocument(ctx, documentId);
  ok(res, serializeDocument(row));
});

// ============================================================
//  DELETE /documents/:id — delete row + best-effort Cloudinary destroy
// ============================================================
documentsRouter.delete('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const documentId = param(req, 'id');
  const doc = await getScopedDocument(ctx, documentId);

  await db
    .delete(documents)
    .where(
      and(eq(documents.id, documentId), eq(documents.agencyId, ctx.agencyId)),
    );

  // Best-effort: never fail the delete if Cloudinary errors.
  if (doc.publicId) {
    try {
      await destroyAsset(
        doc.publicId,
        doc.resourceType as 'image' | 'raw' | 'video',
      );
    } catch {
      // non-fatal — reconciliation can clean up later
    }
  }

  ok(res, { deleted: true });
});
