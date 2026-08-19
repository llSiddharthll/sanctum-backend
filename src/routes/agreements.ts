import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agreements,
  agreementTemplates,
  clients,
  agencies,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId, newOpaqueToken } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import { notifyMany, agencyOwners } from '../services/notifications.js';
import { sendEmail } from '../services/email.js';
import { getFrontendOrigin } from '../lib/frontend-url.js';
import { generateAiAgreementDraft, enhanceTextWithAi } from '../services/ai.js';

export const agreementsRouter = Router();

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ============================================================
//  PUBLIC DIGITAL SIGNING (Client view & sign by token)
// ============================================================
agreementsRouter.get('/public/:token', async (req, res) => {
  const token = param(req, 'token');
  const [a] = await db
    .select()
    .from(agreements)
    .where(eq(agreements.token, token))
    .limit(1);

  if (!a) throw notFound('Agreement not found or link has expired.');

  const [agency] = await db
    .select({ name: agencies.name, logoUrl: agencies.logoUrl, brandColor: agencies.brandColor })
    .from(agencies)
    .where(eq(agencies.id, a.agencyId))
    .limit(1);

  const [client] = await db
    .select({ name: clients.name, contactEmail: clients.contactEmail, billingAddress: clients.billingAddress })
    .from(clients)
    .where(eq(clients.id, a.clientId))
    .limit(1);

  ok(res, {
    ...serializeAgreement(a, true),
    agency,
    client,
  });
});

const signSchema = z.object({
  signerName: z.string().trim().min(1).max(160),
  signerEmail: z.string().email(),
  signatureDataUrl: z.string().min(10), // data:image/png;base64,...
});

agreementsRouter.post('/public/:token/sign', async (req, res) => {
  const token = param(req, 'token');
  const body = signSchema.parse(req.body);

  const [a] = await db
    .select()
    .from(agreements)
    .where(eq(agreements.token, token))
    .limit(1);

  if (!a) throw notFound('Agreement not found.');
  if (a.status === 'signed' || a.status === 'active') {
    return ok(res, { message: 'Agreement is already signed.' });
  }

  await db
    .update(agreements)
    .set({
      status: 'signed',
      signedAt: new Date(),
      signerName: body.signerName,
      signerEmail: body.signerEmail,
      signerIp: req.ip ?? 'unknown',
      signatureDataUrl: body.signatureDataUrl,
      updatedAt: new Date(),
    })
    .where(eq(agreements.id, a.id));

  await audit({
    agencyId: a.agencyId,
    actorType: 'client',
    actorId: body.signerEmail,
    action: 'agreement.sign',
    entityType: 'agreement',
    entityId: a.id,
    metadata: { signerName: body.signerName, signerIp: req.ip },
    ip: req.ip,
  });

  // Notify the owner(s) in real time (bell + socket + push). Agreements are an
  // owner-only Business module, so only owners are alerted.
  await notifyMany(await agencyOwners(a.agencyId), {
    agencyId: a.agencyId,
    type: 'agreement.signed',
    title: `Agreement signed — ${a.title}`,
    body: `${body.signerName} e-signed this agreement.`,
    entityType: 'agreement',
    entityId: a.id,
    link: '/agreements',
  });

  ok(res, { signed: true, signedAt: new Date().toISOString() });
});

// ============================================================
//  AUTHENTICATED AGENCY ROUTES
// ============================================================
const authRouter = Router();
authRouter.use(requireAuth);
// Owner-only Business module (public sign routes are mounted above).
authRouter.use(requireModuleRW('business'));

function serializeAgreement(
  a: typeof agreements.$inferSelect,
  showFinance = false,
  extra?: { clientName?: string | null; createdByName?: string | null },
) {
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
    retainerPaise: showFinance ? a.retainerPaise : null,
    totalValuePaise: showFinance ? a.totalValuePaise : null,
    effectiveDate: toIso(a.effectiveDate),
    expirationDate: toIso(a.expirationDate),
    terms: safeJson(a.termsJson),
    token: a.token,
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
  };
}

// ---- TEMPLATES ----
authRouter.get('/templates', async (req, res) => {
  const ctx = getAuth(req);
  const rows = await db
    .select()
    .from(agreementTemplates)
    .where(eq(agreementTemplates.agencyId, ctx.agencyId))
    .orderBy(desc(agreementTemplates.createdAt));

  ok(
    res,
    rows.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      description: t.description,
      terms: safeJson(t.termsJson),
      createdAt: toIso(t.createdAt),
    })),
  );
});

const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(['msa', 'retainer', 'sow', 'nda', 'custom']).optional(),
  description: z.string().trim().max(1000).optional(),
  terms: z.record(z.string(), z.any()),
});

