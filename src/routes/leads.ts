import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  leads,
  leadActivities,
  clients,
  clientContacts,
  clientNotes,
  users,
  LEAD_STAGES,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound, badRequest, forbidden, invalidState } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize, canOrg, capabilities, check, requirePermission } from '../authz/engine.js';
import { actorAuditId, type Actor } from '../authz/actor.js';
import { requireActiveStaff } from '../authz/tenancy.js';
import {
  leadFactsOf,
  loadLead,
  ownScopeFilter,
  staffNames,
} from '../authz/policies/business.js';

export const leadsRouter = Router();
leadsRouter.use(authenticate);

// Stage buckets shown as tabs in the UI.
const OPEN_STAGES = ['new', 'contacted', 'qualified'] as const;
const BIN_STAGES = ['lost', 'spam'] as const;
const ACTIVITY_TYPES = [
  'note',
  'call',
  'meeting',
  'email',
  'follow_up',
] as const;

const LEAD_CAPABILITIES = [
  'leads.update',
  'leads.delete',
  'leads.assign',
  'leads.convert',
  'leads.view_value',
];

type LeadRow = typeof leads.$inferSelect;

// ── serialization ────────────────────────────────────────────────────────────
function serializeLead(
  actor: Actor,
  l: LeadRow,
  extra?: {
    ownerName?: string | null;
    convertedClientName?: string | null;
    openFollowUps?: number;
    nextFollowUpAt?: Date | null;
  },
) {
  const facts = leadFactsOf(l);
  const showValue = check(actor, 'leads.view_value', facts);
  return {
    id: l.id,
    name: l.name,
    company: l.company,
    email: l.email,
    phone: l.phone,
    source: l.source,
    service: l.service,
    budget: showValue ? l.budget : null,
    message: l.message,
    stage: l.stage,
    estimatedValue: showValue ? l.estimatedValue : null,
    ownerId: l.ownerId,
    ownerName: extra?.ownerName ?? null,
    convertedClientId: l.convertedClientId,
    convertedClientName: extra?.convertedClientName ?? null,
    openFollowUps: extra?.openFollowUps ?? 0,
    nextFollowUpAt: extra?.nextFollowUpAt ? toIso(extra.nextFollowUpAt) : null,
    lastActivityAt: toIso(l.lastActivityAt),
    createdAt: toIso(l.createdAt),
    updatedAt: toIso(l.updatedAt),
    capabilities: capabilities(actor, facts, LEAD_CAPABILITIES),
  };
}

function serializeActivity(
  a: typeof leadActivities.$inferSelect,
  authorName?: string | null,
) {
  return {
    id: a.id,
    leadId: a.leadId,
    type: a.type,
    body: a.body,
    authorId: a.authorId,
    authorName: authorName ?? null,
    dueAt: toIso(a.dueAt),
    completedAt: toIso(a.completedAt),
    createdAt: toIso(a.createdAt),
  };
}

async function requireLead(actor: Actor, id: string) {
  const lead = await loadLead(actor, id);
  if (!lead) throw notFound('Lead not found.');
  return lead;
}

async function clientName(agencyId: string, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [c] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(and(eq(clients.id, id), eq(clients.agencyId, agencyId)))
    .limit(1);
  return c?.name ?? null;
}

function auditLead(actor: Actor, action: string, leadId: string, ip: string | undefined, metadata?: Record<string, unknown>) {
  return audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action,
    entityType: 'lead',
    entityId: leadId,
    metadata,
    ip,
  });
}

/** Fold pending-follow-up rollups (count + next due) onto a set of leads. */
async function followUpRollups(agencyId: string, leadIds: string[]) {
  const map = new Map<string, { count: number; next: Date | null }>();
  if (leadIds.length === 0) return map;
  const rows = await db
    .select({
      leadId: leadActivities.leadId,
      n: sql<number>`count(*)`,
      next: sql<number | null>`min(${leadActivities.dueAt})`,
    })
    .from(leadActivities)
    .where(
      and(
        eq(leadActivities.agencyId, agencyId),
        inArray(leadActivities.leadId, leadIds),
        eq(leadActivities.type, 'follow_up'),
        isNull(leadActivities.completedAt),
      ),
    )
    .groupBy(leadActivities.leadId);
  for (const r of rows) {
    map.set(r.leadId, {
      count: Number(r.n),
      next: r.next != null ? new Date(Number(r.next) * 1000) : null,
    });
  }
  return map;
}

