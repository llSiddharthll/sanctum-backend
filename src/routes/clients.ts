import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, count, desc, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  clients,
  clientContacts,
  clientTagLinks,
  clientTags,
  messageThreads,
  messages,
  portalTokenProjects,
  portalTokens,
  plans,
  projects,
  roles,
  subscriptions,
  invoices,
  invoicePayments,
  documents,
  threadParticipants,
  users,
  auditLog,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId, newOpaqueToken } from '../lib/ids.js';
import { badRequest, conflict, forbidden, notFound, quotaExceeded } from '../lib/errors.js';
import { verifyPassword } from '../lib/password.js';
import { aiLimiter } from '../middleware/rate-limit.js';
import { audit, auditAuthz } from '../services/audit.js';
import { summarisePinnedConversation } from '../services/ai.js';
import { sendPortalWelcome } from '../services/email.js';
import { getFrontendOrigin } from '../lib/frontend-url.js';
import {
  findClientLogin,
  findClientLoginByEmail,
  listClientLogins,
  mintClientPortalLogin,
  sendClientPortalLoginEmail,
} from '../lib/client-portal-login.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize, capabilities, check, requirePermission, type ObjectFacts } from '../authz/engine.js';
import type { StaffActor } from '../authz/actor.js';
import { requireActiveStaff } from '../authz/tenancy.js';
import { revokePortalTokenSessions } from '../authz/sessions.js';
import { systemRoleId } from '../authz/roles-store.js';
import { clientFacts, clientScopeFilter } from '../authz/policies/clients.js';
import { clientRowFactsBuilder } from '../authz/policies/crm.js';
import { disconnectPortalToken } from '../realtime/authz-sync.js';

export const clientsRouter = Router();
// Authentication ONLY at router level. This router is mounted at /clients and
// sees nested paths (/clients/:clientId/{posts,reservations,ai,social}) first;
// those routers are governed solely by their own permissions.
clientsRouter.use(authenticate);

/** Permissions surfaced as per-client capabilities on the detail response. */
const CLIENT_CAPABILITIES = [
  'clients.update',
  'clients.archive',
  'clients.view_financials',
  'clients.view_activity',
  'clients.manage_assignments',
  'clients.manage_portal',
  'contacts.manage',
  'client_notes.create',
  'deals.view',
  'deals.create',
  'deals.view_value',
  'deals.update_value',
  'tags.manage',
];

const FINANCIAL_FIELDS = [
  'gstNumber',
  'paymentTermsDays',
  'billingAddress',
  'billingState',
  'billingCity',
  'billingPincode',
] as const;

/**
 * Client row → API shape. Billing / GST / payment terms are serialized only
 * with `clients.view_financials` on the client (keys kept, values null).
 */
function serializeClient(c: typeof clients.$inferSelect, showFinancials: boolean) {
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
    gstNumber: showFinancials ? c.gstNumber : null,
    paymentTermsDays: showFinancials ? c.paymentTermsDays : null,
    billingAddress: showFinancials ? c.billingAddress : null,
    billingState: showFinancials ? c.billingState : null,
    billingCity: showFinancials ? c.billingCity : null,
    billingPincode: showFinancials ? c.billingPincode : null,
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

/** Load the client row + facts; 404 when not in the actor's agency. */
async function loadClient(actor: StaffActor, clientId: string) {
  const facts = await clientFacts(actor, clientId);
  if (!facts) throw notFound('Client not found.');
  const [row] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) throw notFound('Client not found.');
  return { client: row, facts };
}

/** Authorize `permission` on the client in :clientId (404 if the actor can't view it). */
async function clientFor(
  req: Parameters<typeof getStaffActor>[0],
  permission: string,
) {
  const actor = getStaffActor(req);
  const { client, facts } = await loadClient(actor, param(req, 'clientId'));
  authorize(actor, 'clients.view', facts);
  if (permission !== 'clients.view') authorize(actor, permission, facts, { view: 'clients.view' });
  return { actor, client, facts };
}

