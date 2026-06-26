import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from '../db/client.js';
import {
  clientContacts,
  clientNotes,
  clientTagLinks,
  clientTags,
  clients,
  deals,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { conflict, notFound } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import {
  assignedClientIds,
  getAuth,
  isPrivileged,
  requireClientAccess,
} from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import type { AuthContext } from '../types/index.js';

export const crmRouter = Router();
crmRouter.use(requireAuth);
// CRM data is part of the Clients module: GET=view, writes=manage.
crmRouter.use(requireModuleRW('clients'));

/** Client ids the caller may touch (null = all, for owner/admin). */
async function scopedClientIds(ctx: AuthContext): Promise<string[] | null> {
  return isPrivileged(ctx.role) ? null : await assignedClientIds(ctx);
}

// ============================================================
//  CONTACTS
// ============================================================
function serializeContact(c: typeof clientContacts.$inferSelect) {
  return {
    id: c.id,
    clientId: c.clientId,
    name: c.name,
    role: c.role,
    email: c.email,
    phone: c.phone,
    isPrimary: c.isPrimary,
    isBilling: c.isBilling,
    notes: c.notes,
    createdAt: toIso(c.createdAt),
  };
}

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(80).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  isPrimary: z.boolean().optional(),
  isBilling: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

crmRouter.get('/clients/:clientId/contacts', async (req, res) => {
  const ctx = getAuth(req);
  await requireClientAccess(ctx, param(req, 'clientId'));
  const rows = await db
    .select()
    .from(clientContacts)
    .where(
      and(
        eq(clientContacts.agencyId, ctx.agencyId),
        eq(clientContacts.clientId, param(req, 'clientId')),
      ),
    )
    .orderBy(desc(clientContacts.isPrimary), asc(clientContacts.name));
  ok(res, rows.map(serializeContact));
});

crmRouter.post('/clients/:clientId/contacts', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const body = contactSchema.parse(req.body);
  const id = newId('cnt');
  // Only one primary / billing contact per client.
  if (body.isPrimary)
    await clearFlag(ctx.agencyId, clientId, 'isPrimary');
  if (body.isBilling)
    await clearFlag(ctx.agencyId, clientId, 'isBilling');
  await db.insert(clientContacts).values({
    id,
    agencyId: ctx.agencyId,
    clientId,
    name: body.name,
    role: body.role ?? null,
    email: body.email ?? null,
    phone: body.phone ?? null,
    isPrimary: body.isPrimary ?? false,
    isBilling: body.isBilling ?? false,
    notes: body.notes ?? null,
  });
  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'client.contact.create',
    entityType: 'client_contact',
    entityId: id,
    metadata: { clientId },
    ip: req.ip,
  });
  const [row] = await db.select().from(clientContacts).where(eq(clientContacts.id, id));
  created(res, serializeContact(row!));
});

async function clearFlag(
  agencyId: string,
  clientId: string,
  flag: 'isPrimary' | 'isBilling',
) {
  await db
    .update(clientContacts)
    .set(flag === 'isPrimary' ? { isPrimary: false } : { isBilling: false })
    .where(
      and(
        eq(clientContacts.agencyId, agencyId),
        eq(clientContacts.clientId, clientId),
      ),
    );
}

