import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  proposals,
  proposalTemplates,
  clients,
  leads,
  agencies,
  users,
  agreements,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId, newOpaqueToken } from '../lib/ids.js';
import { notFound, badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import { notifyMany, agencyOwners } from '../services/notifications.js';
import { sendEmail, basicHtml } from '../services/email.js';
import { getFrontendOrigin } from '../lib/frontend-url.js';
import {
  generateAiProposalDraft,
  enhanceTextWithAi,
  generateMarketingProposal,
} from '../services/ai.js';

export const proposalsRouter = Router();

// ============================================================
//  PUBLIC PROPOSAL ACCESS (Client Viewing & Acceptance by Token)
// ============================================================
proposalsRouter.get('/public/:token', async (req, res) => {
  const token = param(req, 'token');
  const [p] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.token, token))
    .limit(1);

  if (!p) throw notFound('Proposal not found or link has expired.');

  // Mark viewed if draft/sent
  if (p.status === 'sent') {
    await db
      .update(proposals)
      .set({ status: 'viewed', viewedAt: new Date(), updatedAt: new Date() })
      .where(eq(proposals.id, p.id));
  }

  const [agency] = await db
    .select({ name: agencies.name, logoUrl: agencies.logoUrl, brandColor: agencies.brandColor })
    .from(agencies)
    .where(eq(agencies.id, p.agencyId))
    .limit(1);

  let clientName: string | null = null;
  if (p.clientId) {
    const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, p.clientId)).limit(1);
    clientName = c?.name ?? null;
  } else if (p.leadId) {
    const [l] = await db.select({ name: leads.name, company: leads.company }).from(leads).where(eq(leads.id, p.leadId)).limit(1);
    clientName = l ? `${l.name}${l.company ? ' (' + l.company + ')' : ''}` : null;
  }

  ok(res, {
    ...serializeProposal(p, true),
    agency,
    clientName,
  });
});

const acceptProposalSchema = z.object({
  acceptedBy: z.string().trim().min(1).max(160),
});

proposalsRouter.post('/public/:token/accept', async (req, res) => {
  const token = param(req, 'token');
  const body = acceptProposalSchema.parse(req.body);
  const [p] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.token, token))
    .limit(1);

  if (!p) throw notFound('Proposal not found.');
  if (p.status === 'accepted' || p.status === 'converted') {
    return ok(res, { message: 'Proposal is already accepted.' });
  }

  await db
    .update(proposals)
    .set({
      status: 'accepted',
      acceptedAt: new Date(),
      acceptedBy: body.acceptedBy,
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, p.id));

  await audit({
    agencyId: p.agencyId,
    actorType: 'client',
    actorId: body.acceptedBy,
    action: 'proposal.accept',
    entityType: 'proposal',
    entityId: p.id,
    ip: req.ip,
  });

  // Notify the owner(s) in real time (bell + socket + push). Proposals are an
  // owner-only Business module, so only owners are alerted.
  await notifyMany(await agencyOwners(p.agencyId), {
    agencyId: p.agencyId,
    type: 'proposal.accepted',
    title: `Proposal accepted — ${p.title}`,
    body: `${body.acceptedBy} accepted this proposal.`,
    entityType: 'proposal',
    entityId: p.id,
    link: '/proposals',
  });

  ok(res, { accepted: true, acceptedAt: new Date().toISOString() });
});

proposalsRouter.post('/public/:token/reject', async (req, res) => {
  const token = param(req, 'token');
  const body = z.object({ reason: z.string().trim().max(1000).optional() }).parse(req.body);
  const [p] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.token, token))
    .limit(1);

  if (!p) throw notFound('Proposal not found.');

  await db
    .update(proposals)
    .set({
      status: 'rejected',
      rejectedAt: new Date(),
      rejectionReason: body.reason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, p.id));

  await audit({
    agencyId: p.agencyId,
    actorType: 'client',
    actorId: 'client',
    action: 'proposal.changes_requested',
    entityType: 'proposal',
    entityId: p.id,
    ip: req.ip,
  });

  // Alert the owner(s) in real time that the client wants changes.
  await notifyMany(await agencyOwners(p.agencyId), {
    agencyId: p.agencyId,
    type: 'proposal.changes_requested',
    title: `Changes requested — ${p.title}`,
    body: body.reason
      ? `Client feedback: "${body.reason}"`
      : 'The client requested changes to this proposal.',
    entityType: 'proposal',
    entityId: p.id,
    link: '/proposals',
  });

  ok(res, { rejected: true });
});

