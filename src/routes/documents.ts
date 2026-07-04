import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, projects, documents, users } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
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
  'deliverable',
  'invoice',
  'report',
  'design',
  'ai_generated',
  'misc',
] as const;
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

/** Fetch a document scoped to the caller's agency (with joins), or throw 404. */
async function getScopedDocument(
  ctx: ReturnType<typeof getAuth>,
  documentId: string,
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
  return row as DocumentRow;
}

// ============================================================
//  GET /documents?category=&clientId=&projectId=&search=
// ============================================================
const listQuery = z.object({
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  clientId: z.string().optional(),
  projectId: z.string().optional(),
  search: z.string().optional(),
});

documentsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const q = listQuery.parse(req.query);

  const filters = [eq(documents.agencyId, ctx.agencyId)];
  if (q.category) filters.push(eq(documents.category, q.category));
  if (q.clientId) filters.push(eq(documents.clientId, q.clientId));
  if (q.projectId) filters.push(eq(documents.projectId, q.projectId));
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
});

documentsRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = createSchema.parse(req.body);

  if (body.clientId !== undefined) await requireAgencyClient(ctx, body.clientId);
  if (body.projectId !== undefined)
    await requireAgencyProject(ctx, body.projectId);

  const id = newId('doc');
  await db.insert(documents).values({
    id,
    agencyId: ctx.agencyId,
    name: body.name,
    ...(body.category !== undefined ? { category: body.category } : {}),
    clientId: body.clientId ?? null,
    projectId: body.projectId ?? null,
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
    uploadedBy: ctx.userId,
  });

  const row = await getScopedDocument(ctx, id);
  created(res, serializeDocument(row));
});

// ============================================================
//  PATCH /documents/:id
// ============================================================
const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
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

  const patch: Partial<typeof documents.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) patch.name = body.name;
  if (body.category !== undefined) patch.category = body.category;
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.projectId !== undefined) patch.projectId = body.projectId;
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