// GET /clients — directory, filtered in SQL to the clients in the actor's
// clients.view scope (organization → all; assigned → assigned/owned).
clientsRouter.get('/', requires('clients.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const scope = await clientScopeFilter(actor, 'clients.view', clients.id);
  const rows = await db
    .select()
    .from(clients)
    .where(and(eq(clients.agencyId, actor.agencyId), scope));
  const factsFor = await clientRowFactsBuilder(actor);
  ok(
    res,
    rows.map((c) => serializeClient(c, check(actor, 'clients.view_financials', factsFor(c.id)))),
  );
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
const relationshipHealthEnum = z.enum(['excellent', 'good', 'at_risk', 'poor']);

// Optional CRM fields accept `null` so the edit form can CLEAR a field.
const createSchema = z.object({
  name: z.string().min(1).max(120),
  logoUrl: z.string().url().nullable().optional(),
  brandColor: z.string().max(20).nullable().optional(),
  handles: z.record(z.string(), z.string()).optional(),
  contactEmail: z.string().email().nullable().optional(),
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
  // Account manager (clients.manage_assignments; must be active staff).
  ownerId: z.string().nullable().optional(),
  // Client-side portal role (clients.manage_portal).
  portalRole: z.enum(['approver', 'reviewer']).optional(),
  // 'Active client' toggle (create only; PATCH uses archive/restore).
  isActive: z.boolean().optional(),
});

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

// POST /clients — create. Enforces the plan client limit.
clientsRouter.post('/', requires('clients.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = createSchema.parse(req.body);
  const id = newId('cli');

  // Facts of the client-to-be (the actor is "assigned" iff they become owner).
  const futureFacts: ObjectFacts = {
    agencyId: actor.agencyId,
    clientId: id,
    assigned: body.ownerId === actor.userId,
  };
  if (hasValue(body.ownerId)) {
    requirePermission(actor, 'clients.manage_assignments', "You can't set the account owner.");
    await requireActiveStaff(actor.agencyId, [body.ownerId!]);
  }
  if (body.portalRole !== undefined && !check(actor, 'clients.manage_portal', futureFacts)) {
    throw forbidden("You can't change the client's portal settings.");
  }
  if (
    FINANCIAL_FIELDS.some((f) => hasValue(body[f])) &&
    !check(actor, 'clients.view_financials', futureFacts)
  ) {
    throw forbidden("You can't set billing details for clients.");
  }

  if (body.isActive !== false) await enforceClientLimit(actor.agencyId);

  await db.insert(clients).values({
    id,
    agencyId: actor.agencyId,
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
    ...(body.relationshipHealth !== undefined ? { relationshipHealth: body.relationshipHealth } : {}),
    nextFollowUpAt: body.nextFollowUpAt ?? null,
    internalNotes: body.internalNotes ?? null,
    ownerId: body.ownerId ?? null,
    ...(body.portalRole !== undefined ? { portalRole: body.portalRole } : {}),
    ...(body.isActive !== undefined ? { status: body.isActive ? 'active' : 'archived' } : {}),
  });

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.create',
    entityType: 'client',
    entityId: id,
    metadata: body.ownerId ? { ownerId: body.ownerId } : undefined,
    ip: req.ip,
  });

  const { client, facts } = await loadClient(actor, id);
  created(res, serializeClient(client, check(actor, 'clients.view_financials', facts)));
});

async function enforceClientLimit(agencyId: string): Promise<void> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.agencyId, agencyId))
    .limit(1);
  if (!sub) return;
  const [plan] = await db.select().from(plans).where(eq(plans.id, sub.planId)).limit(1);
  if (!plan || plan.maxClients == null) return;

  const existing = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.agencyId, agencyId), eq(clients.status, 'active')));
  if (existing.length >= plan.maxClients) {
    throw quotaExceeded('Client limit reached for your plan.', {
      resource: 'clients',
      limit: plan.maxClients,
      used: existing.length,
      plan: plan.id,
    });
  }
}