// ============================================================
//  AUTHENTICATED AGENCY ROUTES
// ============================================================
const authRouter = Router();
authRouter.use(requireAuth);
// Owner-only Business module (public accept/reject routes are mounted above).
authRouter.use(requireModuleRW('business'));

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function serializeProposal(
  p: typeof proposals.$inferSelect,
  showFinance = false,
  extra?: { clientName?: string | null; leadName?: string | null; createdByName?: string | null },
) {
  return {
    id: p.id,
    proposalNumber: p.proposalNumber,
    title: p.title,
    clientId: p.clientId,
    clientName: extra?.clientName ?? null,
    leadId: p.leadId,
    leadName: extra?.leadName ?? null,
    templateId: p.templateId,
    status: p.status,
    currency: p.currency,
    subtotalPaise: showFinance ? p.subtotalPaise : null,
    taxPaise: showFinance ? p.taxPaise : null,
    totalPaise: showFinance ? p.totalPaise : null,
    billingType: p.billingType,
    recurringPaise: showFinance ? p.recurringPaise : null,
    validUntil: toIso(p.validUntil),
    content: safeJson(p.contentJson),
    token: p.token,
    sentAt: toIso(p.sentAt),
    viewedAt: toIso(p.viewedAt),
    acceptedAt: toIso(p.acceptedAt),
    acceptedBy: p.acceptedBy,
    rejectedAt: toIso(p.rejectedAt),
    rejectionReason: p.rejectionReason,
    convertedAgreementId: p.convertedAgreementId,
    fileUrl: p.fileUrl,
    createdBy: p.createdBy,
    createdByName: extra?.createdByName ?? null,
    createdAt: toIso(p.createdAt),
    updatedAt: toIso(p.updatedAt),
  };
}

// ---- TEMPLATES ----
authRouter.get('/templates', async (req, res) => {
  const ctx = getAuth(req);
  const rows = await db
    .select()
    .from(proposalTemplates)
    .where(eq(proposalTemplates.agencyId, ctx.agencyId))
    .orderBy(desc(proposalTemplates.createdAt));

  ok(
    res,
    rows.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      description: t.description,
      content: safeJson(t.contentJson),
      createdAt: toIso(t.createdAt),
    })),
  );
});

const templateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().max(60).optional(),
  description: z.string().trim().max(1000).optional(),
  content: z.record(z.string(), z.any()),
});

authRouter.post('/templates', async (req, res) => {
  const ctx = getAuth(req);
  const body = templateSchema.parse(req.body);
  const id = newId('ptpl');

  await db.insert(proposalTemplates).values({
    id,
    agencyId: ctx.agencyId,
    name: body.name,
    category: body.category ?? 'general',
    description: body.description ?? null,
    contentJson: JSON.stringify(body.content),
  });

  const [row] = await db.select().from(proposalTemplates).where(eq(proposalTemplates.id, id));
  created(res, {
    id: row!.id,
    name: row!.name,
    category: row!.category,
    description: row!.description,
    content: safeJson(row!.contentJson),
    createdAt: toIso(row!.createdAt),
  });
});

// ---- LIST PROPOSALS ----
authRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const isOwner = ctx.role === 'owner';
  const clientId = req.query.clientId as string | undefined;
  const leadId = req.query.leadId as string | undefined;

  const filters = [eq(proposals.agencyId, ctx.agencyId)];
  if (clientId) filters.push(eq(proposals.clientId, clientId));
  if (leadId) filters.push(eq(proposals.leadId, leadId));

  const rows = await db
    .select({
      p: proposals,
      clientName: clients.name,
      leadName: leads.name,
      createdByName: users.fullName,
    })
    .from(proposals)
    .leftJoin(clients, eq(clients.id, proposals.clientId))
    .leftJoin(leads, eq(leads.id, proposals.leadId))
    .leftJoin(users, eq(users.id, proposals.createdBy))
    .where(and(...filters))
    .orderBy(desc(proposals.createdAt));

  ok(
    res,
    rows.map((r) =>
      serializeProposal(r.p, isOwner, {
        clientName: r.clientName,
        leadName: r.leadName,
        createdByName: r.createdByName,
      }),
    ),
  );
});

