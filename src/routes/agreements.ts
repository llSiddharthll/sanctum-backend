import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agreements,
  agreementTemplates,
  clients,
  agencies,
  projects,
  proposals,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound, forbidden, conflict, invalidState } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { broadcastPortalRefresh } from '../realtime/io.js';
import { notifyMany } from '../services/notifications.js';
import { sendEmail } from '../services/email.js';
import { getFrontendOrigin } from '../lib/frontend-url.js';
import { authenticate, getStaffActor, requires, requiresAny } from '../authz/http.js';
import { authorize, canOrg, capabilities, check } from '../authz/engine.js';
import { actorAuditId, type Actor } from '../authz/actor.js';
import { requireInAgency } from '../authz/tenancy.js';
import {
  activeLinkExpiry,
  agreementFactsOf,
  assertAgreementSignable,
  assertAgreementUnsigned,
  assertSignatureDataUrl,
  consumeDocumentLink,
  containsMoney,
  defaultLinkExpiry,
  deliverViaPortalLogin,
  escapeHtml,
  loadAgreement,
  mintDocumentLink,
  objectViewerIds,
  ownScopeFilter,
  redactMoney,
  resolveAgreementLink,
  revokeDocumentLinks,
} from '../authz/policies/business.js';
import { generateAiAgreementDraft, enhanceTextWithAi } from '../services/ai.js';

export const agreementsRouter = Router();

type AgreementRow = typeof agreements.$inferSelect;

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ============================================================
//  PUBLIC DIGITAL SIGNING (client view & sign by document link)
// ============================================================

/**
 * Minimal anonymous DTO: no signer IP/email/signature image, no staff ids,
 * project/proposal ids or tokens.
 */
function publicAgreement(a: AgreementRow) {
  return {
    id: a.id,
    agreementNumber: a.agreementNumber,
    title: a.title,
    status: a.status,
    currency: a.currency,
    retainerPaise: a.retainerPaise,
    totalValuePaise: a.totalValuePaise,
    effectiveDate: toIso(a.effectiveDate),
    expirationDate: toIso(a.expirationDate),
    terms: safeJson(a.termsJson),
    fileUrl: a.fileUrl,
    sentAt: toIso(a.sentAt),
    signedAt: toIso(a.signedAt),
    signerName: a.signerName,
  };
}

agreementsRouter.get('/public/:token', async (req, res) => {
  const { row: a } = await resolveAgreementLink(param(req, 'token'));

  const [agency] = await db
    .select({ name: agencies.name, logoUrl: agencies.logoUrl, brandColor: agencies.brandColor })
    .from(agencies)
    .where(eq(agencies.id, a.agencyId))
    .limit(1);

  const [client] = await db
    .select({ name: clients.name, billingAddress: clients.billingAddress })
    .from(clients)
    .where(and(eq(clients.id, a.clientId), eq(clients.agencyId, a.agencyId)))
    .limit(1);

  const signed = !!a.signedAt || a.status !== 'sent';
  ok(res, {
    ...publicAgreement(a),
    agency,
    // Party details are shown for signing only; never on an executed contract.
    client: client ? { name: client.name, ...(signed ? {} : { billingAddress: client.billingAddress }) } : null,
  });
});

const signSchema = z.object({
  signerName: z.string().trim().min(1).max(160),
  signerEmail: z.string().email(),
  signatureDataUrl: z.string().min(10), // data:image/png;base64,...
});