// GET /clients/:clientId — detail + counts (+ money with clients.view_financials).
clientsRouter.get('/:clientId', requires('clients.view'), async (req, res) => {
  const { actor, client, facts } = await clientFor(req, 'clients.view');
  const showFinancials = check(actor, 'clients.view_financials', facts);

  const [pc] = await db
    .select({ value: count() })
    .from(projects)
    .where(and(eq(projects.agencyId, actor.agencyId), eq(projects.clientId, client.id)));

  let invoiceCount: number | null = null;
  let outstanding: number | null = null;
  if (showFinancials) {
    const [ic] = await db
      .select({ value: count() })
      .from(invoices)
      .where(and(eq(invoices.agencyId, actor.agencyId), eq(invoices.clientId, client.id)));
    // outstanding (paise) = Σ (total - paid) of issued, not-fully-paid invoices.
    const paidPerInvoiceSq = sql<number>`(
      select coalesce(sum(${invoicePayments.amount}), 0) from ${invoicePayments}
      where ${invoicePayments.invoiceId} = ${invoices.id}
    )`;
    const [out] = await db
      .select({ value: sql<number>`coalesce(sum(${invoices.total} - ${paidPerInvoiceSq}), 0)` })
      .from(invoices)
      .where(
        and(
          eq(invoices.agencyId, actor.agencyId),
          eq(invoices.clientId, client.id),
          inArray(invoices.status, ['sent', 'partially_paid']),
        ),
      );
    invoiceCount = ic?.value ?? 0;
    outstanding = Number(out?.value ?? 0);
  }

  const [dc] = await db
    .select({ value: count() })
    .from(documents)
    .where(and(eq(documents.agencyId, actor.agencyId), eq(documents.clientId, client.id)));

  let ownerName: string | null = null;
  if (client.ownerId) {
    const [o] = await db
      .select({ name: users.fullName, email: users.email })
      .from(users)
      .where(and(eq(users.id, client.ownerId), eq(users.agencyId, actor.agencyId)))
      .limit(1);
    ownerName = o?.name ?? o?.email ?? null;
  }
  const tags = await db
    .select({ id: clientTags.id, name: clientTags.name, colorToken: clientTags.colorToken })
    .from(clientTagLinks)
    .innerJoin(clientTags, eq(clientTags.id, clientTagLinks.tagId))
    .where(and(eq(clientTagLinks.agencyId, actor.agencyId), eq(clientTagLinks.clientId, client.id)));

  ok(res, {
    ...serializeClient(client, showFinancials),
    ownerName,
    tags,
    projectCount: pc?.value ?? 0,
    invoiceCount,
    documentCount: dc?.value ?? 0,
    outstanding, // paise; null without clients.view_financials
    capabilities: capabilities(actor, facts, CLIENT_CAPABILITIES),
  });
});

// PATCH /clients/:clientId — profile fields (clients.update). Field rules:
//  - status / isActive can't change here (archive/restore endpoints);
//  - ownerId change → clients.manage_assignments + active staff;
//  - portalRole / portalVisibleStatuses change → clients.manage_portal;
//  - billing / GST / terms change → clients.view_financials.
const updateSchema = createSchema.partial().extend({
  status: z.enum(['active', 'archived']).optional(),
  portalVisibleStatuses: z.array(z.string()).optional(),
});

