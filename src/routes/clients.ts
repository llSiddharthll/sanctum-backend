import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, count, desc, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  clients,
  clientContacts,
  clientTagLinks,
  clientTags,
  portalTokens,
  plans,
  projects,
  subscriptions,
  invoices,
  invoicePayments,
  documents,
  users,
  auditLog,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId, newOpaqueToken } from '../lib/ids.js';
import { conflict, notFound, quotaExceeded, badRequest } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  requireModuleRW,
  requireModule,
  loadPermissions,
} from '../middleware/permissions.js';
import { meetsLevel } from '../lib/permissions.js';
import {
  getAuth,
  requireClientAccess,
  isPrivileged,
  assignedClientIds,
} from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import { listPinnedForClient } from '../services/messages.js';
import { summarisePinnedConversation } from '../services/ai.js';
import { sendPortalWelcome } from '../services/email.js';
import { getFrontendOrigin } from '../lib/frontend-url.js';
import {
  findClientLogin,
  mintClientPortalLogin,
  sendClientPortalLoginEmail,
} from '../lib/client-portal-login.js';

export const clientsRouter = Router();
clientsRouter.use(requireAuth);
clientsRouter.use(requireModuleRW('clients'));

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
    ownerId: c.ownerId,
    portalVisibleStatuses: c.portalVisibleStatuses.split(','),
    portalRole: c.portalRole,
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

// GET /clients — list. Any member with clients:view browses the full brand
// directory (view-only); editing/managing a client stays gated by permissions.
// (Reaching this handler already requires clients:view via the module gate.)
clientsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const perms = await loadPermissions(req);
  const seeAll = isPrivileged(ctx.role) || meetsLevel(perms.clients, 'view');

  if (seeAll) {
    const rows = await db
      .select()
      .from(clients)
      .where(eq(clients.agencyId, ctx.agencyId));
    ok(res, rows.map(serializeClient));
    return;
  }

  // Scoped members: only their assigned clients.
  const ids = await assignedClientIds(ctx);
  if (ids.length === 0) {
    ok(res, []);
    return;
  }
  const rows = await db
    .select()
    .from(clients)
    .where(
      and(eq(clients.agencyId, ctx.agencyId), inArray(clients.id, ids)),
    );
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
// Optional CRM fields accept `null` so the edit form can CLEAR a field (the
// PATCH handler writes null when the key is present). `name` and the
// defaulted enums/status stay non-nullable.
const createSchema = z.object({
  name: z.string().min(1).max(120),
  logoUrl: z.string().url().nullable().optional(),
  brandColor: z.string().max(20).nullable().optional(),
  handles: z.record(z.string(), z.string()).optional(),
  contactEmail: z.string().email().nullable().optional(),
  // ---- Agency-CRM fields ----
  industry: z.string().trim().max(120).nullable().optional(),
  website: z.string().trim().max(255).nullable().optional(),
  phoneCc: z.string().trim().max(8).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  clientSource: clientSourceEnum.nullable().optional(),
  gstNumber: z.string().trim().max(32).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).nullable().optional(),
  billingAddress: z.string().trim().max(500).nullable().optional(),
  billingState: z.string().trim().max(120).nullable().optional(),
  billingCity: z.string().trim().max(120).nullable().optional(),
  billingPincode: z.string().trim().max(16).nullable().optional(),
  relationshipHealth: relationshipHealthEnum.optional(),
  nextFollowUpAt: z.coerce.date().nullable().optional(),
  internalNotes: z.string().trim().max(5000).nullable().optional(),
  // Account manager / relationship owner.
  ownerId: z.string().nullable().optional(),
  // Client-side portal role: 'approver' (Client Admin) or 'reviewer' (Client
  // Employee — comment/request-changes only, cannot approve).
  portalRole: z.enum(['approver', 'reviewer']).optional(),
  // `isActive` toggle ('Active client' checkbox) maps to status.
  isActive: z.boolean().optional(),
});

// Create is governed by the 'clients' module (edit tier via the router gate),
// so managers with clients access can add clients — not just owner/admin.
clientsRouter.post('/', async (req, res) => {
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
    ownerId: body.ownerId ?? null,
    ...(body.portalRole !== undefined ? { portalRole: body.portalRole } : {}),
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

  // Account owner name + segmentation tags (folded into the detail).
  let ownerName: string | null = null;
  if (client.ownerId) {
    const [o] = await db
      .select({ name: users.fullName, email: users.email })
      .from(users)
      .where(eq(users.id, client.ownerId))
      .limit(1);
    ownerName = o?.name ?? o?.email ?? null;
  }
  const tags = await db
    .select({
      id: clientTags.id,
      name: clientTags.name,
      colorToken: clientTags.colorToken,
    })
    .from(clientTagLinks)
    .innerJoin(clientTags, eq(clientTags.id, clientTagLinks.tagId))
    .where(
      and(
        eq(clientTagLinks.agencyId, ctx.agencyId),
        eq(clientTagLinks.clientId, client.id),
      ),
    );

  const isOwner = ctx.role === 'owner';

  ok(res, {
    ...serializeClient(client),
    ownerName,
    tags,
    projectCount: pc?.value ?? 0,
    invoiceCount: isOwner ? (ic?.value ?? 0) : 0,
    documentCount: dc?.value ?? 0,
    outstanding: isOwner ? Number(out?.value ?? 0) : null, // paise (owner-only)
  });
});

