import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, projects, sheets, users } from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { getFrontendOrigin } from '../lib/frontend-url.js';
import { publishCalendarSheet } from '../services/sheet-publish.js';
import { fetchGoogleSheetCsv } from '../services/google-sheet.js';
import { audit } from '../services/audit.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize } from '../authz/engine.js';
import type { StaffActor } from '../authz/actor.js';
import { requireInAgency } from '../authz/tenancy.js';
import { sheetCapabilities, sheetFacts, sheetFactsFrom } from '../authz/policies/sheets.js';

/**
 * Sheets (staff only).
 *   sheets.view            list / read
 *   sheets.create          create / duplicate / Google import
 *   sheets.update          own (creator) / organization
 *   sheets.delete          own (creator) / organization
 *   sheets.publish         + projects.create / posts.create / tasks.create for
 *                          what it creates and posts.update / tasks.update for
 *                          what a re-publish overwrites (services/sheet-publish.ts)
 */
export const sheetsRouter = Router();
sheetsRouter.use(authenticate);

/** Load a sheet in the actor's tenant and authorize `permission` (404 when invisible). */
async function authorizeSheet(actor: StaffActor, sheetId: string, permission: string) {
  const loaded = await sheetFacts(actor, sheetId);
  if (!loaded) throw notFound('Sheet not found.');
  authorize(actor, permission, loaded.facts, {
    view: permission === 'sheets.view' ? undefined : 'sheets.view',
  });
  return loaded;
}

function auditBase(actor: StaffActor, req: Request) {
  return { agencyId: actor.agencyId, actorType: actor.type, actorId: actor.userId, ip: req.ip };
}

// ============================================================
//  POST /sheets/import/google — sheets.create. Read a shared Google Sheet as CSV.
//  Declared before the /:id routes so 'import' is never taken as an id.
// ============================================================
const googleImportSchema = z.object({ url: z.string().min(1).max(2000) });

sheetsRouter.post('/import/google', requires('sheets.create'), async (req, res) => {
  getStaffActor(req);
  const { url } = googleImportSchema.parse(req.body);
  const { csv, spreadsheetId, gid } = await fetchGoogleSheetCsv(url);
  ok(res, { csv, spreadsheetId, gid });
});

// POST /sheets/:id/publish — sheets.publish (+ target permissions, checked in the
// service before any write). Turns a content-calendar sheet into content posts +
// assigned tasks (idempotent; re-publish updates already-published rows).
sheetsRouter.post('/:id/publish', requires('sheets.publish'), async (req, res) => {
  const actor = getStaffActor(req);
  const sheetId = param(req, 'id');
  await authorizeSheet(actor, sheetId, 'sheets.publish');
  const result = await publishCalendarSheet(actor, sheetId, getFrontendOrigin(req));
  await audit({
    ...auditBase(actor, req),
    action: 'sheet.publish',
    entityType: 'sheet',
    entityId: sheetId,
    metadata: {
      postsCreated: result.postsCreated,
      tasksCreated: result.tasksCreated,
      updated: result.updated,
    },
  });
  ok(res, result);
});

const DEFAULT_SHEET_DATA = '{"cells":{},"rows":50,"cols":26}';