/** Load a contact + verify client access; returns the row. */
async function contactWithAccess(req: Request) {
  const ctx = getAuth(req);
  const [row] = await db
    .select()
    .from(clientContacts)
    .where(
      and(
        eq(clientContacts.id, param(req, 'id')),
        eq(clientContacts.agencyId, ctx.agencyId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Contact not found.');
  await requireClientAccess(ctx, row.clientId);
  return row;
}

crmRouter.patch('/contacts/:id', async (req, res) => {
  const ctx = getAuth(req);
  const existing = await contactWithAccess(req);
  const body = contactSchema.partial().parse(req.body);
  if (body.isPrimary) await clearFlag(ctx.agencyId, existing.clientId, 'isPrimary');
  if (body.isBilling) await clearFlag(ctx.agencyId, existing.clientId, 'isBilling');
  const patch: Partial<typeof clientContacts.$inferInsert> = {
    updatedAt: new Date(),
  };
  for (const k of ['name', 'role', 'email', 'phone', 'isPrimary', 'isBilling', 'notes'] as const) {
    if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
  }
  await db.update(clientContacts).set(patch).where(eq(clientContacts.id, existing.id));
  const [row] = await db.select().from(clientContacts).where(eq(clientContacts.id, existing.id));
  ok(res, serializeContact(row!));
});

crmRouter.delete('/contacts/:id', async (req, res) => {
  const existing = await contactWithAccess(req);
  await db.delete(clientContacts).where(eq(clientContacts.id, existing.id));
  ok(res, { deleted: true });
});

// ============================================================
//  NOTES / ACTIVITY TIMELINE
// ============================================================
function serializeNote(
  n: typeof clientNotes.$inferSelect,
  authorName?: string | null,
) {
  return {
    id: n.id,
    clientId: n.clientId,
    authorId: n.authorId,
    authorName: authorName ?? null,
    type: n.type,
    body: n.body,
    pinned: n.pinned,
    dueAt: toIso(n.dueAt),
    completedAt: toIso(n.completedAt),
    createdAt: toIso(n.createdAt),
  };
}

const noteSchema = z.object({
  type: z.enum(['note', 'call', 'meeting', 'email', 'task']).optional(),
  body: z.string().trim().min(1).max(5000),
  pinned: z.boolean().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

crmRouter.get('/clients/:clientId/notes', async (req, res) => {
  const ctx = getAuth(req);
  await requireClientAccess(ctx, param(req, 'clientId'));
  const rows = await db
    .select({ n: clientNotes, authorName: users.fullName, authorEmail: users.email })
    .from(clientNotes)
    .leftJoin(users, eq(users.id, clientNotes.authorId))
    .where(
      and(
        eq(clientNotes.agencyId, ctx.agencyId),
        eq(clientNotes.clientId, param(req, 'clientId')),
      ),
    )
    .orderBy(desc(clientNotes.pinned), desc(clientNotes.createdAt))
    .limit(200);
  ok(res, rows.map((r) => serializeNote(r.n, r.authorName ?? r.authorEmail)));
});

crmRouter.post('/clients/:clientId/notes', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const body = noteSchema.parse(req.body);
  const id = newId('nte');
  await db.insert(clientNotes).values({
    id,
    agencyId: ctx.agencyId,
    clientId,
    authorId: ctx.userId,
    type: body.type ?? 'note',
    body: body.body,
    pinned: body.pinned ?? false,
    dueAt: body.dueAt ?? null,
  });
  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'client.note.create',
    entityType: 'client_note',
    entityId: id,
    metadata: { clientId, type: body.type ?? 'note' },
    ip: req.ip,
  });
  const [me] = await db
    .select({ name: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);
  const [row] = await db.select().from(clientNotes).where(eq(clientNotes.id, id));
  created(res, serializeNote(row!, me?.name ?? me?.email));
});

async function noteWithAccess(req: Request) {
  const ctx = getAuth(req);
  const [row] = await db
    .select()
    .from(clientNotes)
    .where(
      and(
        eq(clientNotes.id, param(req, 'id')),
        eq(clientNotes.agencyId, ctx.agencyId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Note not found.');
  await requireClientAccess(ctx, row.clientId);
  return row;
}

const notePatchSchema = z.object({
  body: z.string().trim().min(1).max(5000).optional(),
  pinned: z.boolean().optional(),
  type: z.enum(['note', 'call', 'meeting', 'email', 'task']).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  completed: z.boolean().optional(),
});

crmRouter.patch('/notes/:id', async (req, res) => {
  const existing = await noteWithAccess(req);
  const body = notePatchSchema.parse(req.body);
  const patch: Partial<typeof clientNotes.$inferInsert> = { updatedAt: new Date() };
  if (body.body !== undefined) patch.body = body.body;
  if (body.pinned !== undefined) patch.pinned = body.pinned;
  if (body.type !== undefined) patch.type = body.type;
  if (body.dueAt !== undefined) patch.dueAt = body.dueAt;
  if (body.completed !== undefined)
    patch.completedAt = body.completed ? new Date() : null;
  await db.update(clientNotes).set(patch).where(eq(clientNotes.id, existing.id));
  const [row] = await db.select().from(clientNotes).where(eq(clientNotes.id, existing.id));
  ok(res, serializeNote(row!));
});

crmRouter.delete('/notes/:id', async (req, res) => {
  const existing = await noteWithAccess(req);
  await db.delete(clientNotes).where(eq(clientNotes.id, existing.id));
  ok(res, { deleted: true });
});

// ============================================================
//  TAGS (definitions = owner/admin; links = manage + access)
// ============================================================
function serializeTag(t: typeof clientTags.$inferSelect) {
  return { id: t.id, name: t.name, colorToken: t.colorToken };
}

crmRouter.get('/tags', async (req, res) => {
  const ctx = getAuth(req);
  const rows = await db
    .select()
    .from(clientTags)
    .where(eq(clientTags.agencyId, ctx.agencyId))
    .orderBy(asc(clientTags.name));
  ok(res, rows.map(serializeTag));
});

const tagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  colorToken: z.string().trim().max(20).optional(),
});

crmRouter.post('/tags', requireRole('owner', 'admin'), async (req, res) => {
  const ctx = getAuth(req);
  const body = tagSchema.parse(req.body);
  const [dupe] = await db
    .select({ id: clientTags.id })
    .from(clientTags)
    .where(and(eq(clientTags.agencyId, ctx.agencyId), eq(clientTags.name, body.name)))
    .limit(1);
  if (dupe) throw conflict('A tag with that name already exists.');
  const id = newId('tag');
  await db.insert(clientTags).values({
    id,
    agencyId: ctx.agencyId,
    name: body.name,
    colorToken: body.colorToken ?? 'pine',
  });
  const [row] = await db.select().from(clientTags).where(eq(clientTags.id, id));
  created(res, serializeTag(row!));
});

crmRouter.delete('/tags/:id', requireRole('owner', 'admin'), async (req, res) => {
  const ctx = getAuth(req);
  await db
    .delete(clientTags)
    .where(and(eq(clientTags.id, param(req, 'id')), eq(clientTags.agencyId, ctx.agencyId)));
  ok(res, { deleted: true });
});

crmRouter.get('/clients/:clientId/tags', async (req, res) => {
  const ctx = getAuth(req);
  await requireClientAccess(ctx, param(req, 'clientId'));
  const rows = await db
    .select({ t: clientTags })
    .from(clientTagLinks)
    .innerJoin(clientTags, eq(clientTags.id, clientTagLinks.tagId))
    .where(
      and(
        eq(clientTagLinks.agencyId, ctx.agencyId),
        eq(clientTagLinks.clientId, param(req, 'clientId')),
      ),
    );
  ok(res, rows.map((r) => serializeTag(r.t)));
});

crmRouter.post('/clients/:clientId/tags/:tagId', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const [tag] = await db
    .select({ id: clientTags.id })
    .from(clientTags)
    .where(and(eq(clientTags.id, param(req, 'tagId')), eq(clientTags.agencyId, ctx.agencyId)))
    .limit(1);
  if (!tag) throw notFound('Tag not found.');
  await db
    .insert(clientTagLinks)
    .values({ agencyId: ctx.agencyId, clientId, tagId: tag.id })
    .onConflictDoNothing();
  ok(res, { linked: true });
});

crmRouter.delete('/clients/:clientId/tags/:tagId', async (req, res) => {
  const ctx = getAuth(req);
  await requireClientAccess(ctx, param(req, 'clientId'));
  await db
    .delete(clientTagLinks)
    .where(
      and(
        eq(clientTagLinks.agencyId, ctx.agencyId),
        eq(clientTagLinks.clientId, param(req, 'clientId')),
        eq(clientTagLinks.tagId, param(req, 'tagId')),
      ),
    );
  ok(res, { unlinked: true });
});

// ============================================================
//  DEALS / PIPELINE
// ============================================================
const ownerUser = alias(users, 'owner_user');

function serializeDeal(
  d: typeof deals.$inferSelect,
  clientName?: string | null,
  ownerName?: string | null,
) {
  return {
    id: d.id,
    clientId: d.clientId,
    clientName: clientName ?? null,
    title: d.title,
    stage: d.stage,
    valuePaise: d.valuePaise,
    currency: d.currency,
    probability: d.probability,
    expectedCloseAt: toIso(d.expectedCloseAt),
    ownerId: d.ownerId,
    ownerName: ownerName ?? null,
    lostReason: d.lostReason,
    notes: d.notes,
    closedAt: toIso(d.closedAt),
    createdAt: toIso(d.createdAt),
  };
}

const dealSelect = {
  d: deals,
  clientName: clients.name,
  ownerName: ownerUser.fullName,
};

// GET /crm/deals — full pipeline (member-scoped to assigned clients).
crmRouter.get('/deals', async (req, res) => {
  const ctx = getAuth(req);
  const ids = await scopedClientIds(ctx);
  const filters = [eq(deals.agencyId, ctx.agencyId)];
  if (ids) {
    if (!ids.length) return ok(res, []);
    filters.push(inArray(deals.clientId, ids));
  }
  const rows = await db
    .select(dealSelect)
    .from(deals)
    .leftJoin(clients, eq(clients.id, deals.clientId))
    .leftJoin(ownerUser, eq(ownerUser.id, deals.ownerId))
    .where(and(...filters))
    .orderBy(desc(deals.createdAt))
    .limit(500);
  ok(res, rows.map((r) => serializeDeal(r.d, r.clientName, r.ownerName)));
});

crmRouter.get('/clients/:clientId/deals', async (req, res) => {
  const ctx = getAuth(req);
  await requireClientAccess(ctx, param(req, 'clientId'));
  const rows = await db
    .select(dealSelect)
    .from(deals)
    .leftJoin(clients, eq(clients.id, deals.clientId))
    .leftJoin(ownerUser, eq(ownerUser.id, deals.ownerId))
    .where(
      and(
        eq(deals.agencyId, ctx.agencyId),
        eq(deals.clientId, param(req, 'clientId')),
      ),
    )
    .orderBy(desc(deals.createdAt));
  ok(res, rows.map((r) => serializeDeal(r.d, r.clientName, r.ownerName)));
});

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
const dealSchema = z.object({
  title: z.string().trim().min(1).max(160),
  stage: z.enum(STAGES).optional(),
  valuePaise: z.number().int().min(0).optional(),
  currency: z.string().trim().max(8).optional(),
  probability: z.number().int().min(0).max(100).optional(),
  expectedCloseAt: z.coerce.date().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lostReason: z.string().trim().max(500).nullable().optional(),
});

const CLOSED = new Set(['won', 'lost']);

crmRouter.post('/clients/:clientId/deals', async (req, res) => {
  const ctx = getAuth(req);
  const clientId = param(req, 'clientId');
  await requireClientAccess(ctx, clientId);
  const body = dealSchema.parse(req.body);
  if (body.ownerId) await assertAgencyUser(ctx.agencyId, body.ownerId);
  const id = newId('dl');
  const stage = body.stage ?? 'lead';
  await db.insert(deals).values({
    id,
    agencyId: ctx.agencyId,
    clientId,
    title: body.title,
    stage,
    valuePaise: body.valuePaise ?? 0,
    currency: body.currency ?? 'INR',
    probability: body.probability ?? 0,
    expectedCloseAt: body.expectedCloseAt ?? null,
    ownerId: body.ownerId ?? null,
    notes: body.notes ?? null,
    createdBy: ctx.userId,
    closedAt: CLOSED.has(stage) ? new Date() : null,
  });
  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'deal.create',
    entityType: 'deal',
    entityId: id,
    metadata: { clientId, stage },
    ip: req.ip,
  });
  created(res, await loadDeal(ctx.agencyId, id));
});

async function assertAgencyUser(agencyId: string, userId: string) {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.agencyId, agencyId)))
    .limit(1);
  if (!u) throw notFound('Owner user not found.');
}