clientsRouter.patch('/:clientId', requires('clients.update'), async (req, res) => {
  const { actor, client, facts } = await clientFor(req, 'clients.update');
  const body = updateSchema.parse(req.body);

  const wantsActive =
    body.isActive !== undefined ? body.isActive : body.status !== undefined ? body.status === 'active' : undefined;
  if (wantsActive !== undefined && wantsActive !== (client.status === 'active')) {
    throw badRequest(
      wantsActive
        ? 'Restore the client with POST /clients/:clientId/restore.'
        : 'Archive the client with POST /clients/:clientId/archive.',
    );
  }

  if (body.ownerId !== undefined && body.ownerId !== client.ownerId) {
    authorize(actor, 'clients.manage_assignments', facts, {
      view: 'clients.view',
      message: "You can't change the account owner.",
    });
    if (body.ownerId) await requireActiveStaff(actor.agencyId, [body.ownerId]);
  }

  const portalChanged =
    (body.portalRole !== undefined && body.portalRole !== client.portalRole) ||
    (body.portalVisibleStatuses !== undefined &&
      body.portalVisibleStatuses.join(',') !== client.portalVisibleStatuses);
  if (portalChanged) {
    authorize(actor, 'clients.manage_portal', facts, {
      view: 'clients.view',
      message: "You can't change the client's portal settings.",
    });
  }

  const financialChanged = FINANCIAL_FIELDS.some(
    (f) => body[f] !== undefined && (body[f] ?? null) !== (client[f] ?? null),
  );
  if (financialChanged) {
    authorize(actor, 'clients.view_financials', facts, {
      view: 'clients.view',
      message: "You can't change billing details for this client.",
    });
  }

  const patch: Partial<typeof clients.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.logoUrl !== undefined) patch.logoUrl = body.logoUrl;
  if (body.brandColor !== undefined) patch.brandColor = body.brandColor;
  if (body.handles !== undefined) patch.handlesJson = JSON.stringify(body.handles);
  if (body.contactEmail !== undefined) patch.contactEmail = body.contactEmail;
  if (body.industry !== undefined) patch.industry = body.industry;
  if (body.website !== undefined) patch.website = body.website;
  if (body.phoneCc !== undefined) patch.phoneCc = body.phoneCc;
  if (body.phone !== undefined) patch.phone = body.phone;
  if (body.clientSource !== undefined) patch.clientSource = body.clientSource;
  if (financialChanged) {
    if (body.gstNumber !== undefined) patch.gstNumber = body.gstNumber;
    if (body.paymentTermsDays !== undefined) patch.paymentTermsDays = body.paymentTermsDays;
    if (body.billingAddress !== undefined) patch.billingAddress = body.billingAddress;
    if (body.billingState !== undefined) patch.billingState = body.billingState;
    if (body.billingCity !== undefined) patch.billingCity = body.billingCity;
    if (body.billingPincode !== undefined) patch.billingPincode = body.billingPincode;
  }
  if (body.relationshipHealth !== undefined) patch.relationshipHealth = body.relationshipHealth;
  if (body.nextFollowUpAt !== undefined) patch.nextFollowUpAt = body.nextFollowUpAt;
  if (body.internalNotes !== undefined) patch.internalNotes = body.internalNotes;
  if (body.ownerId !== undefined) patch.ownerId = body.ownerId;
  if (body.portalRole !== undefined) patch.portalRole = body.portalRole;
  if (body.portalVisibleStatuses !== undefined) {
    patch.portalVisibleStatuses = body.portalVisibleStatuses.join(',');
  }

  await db
    .update(clients)
    .set(patch)
    .where(and(eq(clients.id, client.id), eq(clients.agencyId, actor.agencyId)));

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.update',
    entityType: 'client',
    entityId: client.id,
    metadata: {
      fields: Object.keys(patch).filter((k) => k !== 'updatedAt'),
      ...(body.ownerId !== undefined && body.ownerId !== client.ownerId
        ? { ownerId: { before: client.ownerId, after: body.ownerId } }
        : {}),
      ...(portalChanged
        ? {
            portal: {
              before: { role: client.portalRole, visible: client.portalVisibleStatuses },
              after: {
                role: patch.portalRole ?? client.portalRole,
                visible: patch.portalVisibleStatuses ?? client.portalVisibleStatuses,
              },
            },
          }
        : {}),
    },
    ip: req.ip,
  });

  const reloaded = await loadClient(actor, client.id);
  ok(res, serializeClient(reloaded.client, check(actor, 'clients.view_financials', reloaded.facts)));
});

// POST /clients/:clientId/archive — clients.archive.
clientsRouter.post('/:clientId/archive', requires('clients.archive'), async (req, res) => {
  const { actor, client } = await clientFor(req, 'clients.archive');
  await db
    .update(clients)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(and(eq(clients.id, client.id), eq(clients.agencyId, actor.agencyId)));
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.archive',
    entityType: 'client',
    entityId: client.id,
    ip: req.ip,
  });
  ok(res, { archived: true });
});

// POST /clients/:clientId/restore — clients.archive; re-checks the plan client limit.
clientsRouter.post('/:clientId/restore', requires('clients.archive'), async (req, res) => {
  const { actor, client } = await clientFor(req, 'clients.archive');
  if (client.status !== 'active') {
    await enforceClientLimit(actor.agencyId);
    await db
      .update(clients)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(clients.id, client.id), eq(clients.agencyId, actor.agencyId)));
    await audit({
      agencyId: actor.agencyId,
      actorType: actor.type,
      actorId: actor.userId,
      action: 'client.restore',
      entityType: 'client',
      entityId: client.id,
      ip: req.ip,
    });
  }
  ok(res, { archived: false });
});

// ============================================================
//  Portal share links (clients.manage_portal)
// ============================================================

const LINK_DEFAULT_DAYS = 30;
const LINK_MAX_DAYS = 90;
const DAY_MS = 86_400_000;

/**
 * Resolve the client role a share link carries: an explicit client role of
 * the agency, or the system share-link role matching the brand's portalRole.
 */
async function resolveLinkRole(
  actor: StaffActor,
  client: typeof clients.$inferSelect,
  roleId: string | undefined,
): Promise<string> {
  if (roleId) {
    const [r] = await db
      .select({ id: roles.id, actorType: roles.actorType })
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.agencyId, actor.agencyId), isNull(roles.archivedAt)))
      .limit(1);
    if (!r) throw notFound('Role not found.');
    if (r.actorType !== 'client') throw badRequest('Share links can only carry a client role.');
    return r.id;
  }
  const key = client.portalRole === 'reviewer' ? 'share_link_reviewer' : 'share_link';
  const id = await systemRoleId(actor.agencyId, key);
  if (!id) throw conflict('Share-link roles are not set up for this workspace.');
  return id;
}