const listSelection = {
  id: sheets.id,
  agencyId: sheets.agencyId,
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
  agencyId: string;
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

function serializeSheetListItem(actor: StaffActor, s: SheetListRow) {
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
    capabilities: sheetCapabilities(actor, sheetFactsFrom(s)),
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function serializeSheetFull(actor: StaffActor, s: typeof sheets.$inferSelect) {
  return {
    id: s.id,
    title: s.title,
    clientId: s.clientId,
    projectId: s.projectId,
    data: safeJson(s.data),
    createdBy: s.createdBy,
    createdAt: toIso(s.createdAt),
    updatedAt: toIso(s.updatedAt),
    capabilities: sheetCapabilities(actor, sheetFactsFrom(s)),
  };
}

async function reload(actor: StaffActor, sheetId: string) {
  const loaded = await sheetFacts(actor, sheetId);
  if (!loaded) throw notFound('Sheet not found.');
  return loaded.row;
}

// ============================================================
//  GET /sheets — sheets.view (organization) — list (order updatedAt desc)
// ============================================================
sheetsRouter.get('/', requires('sheets.view'), async (req, res) => {
  const actor = getStaffActor(req);

  const rows = await db
    .select(listSelection)
    .from(sheets)
    .leftJoin(clients, eq(clients.id, sheets.clientId))
    .leftJoin(projects, eq(projects.id, sheets.projectId))
    .leftJoin(users, eq(users.id, sheets.createdBy))
    .where(eq(sheets.agencyId, actor.agencyId))
    .orderBy(desc(sheets.updatedAt));

  ok(res, (rows as SheetListRow[]).map((s) => serializeSheetListItem(actor, s)));
});

// ============================================================
//  POST /sheets — sheets.create
// ============================================================
const createSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  clientId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

sheetsRouter.post('/', requires('sheets.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = createSchema.parse(req.body ?? {});

  if (body.clientId !== undefined) await requireInAgency(clients, actor.agencyId, body.clientId, 'Client');
  if (body.projectId !== undefined) await requireInAgency(projects, actor.agencyId, body.projectId, 'Project');

  const id = newId('sht');
  await db.insert(sheets).values({
    id,
    agencyId: actor.agencyId,
    ...(body.title !== undefined ? { title: body.title } : {}),
    clientId: body.clientId ?? null,
    projectId: body.projectId ?? null,
    data: DEFAULT_SHEET_DATA,
    createdBy: actor.userId,
  });

  created(res, serializeSheetFull(actor, await reload(actor, id)));
});

// ============================================================
//  GET /sheets/:id — sheets.view — full row (data parsed)
// ============================================================
sheetsRouter.get('/:id', requires('sheets.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const { row } = await authorizeSheet(actor, param(req, 'id'), 'sheets.view');
  ok(res, serializeSheetFull(actor, row));
});

// ============================================================
//  PATCH /sheets/:id — sheets.update (own / organization) — autosave
// ============================================================
const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  clientId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
});

sheetsRouter.patch('/:id', requires('sheets.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const sheetId = param(req, 'id');
  await authorizeSheet(actor, sheetId, 'sheets.update');
  const body = updateSchema.parse(req.body);

  if (body.clientId) await requireInAgency(clients, actor.agencyId, body.clientId, 'Client');
  if (body.projectId) await requireInAgency(projects, actor.agencyId, body.projectId, 'Project');

  const patch: Partial<typeof sheets.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) patch.title = body.title;
  if (body.data !== undefined) patch.data = JSON.stringify(body.data);
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.projectId !== undefined) patch.projectId = body.projectId;

  await db
    .update(sheets)
    .set(patch)
    .where(and(eq(sheets.id, sheetId), eq(sheets.agencyId, actor.agencyId)));

  ok(res, serializeSheetFull(actor, await reload(actor, sheetId)));
});

// ============================================================
//  POST /sheets/:id/duplicate — sheets.create (+ sheets.view on the source)
// ============================================================
sheetsRouter.post('/:id/duplicate', requires('sheets.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const { row: source } = await authorizeSheet(actor, param(req, 'id'), 'sheets.view');

  const id = newId('sht');
  await db.insert(sheets).values({
    id,
    agencyId: actor.agencyId,
    title: `${source.title} (copy)`,
    clientId: source.clientId,
    projectId: source.projectId,
    data: source.data,
    createdBy: actor.userId,
  });

  created(res, serializeSheetFull(actor, await reload(actor, id)));
});

// ============================================================
//  DELETE /sheets/:id — sheets.delete (own / organization)
// ============================================================
sheetsRouter.delete('/:id', requires('sheets.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const sheetId = param(req, 'id');
  const { row } = await authorizeSheet(actor, sheetId, 'sheets.delete');

  await db
    .delete(sheets)
    .where(and(eq(sheets.id, sheetId), eq(sheets.agencyId, actor.agencyId)));

  await audit({
    ...auditBase(actor, req),
    action: 'sheet.delete',
    entityType: 'sheet',
    entityId: sheetId,
    metadata: { title: row.title },
  });
  ok(res, { deleted: true });
});
