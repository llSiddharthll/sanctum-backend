import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  aiGenerations,
  auditLog,
  clients,
  customRoles,
  plans,
  subscriptions,
  usageCounters,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { conflict, notFound } from '../lib/errors.js';
import { currentPeriod, newId } from '../lib/ids.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireModule } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';
import {
  moduleCatalog,
  resolveRolePermissions,
  resolvePermissions,
  serializeRoleDefaults,
  serializeOverrides,
  parseRoleDefaults,
  sanitizeRoleDefaults,
  rolePresetCatalog,
} from '../lib/permissions.js';
import { audit } from '../services/audit.js';
import { rateLimitConfig } from '../middleware/rate-limit.js';
import { env } from '../env.js';

export const agenciesRouter = Router();
agenciesRouter.use(requireAuth);

// GET /agency — current agency profile.
agenciesRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const [agency] = await db
    .select()
    .from(agencies)
    .where(eq(agencies.id, ctx.agencyId))
    .limit(1);
  if (!agency) throw notFound('Agency not found.');
  ok(res, {
    id: agency.id,
    name: agency.name,
    slug: agency.slug,
    logoUrl: agency.logoUrl,
    brandColor: agency.brandColor,
    themePreset: agency.themePreset,
    status: agency.status,
  });
});

// Allowed UI theme presets (must mirror frontend theme/registry.ts keys).
const THEME_PRESETS = ['evergreen', 'goldcrest'] as const;

// PATCH /agency — owner/admin edit branding + theme.
const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  logoUrl: z.string().url().nullable().optional(),
  brandColor: z.string().max(20).nullable().optional(),
  themePreset: z.enum(THEME_PRESETS).optional(),
});

agenciesRouter.patch(
  '/',
  requireRole('owner', 'admin'),
  requireModule('settings', 'manage'),
  async (req, res) => {
  const ctx = getAuth(req);
  const body = patchSchema.parse(req.body);
  const patch: Partial<typeof agencies.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.logoUrl !== undefined) patch.logoUrl = body.logoUrl;
  if (body.brandColor !== undefined) patch.brandColor = body.brandColor;
  if (body.themePreset !== undefined) patch.themePreset = body.themePreset;

  await db.update(agencies).set(patch).where(eq(agencies.id, ctx.agencyId));
  const [row] = await db
    .select()
    .from(agencies)
    .where(eq(agencies.id, ctx.agencyId));
  ok(res, {
    id: row!.id,
    name: row!.name,
    slug: row!.slug,
    logoUrl: row!.logoUrl,
    brandColor: row!.brandColor,
    themePreset: row!.themePreset,
  });
});

// GET /agency/usage — current-period AI/storage usage + counts vs plan.
agenciesRouter.get(
  '/usage',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    const period = currentPeriod();

    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.agencyId, ctx.agencyId))
      .limit(1);
    let plan = null;
    if (sub) {
      const [p] = await db
        .select()
        .from(plans)
        .where(eq(plans.id, sub.planId))
        .limit(1);
      plan = p ?? null;
    }

    const [counter] = await db
      .select()
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.agencyId, ctx.agencyId),
          eq(usageCounters.period, period),
        ),
      )
      .limit(1);

    const aiUsed = await db
      .select({ n: count() })
      .from(aiGenerations)
      .where(
        and(
          eq(aiGenerations.agencyId, ctx.agencyId),
          eq(aiGenerations.period, period),
          eq(aiGenerations.status, 'succeeded'),
        ),
      );

    const [clientCount] = await db
      .select({ n: count() })
      .from(clients)
      .where(
        and(
          eq(clients.agencyId, ctx.agencyId),
          eq(clients.status, 'active'),
        ),
      );
    const [userCount] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.agencyId, ctx.agencyId));

    ok(res, {
      period,
      planName: plan?.name ?? null,
      ai: {
        used: aiUsed[0]?.n ?? 0,
        limit: plan?.maxAiGenerations ?? null,
        provider: env.AI_PROVIDER,
        model: env.GEMINI_MODEL,
      },
      storage: {
        usedBytes: counter?.storageBytesUsed ?? 0,
        limitBytes: plan?.maxStorageBytes ?? null,
      },
      clients: { used: clientCount?.n ?? 0, limit: plan?.maxClients ?? null },
      team: { used: userCount?.n ?? 0, limit: plan?.maxTeamMembers ?? null },
      rateLimits: {
        global: {
          max: rateLimitConfig.global.max,
          windowMs: rateLimitConfig.global.windowMs,
        },
        auth: {
          max: rateLimitConfig.auth.max,
          windowMs: rateLimitConfig.auth.windowMs,
        },
        ai: {
          max: rateLimitConfig.ai.max,
          windowMs: rateLimitConfig.ai.windowMs,
        },
      },
    });
  },
);