// ============================================================
//  GET /leads?bucket=open|converted|bin|all&stage=&search=
// ============================================================
const listQuery = z.object({
  bucket: z.enum(['open', 'converted', 'bin', 'all']).optional(),
  stage: z.enum(LEAD_STAGES).optional(),
  search: z.string().optional(),
});

leadsRouter.get('/', requires('leads.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const q = listQuery.parse(req.query);
  const bucket = q.bucket ?? 'open';

  const filters = [
    eq(leads.agencyId, actor.agencyId),
    ownScopeFilter(actor, 'leads.view', leads.ownerId),
  ];
  if (q.stage) {
    filters.push(eq(leads.stage, q.stage));
  } else if (bucket === 'open') {
    filters.push(inArray(leads.stage, [...OPEN_STAGES]));
  } else if (bucket === 'converted') {
    filters.push(eq(leads.stage, 'converted'));
  } else if (bucket === 'bin') {
    filters.push(inArray(leads.stage, [...BIN_STAGES]));
  }
  if (q.search && q.search.trim()) {
    const s = `%${q.search.trim()}%`;
    filters.push(
      or(like(leads.name, s), like(leads.company, s), like(leads.email, s))!,
    );
  }

  const rows = await db
    .select()
    .from(leads)
    .where(and(...filters))
    .orderBy(desc(leads.createdAt));

  // Bulk-resolve owner + converted-client names, restricted to this tenant.
  const ownerNames = await staffNames(actor.agencyId, rows.map((r) => r.ownerId));
  const convIds = [
    ...new Set(rows.map((r) => r.convertedClientId).filter(Boolean) as string[]),
  ];
  const convNames = new Map<string, string | null>();
  if (convIds.length) {
    for (const c of await db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(and(eq(clients.agencyId, actor.agencyId), inArray(clients.id, convIds))))
      convNames.set(c.id, c.name);
  }

  const rollups = await followUpRollups(
    actor.agencyId,
    rows.map((r) => r.id),
  );

  ok(
    res,
    rows.map((l) =>
      serializeLead(actor, l, {
        ownerName: l.ownerId ? ownerNames.get(l.ownerId) ?? null : null,
        convertedClientName: l.convertedClientId
          ? convNames.get(l.convertedClientId) ?? null
          : null,
        openFollowUps: rollups.get(l.id)?.count ?? 0,
        nextFollowUpAt: rollups.get(l.id)?.next ?? null,
      }),
    ),
  );
});

// ============================================================
//  GET /leads/stats — bucket counts (for tab badges; respects scope)
// ============================================================
leadsRouter.get('/stats', requires('leads.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const rows = await db
    .select({ stage: leads.stage, n: sql<number>`count(*)` })
    .from(leads)
    .where(and(eq(leads.agencyId, actor.agencyId), ownScopeFilter(actor, 'leads.view', leads.ownerId)))
    .groupBy(leads.stage);
  const byStage: Record<string, number> = {};
  for (const r of rows) byStage[r.stage] = Number(r.n);
  const sum = (ks: readonly string[]) =>
    ks.reduce((a, k) => a + (byStage[k] ?? 0), 0);
  ok(res, {
    byStage,
    open: sum(OPEN_STAGES),
    converted: byStage['converted'] ?? 0,
    bin: sum(BIN_STAGES),
  });
});

