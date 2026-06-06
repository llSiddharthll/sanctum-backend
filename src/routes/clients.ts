import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, count, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  clients,
  portalTokens,
  plans,
  projects,
  subscriptions,
  invoices,
  invoicePayments,
  documents,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId, newOpaqueToken } from '../lib/ids.js';
import { conflict, notFound, quotaExceeded } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  assignedClientIds,
  getAuth,
  isPrivileged,
  requireClientAccess,
} from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import { sendPortalWelcome } from '../services/email.js';

export const clientsRouter = Router();
clientsRouter.use(requireAuth);

function serializeClient(c: typeof clients.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    logoUrl: c.logoUrl,
    brandColor: c.brandColor,
    handles: c.handlesJson ? safeJson(c.handlesJson) : null,
    contactEmail: c.contactEmail,
    status: c.status,
    isActive: c.status === 'active',
    industry: c.industry,
    website: c.website,
    phoneCc: c.phoneCc,
    phone: c.phone,
    clientSource: c.clientSource,
    gstNumber: c.gstNumber,
    paymentTermsDays: c.paymentTermsDays,
    billingAddress: c.billingAddress,
    billingState: c.billingState,
    billingCity: c.billingCity,
    billingPincode: c.billingPincode,
    relationshipHealth: c.relationshipHealth,
    nextFollowUpAt: toIso(c.nextFollowUpAt),
    internalNotes: c.internalNotes,
    portalVisibleStatuses: c.portalVisibleStatuses.split(','),
    createdAt: toIso(c.createdAt),
    updatedAt: toIso(c.updatedAt),
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// GET /clients — list (owner/admin: all; member: assigned).
clientsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  let rows;
  if (isPrivileged(ctx.role)) {
    rows = await db
      .select()
      .from(clients)
      .where(eq(clients.agencyId, ctx.agencyId));
  } else {
    const ids = await assignedClientIds(ctx);
    rows = ids.length
      ? await db
          .select()
          .from(clients)
          .where(
            and(
              eq(clients.agencyId, ctx.agencyId),
              inArray(clients.id, ids),
            ),
          )
      : [];
  }
  ok(res, rows.map(serializeClient));
});

const clientSourceEnum = z.enum([
  'referral',
  'inbound',
  'outbound',
  'social',
  'event',
  'agency_network',
  'other',
]);
const relationshipHealthEnum = z.enum([
  'excellent',
  'good',
  'at_risk',
  'poor',
]);

// POST /clients — create (owner/admin), enforces plan client limit.
const createSchema = z.object({
  name: z.string().min(1).max(120),
  logoUrl: z.string().url().optional(),
  brandColor: z.string().max(20).optional(),
  handles: z.record(z.string(), z.string()).optional(),
  contactEmail: z.string().email().optional(),
  // ---- Agency-CRM fields ----
  industry: z.string().trim().max(120).optional(),
  website: z.string().trim().max(255).optional(),
  phoneCc: z.string().trim().max(8).optional(),
  phone: z.string().trim().max(32).optional(),
  clientSource: clientSourceEnum.optional(),
  gstNumber: z.string().trim().max(32).optional(),
  paymentTermsDays: z.number().int().min(0).optional(),
  billingAddress: z.string().trim().max(500).optional(),
  billingState: z.string().trim().max(120).optional(),
  billingCity: z.string().trim().max(120).optional(),
  billingPincode: z.string().trim().max(16).optional(),
  relationshipHealth: relationshipHealthEnum.optional(),
  nextFollowUpAt: z.coerce.date().optional(),
  internalNotes: z.string().trim().max(5000).optional(),
  // `isActive` toggle ('Active client' checkbox) maps to status.
  isActive: z.boolean().optional(),
});

clientsRouter.post('/', requireRole('owner', 'admin'), async (req, res) => {
  const ctx = getAuth(req);
  const body = createSchema.parse(req.body);

  await enforceClientLimit(ctx.agencyId);

  const id = newId('cli');
  await db.insert(clients).values({
    id,
    agencyId: ctx.agencyId,
    name: body.name,
    logoUrl: body.logoUrl ?? null,
    brandColor: body.brandColor ?? null,
    handlesJson: body.handles ? JSON.stringify(body.handles) : null,
    contactEmail: body.contactEmail ?? null,
    industry: body.industry ?? null,
    website: body.website ?? null,
    phoneCc: body.phoneCc ?? null,
    phone: body.phone ?? null,
    clientSource: body.clientSource ?? null,
    gstNumber: body.gstNumber ?? null,
    paymentTermsDays: body.paymentTermsDays ?? null,
    billingAddress: body.billingAddress ?? null,
    billingState: body.billingState ?? null,
    billingCity: body.billingCity ?? null,
    billingPincode: body.billingPincode ?? null,
    // relationshipHealth has a NOT NULL default; omit to let the DB apply it.
    ...(body.relationshipHealth !== undefined
      ? { relationshipHealth: body.relationshipHealth }
      : {}),
    nextFollowUpAt: body.nextFollowUpAt ?? null,
    internalNotes: body.internalNotes ?? null,
    // 'Active client' toggle: isActive=true -> 'active', false -> 'archived'.
    ...(body.isActive !== undefined
      ? { status: body.isActive ? 'active' : 'archived' }
      : {}),
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'client.create',
    entityType: 'client',
    entityId: id,
    ip: req.ip,
  });

  const [row] = await db.select().from(clients).where(eq(clients.id, id));
  created(res, serializeClient(row!));
});