agreementsRouter.post('/public/:token/sign', async (req, res) => {
  const body = signSchema.parse(req.body);
  assertSignatureDataUrl(body.signatureDataUrl);
  const { link, row: a } = await resolveAgreementLink(param(req, 'token'));
  if (link.consumedAt) throw conflict('This agreement has already been signed.');
  assertAgreementSignable(a);

  const signedAt = new Date();
  const updated = await db
    .update(agreements)
    .set({
      status: 'signed',
      signedAt,
      signerName: body.signerName,
      signerEmail: body.signerEmail,
      signerIp: req.ip ?? 'unknown',
      signatureDataUrl: body.signatureDataUrl,
      updatedAt: signedAt,
    })
    .where(
      and(
        eq(agreements.id, a.id),
        eq(agreements.agencyId, a.agencyId),
        eq(agreements.status, 'sent'),
        isNull(agreements.signedAt),
      ),
    )
    .returning({ id: agreements.id });
  if (!updated.length) throw conflict('This agreement has already been signed.');
  await consumeDocumentLink(link.id);

  await audit({
    agencyId: a.agencyId,
    actorType: 'portal_link',
    actorId: `document_link:${link.id}`,
    action: 'agreement.sign',
    entityType: 'agreement',
    entityId: a.id,
    metadata: { signerName: body.signerName, signerEmail: body.signerEmail, signerIp: req.ip },
    ip: req.ip,
  });

  await notifyMany(await objectViewerIds(a.agencyId, 'agreements.view', a.createdBy), {
    agencyId: a.agencyId,
    type: 'agreement.signed',
    title: `Agreement signed — ${a.title}`,
    body: `${body.signerName} e-signed this agreement.`,
    entityType: 'agreement',
    entityId: a.id,
    link: '/agreements',
  });

  ok(res, { signed: true, signedAt: signedAt.toISOString() });
});

// ============================================================
//  AUTHENTICATED AGENCY ROUTES
// ============================================================
const authRouter = Router();
authRouter.use(authenticate);

const AGREEMENT_CAPABILITIES = [
  'agreements.update',
  'agreements.delete',
  'agreements.send',
  'agreements.view_pricing',
];

function auditAgreement(actor: Actor, action: string, id: string, ip: string | undefined, metadata?: Record<string, unknown>) {
  return audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action,
    entityType: 'agreement',
    entityId: id,
    metadata,
    ip,
  });
}

function serializeAgreement(
  actor: Actor,
  a: AgreementRow,
  extra?: { clientName?: string | null; createdByName?: string | null; linkExpiresAt?: Date | null },
) {
  const facts = agreementFactsOf(a);
  const showPricing = check(actor, 'agreements.view_pricing', facts);
  const terms = safeJson(a.termsJson);
  return {
    id: a.id,
    agreementNumber: a.agreementNumber,
    title: a.title,
    clientId: a.clientId,
    clientName: extra?.clientName ?? null,
    proposalId: a.proposalId,
    projectId: a.projectId,
    templateId: a.templateId,
    status: a.status,
    currency: a.currency,
    retainerPaise: showPricing ? a.retainerPaise : null,
    totalValuePaise: showPricing ? a.totalValuePaise : null,
    effectiveDate: toIso(a.effectiveDate),
    expirationDate: toIso(a.expirationDate),
    terms: showPricing ? terms : redactMoney(terms),
    pricingRedacted: !showPricing,
    // Public links are hashed and only delivered by email on send.
    token: null,
    publicLinkExpiresAt: extra?.linkExpiresAt !== undefined ? toIso(extra.linkExpiresAt) : undefined,
    sentAt: toIso(a.sentAt),
    signedAt: toIso(a.signedAt),
    signerName: a.signerName,
    signerEmail: a.signerEmail,
    signerIp: a.signerIp,
    signatureDataUrl: a.signatureDataUrl,
    fileUrl: a.fileUrl,
    createdBy: a.createdBy,
    createdByName: extra?.createdByName ?? null,
    createdAt: toIso(a.createdAt),
    updatedAt: toIso(a.updatedAt),
    capabilities: capabilities(actor, facts, AGREEMENT_CAPABILITIES),
  };
}

async function checkRefs(
  actor: Actor,
  refs: { clientId?: string | null; proposalId?: string | null; projectId?: string | null; templateId?: string | null },
) {
  if (refs.clientId) await requireInAgency(clients, actor.agencyId, refs.clientId, 'Client');
  if (refs.proposalId) await requireInAgency(proposals, actor.agencyId, refs.proposalId, 'Proposal');
  if (refs.projectId) await requireInAgency(projects, actor.agencyId, refs.projectId, 'Project');
  if (refs.templateId) await requireInAgency(agreementTemplates, actor.agencyId, refs.templateId, 'Template');
}

