import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, isNotNull, lte } from 'drizzle-orm';
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
import { audit } from '../services/audit.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize, capabilities, check, type ObjectFacts } from '../authz/engine.js';
import type { StaffActor } from '../authz/actor.js';
import { requireActiveStaff } from '../authz/tenancy.js';
import { clientFacts, clientScopeFilter } from '../authz/policies/clients.js';
import {
  clientRowFactsBuilder,
  contactFacts,
  dealFacts,
  dealScopeFilter,
  noteFacts,
  tagFacts,
} from '../authz/policies/crm.js';

/**
 * CRM (`/crm`): contacts, notes/activities, tags and deals. Every child object
 * inherits its client's scope (policies/crm.ts). Routes addressing a child by
 * id exist both flat (`/contacts/:id`) and nested under the client
 * (`/clients/:clientId/contacts/:id`); the nested form 404s when the child
 * belongs to another client.
 */
export const crmRouter = Router();
crmRouter.use(authenticate);

type Actor = StaffActor;
type NoteRow = typeof clientNotes.$inferSelect;
type DealRow = typeof deals.$inferSelect;

/**
 * Authorize `permission` on the client in the URL. 404 when the client isn't
 * in the tenant or the actor can't `view` it; 403 when visible but not allowed.
 */
async function clientInUrl(req: Request, permission: string, view = 'clients.view') {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const facts = await clientFacts(actor, clientId);
  if (!facts || !check(actor, view, facts)) throw notFound('Client not found.');
  if (permission !== view) authorize(actor, permission, facts, { view });
  return { actor, clientId, facts: facts! };
}

/** Optional URL parent for child routes (undefined on the flat routes). */
function urlClientId(req: Request): string | undefined {
  const v = (req.params as Record<string, string | undefined>).clientId;
  return typeof v === 'string' && v.length ? v : undefined;
}

// ============================================================
//  CONTACTS  (read: clients.view · write: contacts.manage)
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

crmRouter.get('/clients/:clientId/contacts', requires('clients.view'), async (req, res) => {
  const { actor, clientId } = await clientInUrl(req, 'clients.view');
  const rows = await db
    .select()
    .from(clientContacts)
    .where(and(eq(clientContacts.agencyId, actor.agencyId), eq(clientContacts.clientId, clientId)))
    .orderBy(desc(clientContacts.isPrimary), asc(clientContacts.name));
  ok(res, rows.map(serializeContact));
});

crmRouter.post('/clients/:clientId/contacts', requires('contacts.manage'), async (req, res) => {
  const { actor, clientId } = await clientInUrl(req, 'contacts.manage');
  const body = contactSchema.parse(req.body);
  const id = newId('cnt');
  if (body.isPrimary) await clearFlag(actor.agencyId, clientId, 'isPrimary');
  if (body.isBilling) await clearFlag(actor.agencyId, clientId, 'isBilling');
  await db.insert(clientContacts).values({
    id,
    agencyId: actor.agencyId,
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
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.contact.create',
    entityType: 'client_contact',
    entityId: id,
    metadata: { clientId, isPrimary: body.isPrimary ?? false },
    ip: req.ip,
  });
  const [row] = await db.select().from(clientContacts).where(eq(clientContacts.id, id));
  created(res, serializeContact(row!));
});

async function clearFlag(agencyId: string, clientId: string, flag: 'isPrimary' | 'isBilling') {
  await db
    .update(clientContacts)
    .set(flag === 'isPrimary' ? { isPrimary: false } : { isBilling: false })
    .where(and(eq(clientContacts.agencyId, agencyId), eq(clientContacts.clientId, clientId)));
}

async function contactFor(req: Request) {
  const actor = getStaffActor(req);
  const loaded = await contactFacts(actor, param(req, 'id'), urlClientId(req));
  if (!loaded) throw notFound('Contact not found.');
  authorize(actor, 'contacts.manage', loaded.facts, { view: 'clients.view' });
  return { actor, existing: loaded.row };
}

