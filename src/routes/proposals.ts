import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
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
import { newId } from '../lib/ids.js';
import { notFound, badRequest, forbidden, conflict, invalidState } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { notifyMany } from '../services/notifications.js';
import { sendEmail, basicHtml } from '../services/email.js';
import { getFrontendOrigin } from '../lib/frontend-url.js';
import { authenticate, getStaffActor, requires, requiresAny } from '../authz/http.js';
import { authorize, canOrg, capabilities, check } from '../authz/engine.js';
import { actorAuditId, type Actor } from '../authz/actor.js';
import { requireInAgency } from '../authz/tenancy.js';
import {
  activeLinkExpiry,
  assertProposalConvertible,
  assertProposalEditable,
  assertProposalRespondable,
  assertProposalSendable,
  consumeDocumentLink,
  containsMoney,
  defaultLinkExpiry,
  deliverViaPortalLogin,
  escapeHtml,
  loadProposal,
  mintDocumentLink,
  objectViewerIds,
  ownScopeFilter,
  proposalFactsOf,
  redactMoney,
  resolveProposalLink,
  revokeDocumentLinks,
} from '../authz/policies/business.js';
import {
  generateAiProposalDraft,
  enhanceTextWithAi,
  generateMarketingProposal,
} from '../services/ai.js';

export const proposalsRouter = Router();

type ProposalRow = typeof proposals.$inferSelect;

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ============================================================
//  PUBLIC PROPOSAL ACCESS (client view & response by document link)
//  The link is a capability for ONE proposal: hashed at rest, expiring,
//  revocable; responses only from sent/viewed and before validUntil.
// ============================================================

/** Minimal anonymous DTO: no staff ids, lead/template/agreement ids or tokens. */
function publicProposal(p: ProposalRow) {
  return {
    id: p.id,
    proposalNumber: p.proposalNumber,
    title: p.title,
    status: p.status,
    currency: p.currency,
    subtotalPaise: p.subtotalPaise,
    taxPaise: p.taxPaise,
    totalPaise: p.totalPaise,
    billingType: p.billingType,
    recurringPaise: p.recurringPaise,
    validUntil: toIso(p.validUntil),
    content: safeJson(p.contentJson),
    fileUrl: p.fileUrl,
    sentAt: toIso(p.sentAt),
    viewedAt: toIso(p.viewedAt),
    acceptedAt: toIso(p.acceptedAt),
    acceptedBy: p.acceptedBy,
    rejectedAt: toIso(p.rejectedAt),
  };
}

proposalsRouter.get('/public/:token', async (req, res) => {
  const { row: p } = await resolveProposalLink(param(req, 'token'));

  if (p.status === 'sent') {
    await db
      .update(proposals)
      .set({ status: 'viewed', viewedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(proposals.id, p.id), eq(proposals.status, 'sent')));
    p.status = 'viewed';
  }

  const [agency] = await db
    .select({ name: agencies.name, logoUrl: agencies.logoUrl, brandColor: agencies.brandColor })
    .from(agencies)
    .where(eq(agencies.id, p.agencyId))
    .limit(1);

  let clientName: string | null = null;
  if (p.clientId) {
    const [c] = await db
      .select({ name: clients.name })
      .from(clients)
      .where(and(eq(clients.id, p.clientId), eq(clients.agencyId, p.agencyId)))
      .limit(1);
    clientName = c?.name ?? null;
  } else if (p.leadId) {
    const [l] = await db
      .select({ name: leads.name, company: leads.company })
      .from(leads)
      .where(and(eq(leads.id, p.leadId), eq(leads.agencyId, p.agencyId)))
      .limit(1);
    clientName = l ? `${l.name}${l.company ? ' (' + l.company + ')' : ''}` : null;
  }

  ok(res, { ...publicProposal(p), agency, clientName });
});

const acceptProposalSchema = z.object({
  acceptedBy: z.string().trim().min(1).max(160),
});