/** Every project id must belong to this client in this agency. */
async function validateClientProjects(
  actor: StaffActor,
  clientId: string,
  projectIds: string[],
): Promise<string[]> {
  const ids = [...new Set(projectIds)];
  if (!ids.length) return ids;
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.agencyId, actor.agencyId),
        eq(projects.clientId, clientId),
        inArray(projects.id, ids),
      ),
    );
  if (rows.length !== ids.length) throw badRequest("One or more projects don't belong to this client.");
  return ids;
}

async function insertPortalLink(input: {
  actor: StaffActor;
  clientId: string;
  label: string | null;
  expiresAt: Date;
  roleId: string;
  projectAccess: 'all' | 'selected';
  projectIds: string[];
}): Promise<{ id: string; raw: string }> {
  const { raw, hash } = newOpaqueToken();
  const id = newId('ptk');
  await db.transaction(async (tx) => {
    await tx.insert(portalTokens).values({
      id,
      agencyId: input.actor.agencyId,
      clientId: input.clientId,
      tokenHash: hash,
      label: input.label,
      createdBy: input.actor.userId,
      expiresAt: input.expiresAt,
      roleId: input.roleId,
      projectAccess: input.projectAccess,
    });
    if (input.projectAccess === 'selected' && input.projectIds.length) {
      await tx
        .insert(portalTokenProjects)
        .values(input.projectIds.map((projectId) => ({ tokenId: id, projectId })));
    }
  });
  return { id, raw };
}

const tokenSchema = z
  .object({
    label: z.string().max(80).nullable().optional(),
    expiresInDays: z.number().int().min(1).max(LINK_MAX_DAYS).default(LINK_DEFAULT_DAYS),
    roleId: z.string().min(1).optional(),
    projectAccess: z.enum(['all', 'selected']).default('all'),
    projectIds: z.array(z.string().min(1)).max(500).default([]),
  })
  .refine((b) => b.projectAccess === 'selected' || b.projectIds.length === 0, {
    message: "projectIds require projectAccess 'selected'.",
    path: ['projectIds'],
  });

// POST /clients/:clientId/portal-tokens — returns the raw token ONCE.
clientsRouter.post('/:clientId/portal-tokens', requires('clients.manage_portal'), async (req, res) => {
  const { actor, client } = await clientFor(req, 'clients.manage_portal');
  const body = tokenSchema.parse(req.body ?? {});
  const roleId = await resolveLinkRole(actor, client, body.roleId);
  const projectIds =
    body.projectAccess === 'selected' ? await validateClientProjects(actor, client.id, body.projectIds) : [];
  const expiresAt = new Date(Date.now() + body.expiresInDays * DAY_MS);

  const { id, raw } = await insertPortalLink({
    actor,
    clientId: client.id,
    label: body.label ?? null,
    expiresAt,
    roleId,
    projectAccess: body.projectAccess,
    projectIds,
  });

  await auditAuthz({
    actor,
    action: 'portal_token.create',
    entityType: 'portal_token',
    entityId: id,
    after: {
      clientId: client.id,
      roleId,
      projectAccess: body.projectAccess,
      projectIds,
      expiresAt: expiresAt.toISOString(),
    },
    ip: req.ip,
  });

  created(res, {
    id,
    token: raw, // shown exactly once
    label: body.label ?? null,
    expiresAt: toIso(expiresAt),
    roleId,
    projectAccess: body.projectAccess,
    projectIds,
  });
});