async function updateContact(req: Request, res: Parameters<typeof ok>[0]) {
  const { actor, existing } = await contactFor(req);
  const body = contactSchema.partial().parse(req.body);
  if (body.isPrimary) await clearFlag(actor.agencyId, existing.clientId, 'isPrimary');
  if (body.isBilling) await clearFlag(actor.agencyId, existing.clientId, 'isBilling');
  const patch: Partial<typeof clientContacts.$inferInsert> = { updatedAt: new Date() };
  for (const k of ['name', 'role', 'email', 'phone', 'isPrimary', 'isBilling', 'notes'] as const) {
    if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
  }
  await db.update(clientContacts).set(patch).where(eq(clientContacts.id, existing.id));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.contact.update',
    entityType: 'client_contact',
    entityId: existing.id,
    metadata: { clientId: existing.clientId, fields: Object.keys(patch).filter((k) => k !== 'updatedAt') },
    ip: req.ip,
  });
  const [row] = await db.select().from(clientContacts).where(eq(clientContacts.id, existing.id));
  ok(res, serializeContact(row!));
}

async function deleteContact(req: Request, res: Parameters<typeof ok>[0]) {
  const { actor, existing } = await contactFor(req);
  await db.delete(clientContacts).where(eq(clientContacts.id, existing.id));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.contact.delete',
    entityType: 'client_contact',
    entityId: existing.id,
    metadata: { clientId: existing.clientId },
    ip: req.ip,
  });
  ok(res, { deleted: true });
}

crmRouter.patch('/contacts/:id', requires('contacts.manage'), updateContact);
crmRouter.patch('/clients/:clientId/contacts/:id', requires('contacts.manage'), updateContact);
crmRouter.delete('/contacts/:id', requires('contacts.manage'), deleteContact);
crmRouter.delete('/clients/:clientId/contacts/:id', requires('contacts.manage'), deleteContact);

// ============================================================
//  NOTES / ACTIVITY TIMELINE
//  read: clients.view · create: client_notes.create ·
//  update/delete: client_notes.update/delete (own = author, or organization)
// ============================================================
const NOTE_CAPABILITIES = ['client_notes.update', 'client_notes.delete'];

function serializeNote(
  n: typeof clientNotes.$inferSelect,
  authorName: string | null | undefined,
  caps: Record<string, boolean>,
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
    capabilities: caps,
  };
}