// GET /agency/audit-log — recent events (owner/admin).
agenciesRouter.get(
  '/audit-log',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.agencyId, ctx.agencyId))
      .orderBy(auditLog.createdAt)
      .limit(100);
    ok(
      res,
      rows.map((a) => ({
        id: a.id,
        actorType: a.actorType,
        actorId: a.actorId,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        metadata: a.metadataJson ? JSON.parse(a.metadataJson) : null,
        createdAt: toIso(a.createdAt),
      })),
    );
  },
);

// ============================================================
//  ROLES & PERMISSIONS (admin-managed role defaults)
//  The module catalog is code-defined (single source of truth), so new
//  modules appear here automatically. Per-role defaults are stored per agency
//  and layered under each user's personal overrides.
// ============================================================

// GET /agency/roles — module catalog + the effective per-role permission matrix.
agenciesRouter.get(
  '/roles',
  requireRole('owner', 'admin'),
  requireModule('settings', 'view'),
  async (req, res) => {
    const ctx = getAuth(req);
    const [agency] = await db
      .select({ rolePermissionsJson: agencies.rolePermissionsJson })
      .from(agencies)
      .where(eq(agencies.id, ctx.agencyId))
      .limit(1);
    if (!agency) throw notFound('Agency not found.');
    ok(res, {
      modules: moduleCatalog(),
      // owner is always full access (and not editable); admin + member are
      // resolved from stored defaults, falling back to full access.
      roles: resolveRolePermissions(agency.rolePermissionsJson),
      // Predefined role templates the owner can apply in one click.
      presets: rolePresetCatalog(),
    });
  },
);

// PUT /agency/roles — replace the admin/member role defaults.
const rolesSchema = z.object({
  admin: z.record(z.string(), z.string()).optional(),
  member: z.record(z.string(), z.string()).optional(),
});

agenciesRouter.put(
  '/roles',
  requireRole('owner', 'admin'),
  requireModule('settings', 'manage'),
  async (req, res) => {
    const ctx = getAuth(req);
    const body = rolesSchema.parse(req.body);

    // Merge incoming role maps onto the existing stored defaults.
    const [agency] = await db
      .select({ rolePermissionsJson: agencies.rolePermissionsJson })
      .from(agencies)
      .where(eq(agencies.id, ctx.agencyId))
      .limit(1);
    if (!agency) throw notFound('Agency not found.');

    const existing = parseRoleDefaults(agency.rolePermissionsJson);
    const incoming = sanitizeRoleDefaults(body);
    const merged = {
      admin: { ...existing.admin, ...incoming.admin },
      member: { ...existing.member, ...incoming.member },
    };

    await db
      .update(agencies)
      .set({
        rolePermissionsJson: serializeRoleDefaults(merged),
        updatedAt: new Date(),
      })
      .where(eq(agencies.id, ctx.agencyId));

    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'roles.update',
      entityType: 'agency',
      entityId: ctx.agencyId,
      ip: req.ip,
    });

    ok(res, {
      modules: moduleCatalog(),
      roles: resolveRolePermissions(serializeRoleDefaults(merged)),
    });
  },
);