// PATCH /clients/:clientId
const updateSchema = createSchema.partial().extend({
  status: z.enum(['active', 'archived']).optional(),
  portalVisibleStatuses: z.array(z.string()).optional(),
});

clientsRouter.patch(
  '/:clientId',
  async (req, res) => {
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
  if (body.ownerId !== undefined) patch.ownerId = body.ownerId;
  if (body.portalRole !== undefined) patch.portalRole = body.portalRole;
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

// POST /clients/:clientId/archive — needs full 'manage' on clients.
clientsRouter.post(
  '/:clientId/archive',
  requireModule('clients', 'manage'),
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

clientsRouter.post(
  '/:clientId/portal-tokens',
  requireRole('owner', 'admin'),
  async (req, res) => {
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

// ============================================================
//  Secure client-portal LOGIN (email + password).
//  Replaces the old no-password /access share link: the agency provisions a
//  real role:'client' account for the brand and hands the client credentials
//  they type at /login. The password is never stored in plaintext — it's shown
//  once on create/reset, so the caller must copy/share it immediately.
// ============================================================

// GET /clients/:clientId/portal-login — status of the brand's login account.
// Never returns a password (it isn't stored); just whether one exists + its
// email + last sign-in, so the UI can show "create" vs "reset".
clientsRouter.get(
  '/:clientId/portal-login',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    const client = await requireClientAccess(ctx, param(req, 'clientId'));
    const login = await findClientLogin(ctx.agencyId, client.id);
    ok(res, {
      exists: !!login,
      email: login?.email ?? client.contactEmail ?? null,
      lastLoginAt: login ? toIso(login.lastLoginAt) : null,
      loginUrl: `${getFrontendOrigin(req)}/login`,
    });
  },
);

// POST /clients/:clientId/portal-login — create or reset the brand's secure
// login and return the plaintext password ONCE. Body: { email?, password? }.
// email defaults to the client's contact email; password is auto-generated
// unless one is supplied. Scope = all of the brand's projects.
const portalLoginSchema = z.object({
  email: z.string().email().optional(),
  password: z.string().min(8).max(200).optional(),
});
clientsRouter.post(
  '/:clientId/portal-login',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    const client = await requireClientAccess(ctx, param(req, 'clientId'));
    const body = portalLoginSchema.parse(req.body);

    const { email, password, created: isNew } = await mintClientPortalLogin({
      agencyId: ctx.agencyId,
      clientId: client.id,
      clientName: client.name,
      clientContactEmail: client.contactEmail,
      email: body.email,
      password: body.password,
    });

    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: isNew ? 'portal_login.create' : 'portal_login.reset',
      entityType: 'client',
      entityId: client.id,
      metadata: { email },
      ip: req.ip,
    });

    const payload = {
      email,
      password, // shown ONCE — not persisted in plaintext.
      loginUrl: `${getFrontendOrigin(req)}/login`,
      created: isNew,
    };
    if (isNew) created(res, payload);
    else ok(res, payload);
  },
);

// POST /clients/:clientId/portal-login-email — email the client their branded
// secure-login credentials (login link + email + password).
const loginEmailSchema = z.object({
  email: z.string().email(),
  // Omit when the client already has a login (we don't know their password) —
  // the email then just links them to sign in with their existing credentials.
  password: z.string().min(1).optional(),
  sendTo: z.string().email().optional(),
  // Optional context line, e.g. "A new invoice is ready to view in your portal."
  note: z.string().trim().max(300).optional(),
});
clientsRouter.post(
  '/:clientId/portal-login-email',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    const client = await requireClientAccess(ctx, param(req, 'clientId'));
    const body = loginEmailSchema.parse(req.body);

    const to = body.sendTo?.trim() || body.email.trim() || client.contactEmail;
    if (!to) {
      throw badRequest(
        'No email to send to — add a contact email or enter one.',
      );
    }

    const [agency] = await db
      .select({ name: agencies.name })
      .from(agencies)
      .where(eq(agencies.id, ctx.agencyId))
      .limit(1);
    const agencyName = agency?.name ?? 'Your agency';
    const note = body.note?.trim();

    await sendClientPortalLoginEmail({
      req,
      agencyName,
      clientName: client.name,
      to,
      email: body.email,
      password: body.password,
      note,
    });

    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'portal_login.email',
      entityType: 'client',
      entityId: client.id,
      metadata: { to },
      ip: req.ip,
    });

    ok(res, { sent: true, to });
  },
);