async function loadDeal(agencyId: string, id: string) {
  const [r] = await db
    .select(dealSelect)
    .from(deals)
    .leftJoin(clients, eq(clients.id, deals.clientId))
    .leftJoin(ownerUser, eq(ownerUser.id, deals.ownerId))
    .where(and(eq(deals.id, id), eq(deals.agencyId, agencyId)))
    .limit(1);
  if (!r) throw notFound('Deal not found.');
  return serializeDeal(r.d, r.clientName, r.ownerName);
}

async function dealWithAccess(req: Request) {
  const ctx = getAuth(req);
  const [row] = await db
    .select()
    .from(deals)
    .where(and(eq(deals.id, param(req, 'id')), eq(deals.agencyId, ctx.agencyId)))
    .limit(1);
  if (!row) throw notFound('Deal not found.');
  await requireClientAccess(ctx, row.clientId);
  return row;
}

crmRouter.patch('/deals/:id', async (req, res) => {
  const ctx = getAuth(req);
  const existing = await dealWithAccess(req);
  const body = dealSchema.partial().parse(req.body);
  if (body.ownerId) await assertAgencyUser(ctx.agencyId, body.ownerId);
  const patch: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) patch.title = body.title;
  if (body.valuePaise !== undefined) patch.valuePaise = body.valuePaise;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.probability !== undefined) patch.probability = body.probability;
  if (body.expectedCloseAt !== undefined) patch.expectedCloseAt = body.expectedCloseAt;
  if (body.ownerId !== undefined) patch.ownerId = body.ownerId;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.lostReason !== undefined) patch.lostReason = body.lostReason;
  if (body.stage !== undefined) {
    patch.stage = body.stage;
    // Stamp/clear closedAt when crossing the won/lost boundary.
    if (CLOSED.has(body.stage) && !CLOSED.has(existing.stage)) patch.closedAt = new Date();
    if (!CLOSED.has(body.stage) && CLOSED.has(existing.stage)) patch.closedAt = null;
  }
  await db.update(deals).set(patch).where(eq(deals.id, existing.id));
  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'deal.update',
    entityType: 'deal',
    entityId: existing.id,
    metadata: body.stage ? { stage: body.stage } : undefined,
    ip: req.ip,
  });
  ok(res, await loadDeal(ctx.agencyId, existing.id));
});

