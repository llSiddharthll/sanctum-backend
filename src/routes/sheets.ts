import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, projects, sheets, users } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { getAuth } from '../middleware/tenant.js';

export const sheetsRouter = Router();
sheetsRouter.use(requireAuth);

const DEFAULT_SHEET_DATA = '{"cells":{},"rows":50,"cols":26}';

const listSelection = {
  id: sheets.id,
  title: sheets.title,
  clientId: sheets.clientId,
  projectId: sheets.projectId,
  createdBy: sheets.createdBy,
  createdAt: sheets.createdAt,
  updatedAt: sheets.updatedAt,
  clientName: clients.name,
  projectName: projects.name,
  createdByName: users.fullName,
};

type SheetListRow = {
  id: string;
  title: string;
  clientId: string | null;
  projectId: string | null;
  createdBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  clientName: string | null;
  projectName: string | null;
  createdByName: string | null;
};

function serializeSheetListItem(s: SheetListRow) {
  return {
    id: s.id,
    title: s.title,
    clientId: s.clientId,
    clientName: s.clientName,
    projectId: s.projectId,
    projectName: s.projectName,
    createdBy: s.createdBy,
    createdByName: s.createdByName,
    createdAt: toIso(s.createdAt),
    updatedAt: toIso(s.updatedAt),
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function serializeSheetFull(s: typeof sheets.$inferSelect) {
  return {
    id: s.id,
    title: s.title,
    clientId: s.clientId,
    projectId: s.projectId,
    data: safeJson(s.data),
    createdBy: s.createdBy,
    createdAt: toIso(s.createdAt),
    updatedAt: toIso(s.updatedAt),
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

/** Fetch a raw sheet row scoped to the caller's agency, or throw 404. */
async function getScopedSheet(
  ctx: ReturnType<typeof getAuth>,
  sheetId: string,
) {
  const [row] = await db
    .select()
    .from(sheets)
    .where(and(eq(sheets.id, sheetId), eq(sheets.agencyId, ctx.agencyId)))
    .limit(1);
  if (!row) throw notFound('Sheet not found.');
  return row;
}

// ============================================================
//  GET /sheets — list (order updatedAt desc)
// ============================================================
sheetsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);

  const rows = await db
    .select(listSelection)
    .from(sheets)
    .leftJoin(clients, eq(clients.id, sheets.clientId))
    .leftJoin(projects, eq(projects.id, sheets.projectId))
    .leftJoin(users, eq(users.id, sheets.createdBy))
    .where(eq(sheets.agencyId, ctx.agencyId))
    .orderBy(desc(sheets.updatedAt));

  ok(res, (rows as SheetListRow[]).map(serializeSheetListItem));
});

// ============================================================
//  POST /sheets — create
// ============================================================
const createSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  clientId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

sheetsRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = createSchema.parse(req.body ?? {});

  if (body.clientId !== undefined) await requireAgencyClient(ctx, body.clientId);
  if (body.projectId !== undefined)
    await requireAgencyProject(ctx, body.projectId);

  const id = newId('sht');
  await db.insert(sheets).values({
    id,
    agencyId: ctx.agencyId,
    ...(body.title !== undefined ? { title: body.title } : {}),
    clientId: body.clientId ?? null,
    projectId: body.projectId ?? null,
    data: DEFAULT_SHEET_DATA,
    createdBy: ctx.userId,
  });

  const row = await getScopedSheet(ctx, id);
  created(res, serializeSheetFull(row));
});

// ============================================================
//  GET /sheets/:id — full row (data parsed)
// ============================================================
sheetsRouter.get('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const row = await getScopedSheet(ctx, param(req, 'id'));
  ok(res, serializeSheetFull(row));
});

// ============================================================
//  PATCH /sheets/:id — update (autosave; data stringified before store)
// ============================================================
const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
});

sheetsRouter.patch('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const sheetId = param(req, 'id');
  await getScopedSheet(ctx, sheetId);
  const body = updateSchema.parse(req.body);

  if (body.clientId) await requireAgencyClient(ctx, body.clientId);
  if (body.projectId) await requireAgencyProject(ctx, body.projectId);

  const patch: Partial<typeof sheets.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) patch.title = body.title;
  if (body.data !== undefined) patch.data = JSON.stringify(body.data);
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.projectId !== undefined) patch.projectId = body.projectId;

  await db
    .update(sheets)
    .set(patch)
    .where(and(eq(sheets.id, sheetId), eq(sheets.agencyId, ctx.agencyId)));

  const row = await getScopedSheet(ctx, sheetId);
  ok(res, serializeSheetFull(row));
});

// ============================================================
//  POST /sheets/:id/duplicate — copy row
// ============================================================
sheetsRouter.post('/:id/duplicate', async (req, res) => {
  const ctx = getAuth(req);
  const source = await getScopedSheet(ctx, param(req, 'id'));

  const id = newId('sht');
  await db.insert(sheets).values({
    id,
    agencyId: ctx.agencyId,
    title: `${source.title} (copy)`,
    clientId: source.clientId,
    projectId: source.projectId,
    data: source.data,
    createdBy: ctx.userId,
  });

  const row = await getScopedSheet(ctx, id);
  created(res, serializeSheetFull(row));
});

// ============================================================
//  DELETE /sheets/:id
// ============================================================
sheetsRouter.delete('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const sheetId = param(req, 'id');
  await getScopedSheet(ctx, sheetId);

  await db
    .delete(sheets)
    .where(and(eq(sheets.id, sheetId), eq(sheets.agencyId, ctx.agencyId)));

  ok(res, { deleted: true });
});