proposalsRouter.post('/public/:token/accept', async (req, res) => {
  const body = acceptProposalSchema.parse(req.body);
  const { link, row: p } = await resolveProposalLink(param(req, 'token'));
  if (link.consumedAt) throw conflict('This proposal has already been answered.');
  assertProposalRespondable(p);

  const acceptedAt = new Date();
  const updated = await db
    .update(proposals)
    .set({ status: 'accepted', acceptedAt, acceptedBy: body.acceptedBy, updatedAt: acceptedAt })
    .where(and(eq(proposals.id, p.id), eq(proposals.agencyId, p.agencyId), eq(proposals.status, p.status)))
    .returning({ id: proposals.id });
  if (!updated.length) throw conflict('This proposal has already been answered.');
  await consumeDocumentLink(link.id);

  await audit({
    agencyId: p.agencyId,
    actorType: 'portal_link',
    actorId: `document_link:${link.id}`,
    action: 'proposal.accept',
    entityType: 'proposal',
    entityId: p.id,
    metadata: { acceptedBy: body.acceptedBy },
    ip: req.ip,
  });

  await notifyMany(await objectViewerIds(p.agencyId, 'proposals.view', p.createdBy), {
    agencyId: p.agencyId,
    type: 'proposal.accepted',
    title: `Proposal accepted — ${p.title}`,
    body: `${body.acceptedBy} accepted this proposal.`,
    entityType: 'proposal',
    entityId: p.id,
    link: '/proposals',
  });

  ok(res, { accepted: true, acceptedAt: acceptedAt.toISOString() });
});