// ============================================================
//  GET /leads/follow-ups — pending follow-ups across open leads in scope
// ============================================================
leadsRouter.get('/follow-ups', requires('leads.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const rows = await db
    .select({
      id: leadActivities.id,
      leadId: leadActivities.leadId,
      type: leadActivities.type,
      body: leadActivities.body,
      authorId: leadActivities.authorId,
      dueAt: leadActivities.dueAt,
      completedAt: leadActivities.completedAt,
      createdAt: leadActivities.createdAt,
      leadName: leads.name,
      leadCompany: leads.company,
      leadStage: leads.stage,
      authorName: users.fullName,
    })
    .from(leadActivities)
    .innerJoin(
      leads,
      and(eq(leads.id, leadActivities.leadId), eq(leads.agencyId, leadActivities.agencyId)),
    )
    .leftJoin(
      users,
      and(eq(users.id, leadActivities.authorId), eq(users.agencyId, leadActivities.agencyId)),
    )
    .where(
      and(
        eq(leadActivities.agencyId, actor.agencyId),
        eq(leadActivities.type, 'follow_up'),
        isNull(leadActivities.completedAt),
        inArray(leads.stage, [...OPEN_STAGES]),
        ownScopeFilter(actor, 'leads.view', leads.ownerId),
      ),
    )
    .orderBy(asc(leadActivities.dueAt));

  const now = Date.now();
  ok(
    res,
    rows.map((r) => ({
      id: r.id,
      leadId: r.leadId,
      type: r.type,
      body: r.body,
      authorId: r.authorId,
      authorName: r.authorName,
      dueAt: toIso(r.dueAt),
      completedAt: toIso(r.completedAt),
      createdAt: toIso(r.createdAt),
      leadName: r.leadName,
      leadCompany: r.leadCompany,
      leadStage: r.leadStage,
      overdue: r.dueAt ? (r.dueAt as Date).getTime() < now : false,
    })),
  );
});

// ============================================================
//  POST /leads — manual create
// ============================================================
const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  company: z.string().trim().max(200).nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal('')),
  phone: z.string().trim().max(60).nullable().optional(),
  source: z.string().trim().max(120).nullable().optional(),
  service: z.string().trim().max(200).nullable().optional(),
  budget: z.string().trim().max(120).nullable().optional(),
  message: z.string().trim().max(5000).nullable().optional(),
  estimatedValue: z.number().int().min(0).nullable().optional(),
  ownerId: z.string().min(1).nullable().optional(),
  stage: z.enum(LEAD_STAGES).optional(),
});

leadsRouter.post('/', requires('leads.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = createSchema.parse(req.body);

  // Owner defaults to the creator; anyone else is an assignment.
  const ownerId = body.ownerId === undefined ? actor.userId : body.ownerId;
  if (ownerId !== actor.userId) {
    requirePermission(actor, 'leads.assign', 'You can only create leads you own.');
    if (ownerId) await requireActiveStaff(actor.agencyId, [ownerId]);
  }
  if (body.stage === 'converted') {
    throw invalidState('Create the lead first, then convert it to a client.');
  }
  // Money on a lead requires seeing lead values for that lead.
  const futureFacts = { agencyId: actor.agencyId, ownerIds: [ownerId] };
  if ((body.budget || body.estimatedValue != null) && !check(actor, 'leads.view_value', futureFacts)) {
    throw forbidden("You don't have permission to set lead values.");
  }

  const id = newId('led');
  await db.insert(leads).values({
    id,
    agencyId: actor.agencyId,
    name: body.name,
    company: body.company || null,
    email: body.email || null,
    phone: body.phone || null,
    source: body.source || 'manual',
    service: body.service || null,
    budget: body.budget || null,
    message: body.message || null,
    estimatedValue: body.estimatedValue ?? null,
    ownerId,
    ...(body.stage ? { stage: body.stage } : {}),
    lastActivityAt: new Date(),
  });
  await auditLead(actor, 'lead.create', id, req.ip, { ownerId });
  const { row } = await requireLead(actor, id);
  created(res, serializeLead(actor, row));
});

