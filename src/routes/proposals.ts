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
import { sendEmail } from '../services/email.js';
import { getFrontendOrigin } from '../lib/frontend-url.js';
import { generateAiProposalDraft, enhanceTextWithAi } from '../services/ai.js';

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

  ok(res, { rejected: true });
});

// ============================================================
//  AUTHENTICATED AGENCY ROUTES
// ============================================================
const authRouter = Router();
authRouter.use(requireAuth);
authRouter.use(requireModuleRW('clients'));

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

  await sendEmail({
    to: body.recipientEmail,
    subject: `Proposal: ${p.title} from ${agency?.name ?? 'Creative Monk'}`,
    text: `Hello, We're pleased to share the proposal "${p.title}" with you. Review proposal here: ${publicUrl}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0c0d0e; color: #f3f4f6; border-radius: 12px;">
        <h2 style="color: #ff6b00; margin-top: 0;">${agency?.name ?? 'Creative Monk'} Proposal</h2>
        <p>Hello,</p>
        <p>We're pleased to share the proposal <strong>${p.title}</strong> with you.</p>
        ${body.message ? `<p style="background: #18191b; padding: 12px; border-radius: 8px; color: #d1d5db;">${body.message}</p>` : ''}
        <div style="margin: 30px 0; text-align: center;">
          <a href="${publicUrl}" style="background: #ff6b00; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
            Review Proposal &rarr;
          </a>
        </div>
        <p style="font-size: 12px; color: #6b7280;">If the button above does not work, copy and paste this URL into your browser:<br/>${publicUrl}</p>
      </div>
    `,
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

  await db.insert(agreements).values({
    id: agreementId,
    agencyId: ctx.agencyId,
    clientId: p.clientId,
    proposalId: p.id,
    agreementNumber,
    title: `Agreement for ${p.title}`,
    status: 'draft',
    totalValuePaise: p.totalPaise,
    currency: p.currency,
    termsJson: JSON.stringify({
      scopeOfWork: proposalContent.scope ?? proposalContent.deliverables ?? p.title,
      paymentTerms: proposalContent.paymentTerms ?? 'Standard 30-day net terms',
      milestones: proposalContent.milestones ?? [],
      confidentiality: true,
      intellectualProperty: 'Transferred upon full payment',
    }),
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
  if (body.validUntil !== undefined) patch.validUntil = body.validUntil;
  if (body.content !== undefined) patch.contentJson = JSON.stringify(body.content);

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