const noteSchema = z.object({
  type: z.enum(['note', 'call', 'meeting', 'email', 'task']).optional(),
  body: z.string().trim().min(1).max(5000),
  pinned: z.boolean().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

function noteRowFacts(base: ObjectFacts, authorId: string | null): ObjectFacts {
  return { ...base, ownerIds: [authorId] };
}

async function authorName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await db
    .select({ name: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.name ?? u?.email ?? null;
}

crmRouter.get('/clients/:clientId/notes', requires('clients.view'), async (req, res) => {
  const { actor, clientId, facts } = await clientInUrl(req, 'clients.view');
  const rows = await db
    .select({ n: clientNotes, authorName: users.fullName, authorEmail: users.email })
    .from(clientNotes)
    .leftJoin(users, eq(users.id, clientNotes.authorId))
    .where(and(eq(clientNotes.agencyId, actor.agencyId), eq(clientNotes.clientId, clientId)))
    .orderBy(desc(clientNotes.pinned), desc(clientNotes.createdAt))
    .limit(200);
  ok(
    res,
    rows.map((r) =>
      serializeNote(
        r.n,
        r.authorName ?? r.authorEmail,
        capabilities(actor, noteRowFacts(facts, (r.n as NoteRow).authorId), NOTE_CAPABILITIES),
      ),
    ),
  );
});

crmRouter.post('/clients/:clientId/notes', requires('client_notes.create'), async (req, res) => {
  const { actor, clientId, facts } = await clientInUrl(req, 'client_notes.create');
  const body = noteSchema.parse(req.body);
  const id = newId('nte');
  await db.insert(clientNotes).values({
    id,
    agencyId: actor.agencyId,
    clientId,
    authorId: actor.userId,
    type: body.type ?? 'note',
    body: body.body,
    pinned: body.pinned ?? false,
    dueAt: body.dueAt ?? null,
  });
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.note.create',
    entityType: 'client_note',
    entityId: id,
    metadata: { clientId, type: body.type ?? 'note' },
    ip: req.ip,
  });
  const [row] = await db.select().from(clientNotes).where(eq(clientNotes.id, id));
  created(
    res,
    serializeNote(
      row!,
      await authorName(actor.userId),
      capabilities(actor, noteRowFacts(facts, actor.userId), NOTE_CAPABILITIES),
    ),
  );
});

async function noteFor(req: Request, permission: 'client_notes.update' | 'client_notes.delete') {
  const actor = getStaffActor(req);
  const loaded = await noteFacts(actor, param(req, 'id'), urlClientId(req));
  if (!loaded) throw notFound('Note not found.');
  // Must still see the client (own-scope authors who lost access get 404).
  authorize(actor, 'clients.view', loaded.facts);
  authorize(actor, permission, loaded.facts, { view: 'clients.view' });
  return { actor, existing: loaded.row, facts: loaded.facts };
}

const notePatchSchema = z.object({
  body: z.string().trim().min(1).max(5000).optional(),
  pinned: z.boolean().optional(),
  type: z.enum(['note', 'call', 'meeting', 'email', 'task']).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  completed: z.boolean().optional(),
});

async function updateNote(req: Request, res: Parameters<typeof ok>[0]) {
  const { actor, existing, facts } = await noteFor(req, 'client_notes.update');
  const body = notePatchSchema.parse(req.body);
  const patch: Partial<typeof clientNotes.$inferInsert> = { updatedAt: new Date() };
  if (body.body !== undefined) patch.body = body.body;
  if (body.pinned !== undefined) patch.pinned = body.pinned;
  if (body.type !== undefined) patch.type = body.type;
  if (body.dueAt !== undefined) patch.dueAt = body.dueAt;
  if (body.completed !== undefined) patch.completedAt = body.completed ? new Date() : null;
  await db.update(clientNotes).set(patch).where(eq(clientNotes.id, existing.id));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.note.update',
    entityType: 'client_note',
    entityId: existing.id,
    metadata: {
      clientId: existing.clientId,
      authorId: existing.authorId,
      fields: Object.keys(patch).filter((k) => k !== 'updatedAt'),
    },
    ip: req.ip,
  });
  const [row] = await db.select().from(clientNotes).where(eq(clientNotes.id, existing.id));
  ok(res, serializeNote(row!, await authorName(row!.authorId), capabilities(actor, facts, NOTE_CAPABILITIES)));
}

async function deleteNote(req: Request, res: Parameters<typeof ok>[0]) {
  const { actor, existing } = await noteFor(req, 'client_notes.delete');
  await db.delete(clientNotes).where(eq(clientNotes.id, existing.id));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.note.delete',
    entityType: 'client_note',
    entityId: existing.id,
    metadata: { clientId: existing.clientId, authorId: existing.authorId },
    ip: req.ip,
  });
  ok(res, { deleted: true });
}

crmRouter.patch('/notes/:id', requires('client_notes.update'), updateNote);
crmRouter.patch('/clients/:clientId/notes/:id', requires('client_notes.update'), updateNote);
crmRouter.delete('/notes/:id', requires('client_notes.delete'), deleteNote);
crmRouter.delete('/clients/:clientId/notes/:id', requires('client_notes.delete'), deleteNote);

// ============================================================
//  TAGS  (definitions: tags.manage · links: clients.update on the client)
// ============================================================
function serializeTag(t: typeof clientTags.$inferSelect) {
  return { id: t.id, name: t.name, colorToken: t.colorToken };
}

// Tag definitions are agency-level labels, readable by anyone who can view clients.
crmRouter.get('/tags', requires('clients.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const rows = await db
    .select()
    .from(clientTags)
    .where(eq(clientTags.agencyId, actor.agencyId))
    .orderBy(asc(clientTags.name));
  ok(res, rows.map(serializeTag));
});

const tagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  colorToken: z.string().trim().max(20).optional(),
});

crmRouter.post('/tags', requires('tags.manage'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = tagSchema.parse(req.body);
  const [dupe] = await db
    .select({ id: clientTags.id })
    .from(clientTags)
    .where(and(eq(clientTags.agencyId, actor.agencyId), eq(clientTags.name, body.name)))
    .limit(1);
  if (dupe) throw conflict('A tag with that name already exists.');
  const id = newId('tag');
  await db.insert(clientTags).values({
    id,
    agencyId: actor.agencyId,
    name: body.name,
    colorToken: body.colorToken ?? 'pine',
  });
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.tag.create',
    entityType: 'client_tag',
    entityId: id,
    metadata: { name: body.name },
    ip: req.ip,
  });
  const [row] = await db.select().from(clientTags).where(eq(clientTags.id, id));
  created(res, serializeTag(row!));
});

crmRouter.delete('/tags/:id', requires('tags.manage'), async (req, res) => {
  const actor = getStaffActor(req);
  const loaded = await tagFacts(actor, param(req, 'id'));
  if (!loaded) throw notFound('Tag not found.');
  authorize(actor, 'tags.manage', loaded.facts);
  await db
    .delete(clientTagLinks)
    .where(and(eq(clientTagLinks.agencyId, actor.agencyId), eq(clientTagLinks.tagId, loaded.row.id)));
  await db
    .delete(clientTags)
    .where(and(eq(clientTags.id, loaded.row.id), eq(clientTags.agencyId, actor.agencyId)));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.tag.delete',
    entityType: 'client_tag',
    entityId: loaded.row.id,
    metadata: { name: loaded.row.name },
    ip: req.ip,
  });
  ok(res, { deleted: true });
});

crmRouter.get('/clients/:clientId/tags', requires('clients.view'), async (req, res) => {
  const { actor, clientId } = await clientInUrl(req, 'clients.view');
  const rows = await db
    .select({ t: clientTags })
    .from(clientTagLinks)
    .innerJoin(clientTags, eq(clientTags.id, clientTagLinks.tagId))
    .where(
      and(
        eq(clientTagLinks.agencyId, actor.agencyId),
        eq(clientTagLinks.clientId, clientId),
        eq(clientTags.agencyId, actor.agencyId),
      ),
    );
  ok(res, rows.map((r) => serializeTag(r.t)));
});

crmRouter.post('/clients/:clientId/tags/:tagId', requires('clients.update'), async (req, res) => {
  const { actor, clientId } = await clientInUrl(req, 'clients.update');
  const tag = await tagFacts(actor, param(req, 'tagId'));
  if (!tag) throw notFound('Tag not found.');
  await db
    .insert(clientTagLinks)
    .values({ agencyId: actor.agencyId, clientId, tagId: tag.row.id })
    .onConflictDoNothing();
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.tag.link',
    entityType: 'client',
    entityId: clientId,
    metadata: { tagId: tag.row.id },
    ip: req.ip,
  });
  ok(res, { linked: true });
});

crmRouter.delete('/clients/:clientId/tags/:tagId', requires('clients.update'), async (req, res) => {
  const { actor, clientId } = await clientInUrl(req, 'clients.update');
  const removed = await db
    .delete(clientTagLinks)
    .where(
      and(
        eq(clientTagLinks.agencyId, actor.agencyId),
        eq(clientTagLinks.clientId, clientId),
        eq(clientTagLinks.tagId, param(req, 'tagId')),
      ),
    )
    .returning({ tagId: clientTagLinks.tagId });
  if (removed.length) {
    await audit({
      agencyId: actor.agencyId,
      actorType: actor.type,
      actorId: actor.userId,
      action: 'client.tag.unlink',
      entityType: 'client',
      entityId: clientId,
      metadata: { tagId: param(req, 'tagId') },
      ip: req.ip,
    });
  }
  ok(res, { unlinked: true });
});