// ============================================================
//  GET /leads/:id — detail + activity timeline
// ============================================================
leadsRouter.get('/:id', requires('leads.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const lead = await loadLead(actor, param(req, 'id'));
  authorize(actor, 'leads.view', lead?.facts);
  const row = lead!.row;
  const names = await staffNames(actor.agencyId, [row.ownerId]);
  const acts = await db
    .select({ a: leadActivities, authorName: users.fullName })
    .from(leadActivities)
    .leftJoin(
      users,
      and(eq(users.id, leadActivities.authorId), eq(users.agencyId, leadActivities.agencyId)),
    )
    .where(and(eq(leadActivities.leadId, row.id), eq(leadActivities.agencyId, actor.agencyId)))
    .orderBy(desc(leadActivities.createdAt));

  const rollup = (await followUpRollups(actor.agencyId, [row.id])).get(row.id);
  ok(res, {
    ...serializeLead(actor, row, {
      ownerName: row.ownerId ? names.get(row.ownerId) ?? null : null,
      convertedClientName: await clientName(actor.agencyId, row.convertedClientId),
      openFollowUps: rollup?.count ?? 0,
      nextFollowUpAt: rollup?.next ?? null,
    }),
    activities: acts.map((r) => serializeActivity(r.a, r.authorName)),
  });
});

// ============================================================
//  PATCH /leads/:id — update fields / move stage / reassign
// ============================================================
const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  company: z.string().trim().max(200).nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal('')),
  phone: z.string().trim().max(60).nullable().optional(),
  service: z.string().trim().max(200).nullable().optional(),
  budget: z.string().trim().max(120).nullable().optional(),
  message: z.string().trim().max(5000).nullable().optional(),
  estimatedValue: z.number().int().min(0).nullable().optional(),
  ownerId: z.string().min(1).nullable().optional(),
  stage: z.enum(LEAD_STAGES).optional(),
});

leadsRouter.patch('/:id', requires('leads.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const lead = await loadLead(actor, param(req, 'id'));
  authorize(actor, 'leads.update', lead?.facts, { view: 'leads.view' });
  const row = lead!.row;
  const body = updateSchema.parse(req.body);

  if (body.budget !== undefined || body.estimatedValue !== undefined) {
    if (!check(actor, 'leads.view_value', lead!.facts)) {
      throw forbidden("You don't have permission to change lead values.");
    }
  }
  const ownerChanged = body.ownerId !== undefined && body.ownerId !== row.ownerId;
  if (ownerChanged) {
    requirePermission(actor, 'leads.assign', "You don't have permission to reassign leads.");
    if (body.ownerId) await requireActiveStaff(actor.agencyId, [body.ownerId]);
  }
  if (body.stage === 'converted' && row.stage !== 'converted') {
    throw invalidState('Use "Convert to client" to convert a lead.');
  }
  if (row.stage === 'converted' && body.stage !== undefined && body.stage !== 'converted') {
    throw invalidState('A converted lead cannot change stage.');
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of [
    'name',
    'company',
    'email',
    'phone',
    'service',
    'budget',
    'message',
    'estimatedValue',
    'ownerId',
  ] as const) {
    if (body[k] !== undefined) patch[k] = body[k] === '' ? null : body[k];
  }

  const stageChanged = body.stage !== undefined && body.stage !== row.stage;
  if (body.stage !== undefined) patch.stage = body.stage;
  if (stageChanged) patch.lastActivityAt = new Date();

  await db
    .update(leads)
    .set(patch)
    .where(and(eq(leads.id, row.id), eq(leads.agencyId, actor.agencyId)));

  if (stageChanged) {
    await db.insert(leadActivities).values({
      id: newId('lac'),
      agencyId: actor.agencyId,
      leadId: row.id,
      authorId: actor.userId,
      type: 'stage_change',
      body: `Stage changed: ${row.stage} → ${body.stage}`,
    });
  }
  await auditLead(actor, 'lead.update', row.id, req.ip, {
    fields: Object.keys(patch).filter((k) => k !== 'updatedAt'),
    ...(ownerChanged ? { ownerBefore: row.ownerId, ownerAfter: body.ownerId } : {}),
  });

  const { row: updated } = await requireLead(actor, row.id);
  ok(res, serializeLead(actor, updated));
});

// ============================================================
//  POST /leads/:id/convert — create a client from the lead
// ============================================================
const convertSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  industry: z.string().trim().max(120).optional(),
});