async function enforceClientLimit(agencyId: string): Promise<void> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.agencyId, agencyId))
    .limit(1);
  if (!sub) return;
  const [plan] = await db
    .select()
    .from(plans)
    .where(eq(plans.id, sub.planId))
    .limit(1);
  if (!plan || plan.maxClients == null) return;

  const existing = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(eq(clients.agencyId, agencyId), eq(clients.status, 'active')),
    );
  if (existing.length >= plan.maxClients) {
    throw quotaExceeded('Client limit reached for your plan.', {
      resource: 'clients',
      limit: plan.maxClients,
      used: existing.length,
      plan: plan.id,
    });
  }
}

// GET /clients/:clientId
clientsRouter.get('/:clientId', async (req, res) => {
  const ctx = getAuth(req);
  const client = await requireClientAccess(ctx, param(req, 'clientId'));
  const [pc] = await db
    .select({ value: count() })
    .from(projects)
    .where(
      and(
        eq(projects.agencyId, ctx.agencyId),
        eq(projects.clientId, client.id),
      ),
    );

  // invoiceCount = all of this client's invoices for the agency.
  const [ic] = await db
    .select({ value: count() })
    .from(invoices)
    .where(
      and(
        eq(invoices.agencyId, ctx.agencyId),
        eq(invoices.clientId, client.id),
      ),
    );

  // outstanding (paise) = Σ amountDue (total - paid) of this client's issued,
  // not-fully-paid invoices (status sent | partially_paid).
  const paidPerInvoiceSq = sql<number>`(
    select coalesce(sum(${invoicePayments.amount}), 0) from ${invoicePayments}
    where ${invoicePayments.invoiceId} = ${invoices.id}
  )`;
  const [out] = await db
    .select({
      value: sql<number>`coalesce(sum(${invoices.total} - ${paidPerInvoiceSq}), 0)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.agencyId, ctx.agencyId),
        eq(invoices.clientId, client.id),
        inArray(invoices.status, ['sent', 'partially_paid']),
      ),
    );

  // documentCount = all of this client's documents for the agency.
  const [dc] = await db
    .select({ value: count() })
    .from(documents)
    .where(
      and(
        eq(documents.agencyId, ctx.agencyId),
        eq(documents.clientId, client.id),
      ),
    );

  ok(res, {
    ...serializeClient(client),
    projectCount: pc?.value ?? 0,
    invoiceCount: ic?.value ?? 0,
    documentCount: dc?.value ?? 0,
    outstanding: Number(out?.value ?? 0), // paise
  });
});

// PATCH /clients/:clientId
const updateSchema = createSchema.partial().extend({
  status: z.enum(['active', 'archived']).optional(),
  portalVisibleStatuses: z.array(z.string()).optional(),
});

clientsRouter.patch('/:clientId', async (req, res) => {
  const ctx = getAuth(req);
  const client = await requireClientAccess(ctx, param(req, 'clientId'));
  const body = updateSchema.parse(req.body);

  const patch: Partial<typeof clients.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.logoUrl !== undefined) patch.logoUrl = body.logoUrl;
  if (body.brandColor !== undefined) patch.brandColor = body.brandColor;
  if (body.handles !== undefined)
    patch.handlesJson = JSON.stringify(body.handles);
  if (body.contactEmail !== undefined) patch.contactEmail = body.contactEmail;
  if (body.industry !== undefined) patch.industry = body.industry;
  if (body.website !== undefined) patch.website = body.website;
  if (body.phoneCc !== undefined) patch.phoneCc = body.phoneCc;
  if (body.phone !== undefined) patch.phone = body.phone;
  if (body.clientSource !== undefined) patch.clientSource = body.clientSource;
  if (body.gstNumber !== undefined) patch.gstNumber = body.gstNumber;
  if (body.paymentTermsDays !== undefined)
    patch.paymentTermsDays = body.paymentTermsDays;
  if (body.billingAddress !== undefined)
    patch.billingAddress = body.billingAddress;
  if (body.billingState !== undefined) patch.billingState = body.billingState;
  if (body.billingCity !== undefined) patch.billingCity = body.billingCity;
  if (body.billingPincode !== undefined)
    patch.billingPincode = body.billingPincode;
  if (body.relationshipHealth !== undefined)
    patch.relationshipHealth = body.relationshipHealth;
  if (body.nextFollowUpAt !== undefined)
    patch.nextFollowUpAt = body.nextFollowUpAt;
  if (body.internalNotes !== undefined) patch.internalNotes = body.internalNotes;
  // 'Active client' toggle takes precedence; falls back to explicit status.
  if (body.isActive !== undefined)
    patch.status = body.isActive ? 'active' : 'archived';
  else if (body.status !== undefined) patch.status = body.status;
  if (body.portalVisibleStatuses !== undefined)
    patch.portalVisibleStatuses = body.portalVisibleStatuses.join(',');

  await db
    .update(clients)
    .set(patch)
    .where(
      and(eq(clients.id, client.id), eq(clients.agencyId, ctx.agencyId)),
    );

  const [row] = await db.select().from(clients).where(eq(clients.id, client.id));
  ok(res, serializeClient(row!));
});

// POST /clients/:clientId/archive
clientsRouter.post(
  '/:clientId/archive',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    const client = await requireClientAccess(ctx, param(req, 'clientId'));
    await db
      .update(clients)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(
        and(eq(clients.id, client.id), eq(clients.agencyId, ctx.agencyId)),
      );
    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'client.archive',
      entityType: 'client',
      entityId: client.id,
      ip: req.ip,
    });
    ok(res, { archived: true });
  },
);

// ---- Portal share tokens ----

// POST /clients/:clientId/portal-tokens — returns raw token ONCE.
const tokenSchema = z.object({
  label: z.string().max(80).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

clientsRouter.post('/:clientId/portal-tokens', async (req, res) => {
  const ctx = getAuth(req);
  const client = await requireClientAccess(ctx, param(req, 'clientId'));
  const body = tokenSchema.parse(req.body ?? {});

  const { raw, hash } = newOpaqueToken();
  const id = newId('ptk');
  const expiresAt = body.expiresInDays
    ? new Date(Date.now() + body.expiresInDays * 86_400_000)
    : null;

  await db.insert(portalTokens).values({
    id,
    agencyId: ctx.agencyId,
    clientId: client.id,
    tokenHash: hash,
    label: body.label ?? null,
    createdBy: ctx.userId,
    expiresAt,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'portal_token.create',
    entityType: 'portal_token',
    entityId: id,
    ip: req.ip,
  });

  created(res, {
    id,
    token: raw, // shown exactly once
    label: body.label ?? null,
    expiresAt: toIso(expiresAt),
  });
});

// GET /clients/:clientId/portal-tokens — list (no hashes).
clientsRouter.get('/:clientId/portal-tokens', async (req, res) => {
  const ctx = getAuth(req);
  const client = await requireClientAccess(ctx, param(req, 'clientId'));
  const rows = await db
    .select()
    .from(portalTokens)
    .where(
      and(
        eq(portalTokens.agencyId, ctx.agencyId),
        eq(portalTokens.clientId, client.id),
      ),
    );
  ok(
    res,
    rows.map((tk) => ({
      id: tk.id,
      label: tk.label,
      revoked: tk.revoked,
      expiresAt: toIso(tk.expiresAt),
      lastUsedAt: toIso(tk.lastUsedAt),
      createdAt: toIso(tk.createdAt),
    })),
  );
});

// POST /clients/:clientId/portal-tokens/:tokenId/revoke
clientsRouter.post(
  '/:clientId/portal-tokens/:tokenId/revoke',
  async (req, res) => {
    const ctx = getAuth(req);
    const client = await requireClientAccess(ctx, param(req, 'clientId'));
    const result = await db
      .update(portalTokens)
      .set({ revoked: true, revokedAt: new Date() })
      .where(
        and(
          eq(portalTokens.id, param(req, 'tokenId')),
          eq(portalTokens.agencyId, ctx.agencyId),
          eq(portalTokens.clientId, client.id),
        ),
      )
      .returning({ id: portalTokens.id });
    if (!result.length) throw notFound('Token not found.');

    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'portal_token.revoke',
      entityType: 'portal_token',
      entityId: param(req, 'tokenId'),
      ip: req.ip,
    });
    ok(res, { revoked: true });
  },
);

// POST /clients/:clientId/send-welcome — emails an active portal link.
clientsRouter.post('/:clientId/send-welcome', async (req, res) => {
  const ctx = getAuth(req);
  const client = await requireClientAccess(ctx, param(req, 'clientId'));
  if (!client.contactEmail) {
    throw conflict('Client has no contact email.');
  }

  // Create a fresh share token for the welcome link.
  const { raw, hash } = newOpaqueToken();
  const id = newId('ptk');
  await db.insert(portalTokens).values({
    id,
    agencyId: ctx.agencyId,
    clientId: client.id,
    tokenHash: hash,
    label: 'welcome',
    createdBy: ctx.userId,
  });

  const [agency] = await db
    .select()
    .from(agencies)
    .where(eq(agencies.id, ctx.agencyId))
    .limit(1);

  const portalUrl = `${process.env.FRONTEND_ORIGIN ?? ''}/p/${raw}`;
  await sendPortalWelcome({
    to: client.contactEmail,
    clientName: client.name,
    agencyName: agency?.name ?? 'Your agency',
    portalUrl,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'client.send_welcome',
    entityType: 'client',
    entityId: client.id,
    ip: req.ip,
  });
  ok(res, { sent: true });
});