proposalsRouter.post('/public/:token/reject', async (req, res) => {
  const body = z.object({ reason: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
  const { link, row: p } = await resolveProposalLink(param(req, 'token'));
  if (link.consumedAt) throw conflict('This proposal has already been answered.');
  assertProposalRespondable(p);

  const updated = await db
    .update(proposals)
    .set({
      status: 'rejected',
      rejectedAt: new Date(),
      rejectionReason: body.reason ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(proposals.id, p.id), eq(proposals.agencyId, p.agencyId), eq(proposals.status, p.status)))
    .returning({ id: proposals.id });
  if (!updated.length) throw conflict('This proposal has already been answered.');
  await consumeDocumentLink(link.id);

  await audit({
    agencyId: p.agencyId,
    actorType: 'portal_link',
    actorId: `document_link:${link.id}`,
    action: 'proposal.changes_requested',
    entityType: 'proposal',
    entityId: p.id,
    ip: req.ip,
  });

  await notifyMany(await objectViewerIds(p.agencyId, 'proposals.view', p.createdBy), {
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
authRouter.use(authenticate);

const PROPOSAL_CAPABILITIES = [
  'proposals.update',
  'proposals.send',
  'proposals.convert',
  'proposals.view_pricing',
];

function auditProposal(actor: Actor, action: string, id: string, ip: string | undefined, metadata?: Record<string, unknown>) {
  return audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action,
    entityType: 'proposal',
    entityId: id,
    metadata,
    ip,
  });
}

function serializeProposal(
  actor: Actor,
  p: ProposalRow,
  extra?: {
    clientName?: string | null;
    leadName?: string | null;
    createdByName?: string | null;
    linkExpiresAt?: Date | null;
  },
) {
  const facts = proposalFactsOf(p);
  const showPricing = check(actor, 'proposals.view_pricing', facts);
  const content = safeJson(p.contentJson);
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
    subtotalPaise: showPricing ? p.subtotalPaise : null,
    taxPaise: showPricing ? p.taxPaise : null,
    totalPaise: showPricing ? p.totalPaise : null,
    billingType: p.billingType,
    recurringPaise: showPricing ? p.recurringPaise : null,
    validUntil: toIso(p.validUntil),
    content: showPricing ? content : redactMoney(content),
    pricingRedacted: !showPricing,
    // Public links are hashed and only delivered by email on send.
    token: null,
    publicLinkExpiresAt: extra?.linkExpiresAt !== undefined ? toIso(extra.linkExpiresAt) : undefined,
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
    capabilities: capabilities(actor, facts, PROPOSAL_CAPABILITIES),
  };
}

async function requireProposal(actor: Actor, id: string) {
  const p = await loadProposal(actor, id);
  if (!p) throw notFound('Proposal not found.');
  return p;
}

/** Validate every referenced id against the tenant. */
async function checkRefs(
  actor: Actor,
  refs: { clientId?: string | null; leadId?: string | null; templateId?: string | null },
) {
  if (refs.clientId) await requireInAgency(clients, actor.agencyId, refs.clientId, 'Client');
  if (refs.leadId) await requireInAgency(leads, actor.agencyId, refs.leadId, 'Lead');
  if (refs.templateId) await requireInAgency(proposalTemplates, actor.agencyId, refs.templateId, 'Template');
}

// ---- TEMPLATES ----
authRouter.get('/templates', requires('proposals.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const rows = await db
    .select()
    .from(proposalTemplates)
    .where(eq(proposalTemplates.agencyId, actor.agencyId))
    .orderBy(desc(proposalTemplates.createdAt));
  const showPricing = canOrg(actor, 'proposals.view_pricing');

  ok(
    res,
    rows.map((t) => {
      const content = safeJson(t.contentJson);
      return {
        id: t.id,
        name: t.name,
        category: t.category,
        description: t.description,
        content: showPricing ? content : redactMoney(content),
        createdAt: toIso(t.createdAt),
      };
    }),
  );
});

const templateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().max(60).optional(),
  description: z.string().trim().max(1000).optional(),
  content: z.record(z.string(), z.any()),
});

authRouter.post('/templates', requires('proposals.manage_templates'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = templateSchema.parse(req.body);
  if (containsMoney(body.content) && !canOrg(actor, 'proposals.view_pricing')) {
    throw forbidden("You don't have permission to set proposal pricing.");
  }
  const id = newId('ptpl');

  await db.insert(proposalTemplates).values({
    id,
    agencyId: actor.agencyId,
    name: body.name,
    category: body.category ?? 'general',
    description: body.description ?? null,
    contentJson: JSON.stringify(body.content),
  });

  const [row] = await db
    .select()
    .from(proposalTemplates)
    .where(and(eq(proposalTemplates.id, id), eq(proposalTemplates.agencyId, actor.agencyId)));
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
authRouter.get('/', requires('proposals.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = req.query.clientId as string | undefined;
  const leadId = req.query.leadId as string | undefined;

  const filters = [
    eq(proposals.agencyId, actor.agencyId),
    ownScopeFilter(actor, 'proposals.view', proposals.createdBy),
  ];
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
    .leftJoin(clients, and(eq(clients.id, proposals.clientId), eq(clients.agencyId, proposals.agencyId)))
    .leftJoin(leads, and(eq(leads.id, proposals.leadId), eq(leads.agencyId, proposals.agencyId)))
    .leftJoin(users, and(eq(users.id, proposals.createdBy), eq(users.agencyId, proposals.agencyId)))
    .where(and(...filters))
    .orderBy(desc(proposals.createdAt));

  ok(
    res,
    rows.map((r) =>
      serializeProposal(actor, r.p, {
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

authRouter.post('/', requires('proposals.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = proposalSchema.parse(req.body);
  await checkRefs(actor, body);

  // Setting prices requires seeing them (on a proposal the actor will own).
  const setsMoney =
    body.subtotalPaise !== undefined ||
    body.taxPaise !== undefined ||
    body.totalPaise !== undefined ||
    (body.recurringPaise !== undefined && body.recurringPaise !== null) ||
    containsMoney(body.content);
  const futureFacts = { agencyId: actor.agencyId, ownerIds: [actor.userId] };
  if (setsMoney && !check(actor, 'proposals.view_pricing', futureFacts)) {
    throw forbidden("You don't have permission to set proposal pricing.");
  }

  const id = newId('prp');
  // Generate proposal number PROP-YYYY-XXXX
  const year = new Date().getFullYear();
  const proposalNumber = `PROP-${year}-${String(Date.now() % 10000).padStart(4, '0')}`;

  await db.insert(proposals).values({
    id,
    agencyId: actor.agencyId,
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
    // No public token at creation: links are minted (hashed) on send.
    token: null,
    createdBy: actor.userId,
  });

  await auditProposal(actor, 'proposal.create', id, req.ip);

  const { row } = await requireProposal(actor, id);
  created(res, serializeProposal(actor, row));
});

// ---- DETAIL ----
authRouter.get('/:id', requires('proposals.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const loaded = await loadProposal(actor, param(req, 'id'));
  authorize(actor, 'proposals.view', loaded?.facts);
  const p = loaded!.row;
  const [names] = await db
    .select({ clientName: clients.name, leadName: leads.name, createdByName: users.fullName })
    .from(proposals)
    .leftJoin(clients, and(eq(clients.id, proposals.clientId), eq(clients.agencyId, proposals.agencyId)))
    .leftJoin(leads, and(eq(leads.id, proposals.leadId), eq(leads.agencyId, proposals.agencyId)))
    .leftJoin(users, and(eq(users.id, proposals.createdBy), eq(users.agencyId, proposals.agencyId)))
    .where(eq(proposals.id, p.id))
    .limit(1);

  ok(
    res,
    serializeProposal(actor, p, {
      clientName: names?.clientName ?? null,
      leadName: names?.leadName ?? null,
      createdByName: names?.createdByName ?? null,
      linkExpiresAt: await activeLinkExpiry(actor.agencyId, 'proposal', p.id),
    }),
  );
});

// ---- SEND PROPOSAL ----
authRouter.post('/:id/send', requires('proposals.send'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = z.object({ recipientEmail: z.string().email(), message: z.string().max(2000).optional() }).parse(req.body);
  const loaded = await loadProposal(actor, param(req, 'id'));
  authorize(actor, 'proposals.send', loaded?.facts, { view: 'proposals.view' });
  const p = loaded!.row;
  assertProposalSendable(p);

  const [agency] = await db.select().from(agencies).where(eq(agencies.id, actor.agencyId)).limit(1);
  const agencyName = agency?.name ?? 'Creative Monk';
  const safeTitle = escapeHtml(p.title);
  const safeMessage = body.message ? escapeHtml(body.message) : '';

  // Document-mode proposals (an uploaded file, no in-app content) have nothing
  // for the link page to render — deliver them through the client portal.
  const viaPortalLogin = !!(p.fileUrl && p.clientId);
  let publicUrl: string | null = null;
  let linkExpiresAt: Date | null = null;
  if (viaPortalLogin) {
    await deliverViaPortalLogin({
      actor,
      req,
      clientId: p.clientId!,
      recipientEmail: body.recipientEmail,
      agencyName,
      note: `${safeMessage ? `${safeMessage} ` : ''}A new proposal — "${safeTitle}" — is ready to view in your portal.`.trim(),
    });
    await revokeDocumentLinks(actor.agencyId, 'proposal', p.id);
  } else {
    // A fresh link per send; earlier links stop working.
    const link = await mintDocumentLink({
      agencyId: actor.agencyId,
      objectType: 'proposal',
      objectId: p.id,
      expiresAt: defaultLinkExpiry(p.validUntil),
      createdBy: actor.userId,
    });
    linkExpiresAt = link.expiresAt;
    publicUrl = `${getFrontendOrigin(req)}/proposals/view/${link.raw}`;
    await sendEmail({
      to: body.recipientEmail,
      subject: `Your proposal from ${agencyName}: ${p.title}`,
      text: `We're pleased to share the proposal "${p.title}" with you.${body.message ? `\n\n${body.message}` : ''}\n\nReview it online (no login needed): ${publicUrl}`,
      html: basicHtml({
        heading: p.title,
        bodyHtml: `${escapeHtml(agencyName)} has prepared a proposal for you — <strong>${safeTitle}</strong>. Open it below to read the plan, scope, investment options and projected return, and accept it right from the page.${safeMessage ? `<br><br><em>${safeMessage}</em>` : ''}`,
        buttonLabel: 'Review the proposal',
        buttonUrl: publicUrl,
        preheader: `${agencyName} shared a proposal with you — open it in one tap.`,
      }),
    });
  }

  await db
    .update(proposals)
    .set({
      status: p.status === 'draft' ? 'sent' : p.status,
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(proposals.id, p.id), eq(proposals.agencyId, actor.agencyId)));

  await auditProposal(actor, 'proposal.send', p.id, req.ip, {
    recipientEmail: body.recipientEmail,
    viaPortalLogin,
    linkExpiresAt: linkExpiresAt?.toISOString() ?? null,
  });

  ok(res, { sent: true, publicUrl, linkExpiresAt: toIso(linkExpiresAt) });
});

// ---- MINT A SHAREABLE REVIEW LINK ----
// Links are stored hashed, so an existing one can never be shown again. This
// mints a fresh link to paste into WhatsApp/chat and revokes the previous one
// (same as pressing Send), which is why it needs proposals.send.
authRouter.post('/:id/link', requires('proposals.send'), async (req, res) => {
  const actor = getStaffActor(req);
  const loaded = await loadProposal(actor, param(req, 'id'));
  authorize(actor, 'proposals.send', loaded?.facts, { view: 'proposals.view' });
  const p = loaded!.row;
  assertProposalSendable(p);
  if (p.fileUrl && p.clientId) {
    throw invalidState('This proposal is a file — share it from the client portal instead.');
  }

  const link = await mintDocumentLink({
    agencyId: actor.agencyId,
    objectType: 'proposal',
    objectId: p.id,
    expiresAt: defaultLinkExpiry(p.validUntil),
    createdBy: actor.userId,
  });
  await auditProposal(actor, 'proposal.link_mint', p.id, req.ip, {
    expiresAt: link.expiresAt.toISOString(),
  });
  ok(res, {
    url: `${getFrontendOrigin(req)}/proposals/view/${link.raw}`,
    expiresAt: toIso(link.expiresAt),
  });
});

// ---- CONVERT PROPOSAL TO AGREEMENT ----
authRouter.post(
  '/:id/convert-to-agreement',
  requires('proposals.convert', 'agreements.create'),
  async (req, res) => {
    const actor = getStaffActor(req);
    const loaded = await loadProposal(actor, param(req, 'id'));
    authorize(actor, 'proposals.convert', loaded?.facts, { view: 'proposals.view' });
    const p = loaded!.row;
    assertProposalConvertible(p);
    if (!p.clientId) {
      throw badRequest('Please convert or assign this proposal to an active client first.');
    }

    const agreementId = newId('agr');
    const year = new Date().getFullYear();
    const agreementNumber = `AGR-${year}-${String(Date.now() % 10000).padStart(4, '0')}`;

    const proposalContent = safeJson(p.contentJson) as Record<string, any>;

    // Map the proposal into the agreement's { scope: string, clauses: string[] }
    // shape (same as a form-authored agreement).
    const overview =
      typeof proposalContent.scopeOverview === 'string' &&
      proposalContent.scopeOverview.trim()
        ? proposalContent.scopeOverview.trim()
        : typeof proposalContent.scope === 'string' && proposalContent.scope.trim()
          ? proposalContent.scope.trim()
          : `Agency services as described in "${p.title}".`;

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

    // Claim the conversion atomically (exactly once, only from accepted).
    const claimed = await db
      .update(proposals)
      .set({ status: 'converted', convertedAgreementId: agreementId, updatedAt: new Date() })
      .where(
        and(
          eq(proposals.id, p.id),
          eq(proposals.agencyId, actor.agencyId),
          eq(proposals.status, 'accepted'),
          isNull(proposals.convertedAgreementId),
        ),
      )
      .returning({ id: proposals.id });
    if (!claimed.length) throw conflict('This proposal has already been converted to an agreement.');

    try {
      await db.insert(agreements).values({
        id: agreementId,
        agencyId: actor.agencyId,
        clientId: p.clientId,
        proposalId: p.id,
        agreementNumber,
        title: `Agreement for ${p.title}`,
        status: 'draft',
        totalValuePaise: p.totalPaise,
        retainerPaise: p.billingType === 'retainer' ? p.recurringPaise : 0,
        currency: p.currency,
        termsJson: JSON.stringify({ scope, clauses }),
        token: null,
        createdBy: actor.userId,
      });
    } catch (e) {
      // Roll the claim back so the conversion can be retried.
      await db
        .update(proposals)
        .set({ status: 'accepted', convertedAgreementId: null, updatedAt: new Date() })
        .where(and(eq(proposals.id, p.id), eq(proposals.convertedAgreementId, agreementId)));
      throw e;
    }

    // Converted is terminal for the client-facing link.
    await revokeDocumentLinks(actor.agencyId, 'proposal', p.id);
    await auditProposal(actor, 'proposal.convert_to_agreement', p.id, req.ip, { agreementId });

    created(res, { agreementId, agreementNumber });
  },
);

// ---- AI PROPOSAL GENERATION ----
const aiGenerateProposalSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  clientName: z.string().trim().max(160).optional(),
  budgetRupees: z.number().int().min(0).optional(),
  deliverablesCount: z.number().int().min(1).max(12).optional(),
});

authRouter.post('/ai/generate', requires('proposals.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = aiGenerateProposalSchema.parse(req.body);
  const result = await generateAiProposalDraft({
    prompt: body.prompt,
    clientName: body.clientName,
    budgetRupees: body.budgetRupees,
    deliverablesCount: body.deliverablesCount,
  });
  ok(res, canOrg(actor, 'proposals.view_pricing') ? result : redactMoney(result));
});

// POST /proposals/ai/marketing — generate a full 10-section marketing proposal.
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

authRouter.post('/ai/marketing', requires('proposals.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = aiMarketingSchema.parse(req.body);

  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, actor.agencyId))
    .limit(1);

  // Enrich the brief from the client record when a clientId is given.
  let clientName = body.clientName;
  let industry = body.industry;
  if (body.clientId) {
    const [c] = await db
      .select({ name: clients.name, industry: clients.industry })
      .from(clients)
      .where(and(eq(clients.id, body.clientId), eq(clients.agencyId, actor.agencyId)))
      .limit(1);
    if (!c) throw notFound('Client not found.');
    clientName = clientName ?? c.name;
    industry = industry ?? c.industry ?? undefined;
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
  ok(res, canOrg(actor, 'proposals.view_pricing') ? result : redactMoney(result));
});

// ---- AI TEXT ENHANCEMENT ----
const aiEnhanceSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  context: z.string().trim().max(500).optional(),
  instruction: z.string().trim().max(500).optional(),
});

authRouter.post('/ai/enhance', requiresAny('proposals.create', 'proposals.update'), async (req, res) => {
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
  // The uploaded-document URL (for a document-sourced proposal).
  fileUrl: z.string().url().nullable().optional(),
});

authRouter.put('/:id', requires('proposals.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = updateProposalSchema.parse(req.body);
  const loaded = await loadProposal(actor, param(req, 'id'));
  authorize(actor, 'proposals.update', loaded?.facts, { view: 'proposals.view' });
  const p = loaded!.row;
  assertProposalEditable(p);
  await checkRefs(actor, body);

  const canPrice = check(actor, 'proposals.view_pricing', loaded!.facts);
  if (!canPrice) {
    const setsMoney =
      body.subtotalPaise !== undefined ||
      body.taxPaise !== undefined ||
      body.totalPaise !== undefined ||
      body.recurringPaise !== undefined;
    // Without pricing access the stored content cannot be seen in full, so it
    // cannot be overwritten when it carries pricing (nor can pricing be added).
    const touchesPricedContent =
      body.content !== undefined && (containsMoney(body.content) || containsMoney(safeJson(p.contentJson)));
    if (setsMoney || touchesPricedContent) {
      throw forbidden("You don't have permission to change proposal pricing.");
    }
  }

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
  if (body.fileUrl !== undefined) patch.fileUrl = body.fileUrl;

  // Editing a declined proposal revives it as a draft so it can be revised and
  // re-sent (clears the prior rejection; any old link is dead).
  if (p.status === 'rejected') {
    patch.status = 'draft';
    patch.rejectedAt = null;
    patch.rejectionReason = null;
    await revokeDocumentLinks(actor.agencyId, 'proposal', p.id);
  }

  const updated = await db
    .update(proposals)
    .set(patch)
    .where(and(eq(proposals.id, p.id), eq(proposals.agencyId, actor.agencyId), eq(proposals.status, p.status)))
    .returning({ id: proposals.id });
  if (!updated.length) throw conflict('The proposal changed while you were editing it. Reload and try again.');

  await auditProposal(actor, 'proposal.update', p.id, req.ip, {
    fields: Object.keys(patch).filter((k) => k !== 'updatedAt'),
  });

  const { row } = await requireProposal(actor, p.id);
  ok(res, serializeProposal(actor, row));
});

proposalsRouter.use('/', authRouter);