// ============================================================
//  DEALS / PIPELINE
//  view: deals.view · create/update/delete: deals.* ·
//  valuePaise read: deals.view_value · valuePaise write: deals.update_value
// ============================================================
const ownerUser = alias(users, 'owner_user');
const DEAL_CAPABILITIES = ['deals.update', 'deals.delete', 'deals.view_value', 'deals.update_value'];

function serializeDeal(
  actor: Actor,
  d: typeof deals.$inferSelect,
  facts: ObjectFacts,
  clientName?: string | null,
  ownerName?: string | null,
) {
  const showValue = check(actor, 'deals.view_value', facts);
  return {
    id: d.id,
    clientId: d.clientId,
    clientName: clientName ?? null,
    title: d.title,
    stage: d.stage,
    valuePaise: showValue ? d.valuePaise : null,
    currency: d.currency,
    probability: d.probability,
    expectedCloseAt: toIso(d.expectedCloseAt),
    ownerId: d.ownerId,
    ownerName: ownerName ?? null,
    lostReason: d.lostReason,
    notes: d.notes,
    closedAt: toIso(d.closedAt),
    createdAt: toIso(d.createdAt),
    capabilities: capabilities(actor, facts, DEAL_CAPABILITIES),
  };
}

const dealSelect = {
  d: deals,
  clientName: clients.name,
  ownerName: ownerUser.fullName,
};

// GET /crm/deals — pipeline, filtered in SQL to clients in the deals.view scope.
crmRouter.get('/deals', requires('deals.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const scope = await dealScopeFilter(actor, 'deals.view');
  const rows = await db
    .select(dealSelect)
    .from(deals)
    .leftJoin(clients, eq(clients.id, deals.clientId))
    .leftJoin(ownerUser, eq(ownerUser.id, deals.ownerId))
    .where(and(eq(deals.agencyId, actor.agencyId), scope))
    .orderBy(desc(deals.createdAt))
    .limit(500);
  const factsFor = await clientRowFactsBuilder(actor);
  ok(res, rows.map((r) => serializeDeal(actor, r.d, factsFor((r.d as DealRow).clientId), r.clientName, r.ownerName)));
});

crmRouter.get('/clients/:clientId/deals', requires('deals.view'), async (req, res) => {
  const { actor, clientId, facts } = await clientInUrl(req, 'deals.view', 'deals.view');
  const rows = await db
    .select(dealSelect)
    .from(deals)
    .leftJoin(clients, eq(clients.id, deals.clientId))
    .leftJoin(ownerUser, eq(ownerUser.id, deals.ownerId))
    .where(and(eq(deals.agencyId, actor.agencyId), eq(deals.clientId, clientId)))
    .orderBy(desc(deals.createdAt));
  ok(res, rows.map((r) => serializeDeal(actor, r.d, facts, r.clientName, r.ownerName)));
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

async function loadDeal(actor: Actor, id: string) {
  const [r] = await db
    .select(dealSelect)
    .from(deals)
    .leftJoin(clients, eq(clients.id, deals.clientId))
    .leftJoin(ownerUser, eq(ownerUser.id, deals.ownerId))
    .where(and(eq(deals.id, id), eq(deals.agencyId, actor.agencyId)))
    .limit(1);
  if (!r) throw notFound('Deal not found.');
  const facts = await clientFacts(actor, (r.d as DealRow).clientId);
  return serializeDeal(actor, r.d, facts!, r.clientName, r.ownerName);
}

crmRouter.post('/clients/:clientId/deals', requires('deals.create'), async (req, res) => {
  const { actor, clientId, facts } = await clientInUrl(req, 'deals.create', 'deals.view');
  const body = dealSchema.parse(req.body);
  if (body.valuePaise !== undefined && body.valuePaise !== 0) {
    authorize(actor, 'deals.update_value', facts, {
      view: 'deals.view',
      message: "You can't set deal values.",
    });
  }
  if (body.ownerId) await requireActiveStaff(actor.agencyId, [body.ownerId]);
  const id = newId('dl');
  const stage = body.stage ?? 'lead';
  await db.insert(deals).values({
    id,
    agencyId: actor.agencyId,
    clientId,
    title: body.title,
    stage,
    valuePaise: body.valuePaise ?? 0,
    currency: body.currency ?? 'INR',
    probability: body.probability ?? 0,
    expectedCloseAt: body.expectedCloseAt ?? null,
    ownerId: body.ownerId ?? null,
    notes: body.notes ?? null,
    createdBy: actor.userId,
    closedAt: CLOSED.has(stage) ? new Date() : null,
  });
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'deal.create',
    entityType: 'deal',
    entityId: id,
    metadata: { clientId, stage },
    ip: req.ip,
  });
  created(res, await loadDeal(actor, id));
});