// ---- TEMPLATES ----
authRouter.get('/templates', requires('agreements.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const rows = await db
    .select()
    .from(agreementTemplates)
    .where(eq(agreementTemplates.agencyId, actor.agencyId))
    .orderBy(desc(agreementTemplates.createdAt));
  const showPricing = canOrg(actor, 'agreements.view_pricing');

  ok(
    res,
    rows.map((t) => {
      const terms = safeJson(t.termsJson);
      return {
        id: t.id,
        name: t.name,
        type: t.type,
        description: t.description,
        terms: showPricing ? terms : redactMoney(terms),
        createdAt: toIso(t.createdAt),
      };
    }),
  );
});

const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(['msa', 'retainer', 'sow', 'nda', 'custom']).optional(),
  description: z.string().trim().max(1000).optional(),
  terms: z.record(z.string(), z.any()),
});

authRouter.post('/templates', requires('agreements.manage_templates'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = createTemplateSchema.parse(req.body);
  if (containsMoney(body.terms) && !canOrg(actor, 'agreements.view_pricing')) {
    throw forbidden("You don't have permission to set agreement values.");
  }
  const id = newId('atpl');

  await db.insert(agreementTemplates).values({
    id,
    agencyId: actor.agencyId,
    name: body.name,
    type: body.type ?? 'msa',
    description: body.description ?? null,
    termsJson: JSON.stringify(body.terms),
  });

  const [row] = await db
    .select()
    .from(agreementTemplates)
    .where(and(eq(agreementTemplates.id, id), eq(agreementTemplates.agencyId, actor.agencyId)));
  created(res, {
    id: row!.id,
    name: row!.name,
    type: row!.type,
    description: row!.description,
    terms: safeJson(row!.termsJson),
    createdAt: toIso(row!.createdAt),
  });
});

// ---- LIST AGREEMENTS ----
authRouter.get('/', requires('agreements.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = req.query.clientId as string | undefined;

  const filters = [
    eq(agreements.agencyId, actor.agencyId),
    ownScopeFilter(actor, 'agreements.view', agreements.createdBy),
  ];
  if (clientId) filters.push(eq(agreements.clientId, clientId));

  const rows = await db
    .select({
      a: agreements,
      clientName: clients.name,
      createdByName: users.fullName,
    })
    .from(agreements)
    .leftJoin(clients, and(eq(clients.id, agreements.clientId), eq(clients.agencyId, agreements.agencyId)))
    .leftJoin(users, and(eq(users.id, agreements.createdBy), eq(users.agencyId, agreements.agencyId)))
    .where(and(...filters))
    .orderBy(desc(agreements.createdAt));

  ok(
    res,
    rows.map((r) =>
      serializeAgreement(actor, r.a, {
        clientName: r.clientName,
        createdByName: r.createdByName,
      }),
    ),
  );
});

// ---- CREATE AGREEMENT ----
const createAgreementSchema = z.object({
  clientId: z.string().min(1),
  proposalId: z.string().optional(),
  projectId: z.string().optional(),
  templateId: z.string().optional(),
  title: z.string().trim().min(1).max(200),
  effectiveDate: z.coerce.date().optional(),
  expirationDate: z.coerce.date().optional(),
  retainerPaise: z.number().int().min(0).optional(),
  totalValuePaise: z.number().int().min(0).optional(),
  currency: z.string().trim().max(8).optional(),
  terms: z.record(z.string(), z.any()),
});