// ---- CREATE PROPOSAL ----
const proposalSchema = z.object({
  clientId: z.string().optional(),
  leadId: z.string().optional(),
  templateId: z.string().optional(),
  title: z.string().trim().min(1).max(200),
  currency: z.string().trim().max(8).optional(),
  subtotalPaise: z.number().int().min(0).optional(),
  taxPaise: z.number().int().min(0).optional(),
  totalPaise: z.number().int().min(0).optional(),
  billingType: z.enum(['one_time', 'retainer']).optional(),
  recurringPaise: z.number().int().min(0).nullable().optional(),
  validUntil: z.coerce.date().optional(),
  content: z.record(z.string(), z.any()),
});

authRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = proposalSchema.parse(req.body);
  const id = newId('prp');
  const token = newOpaqueToken().raw;

  // Generate proposal number PROP-YYYY-XXXX
  const year = new Date().getFullYear();
  const proposalNumber = `PROP-${year}-${String(Date.now() % 10000).padStart(4, '0')}`;

  await db.insert(proposals).values({
    id,
    agencyId: ctx.agencyId,
    clientId: body.clientId ?? null,
    leadId: body.leadId ?? null,
    templateId: body.templateId ?? null,
    proposalNumber,
    title: body.title,
    status: 'draft',
    currency: body.currency ?? 'INR',
    subtotalPaise: body.subtotalPaise ?? 0,
    taxPaise: body.taxPaise ?? 0,
    totalPaise: body.totalPaise ?? body.subtotalPaise ?? 0,
    billingType: body.billingType ?? 'one_time',
    recurringPaise: body.recurringPaise ?? 0,
    validUntil: body.validUntil ?? null,
    contentJson: JSON.stringify(body.content),
    token,
    createdBy: ctx.userId,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'proposal.create',
    entityType: 'proposal',
    entityId: id,
    ip: req.ip,
  });

  const [row] = await db.select().from(proposals).where(eq(proposals.id, id));
  created(res, serializeProposal(row!, ctx.role === 'owner'));
});

// ---- DETAIL ----
authRouter.get('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const [row] = await db
    .select({
      p: proposals,
      clientName: clients.name,
      leadName: leads.name,
      createdByName: users.fullName,
    })
    .from(proposals)
    .leftJoin(clients, eq(clients.id, proposals.clientId))
    .leftJoin(leads, eq(leads.id, proposals.leadId))
    .leftJoin(users, eq(users.id, proposals.createdBy))
    .where(and(eq(proposals.id, param(req, 'id')), eq(proposals.agencyId, ctx.agencyId)))
    .limit(1);

  if (!row) throw notFound('Proposal not found.');
  ok(
    res,
    serializeProposal(row.p, ctx.role === 'owner', {
      clientName: row.clientName,
      leadName: row.leadName,
      createdByName: row.createdByName,
    }),
  );
});

// ---- SEND PROPOSAL ----
authRouter.post('/:id/send', async (req, res) => {
  const ctx = getAuth(req);
  const proposalId = param(req, 'id');
  const body = z.object({ recipientEmail: z.string().email(), message: z.string().optional() }).parse(req.body);

  const [p] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.agencyId, ctx.agencyId)))
    .limit(1);

  if (!p) throw notFound('Proposal not found.');

  const [agency] = await db.select().from(agencies).where(eq(agencies.id, ctx.agencyId)).limit(1);
  const publicUrl = `${getFrontendOrigin(req)}/proposals/view/${p.token}`;

  const agencyName = agency?.name ?? 'Creative Monk';
  await sendEmail({
    to: body.recipientEmail,
    subject: `Your proposal from ${agencyName}: ${p.title}`,
    text: `We're pleased to share the proposal "${p.title}" with you.${body.message ? `\n\n${body.message}` : ''}\n\nReview it online (no login needed): ${publicUrl}`,
    html: basicHtml({
      heading: p.title,
      bodyHtml: `${agencyName} has prepared a proposal for you — <strong>${p.title}</strong>. Open it below to read the plan, scope, investment options and projected return, and accept it right from the page.${body.message ? `<br><br><em>${body.message}</em>` : ''}`,
      buttonLabel: 'Review the proposal',
      buttonUrl: publicUrl,
      preheader: `${agencyName} shared a proposal with you — open it in one tap.`,
    }),
  });

  await db
    .update(proposals)
    .set({
      status: p.status === 'draft' ? 'sent' : p.status,
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, p.id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'proposal.send',
    entityType: 'proposal',
    entityId: p.id,
    metadata: { recipientEmail: body.recipientEmail },
    ip: req.ip,
  });

  ok(res, { sent: true, publicUrl });
});