async function dealFor(req: Request, permission: 'deals.update' | 'deals.delete') {
  const actor = getStaffActor(req);
  const loaded = await dealFacts(actor, param(req, 'id'), urlClientId(req));
  if (!loaded) throw notFound('Deal not found.');
  authorize(actor, permission, loaded.facts, { view: 'deals.view' });
  return { actor, existing: loaded.row, facts: loaded.facts };
}

async function updateDeal(req: Request, res: Parameters<typeof ok>[0]) {
  const { actor, existing, facts } = await dealFor(req, 'deals.update');
  const body = dealSchema.partial().parse(req.body);
  if (body.valuePaise !== undefined && body.valuePaise !== existing.valuePaise) {
    authorize(actor, 'deals.update_value', facts, {
      view: 'deals.view',
      message: "You can't change deal values.",
    });
  }
  if (body.ownerId && body.ownerId !== existing.ownerId) {
    await requireActiveStaff(actor.agencyId, [body.ownerId]);
  }
  const patch: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) patch.title = body.title;
  if (body.valuePaise !== undefined && body.valuePaise !== existing.valuePaise) patch.valuePaise = body.valuePaise;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.probability !== undefined) patch.probability = body.probability;
  if (body.expectedCloseAt !== undefined) patch.expectedCloseAt = body.expectedCloseAt;
  if (body.ownerId !== undefined) patch.ownerId = body.ownerId;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.lostReason !== undefined) patch.lostReason = body.lostReason;
  if (body.stage !== undefined) {
    patch.stage = body.stage;
    if (CLOSED.has(body.stage) && !CLOSED.has(existing.stage)) patch.closedAt = new Date();
    if (!CLOSED.has(body.stage) && CLOSED.has(existing.stage)) patch.closedAt = null;
  }
  await db.update(deals).set(patch).where(eq(deals.id, existing.id));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'deal.update',
    entityType: 'deal',
    entityId: existing.id,
    metadata: {
      clientId: existing.clientId,
      fields: Object.keys(patch).filter((k) => k !== 'updatedAt'),
      ...(body.stage ? { stage: body.stage } : {}),
    },
    ip: req.ip,
  });
  ok(res, await loadDeal(actor, existing.id));
}

async function deleteDeal(req: Request, res: Parameters<typeof ok>[0]) {
  const { actor, existing } = await dealFor(req, 'deals.delete');
  await db.delete(deals).where(eq(deals.id, existing.id));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'deal.delete',
    entityType: 'deal',
    entityId: existing.id,
    metadata: { clientId: existing.clientId, title: existing.title },
    ip: req.ip,
  });
  ok(res, { deleted: true });
}

crmRouter.patch('/deals/:id', requires('deals.update'), updateDeal);
crmRouter.patch('/clients/:clientId/deals/:id', requires('deals.update'), updateDeal);
crmRouter.delete('/deals/:id', requires('deals.delete'), deleteDeal);
crmRouter.delete('/clients/:clientId/deals/:id', requires('deals.delete'), deleteDeal);

// ============================================================
//  FOLLOW-UPS (clients with a nextFollowUpAt, clients.view scope)
// ============================================================
crmRouter.get('/follow-ups', requires('clients.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const scope = await clientScopeFilter(actor, 'clients.view', clients.id);
  const filters = [
    eq(clients.agencyId, actor.agencyId),
    isNotNull(clients.nextFollowUpAt),
    eq(clients.status, 'active'),
    scope,
  ];
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