leadsRouter.post('/:id/convert', requires('leads.convert', 'clients.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const lead = await loadLead(actor, param(req, 'id'));
  authorize(actor, 'leads.convert', lead?.facts, { view: 'leads.view' });
  const row = lead!.row;
  const body = convertSchema.parse(req.body ?? {});

  // Idempotent: if already converted, return the existing client.
  if (row.convertedClientId) {
    return ok(res, { clientId: row.convertedClientId, leadId: row.id, already: true });
  }
  if (row.stage === 'lost' || row.stage === 'spam') {
    throw invalidState(`A ${row.stage} lead cannot be converted.`);
  }

  const clientId = newId('cli');
  const newClientName = body.name?.trim() || row.company || row.name;
  // Keep the account owner only when it is still an active teammate.
  let ownerId: string = actor.userId;
  if (row.ownerId) {
    try {
      await requireActiveStaff(actor.agencyId, [row.ownerId]);
      ownerId = row.ownerId;
    } catch {
      ownerId = actor.userId;
    }
  }
  // The budget only travels into client notes when the converter may see it.
  const showValue = check(actor, 'leads.view_value', lead!.facts);
  const summary = [
    row.source ? `Source: ${row.source}` : null,
    row.service ? `Interested in: ${row.service}` : null,
    showValue && row.budget ? `Budget: ${row.budget}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  await db.insert(clients).values({
    id: clientId,
    agencyId: actor.agencyId,
    name: newClientName,
    contactEmail: row.email || null,
    phone: row.phone || null,
    ...(body.industry ? { industry: body.industry } : {}),
    clientSource: 'inbound',
    ownerId,
    internalNotes: `Converted from lead — ${row.name}${summary ? ' · ' + summary : ''}`,
  });

  // Carry the person over as a primary contact.
  try {
    await db.insert(clientContacts).values({
      id: newId('cnt'),
      agencyId: actor.agencyId,
      clientId,
      name: row.name,
      email: row.email || null,
      phone: row.phone || null,
      isPrimary: true,
    });
  } catch {}

  // Preserve the original enquiry as a client note.
  try {
    const noteBody =
      [row.message, summary].filter(Boolean).join('\n\n') ||
      'Converted from an inbound lead.';
    await db.insert(clientNotes).values({
      id: newId('nte'),
      agencyId: actor.agencyId,
      clientId,
      authorId: actor.userId,
      type: 'note',
      body: noteBody,
    });
  } catch {}

  // Flip the lead to converted, keep it linked (history stays on the lead).
  await db
    .update(leads)
    .set({
      stage: 'converted',
      convertedClientId: clientId,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(leads.id, row.id), eq(leads.agencyId, actor.agencyId)));

  await db.insert(leadActivities).values({
    id: newId('lac'),
    agencyId: actor.agencyId,
    leadId: row.id,
    authorId: actor.userId,
    type: 'stage_change',
    body: `Converted to client "${newClientName}"`,
  });
  await auditLead(actor, 'lead.convert', row.id, req.ip, { clientId });

  created(res, { clientId, leadId: row.id });
});

// ============================================================
//  DELETE /leads/:id — permanent delete (cascades activities)
// ============================================================
leadsRouter.delete('/:id', requires('leads.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const lead = await loadLead(actor, param(req, 'id'));
  authorize(actor, 'leads.delete', lead?.facts, { view: 'leads.view' });
  const row = lead!.row;
  await db.delete(leads).where(and(eq(leads.id, row.id), eq(leads.agencyId, actor.agencyId)));
  await auditLead(actor, 'lead.delete', row.id, req.ip, {
    name: row.name,
    stage: row.stage,
    convertedClientId: row.convertedClientId,
  });
  ok(res, { deleted: true, id: row.id });
});

// ============================================================
//  Activities (notes, calls, follow-ups) on a lead
// ============================================================
const activitySchema = z.object({
  type: z.enum(ACTIVITY_TYPES).optional(),
  body: z.string().trim().min(1).max(5000),
  dueAt: z.coerce.date().nullable().optional(),
});

leadsRouter.post('/:id/activities', requires('leads.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const lead = await loadLead(actor, param(req, 'id'));
  authorize(actor, 'leads.update', lead?.facts, { view: 'leads.view' });
  const row = lead!.row;
  const body = activitySchema.parse(req.body);
  const id = newId('lac');
  await db.insert(leadActivities).values({
    id,
    agencyId: actor.agencyId,
    leadId: row.id,
    authorId: actor.userId,
    ...(body.type ? { type: body.type } : {}),
    body: body.body,
    dueAt: body.dueAt ?? null,
  });
  await db
    .update(leads)
    .set({ lastActivityAt: new Date(), updatedAt: new Date() })
    .where(and(eq(leads.id, row.id), eq(leads.agencyId, actor.agencyId)));
  const [act] = await db
    .select({ a: leadActivities, authorName: users.fullName })
    .from(leadActivities)
    .leftJoin(users, eq(users.id, leadActivities.authorId))
    .where(and(eq(leadActivities.id, id), eq(leadActivities.agencyId, actor.agencyId)));
  created(res, serializeActivity(act!.a, act!.authorName));
});

async function loadActivity(actor: Actor, leadId: string, actId: string) {
  const [existing] = await db
    .select()
    .from(leadActivities)
    .where(
      and(
        eq(leadActivities.id, actId),
        eq(leadActivities.leadId, leadId),
        eq(leadActivities.agencyId, actor.agencyId),
      ),
    )
    .limit(1);
  if (!existing) throw notFound('Activity not found.');
  return existing;
}

const activityPatchSchema = z.object({
  body: z.string().trim().min(1).max(5000).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  // Toggle follow-up completion. true → now, false → clear.
  done: z.boolean().optional(),
});

leadsRouter.patch('/:id/activities/:actId', requires('leads.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const lead = await loadLead(actor, param(req, 'id'));
  authorize(actor, 'leads.update', lead?.facts, { view: 'leads.view' });
  const body = activityPatchSchema.parse(req.body);
  const actId = param(req, 'actId');
  const existing = await loadActivity(actor, lead!.row.id, actId);

  const patch: Record<string, unknown> = {};
  if (body.body !== undefined || body.dueAt !== undefined) {
    // System history is immutable; others' notes are editable only org-wide.
    if (existing.type === 'stage_change') {
      throw invalidState('Stage history cannot be edited.');
    }
    if (existing.authorId !== actor.userId && !canOrg(actor, 'leads.update')) {
      throw forbidden('You can only edit your own activities.');
    }
    if (body.body !== undefined) patch.body = body.body;
    if (body.dueAt !== undefined) patch.dueAt = body.dueAt;
  }
  if (body.done !== undefined) patch.completedAt = body.done ? new Date() : null;
  if (Object.keys(patch).length === 0) throw badRequest('Nothing to update.');

  await db
    .update(leadActivities)
    .set(patch)
    .where(and(eq(leadActivities.id, actId), eq(leadActivities.agencyId, actor.agencyId)));
  const [act] = await db
    .select({ a: leadActivities, authorName: users.fullName })
    .from(leadActivities)
    .leftJoin(users, eq(users.id, leadActivities.authorId))
    .where(and(eq(leadActivities.id, actId), eq(leadActivities.agencyId, actor.agencyId)));
  ok(res, serializeActivity(act!.a, act!.authorName));
});

leadsRouter.delete('/:id/activities/:actId', requires('leads.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const lead = await loadLead(actor, param(req, 'id'));
  authorize(actor, 'leads.delete', lead?.facts, { view: 'leads.view' });
  const actId = param(req, 'actId');
  const existing = await loadActivity(actor, lead!.row.id, actId);
  if (existing.type === 'stage_change') {
    throw invalidState('Stage history cannot be deleted.');
  }
  if (existing.authorId !== actor.userId && !canOrg(actor, 'leads.delete')) {
    throw forbidden('You can only delete your own activities.');
  }
  await db
    .delete(leadActivities)
    .where(
      and(
        eq(leadActivities.id, actId),
        eq(leadActivities.leadId, lead!.row.id),
        eq(leadActivities.agencyId, actor.agencyId),
      ),
    );
  await auditLead(actor, 'lead.activity.delete', lead!.row.id, req.ip, { activityId: actId });
  ok(res, { deleted: true, id: actId });
});