// GET /clients/:clientId/portal-tokens — list (never hashes).
clientsRouter.get('/:clientId/portal-tokens', requires('clients.manage_portal'), async (req, res) => {
  const { actor, client } = await clientFor(req, 'clients.manage_portal');
  const rows = await db
    .select({
      id: portalTokens.id,
      label: portalTokens.label,
      revoked: portalTokens.revoked,
      revokedAt: portalTokens.revokedAt,
      expiresAt: portalTokens.expiresAt,
      lastUsedAt: portalTokens.lastUsedAt,
      createdAt: portalTokens.createdAt,
      createdBy: portalTokens.createdBy,
      roleId: portalTokens.roleId,
      roleKey: roles.key,
      roleName: roles.name,
      projectAccess: portalTokens.projectAccess,
    })
    .from(portalTokens)
    .leftJoin(roles, eq(roles.id, portalTokens.roleId))
    .where(and(eq(portalTokens.agencyId, actor.agencyId), eq(portalTokens.clientId, client.id)))
    .orderBy(desc(portalTokens.createdAt));
  const projRows = rows.length
    ? await db
        .select({ tokenId: portalTokenProjects.tokenId, projectId: portalTokenProjects.projectId })
        .from(portalTokenProjects)
        .where(inArray(portalTokenProjects.tokenId, rows.map((r) => r.id)))
    : [];
  const now = Date.now();
  ok(
    res,
    rows.map((tk) => ({
      id: tk.id,
      label: tk.label,
      revoked: tk.revoked,
      revokedAt: toIso(tk.revokedAt),
      expiresAt: toIso(tk.expiresAt),
      expired: tk.expiresAt ? (tk.expiresAt as Date).getTime() <= now : false,
      lastUsedAt: toIso(tk.lastUsedAt),
      createdAt: toIso(tk.createdAt),
      createdBy: tk.createdBy,
      roleId: tk.roleId,
      roleKey: tk.roleKey ?? null,
      roleName: tk.roleName ?? null,
      projectAccess: tk.projectAccess,
      projectIds: projRows.filter((p) => p.tokenId === tk.id).map((p) => p.projectId),
    })),
  );
});

// POST /clients/:clientId/portal-tokens/:tokenId/revoke — ends link sessions + sockets.
clientsRouter.post(
  '/:clientId/portal-tokens/:tokenId/revoke',
  requires('clients.manage_portal'),
  async (req, res) => {
    const { actor, client } = await clientFor(req, 'clients.manage_portal');
    const tokenId = param(req, 'tokenId');
    const [tk] = await db
      .select({ id: portalTokens.id, revoked: portalTokens.revoked })
      .from(portalTokens)
      .where(
        and(
          eq(portalTokens.id, tokenId),
          eq(portalTokens.agencyId, actor.agencyId),
          eq(portalTokens.clientId, client.id),
        ),
      )
      .limit(1);
    if (!tk) throw notFound('Token not found.');
    if (!tk.revoked) {
      await db
        .update(portalTokens)
        .set({ revoked: true, revokedAt: new Date() })
        .where(eq(portalTokens.id, tk.id));
    }
    const endedSessions = await revokePortalTokenSessions(tk.id, 'link_revoked');
    disconnectPortalToken(tk.id);

    await auditAuthz({
      actor,
      action: 'portal_token.revoke',
      entityType: 'portal_token',
      entityId: tk.id,
      before: { revoked: tk.revoked },
      after: { revoked: true, endedSessions },
      ip: req.ip,
    });
    ok(res, { revoked: true });
  },
);

// POST /clients/:clientId/send-welcome — emails a 30-day portal link.
clientsRouter.post('/:clientId/send-welcome', requires('clients.manage_portal'), async (req, res) => {
  const { actor, client } = await clientFor(req, 'clients.manage_portal');
  const [contact] = await db
    .select({ email: clientContacts.email })
    .from(clientContacts)
    .where(
      and(
        eq(clientContacts.agencyId, actor.agencyId),
        eq(clientContacts.clientId, client.id),
        eq(clientContacts.isPrimary, true),
      ),
    )
    .limit(1);
  const recipient = contact?.email ?? client.contactEmail;
  if (!recipient) throw conflict('Client has no contact email.');

  const roleId = await resolveLinkRole(actor, client, undefined);
  const expiresAt = new Date(Date.now() + LINK_DEFAULT_DAYS * DAY_MS);
  const { id, raw } = await insertPortalLink({
    actor,
    clientId: client.id,
    label: 'welcome',
    expiresAt,
    roleId,
    projectAccess: 'all',
    projectIds: [],
  });

  const [agency] = await db.select().from(agencies).where(eq(agencies.id, actor.agencyId)).limit(1);
  const portalUrl = `${getFrontendOrigin(req)}/portal/${raw}`;
  await sendPortalWelcome({
    to: recipient,
    clientName: client.name,
    agencyName: agency?.name ?? 'Your agency',
    portalUrl,
  });

  await auditAuthz({
    actor,
    action: 'portal_token.create',
    entityType: 'portal_token',
    entityId: id,
    after: { clientId: client.id, roleId, projectAccess: 'all', expiresAt: expiresAt.toISOString(), via: 'send_welcome' },
    ip: req.ip,
  });
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'client.send_welcome',
    entityType: 'client',
    entityId: client.id,
    metadata: { tokenId: id, to: recipient, expiresAt: expiresAt.toISOString() },
    ip: req.ip,
  });
  ok(res, { sent: true, tokenId: id, expiresAt: toIso(expiresAt) });
});