authRouter.post('/', requires('agreements.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = createAgreementSchema.parse(req.body);
  await checkRefs(actor, body);

  const setsMoney =
    body.retainerPaise !== undefined || body.totalValuePaise !== undefined || containsMoney(body.terms);
  if (setsMoney && !check(actor, 'agreements.view_pricing', { agencyId: actor.agencyId, ownerIds: [actor.userId] })) {
    throw forbidden("You don't have permission to set agreement values.");
  }

  const id = newId('agr');
  const year = new Date().getFullYear();
  const agreementNumber = `AGR-${year}-${String(Date.now() % 10000).padStart(4, '0')}`;

  await db.insert(agreements).values({
    id,
    agencyId: actor.agencyId,
    clientId: body.clientId,
    proposalId: body.proposalId ?? null,
    projectId: body.projectId ?? null,
    templateId: body.templateId ?? null,
    agreementNumber,
    title: body.title,
    status: 'draft',
    effectiveDate: body.effectiveDate ?? new Date(),
    expirationDate: body.expirationDate ?? null,
    retainerPaise: body.retainerPaise ?? 0,
    totalValuePaise: body.totalValuePaise ?? 0,
    currency: body.currency ?? 'INR',
    termsJson: JSON.stringify(body.terms),
    // No public token at creation: links are minted (hashed) on send.
    token: null,
    createdBy: actor.userId,
  });

  await auditAgreement(actor, 'agreement.create', id, req.ip);

  const loaded = await loadAgreement(actor, id);
  created(res, serializeAgreement(actor, loaded!.row));
});

// ---- DETAIL ----
authRouter.get('/:id', requires('agreements.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const loaded = await loadAgreement(actor, param(req, 'id'));
  authorize(actor, 'agreements.view', loaded?.facts);
  const a = loaded!.row;
  const [names] = await db
    .select({ clientName: clients.name, createdByName: users.fullName })
    .from(agreements)
    .leftJoin(clients, and(eq(clients.id, agreements.clientId), eq(clients.agencyId, agreements.agencyId)))
    .leftJoin(users, and(eq(users.id, agreements.createdBy), eq(users.agencyId, agreements.agencyId)))
    .where(eq(agreements.id, a.id))
    .limit(1);

  ok(
    res,
    serializeAgreement(actor, a, {
      clientName: names?.clientName ?? null,
      createdByName: names?.createdByName ?? null,
      linkExpiresAt: await activeLinkExpiry(actor.agencyId, 'agreement', a.id),
    }),
  );
});

// ---- SEND AGREEMENT FOR SIGNING ----
authRouter.post('/:id/send', requires('agreements.send'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = z.object({ recipientEmail: z.string().email(), message: z.string().max(2000).optional() }).parse(req.body);
  const loaded = await loadAgreement(actor, param(req, 'id'));
  authorize(actor, 'agreements.send', loaded?.facts, { view: 'agreements.view' });
  const a = loaded!.row;
  assertAgreementUnsigned(a);
  if (a.expirationDate && a.expirationDate.getTime() <= Date.now()) {
    throw invalidState('This agreement is past its expiration date. Update it before sending.');
  }

  const [agency] = await db.select().from(agencies).where(eq(agencies.id, actor.agencyId)).limit(1);
  const agencyName = agency?.name ?? 'Creative Monk';
  const safeTitle = escapeHtml(a.title);
  const safeMessage = body.message ? escapeHtml(body.message) : '';

  // Document-mode agreements (an uploaded file, no in-app terms) are delivered
  // through the client portal.
  const viaPortalLogin = !!(a.fileUrl && a.clientId);
  let signUrl: string | null = null;
  let linkExpiresAt: Date | null = null;
  if (viaPortalLogin) {
    await deliverViaPortalLogin({
      actor,
      req,
      clientId: a.clientId,
      recipientEmail: body.recipientEmail,
      agencyName,
      note: `${safeMessage ? `${safeMessage} ` : ''}A new agreement — "${safeTitle}" — is ready to review and sign in your portal.`.trim(),
    });
    await revokeDocumentLinks(actor.agencyId, 'agreement', a.id);
  } else {
    const link = await mintDocumentLink({
      agencyId: actor.agencyId,
      objectType: 'agreement',
      objectId: a.id,
      expiresAt: defaultLinkExpiry(a.expirationDate),
      createdBy: actor.userId,
    });
    linkExpiresAt = link.expiresAt;
    signUrl = `${getFrontendOrigin(req)}/agreements/sign/${link.raw}`;
    const safeAgency = escapeHtml(agencyName);
    await sendEmail({
      to: body.recipientEmail,
      subject: `Action Required: Please sign ${a.title} with ${agencyName}`,
      text: `Hello, Your agreement "${a.title}" is ready for review and digital signature: ${signUrl}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0c0d0e; color: #f3f4f6; border-radius: 12px;">
          <h2 style="color: #ff6b00; margin-top: 0;">${safeAgency} Agreement</h2>
          <p>Hello,</p>
          <p>Your agreement <strong>${safeTitle}</strong> is ready for review and digital signature.</p>
          ${safeMessage ? `<p style="background: #18191b; padding: 12px; border-radius: 8px; color: #d1d5db;">${safeMessage}</p>` : ''}
          <div style="margin: 30px 0; text-align: center;">
            <a href="${signUrl}" style="background: #ff6b00; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
              Review & Sign Agreement &rarr;
            </a>
          </div>
          <p style="font-size: 12px; color: #6b7280;">If the button above does not work, copy and paste this URL into your browser:<br/>${signUrl}</p>
        </div>
      `,
    });
  }

  await db
    .update(agreements)
    .set({
      status: a.status === 'draft' ? 'sent' : a.status,
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(agreements.id, a.id), eq(agreements.agencyId, actor.agencyId)));

  await auditAgreement(actor, 'agreement.send', a.id, req.ip, {
    recipientEmail: body.recipientEmail,
    viaPortalLogin,
    linkExpiresAt: linkExpiresAt?.toISOString() ?? null,
  });

  ok(res, { sent: true, signUrl, linkExpiresAt: toIso(linkExpiresAt) });
});