// ---- CONVERT PROPOSAL TO AGREEMENT ----
authRouter.post('/:id/convert-to-agreement', async (req, res) => {
  const ctx = getAuth(req);
  const proposalId = param(req, 'id');

  const [p] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.agencyId, ctx.agencyId)))
    .limit(1);

  if (!p) throw notFound('Proposal not found.');
  if (!p.clientId) {
    throw badRequest('Please convert or assign this proposal to an active client first.');
  }

  const agreementId = newId('agr');
  const token = newOpaqueToken().raw;
  const year = new Date().getFullYear();
  const agreementNumber = `AGR-${year}-${String(Date.now() % 10000).padStart(4, '0')}`;

  const proposalContent = safeJson(p.contentJson) as Record<string, any>;

  // Map the proposal into the agreement's { scope: string, clauses: string[] }
  // shape (same as a form-authored agreement). The proposal's scope field is
  // `scopeOverview`; its `terms` array becomes the contract clauses.
  const overview =
    typeof proposalContent.scopeOverview === 'string' &&
    proposalContent.scopeOverview.trim()
      ? proposalContent.scopeOverview.trim()
      : typeof proposalContent.scope === 'string' && proposalContent.scope.trim()
        ? proposalContent.scope.trim()
        : `Agency services as described in "${p.title}".`;

  // Fold the deliverable titles into the scope so nothing is lost in conversion.
  const deliverableTitles = Array.isArray(proposalContent.deliverables)
    ? proposalContent.deliverables
        .map((d: any) => (typeof d?.title === 'string' ? d.title.trim() : ''))
        .filter((s: string) => s.length > 0)
    : [];
  const scope = deliverableTitles.length
    ? `${overview}\n\nDeliverables: ${deliverableTitles.join('; ')}.`
    : overview;

  const clauses: string[] = Array.isArray(proposalContent.terms)
    ? proposalContent.terms.filter(
        (c: unknown): c is string => typeof c === 'string' && c.trim().length > 0,
      )
    : [];
  if (clauses.length === 0) {
    clauses.push(
      'Services will be delivered per the accepted proposal.',
      'Intellectual property transfers to the client upon full payment.',
      'Either party may terminate with 30 days written notice.',
    );
  }

  await db.insert(agreements).values({
    id: agreementId,
    agencyId: ctx.agencyId,
    clientId: p.clientId,
    proposalId: p.id,
    agreementNumber,
    title: `Agreement for ${p.title}`,
    status: 'draft',
    totalValuePaise: p.totalPaise,
    retainerPaise: p.billingType === 'retainer' ? p.recurringPaise : 0,
    currency: p.currency,
    termsJson: JSON.stringify({ scope, clauses }),
    token,
    createdBy: ctx.userId,
  });

  await db
    .update(proposals)
    .set({
      status: 'converted',
      convertedAgreementId: agreementId,
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, p.id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'proposal.convert_to_agreement',
    entityType: 'proposal',
    entityId: p.id,
    metadata: { agreementId },
    ip: req.ip,
  });

  created(res, { agreementId, agreementNumber });
});

// ---- AI PROPOSAL GENERATION ----
const aiGenerateProposalSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  clientName: z.string().trim().max(160).optional(),
  budgetRupees: z.number().int().min(0).optional(),
  deliverablesCount: z.number().int().min(1).max(12).optional(),
});

authRouter.post('/ai/generate', async (req, res) => {
  const body = aiGenerateProposalSchema.parse(req.body);
  const result = await generateAiProposalDraft({
    prompt: body.prompt,
    clientName: body.clientName,
    budgetRupees: body.budgetRupees,
    deliverablesCount: body.deliverablesCount,
  });
  ok(res, result);
});