crmRouter.delete('/deals/:id', async (req, res) => {
  const existing = await dealWithAccess(req);
  await db.delete(deals).where(eq(deals.id, existing.id));
  ok(res, { deleted: true });
});

// ============================================================
//  FOLLOW-UPS (clients with a nextFollowUpAt, member-scoped)
// ============================================================
crmRouter.get('/follow-ups', async (req, res) => {
  const ctx = getAuth(req);
  const ids = await scopedClientIds(ctx);
  const filters = [
    eq(clients.agencyId, ctx.agencyId),
    isNotNull(clients.nextFollowUpAt),
    eq(clients.status, 'active'),
  ];
  if (ids) {
    if (!ids.length) return ok(res, []);
    filters.push(inArray(clients.id, ids));
  }
  const horizon = req.query.window === 'all' ? null : new Date(Date.now() + 14 * 86_400_000);
  if (horizon) filters.push(lte(clients.nextFollowUpAt, horizon));
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      brandColor: clients.brandColor,
      nextFollowUpAt: clients.nextFollowUpAt,
      relationshipHealth: clients.relationshipHealth,
      ownerName: ownerUser.fullName,
    })
    .from(clients)
    .leftJoin(ownerUser, eq(ownerUser.id, clients.ownerId))
    .where(and(...filters))
    .orderBy(asc(clients.nextFollowUpAt))
    .limit(100);
  const now = Date.now();
  ok(
    res,
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      brandColor: r.brandColor,
      nextFollowUpAt: toIso(r.nextFollowUpAt),
      overdue: r.nextFollowUpAt ? r.nextFollowUpAt.getTime() < now : false,
      relationshipHealth: r.relationshipHealth,
      ownerName: r.ownerName ?? null,
    })),
  );
});