// ---- AI AGREEMENT GENERATION ----
const aiGenerateAgreementSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  clientName: z.string().trim().max(160).optional(),
  agreementType: z.string().trim().max(100).optional(),
  retainerRupees: z.number().int().min(0).optional(),
});

authRouter.post('/ai/generate', requires('agreements.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = aiGenerateAgreementSchema.parse(req.body);
  const result = await generateAiAgreementDraft({
    prompt: body.prompt,
    clientName: body.clientName,
    agreementType: body.agreementType,
    retainerRupees: body.retainerRupees,
  });
  ok(res, canOrg(actor, 'agreements.view_pricing') ? result : redactMoney(result));
});

// ---- MINT A SHAREABLE SIGNING LINK ----
// Signing links are stored hashed and cannot be shown again, so this mints a
// fresh one to paste into a chat and revokes the previous one.
authRouter.post('/:id/link', requires('agreements.send'), async (req, res) => {
  const actor = getStaffActor(req);
  const loaded = await loadAgreement(actor, param(req, 'id'));
  authorize(actor, 'agreements.send', loaded?.facts, { view: 'agreements.view' });
  const a = loaded!.row;
  assertAgreementUnsigned(a);
  if (a.expirationDate && a.expirationDate.getTime() <= Date.now()) {
    throw invalidState('This agreement is past its expiration date. Update it before sharing.');
  }
  if (a.fileUrl && a.clientId) {
    throw invalidState('This agreement is a file — share it from the client portal instead.');
  }

  const link = await mintDocumentLink({
    agencyId: actor.agencyId,
    objectType: 'agreement',
    objectId: a.id,
    expiresAt: defaultLinkExpiry(a.expirationDate),
    createdBy: actor.userId,
  });
  await auditAgreement(actor, 'agreement.link_mint', a.id, req.ip, {
    expiresAt: link.expiresAt.toISOString(),
  });
  ok(res, {
    url: `${getFrontendOrigin(req)}/agreements/sign/${link.raw}`,
    expiresAt: toIso(link.expiresAt),
  });
});

// ---- AI TEXT ENHANCEMENT ----
const aiEnhanceAgreementSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  context: z.string().trim().max(500).optional(),
  instruction: z.string().trim().max(500).optional(),
});

authRouter.post('/ai/enhance', requiresAny('agreements.create', 'agreements.update'), async (req, res) => {
  const body = aiEnhanceAgreementSchema.parse(req.body);
  const result = await enhanceTextWithAi({
    text: body.text,
    context: body.context,
    instruction: body.instruction,
  });
  ok(res, result);
});