// ============================================================
//  Client-portal LOGIN accounts (clients.manage_portal)
// ============================================================

// GET /clients/:clientId/portal-login — login account status (never a password).
clientsRouter.get('/:clientId/portal-login', requires('clients.manage_portal'), async (req, res) => {
  const { actor, client } = await clientFor(req, 'clients.manage_portal');
  const login = await findClientLogin(actor.agencyId, client.id);
  const accounts = await listClientLogins(actor.agencyId, client.id);
  ok(res, {
    exists: !!login,
    email: login?.email ?? client.contactEmail ?? null,
    lastLoginAt: login ? toIso(login.lastLoginAt) : null,
    loginUrl: `${getFrontendOrigin(req)}/login`,
    accounts: accounts.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      status: u.status,
      lastLoginAt: toIso(u.lastLoginAt),
    })),
  });
});

// POST /clients/:clientId/portal-login — { email? } (defaults to the contact email).
//  - no client account with that email on this brand → create it; the
//    generated password is returned ONCE (201);
//  - account exists → nothing changes; if active, a password-reset link is
//    emailed to the account's own address (200, password: null);
//  - account exists but disabled → 409 (re-enable via client users).
const portalLoginSchema = z.object({
  email: z.string().email().optional(),
});
clientsRouter.post('/:clientId/portal-login', requires('clients.manage_portal'), async (req, res) => {
  const { actor, client } = await clientFor(req, 'clients.manage_portal');
  if (req.body && typeof req.body === 'object' && 'password' in req.body && req.body.password) {
    throw badRequest("Client passwords can't be chosen by staff. The client sets their own.");
  }
  const body = portalLoginSchema.parse(req.body ?? {});

  const result = await mintClientPortalLogin({
    agencyId: actor.agencyId,
    clientId: client.id,
    clientName: client.name,
    clientContactEmail: client.contactEmail,
    email: body.email,
    sendResetIfExists: true,
    req,
  });
  if (!result.created && result.status !== 'active') {
    throw conflict('That portal login is disabled. Re-enable it from the client users list first.');
  }

  if (result.created) {
    await auditAuthz({
      actor,
      action: 'client_user.create',
      entityType: 'client_user',
      entityId: result.userId,
      after: { clientId: client.id, email: result.email, via: 'portal_login' },
      ip: req.ip,
    });
  } else {
    await auditAuthz({
      actor,
      action: 'client_user.password_reset',
      entityType: 'client_user',
      entityId: result.userId,
      after: { via: 'portal_login' },
      ip: req.ip,
    });
  }

  const payload = {
    userId: result.userId,
    email: result.email,
    // Brand-new account only: shown ONCE, never persisted in plaintext.
    password: result.password ?? null,
    loginUrl: `${getFrontendOrigin(req)}/login`,
    created: result.created,
    resetSent: result.resetSent,
  };
  if (result.created) created(res, payload);
  else ok(res, payload);
});

// POST /clients/:clientId/portal-login-email — email a brand login account its
// sign-in details. Always sent to the ACCOUNT's own email. A password may be
// included only if it is the account's current password (i.e. the one just
// generated for a new account).
const loginEmailSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).optional(),
  sendTo: z.string().email().optional(),
  note: z.string().trim().max(300).optional(),
});
clientsRouter.post('/:clientId/portal-login-email', requires('clients.manage_portal'), async (req, res) => {
  const { actor, client } = await clientFor(req, 'clients.manage_portal');
  const body = loginEmailSchema.parse(req.body);

  const account = await findClientLoginByEmail(actor.agencyId, client.id, body.email);
  if (!account) throw notFound('No portal login with that email for this client.');
  if (account.status !== 'active') throw conflict('That portal login is disabled.');
  if (body.sendTo && body.sendTo.toLowerCase().trim() !== account.email.toLowerCase()) {
    throw badRequest('Login details can only be sent to the account’s own email.');
  }
  if (body.password && !(await verifyPassword(account.passwordHash, body.password))) {
    throw badRequest("That isn't the account's current password.");
  }

  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, actor.agencyId))
    .limit(1);

  await sendClientPortalLoginEmail({
    req,
    agencyName: agency?.name ?? 'Your agency',
    clientName: client.name,
    to: account.email,
    email: account.email,
    password: body.password,
    note: body.note?.trim(),
  });

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'portal_login.email',
    entityType: 'client',
    entityId: client.id,
    metadata: { to: account.email, userId: account.id, withPassword: !!body.password },
    ip: req.ip,
  });

  ok(res, { sent: true, to: account.email });
});

