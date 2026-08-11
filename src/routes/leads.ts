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
import { notFound, badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';

export const leadsRouter = Router();
leadsRouter.use(requireAuth);
// Leads are CRM data — gated on the `clients` module (read/write).
leadsRouter.use(requireModuleRW('clients'));

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

type Auth = ReturnType<typeof getAuth>;

// ── serialization ────────────────────────────────────────────────────────────
function serializeLead(l: typeof leads.$inferSelect, extra?: {
  ownerName?: string | null;
  convertedClientName?: string | null;
  openFollowUps?: number;
  nextFollowUpAt?: Date | null;
}) {
  return {
    id: l.id,
    name: l.name,
    company: l.company,
    email: l.email,
    phone: l.phone,
    source: l.source,
    service: l.service,
    budget: l.budget,
    message: l.message,
    stage: l.stage,
    estimatedValue: l.estimatedValue,
    ownerId: l.ownerId,
    ownerName: extra?.ownerName ?? null,
    convertedClientId: l.convertedClientId,
    convertedClientName: extra?.convertedClientName ?? null,
    openFollowUps: extra?.openFollowUps ?? 0,
    nextFollowUpAt: extra?.nextFollowUpAt ? toIso(extra.nextFollowUpAt) : null,
    lastActivityAt: toIso(l.lastActivityAt),
    createdAt: toIso(l.createdAt),
    updatedAt: toIso(l.updatedAt),
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

async function getScopedLead(ctx: Auth, id: string) {
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, id), eq(leads.agencyId, ctx.agencyId)))
    .limit(1);
  if (!row) throw notFound('Lead not found.');
  return row;
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

leadsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const q = listQuery.parse(req.query);
  const bucket = q.bucket ?? 'open';

  const filters = [eq(leads.agencyId, ctx.agencyId)];
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

  // Bulk-resolve owner + converted-client names (avoids join-typing quirks).
  const ownerIds = [
    ...new Set(rows.map((r) => r.ownerId).filter(Boolean) as string[]),
  ];
  const convIds = [
    ...new Set(rows.map((r) => r.convertedClientId).filter(Boolean) as string[]),
  ];
  const ownerNames = new Map<string, string | null>();
  if (ownerIds.length) {
    for (const u of await db
      .select({ id: users.id, name: users.fullName })
      .from(users)
      .where(inArray(users.id, ownerIds)))
      ownerNames.set(u.id, u.name);
  }
  const convNames = new Map<string, string | null>();
  if (convIds.length) {
    for (const c of await db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(inArray(clients.id, convIds)))
      convNames.set(c.id, c.name);
  }

  const rollups = await followUpRollups(
    ctx.agencyId,
    rows.map((r) => r.id),
  );

  ok(
    res,
    rows.map((l) =>
      serializeLead(l, {
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
//  GET /leads/stats — bucket counts (for tab badges)
// ============================================================
leadsRouter.get('/stats', async (req, res) => {
  const ctx = getAuth(req);
  const rows = await db
    .select({ stage: leads.stage, n: sql<number>`count(*)` })
    .from(leads)
    .where(eq(leads.agencyId, ctx.agencyId))
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
//  GET /leads/follow-ups — pending follow-ups across open leads
// ============================================================
leadsRouter.get('/follow-ups', async (req, res) => {
  const ctx = getAuth(req);
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
    .innerJoin(leads, eq(leads.id, leadActivities.leadId))
    .leftJoin(users, eq(users.id, leadActivities.authorId))
    .where(
      and(
        eq(leadActivities.agencyId, ctx.agencyId),
        eq(leadActivities.type, 'follow_up'),
        isNull(leadActivities.completedAt),
        inArray(leads.stage, [...OPEN_STAGES]),
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
  company: z.string().trim().max(200).optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().trim().max(60).optional(),
  source: z.string().trim().max(120).optional(),
  service: z.string().trim().max(200).optional(),
  budget: z.string().trim().max(120).optional(),
  message: z.string().trim().max(5000).optional(),
  estimatedValue: z.number().int().min(0).nullable().optional(),
  ownerId: z.string().min(1).nullable().optional(),
  stage: z.enum(LEAD_STAGES).optional(),
});

leadsRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = createSchema.parse(req.body);
  const id = newId('led');
  await db.insert(leads).values({
    id,
    agencyId: ctx.agencyId,
    name: body.name,
    company: body.company || null,
    email: body.email || null,
    phone: body.phone || null,
    source: body.source || 'manual',
    service: body.service || null,
    budget: body.budget || null,
    message: body.message || null,
    estimatedValue: body.estimatedValue ?? null,
    ownerId: body.ownerId ?? ctx.userId,
    ...(body.stage ? { stage: body.stage } : {}),
    lastActivityAt: new Date(),
  });
  const row = await getScopedLead(ctx, id);
  created(res, serializeLead(row));
});

// ============================================================
//  GET /leads/:id — detail + activity timeline
// ============================================================
leadsRouter.get('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const lead = await getScopedLead(ctx, param(req, 'id'));
  const [owner] = lead.ownerId
    ? await db.select({ name: users.fullName }).from(users).where(eq(users.id, lead.ownerId)).limit(1)
    : [];
  const [conv] = lead.convertedClientId
    ? await db.select({ name: clients.name }).from(clients).where(eq(clients.id, lead.convertedClientId)).limit(1)
    : [];
  const acts = await db
    .select({ a: leadActivities, authorName: users.fullName })
    .from(leadActivities)
    .leftJoin(users, eq(users.id, leadActivities.authorId))
    .where(eq(leadActivities.leadId, lead.id))
    .orderBy(desc(leadActivities.createdAt));

  const rollup = (await followUpRollups(ctx.agencyId, [lead.id])).get(lead.id);
  ok(res, {
    ...serializeLead(lead, {
      ownerName: owner?.name ?? null,
      convertedClientName: conv?.name ?? null,
      openFollowUps: rollup?.count ?? 0,
      nextFollowUpAt: rollup?.next ?? null,
    }),
    activities: acts.map((r) => serializeActivity(r.a, r.authorName)),
  });
});

// ============================================================
//  PATCH /leads/:id — update fields / move stage
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

leadsRouter.patch('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const lead = await getScopedLead(ctx, param(req, 'id'));
  const body = updateSchema.parse(req.body);

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

  const stageChanged = body.stage !== undefined && body.stage !== lead.stage;
  if (body.stage !== undefined) patch.stage = body.stage;
  if (stageChanged) patch.lastActivityAt = new Date();

  await db.update(leads).set(patch).where(eq(leads.id, lead.id));

  if (stageChanged) {
    await db.insert(leadActivities).values({
      id: newId('lac'),
      agencyId: ctx.agencyId,
      leadId: lead.id,
      authorId: ctx.userId,
      type: 'stage_change',
      body: `Stage changed: ${lead.stage} → ${body.stage}`,
    });
  }

  const row = await getScopedLead(ctx, lead.id);
  ok(res, serializeLead(row));
});

// ============================================================
//  POST /leads/:id/convert — create a client from the lead
// ============================================================
const convertSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  industry: z.string().trim().max(120).optional(),
});

leadsRouter.post('/:id/convert', async (req, res) => {
  const ctx = getAuth(req);
  const lead = await getScopedLead(ctx, param(req, 'id'));
  const body = convertSchema.parse(req.body ?? {});

  // Idempotent: if already converted, return the existing client.
  if (lead.convertedClientId) {
    return ok(res, { clientId: lead.convertedClientId, leadId: lead.id, already: true });
  }

  const clientId = newId('cli');
  const clientName = body.name?.trim() || lead.company || lead.name;
  const ownerId = lead.ownerId ?? ctx.userId;
  const summary = [
    lead.source ? `Source: ${lead.source}` : null,
    lead.service ? `Interested in: ${lead.service}` : null,
    lead.budget ? `Budget: ${lead.budget}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  await db.insert(clients).values({
    id: clientId,
    agencyId: ctx.agencyId,
    name: clientName,
    contactEmail: lead.email || null,
    phone: lead.phone || null,
    ...(body.industry ? { industry: body.industry } : {}),
    clientSource: 'inbound',
    ownerId,
    internalNotes: `Converted from lead — ${lead.name}${summary ? ' · ' + summary : ''}`,
  });

  // Carry the person over as a primary contact.
  try {
    await db.insert(clientContacts).values({
      id: newId('cnt'),
      agencyId: ctx.agencyId,
      clientId,
      name: lead.name,
      email: lead.email || null,
      phone: lead.phone || null,
      isPrimary: true,
    });
  } catch {}

  // Preserve the original enquiry as a client note.
  try {
    const noteBody =
      [lead.message, summary].filter(Boolean).join('\n\n') ||
      'Converted from an inbound lead.';
    await db.insert(clientNotes).values({
      id: newId('nte'),
      agencyId: ctx.agencyId,
      clientId,
      authorId: ctx.userId,
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
    .where(eq(leads.id, lead.id));

  await db.insert(leadActivities).values({
    id: newId('lac'),
    agencyId: ctx.agencyId,
    leadId: lead.id,
    authorId: ctx.userId,
    type: 'stage_change',
    body: `Converted to client "${clientName}"`,
  });

  created(res, { clientId, leadId: lead.id });
});

// ============================================================
//  DELETE /leads/:id — permanent delete (cascades activities)
// ============================================================
leadsRouter.delete('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const lead = await getScopedLead(ctx, param(req, 'id'));
  await db.delete(leads).where(eq(leads.id, lead.id));
  ok(res, { deleted: true, id: lead.id });
});

// ============================================================
//  Activities (notes, calls, follow-ups) on a lead
// ============================================================
const activitySchema = z.object({
  type: z.enum(ACTIVITY_TYPES).optional(),
  body: z.string().trim().min(1).max(5000),
  dueAt: z.coerce.date().nullable().optional(),
});

leadsRouter.post('/:id/activities', async (req, res) => {
  const ctx = getAuth(req);
  const lead = await getScopedLead(ctx, param(req, 'id'));
  const body = activitySchema.parse(req.body);
  const id = newId('lac');
  await db.insert(leadActivities).values({
    id,
    agencyId: ctx.agencyId,
    leadId: lead.id,
    authorId: ctx.userId,
    ...(body.type ? { type: body.type } : {}),
    body: body.body,
    dueAt: body.dueAt ?? null,
  });
  await db
    .update(leads)
    .set({ lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(leads.id, lead.id));
  const [row] = await db
    .select({ a: leadActivities, authorName: users.fullName })
    .from(leadActivities)
    .leftJoin(users, eq(users.id, leadActivities.authorId))
    .where(eq(leadActivities.id, id));
  created(res, serializeActivity(row!.a, row!.authorName));
});

const activityPatchSchema = z.object({
  body: z.string().trim().min(1).max(5000).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  // Toggle follow-up completion. true → now, false → clear.
  done: z.boolean().optional(),
});

leadsRouter.patch('/:id/activities/:actId', async (req, res) => {
  const ctx = getAuth(req);
  await getScopedLead(ctx, param(req, 'id'));
  const body = activityPatchSchema.parse(req.body);
  const actId = param(req, 'actId');
  const [existing] = await db
    .select()
    .from(leadActivities)
    .where(
      and(
        eq(leadActivities.id, actId),
        eq(leadActivities.leadId, param(req, 'id')),
        eq(leadActivities.agencyId, ctx.agencyId),
      ),
    )
    .limit(1);
  if (!existing) throw notFound('Activity not found.');

  const patch: Record<string, unknown> = {};
  if (body.body !== undefined) patch.body = body.body;
  if (body.dueAt !== undefined) patch.dueAt = body.dueAt;
  if (body.done !== undefined) patch.completedAt = body.done ? new Date() : null;
  if (Object.keys(patch).length === 0) throw badRequest('Nothing to update.');

  await db.update(leadActivities).set(patch).where(eq(leadActivities.id, actId));
  const [row] = await db
    .select({ a: leadActivities, authorName: users.fullName })
    .from(leadActivities)
    .leftJoin(users, eq(users.id, leadActivities.authorId))
    .where(eq(leadActivities.id, actId));
  ok(res, serializeActivity(row!.a, row!.authorName));
});

leadsRouter.delete('/:id/activities/:actId', async (req, res) => {
  const ctx = getAuth(req);
  await getScopedLead(ctx, param(req, 'id'));
  const actId = param(req, 'actId');
  await db
    .delete(leadActivities)
    .where(
      and(
        eq(leadActivities.id, actId),
        eq(leadActivities.leadId, param(req, 'id')),
        eq(leadActivities.agencyId, ctx.agencyId),
      ),
    );
  ok(res, { deleted: true, id: actId });
});