// POST /proposals/ai/marketing — generate a full 10-section marketing proposal
// (Situation → ROI → FAQ → Next step) from a short brief, filled dynamically.
const aiMarketingSchema = z.object({
  clientId: z.string().optional(),
  clientName: z.string().max(160).optional(),
  industry: z.string().max(160).optional(),
  services: z.array(z.string().max(60)).max(20).optional(),
  painPoints: z.string().max(2000).optional(),
  knownNumbers: z.string().max(2000).optional(),
  budget: z.string().max(200).optional(),
  timeline: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

authRouter.post('/ai/marketing', async (req, res) => {
  const ctx = getAuth(req);
  const body = aiMarketingSchema.parse(req.body);

  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, ctx.agencyId))
    .limit(1);

  // Enrich the brief from the client record when a clientId is given.
  let clientName = body.clientName;
  let industry = body.industry;
  if (body.clientId) {
    const [c] = await db
      .select({ name: clients.name, industry: clients.industry })
      .from(clients)
      .where(
        and(eq(clients.id, body.clientId), eq(clients.agencyId, ctx.agencyId)),
      )
      .limit(1);
    if (c) {
      clientName = clientName ?? c.name;
      industry = industry ?? c.industry ?? undefined;
    }
  }

  const result = await generateMarketingProposal({
    clientName,
    industry,
    agencyName: agency?.name ?? null,
    services: body.services ?? null,
    painPoints: body.painPoints ?? null,
    knownNumbers: body.knownNumbers ?? null,
    budget: body.budget ?? null,
    timeline: body.timeline ?? null,
    notes: body.notes ?? null,
  });
  ok(res, result);
});

// ---- AI TEXT ENHANCEMENT ----
const aiEnhanceSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  context: z.string().trim().max(500).optional(),
  instruction: z.string().trim().max(500).optional(),
});

authRouter.post('/ai/enhance', async (req, res) => {
  const body = aiEnhanceSchema.parse(req.body);
  const result = await enhanceTextWithAi({
    text: body.text,
    context: body.context,
    instruction: body.instruction,
  });
  ok(res, result);
});

// ---- UPDATE PROPOSAL ----
const updateProposalSchema = z.object({
  clientId: z.string().optional().nullable(),
  leadId: z.string().optional().nullable(),
  templateId: z.string().optional().nullable(),
  title: z.string().trim().min(1).max(200).optional(),
  currency: z.string().trim().max(8).optional(),
  subtotalPaise: z.number().int().min(0).optional(),
  taxPaise: z.number().int().min(0).optional(),
  totalPaise: z.number().int().min(0).optional(),
  billingType: z.enum(['one_time', 'retainer']).optional(),
  recurringPaise: z.number().int().min(0).nullable().optional(),
  validUntil: z.coerce.date().optional().nullable(),
  content: z.record(z.string(), z.any()).optional(),
});

authRouter.put('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const proposalId = param(req, 'id');
  const body = updateProposalSchema.parse(req.body);

  const [p] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.agencyId, ctx.agencyId)))
    .limit(1);

  if (!p) throw notFound('Proposal not found.');

  const patch: Partial<typeof proposals.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (body.title !== undefined) patch.title = body.title;
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.leadId !== undefined) patch.leadId = body.leadId;
  if (body.templateId !== undefined) patch.templateId = body.templateId;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.subtotalPaise !== undefined) patch.subtotalPaise = body.subtotalPaise;
  if (body.taxPaise !== undefined) patch.taxPaise = body.taxPaise;
  if (body.totalPaise !== undefined) patch.totalPaise = body.totalPaise;
  if (body.billingType !== undefined) patch.billingType = body.billingType;
  if (body.recurringPaise !== undefined)
    patch.recurringPaise = body.recurringPaise ?? 0;
  if (body.validUntil !== undefined) patch.validUntil = body.validUntil;
  if (body.content !== undefined) patch.contentJson = JSON.stringify(body.content);

  // Editing a declined proposal revives it as a draft so it can be revised and
  // re-sent (clears the prior rejection).
  if (p.status === 'rejected') {
    patch.status = 'draft';
    patch.rejectedAt = null;
    patch.rejectionReason = null;
  }

  await db.update(proposals).set(patch).where(eq(proposals.id, p.id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'proposal.update',
    entityType: 'proposal',
    entityId: p.id,
    ip: req.ip,
  });

  const [updated] = await db.select().from(proposals).where(eq(proposals.id, p.id));
  ok(res, serializeProposal(updated!, ctx.role === 'owner'));
});

proposalsRouter.use('/', authRouter);