// ---- UPDATE AGREEMENT ----
const updateAgreementSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  clientId: z.string().optional(),
  projectId: z.string().optional().nullable(),
  templateId: z.string().optional().nullable(),
  effectiveDate: z.coerce.date().optional(),
  expirationDate: z.coerce.date().optional().nullable(),
  retainerPaise: z.number().int().min(0).optional(),
  totalValuePaise: z.number().int().min(0).optional(),
  currency: z.string().trim().max(8).optional(),
  terms: z.record(z.string(), z.any()).optional(),
});

authRouter.put('/:id', requires('agreements.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = updateAgreementSchema.parse(req.body);
  const loaded = await loadAgreement(actor, param(req, 'id'));
  authorize(actor, 'agreements.update', loaded?.facts, { view: 'agreements.view' });
  const a = loaded!.row;
  assertAgreementUnsigned(a);
  await checkRefs(actor, body);

  if (!check(actor, 'agreements.view_pricing', loaded!.facts)) {
    const setsMoney = body.retainerPaise !== undefined || body.totalValuePaise !== undefined;
    const touchesPricedTerms =
      body.terms !== undefined && (containsMoney(body.terms) || containsMoney(safeJson(a.termsJson)));
    if (setsMoney || touchesPricedTerms) {
      throw forbidden("You don't have permission to change agreement values.");
    }
  }

  const patch: Partial<typeof agreements.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (body.title !== undefined) patch.title = body.title;
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.projectId !== undefined) patch.projectId = body.projectId;
  if (body.templateId !== undefined) patch.templateId = body.templateId;
  if (body.effectiveDate !== undefined) patch.effectiveDate = body.effectiveDate;
  if (body.expirationDate !== undefined) patch.expirationDate = body.expirationDate;
  if (body.retainerPaise !== undefined) patch.retainerPaise = body.retainerPaise;
  if (body.totalValuePaise !== undefined) patch.totalValuePaise = body.totalValuePaise;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.terms !== undefined) patch.termsJson = JSON.stringify(body.terms);

  // Re-targeting the agreement to another client kills any link already sent.
  if (body.clientId !== undefined && body.clientId !== a.clientId) {
    await revokeDocumentLinks(actor.agencyId, 'agreement', a.id);
  }

  const updated = await db
    .update(agreements)
    .set(patch)
    .where(
      and(
        eq(agreements.id, a.id),
        eq(agreements.agencyId, actor.agencyId),
        inArray(agreements.status, ['draft', 'sent']),
        isNull(agreements.signedAt),
      ),
    )
    .returning({ id: agreements.id });
  if (!updated.length) throw invalidState('This agreement was signed and can no longer be changed.');

  await auditAgreement(actor, 'agreement.update', a.id, req.ip, {
    fields: Object.keys(patch).filter((k) => k !== 'updatedAt'),
  });

  const reloaded = await loadAgreement(actor, a.id);
  ok(res, serializeAgreement(actor, reloaded!.row));
});

// DELETE /agreements/:id — remove a not-yet-executed agreement. Signed/active
// contracts are legally binding and cannot be deleted.
authRouter.delete('/:id', requires('agreements.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const loaded = await loadAgreement(actor, param(req, 'id'));
  if (!loaded) throw notFound('Agreement not found.');
  authorize(actor, 'agreements.delete', loaded.facts, { view: 'agreements.view' });
  const a = loaded.row;
  if (a.status !== 'draft' && a.status !== 'sent') {
    throw invalidState(
      `Only draft or unsigned agreements can be deleted — this one is ${a.status}.`,
    );
  }
  await revokeDocumentLinks(actor.agencyId, 'agreement', a.id);
  await db.delete(agreements).where(and(eq(agreements.id, a.id), eq(agreements.agencyId, actor.agencyId)));

  // A 'sent' agreement is visible in the client portal, so tell any open portal
  // session to refetch immediately rather than showing a document that is gone.
  if (a.clientId) {
    broadcastPortalRefresh(a.clientId, {
      type: 'agreement.deleted',
      agreementId: a.id,
    });
  }
  await auditAgreement(actor, 'agreement.delete', a.id, req.ip, { status: a.status, title: a.title });
  ok(res, { deleted: true, id: a.id });
});

agreementsRouter.use('/', authRouter);