// ============================================================
//  CUSTOM ROLES (named permission presets, owner/admin-managed)
// ============================================================
function serializeCustomRole(cr: typeof customRoles.$inferSelect) {
  return {
    id: cr.id,
    name: cr.name,
    colorToken: cr.colorToken,
    baseRole: cr.baseRole,
    // Effective module map (custom overrides over the base tier defaults).
    permissions: resolvePermissions(cr.baseRole, null, null, cr.permissionsJson),
  };
}

agenciesRouter.get(
  '/custom-roles',
  requireRole('owner', 'admin'),
  requireModule('settings', 'view'),
  async (req, res) => {
    const ctx = getAuth(req);
    const rows = await db
      .select()
      .from(customRoles)
      .where(eq(customRoles.agencyId, ctx.agencyId))
      .orderBy(customRoles.name);
    ok(res, rows.map(serializeCustomRole));
  },
);

const customRoleSchema = z.object({
  name: z.string().trim().min(1).max(40),
  colorToken: z.string().trim().max(20).optional(),
  baseRole: z.enum(['admin', 'member']),
  permissions: z.record(z.string(), z.string()).optional(),
});

agenciesRouter.post(
  '/custom-roles',
  requireRole('owner', 'admin'),
  requireModule('settings', 'manage'),
  async (req, res) => {
    const ctx = getAuth(req);
    const body = customRoleSchema.parse(req.body);
    const [dupe] = await db
      .select({ id: customRoles.id })
      .from(customRoles)
      .where(and(eq(customRoles.agencyId, ctx.agencyId), eq(customRoles.name, body.name)))
      .limit(1);
    if (dupe) throw conflict('A role with that name already exists.');
    const id = newId('crl');
    await db.insert(customRoles).values({
      id,
      agencyId: ctx.agencyId,
      name: body.name,
      colorToken: body.colorToken ?? 'pine',
      baseRole: body.baseRole,
      permissionsJson: serializeOverrides(body.permissions ?? {}),
    });
    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'role.create',
      entityType: 'custom_role',
      entityId: id,
      metadata: { name: body.name, baseRole: body.baseRole },
      ip: req.ip,
    });
    const [row] = await db.select().from(customRoles).where(eq(customRoles.id, id));
    created(res, serializeCustomRole(row!));
  },
);

agenciesRouter.patch(
  '/custom-roles/:id',
  requireRole('owner', 'admin'),
  requireModule('settings', 'manage'),
  async (req, res) => {
    const ctx = getAuth(req);
    const id = param(req, 'id');
    const body = customRoleSchema.partial().parse(req.body);
    const patch: Partial<typeof customRoles.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.colorToken !== undefined) patch.colorToken = body.colorToken;
    if (body.baseRole !== undefined) patch.baseRole = body.baseRole;
    if (body.permissions !== undefined)
      patch.permissionsJson = serializeOverrides(body.permissions);
    await db
      .update(customRoles)
      .set(patch)
      .where(and(eq(customRoles.id, id), eq(customRoles.agencyId, ctx.agencyId)));
    // Changing the base tier re-tiers every user holding this role.
    if (body.baseRole !== undefined) {
      await db
        .update(users)
        .set({ role: body.baseRole, updatedAt: new Date() })
        .where(and(eq(users.agencyId, ctx.agencyId), eq(users.customRoleId, id)));
    }
    const [row] = await db.select().from(customRoles).where(eq(customRoles.id, id));
    if (!row) throw notFound('Role not found.');
    ok(res, serializeCustomRole(row));
  },
);

agenciesRouter.delete(
  '/custom-roles/:id',
  requireRole('owner', 'admin'),
  requireModule('settings', 'manage'),
  async (req, res) => {
    const ctx = getAuth(req);
    const id = param(req, 'id');
    // Detach holders — they revert to their base tier with no preset.
    await db
      .update(users)
      .set({ customRoleId: null, updatedAt: new Date() })
      .where(and(eq(users.agencyId, ctx.agencyId), eq(users.customRoleId, id)));
    await db
      .delete(customRoles)
      .where(and(eq(customRoles.id, id), eq(customRoles.agencyId, ctx.agencyId)));
    ok(res, { deleted: true });
  },
);