authRouter.post('/templates', async (req, res) => {
  const ctx = getAuth(req);
  const body = createTemplateSchema.parse(req.body);
  const id = newId('atpl');

  await db.insert(agreementTemplates).values({
    id,
    agencyId: ctx.agencyId,
    name: body.name,
    type: body.type ?? 'msa',
    description: body.description ?? null,
    termsJson: JSON.stringify(body.terms),
  });

  const [row] = await db.select().from(agreementTemplates).where(eq(agreementTemplates.id, id));
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
authRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const isOwner = ctx.role === 'owner';
  const clientId = req.query.clientId as string | undefined;

  const filters = [eq(agreements.agencyId, ctx.agencyId)];
  if (clientId) filters.push(eq(agreements.clientId, clientId));

  const rows = await db
    .select({
      a: agreements,
      clientName: clients.name,
      createdByName: users.fullName,
    })
    .from(agreements)
    .leftJoin(clients, eq(clients.id, agreements.clientId))
    .leftJoin(users, eq(users.id, agreements.createdBy))
    .where(and(...filters))
    .orderBy(desc(agreements.createdAt));

  ok(
    res,
    rows.map((r) =>
      serializeAgreement(r.a, isOwner, {
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

authRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = createAgreementSchema.parse(req.body);
  const id = newId('agr');
  const token = newOpaqueToken().raw;

  const year = new Date().getFullYear();
  const agreementNumber = `AGR-${year}-${String(Date.now() % 10000).padStart(4, '0')}`;

  await db.insert(agreements).values({
    id,
    agencyId: ctx.agencyId,
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
    token,
    createdBy: ctx.userId,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'agreement.create',
    entityType: 'agreement',
    entityId: id,
    ip: req.ip,
  });

  const [row] = await db.select().from(agreements).where(eq(agreements.id, id));
  created(res, serializeAgreement(row!, ctx.role === 'owner'));
});

// ---- DETAIL ----
authRouter.get('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const [row] = await db
    .select({
      a: agreements,
      clientName: clients.name,
      createdByName: users.fullName,
    })
    .from(agreements)
    .leftJoin(clients, eq(clients.id, agreements.clientId))
    .leftJoin(users, eq(users.id, agreements.createdBy))
    .where(and(eq(agreements.id, param(req, 'id')), eq(agreements.agencyId, ctx.agencyId)))
    .limit(1);

  if (!row) throw notFound('Agreement not found.');
  ok(
    res,
    serializeAgreement(row.a, ctx.role === 'owner', {
      clientName: row.clientName,
      createdByName: row.createdByName,
    }),
  );
});

// ---- SEND AGREEMENT FOR SIGNING ----
authRouter.post('/:id/send', async (req, res) => {
  const ctx = getAuth(req);
  const agreementId = param(req, 'id');
  const body = z.object({ recipientEmail: z.string().email(), message: z.string().optional() }).parse(req.body);

  const [a] = await db
    .select()
    .from(agreements)
    .where(and(eq(agreements.id, agreementId), eq(agreements.agencyId, ctx.agencyId)))
    .limit(1);

  if (!a) throw notFound('Agreement not found.');

  const [agency] = await db.select().from(agencies).where(eq(agencies.id, ctx.agencyId)).limit(1);
  const signUrl = `${getFrontendOrigin(req)}/agreements/sign/${a.token}`;

  await sendEmail({
    to: body.recipientEmail,
    subject: `Action Required: Please sign ${a.title} with ${agency?.name ?? 'Creative Monk'}`,
    text: `Hello, Your agreement "${a.title}" is ready for review and digital signature: ${signUrl}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0c0d0e; color: #f3f4f6; border-radius: 12px;">
        <h2 style="color: #ff6b00; margin-top: 0;">${agency?.name ?? 'Creative Monk'} Agreement</h2>
        <p>Hello,</p>
        <p>Your agreement <strong>${a.title}</strong> is ready for review and digital signature.</p>
        ${body.message ? `<p style="background: #18191b; padding: 12px; border-radius: 8px; color: #d1d5db;">${body.message}</p>` : ''}
        <div style="margin: 30px 0; text-align: center;">
          <a href="${signUrl}" style="background: #ff6b00; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
            Review & Sign Agreement &rarr;
          </a>
        </div>
        <p style="font-size: 12px; color: #6b7280;">If the button above does not work, copy and paste this URL into your browser:<br/>${signUrl}</p>
      </div>
    `,
  });

  await db
    .update(agreements)
    .set({
      status: a.status === 'draft' ? 'sent' : a.status,
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agreements.id, a.id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'agreement.send',
    entityType: 'agreement',
    entityId: a.id,
    metadata: { recipientEmail: body.recipientEmail },
    ip: req.ip,
  });

  ok(res, { sent: true, signUrl });
});

// ---- AI AGREEMENT GENERATION ----
const aiGenerateAgreementSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  clientName: z.string().trim().max(160).optional(),
  agreementType: z.string().trim().max(100).optional(),
  retainerRupees: z.number().int().min(0).optional(),
});

authRouter.post('/ai/generate', async (req, res) => {
  const body = aiGenerateAgreementSchema.parse(req.body);
  const result = await generateAiAgreementDraft({
    prompt: body.prompt,
    clientName: body.clientName,
    agreementType: body.agreementType,
    retainerRupees: body.retainerRupees,
  });
  ok(res, result);
});

// ---- AI TEXT ENHANCEMENT ----
const aiEnhanceAgreementSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  context: z.string().trim().max(500).optional(),
  instruction: z.string().trim().max(500).optional(),
});

authRouter.post('/ai/enhance', async (req, res) => {
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

authRouter.put('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const agreementId = param(req, 'id');
  const body = updateAgreementSchema.parse(req.body);

  const [a] = await db
    .select()
    .from(agreements)
    .where(and(eq(agreements.id, agreementId), eq(agreements.agencyId, ctx.agencyId)))
    .limit(1);

  if (!a) throw notFound('Agreement not found.');

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

  await db.update(agreements).set(patch).where(eq(agreements.id, a.id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'agreement.update',
    entityType: 'agreement',
    entityId: a.id,
    ip: req.ip,
  });

  const [updated] = await db.select().from(agreements).where(eq(agreements.id, a.id));
  ok(res, serializeAgreement(updated!, ctx.role === 'owner'));
});

agreementsRouter.use('/', authRouter);