// ============================================================
//  Pinned messages (clients.view + messages.view; participation only)
// ============================================================

function parseAttachments(raw: string | null | undefined) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((a) => a && typeof a.url === 'string')
      .map((a) => ({
        url: String(a.url),
        type: a.type === 'image' ? 'image' : 'file',
        name: typeof a.name === 'string' ? a.name : 'file',
        mime: a.mime ?? null,
        bytes: typeof a.bytes === 'number' ? a.bytes : null,
      }));
  } catch {
    return [];
  }
}

/** Pins across the client's threads that the actor PARTICIPATES in, newest pin first. */
async function listParticipantPins(actor: StaffActor, clientId: string, limit = 50) {
  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      senderId: messages.senderId,
      body: messages.body,
      attachmentsJson: messages.attachmentsJson,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      senderName: users.fullName,
      pinnedAt: messages.pinnedAt,
      pinnedBy: messages.pinnedBy,
      threadSubject: messageThreads.subject,
      projectId: messageThreads.projectId,
    })
    .from(messages)
    .innerJoin(messageThreads, eq(messageThreads.id, messages.threadId))
    .innerJoin(
      threadParticipants,
      and(
        eq(threadParticipants.threadId, messageThreads.id),
        eq(threadParticipants.agencyId, actor.agencyId),
        eq(threadParticipants.userId, actor.userId),
      ),
    )
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(
      and(
        eq(messageThreads.agencyId, actor.agencyId),
        eq(messageThreads.clientId, clientId),
        isNotNull(messages.pinnedAt),
      ),
    )
    .orderBy(desc(messages.pinnedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    threadId: r.threadId,
    senderId: r.senderId,
    senderName: r.senderName ?? null,
    senderAvatarUrl: null,
    body: r.body,
    attachments: parseAttachments(r.attachmentsJson),
    createdAt: toIso(r.createdAt),
    editedAt: toIso(r.editedAt),
    pinnedAt: toIso(r.pinnedAt ?? null),
    pinnedBy: r.pinnedBy ?? null,
    threadSubject: r.threadSubject ?? null,
    projectId: r.projectId ?? null,
  }));
}

// GET /clients/:clientId/pinned
clientsRouter.get('/:clientId/pinned', requires('clients.view', 'messages.view'), async (req, res) => {
  const { actor, client } = await clientFor(req, 'clients.view');
  ok(res, await listParticipantPins(actor, client.id));
});

// POST /clients/:clientId/pinned/summary — AI catch-up brief (+ ai.use_assistant, AI rate limit).
clientsRouter.post(
  '/:clientId/pinned/summary',
  requires('clients.view', 'messages.view', 'ai.use_assistant'),
  aiLimiter,
  async (req, res) => {
    const { actor, client } = await clientFor(req, 'clients.view');
    const pinned = await listParticipantPins(actor, client.id);

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
        .reverse()
        .map((p) => ({
          body: p.body,
          senderName: p.senderName,
          threadSubject: p.threadSubject,
          pinnedAt: p.pinnedAt,
        })),
    });

    await audit({
      agencyId: actor.agencyId,
      actorType: actor.type,
      actorId: actor.userId,
      action: 'ai.pinned_summary',
      entityType: 'client',
      entityId: client.id,
      metadata: { pinnedCount: pinned.length, generated: !!summary },
      ip: req.ip,
    });

    ok(res, {
      summary,
      pinnedCount: pinned.length,
      message: summary ? null : 'AI is not configured, showing the pinned messages instead.',
    });
  },
);

// GET /clients/:clientId/activity — audit feed across the client's projects (clients.view_activity).
clientsRouter.get('/:clientId/activity', requires('clients.view_activity'), async (req, res) => {
  const { actor, client } = await clientFor(req, 'clients.view_activity');
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));

  const projs = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.agencyId, actor.agencyId), eq(projects.clientId, client.id)));
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
        eq(auditLog.agencyId, actor.agencyId),
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
        projectName: pid ? (projectName.get(pid) ?? null) : null,
        metadata,
        createdAt: toIso(r.createdAt),
      };
    }),
  );
});