// GET /clients/:clientId/pinned — the messages the team pinned across this
// client's threads. Visible to anyone who can see the client, so a newcomer can
// read the few messages that actually explain the engagement.
clientsRouter.get('/:clientId/pinned', async (req, res) => {
  const ctx = getAuth(req);
  const client = await requireClientAccess(ctx, param(req, 'clientId'));
  const pinned = await listPinnedForClient(ctx.agencyId, client.id);
  ok(res, pinned);
});

// POST /clients/:clientId/pinned/summary — AI catch-up brief over those pins.
clientsRouter.post('/:clientId/pinned/summary', async (req, res) => {
  const ctx = getAuth(req);
  const client = await requireClientAccess(ctx, param(req, 'clientId'));
  const pinned = await listPinnedForClient(ctx.agencyId, client.id);

  if (!pinned.length) {
    return ok(res, {
      summary: null,
      pinnedCount: 0,
      message: 'Nothing pinned yet — pin the messages that explain this account.',
    });
  }

  const summary = await summarisePinnedConversation({
    clientName: client.name,
    pinned: pinned
      .slice()
      .reverse() // oldest pin first reads better as a narrative
      .map((p) => ({
        body: p.body,
        senderName: p.senderName,
        threadSubject: p.threadSubject,
        pinnedAt: p.pinnedAt,
      })),
  });

  ok(res, {
    summary,
    pinnedCount: pinned.length,
    // Null summary means AI is disabled — the client still renders the pins.
    message: summary ? null : 'AI is not configured, showing the pinned messages instead.',
  });
});

// GET /clients/:clientId/activity — audit feed across ALL the client's projects
// (project create/update, task status changes, timers, milestones, etc.).
clientsRouter.get(
  '/:clientId/activity',
  // Oversight feed: owner/admin + managers (projects:manage). Employees, who
  // sit at projects:edit, don't get a log of their colleagues' every action.
  requireModule('projects', 'manage'),
  async (req, res) => {
  const ctx = getAuth(req);
  const client = await requireClientAccess(ctx, param(req, 'clientId'));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));

  const projs = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(eq(projects.agencyId, ctx.agencyId), eq(projects.clientId, client.id)),
    );
  if (projs.length === 0) {
    ok(res, []);
    return;
  }
  const projectName = new Map(projs.map((p) => [p.id, p.name]));

  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorId: auditLog.actorId,
      actorName: users.fullName,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      metadataJson: auditLog.metadataJson,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(
      and(
        eq(auditLog.agencyId, ctx.agencyId),
        inArray(
          sql`json_extract(${auditLog.metadataJson}, '$.projectId')`,
          projs.map((p) => p.id),
        ),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);

  ok(
    res,
    rows.map((r) => {
      let metadata: Record<string, unknown> | null = null;
      if (r.metadataJson) {
        try {
          metadata = JSON.parse(r.metadataJson);
        } catch {
          metadata = null;
        }
      }
      const pid = metadata?.projectId as string | undefined;
      return {
        id: r.id,
        action: r.action,
        actorId: r.actorId,
        actorName: r.actorName,
        entityType: r.entityType,
        entityId: r.entityId,
        projectId: pid ?? null,
        projectName: pid ? projectName.get(pid) ?? null : null,
        metadata,
        createdAt: toIso(r.createdAt),
      };
    }),
  );
  },
);

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
  requireRole('owner', 'admin'),
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
clientsRouter.post(
  '/:clientId/send-welcome',
  requireRole('owner', 'admin'),
  async (req, res) => {
  const ctx = getAuth(req);
  const client = await requireClientAccess(ctx, param(req, 'clientId'));
  // Prefer the primary contact's email, then the billing contact, then the
  // legacy client.contactEmail field.
  const [contact] = await db
    .select({ email: clientContacts.email })
    .from(clientContacts)
    .where(
      and(
        eq(clientContacts.agencyId, ctx.agencyId),
        eq(clientContacts.clientId, client.id),
        eq(clientContacts.isPrimary, true),
      ),
    )
    .limit(1);
  const recipient = contact?.email ?? client.contactEmail;
  if (!recipient) {
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

  const portalUrl = `${getFrontendOrigin(req)}/portal/${raw}`;
  await sendPortalWelcome({
    to: recipient,
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
