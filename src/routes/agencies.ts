import { Router } from 'express';
import { z } from 'zod';
import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  aiGenerations,
  auditLog,
  clients,
  plans,
  subscriptions,
  usageCounters,
  users,
} from '../db/schema.js';
import { ok, toIso } from '../lib/http.js';
import { forbidden, notFound } from '../lib/errors.js';
import { currentPeriod } from '../lib/ids.js';
import { audit } from '../services/audit.js';
import { rateLimitConfig } from '../middleware/rate-limit.js';
import { env } from '../env.js';
import { getStorageStatus } from '../services/storage-status.js';
import { runMediaArchive } from '../services/media-archive.js';
import { authenticate, getActor, getStaffActor, requires } from '../authz/http.js';
import type { Actor } from '../authz/actor.js';

export const agenciesRouter = Router();
agenciesRouter.use(authenticate);

/** Storage is host-level: only the configured platform agency may touch it. */
function assertPlatformAgency(actor: Actor): void {
  if (!env.PLATFORM_AGENCY_ID || actor.agencyId !== env.PLATFORM_AGENCY_ID) {
    throw forbidden('Storage operations are restricted to the platform operator.');
  }
}

// GET /agency/storage — host disk usage + backups (platform operator).
agenciesRouter.get('/storage', requires('storage.view'), async (req, res) => {
  assertPlatformAgency(getStaffActor(req));
  ok(res, await getStorageStatus());
});

const archiveSchema = z.object({
  dryRun: z.boolean().optional(),
  olderThanDays: z.number().int().min(0).max(3650).optional(),
});

// POST /agency/storage/archive — run the media retention job (platform operator).
agenciesRouter.post('/storage/archive', requires('storage.archive'), async (req, res) => {
  const actor = getStaffActor(req);
  assertPlatformAgency(actor);
  const body = archiveSchema.parse(req.body ?? {});
  const result = await runMediaArchive({ dryRun: body.dryRun, retentionDays: body.olderThanDays });
  await audit({
    agencyId: actor.agencyId,
    actorType: 'staff',
    actorId: actor.userId,
    action: 'storage.archive',
    metadata: { dryRun: !!body.dryRun, olderThanDays: body.olderThanDays ?? null },
    ip: req.ip,
  });
  ok(res, result);
});

// GET /agency — agency profile & branding (any staff with organization.view;
// client actors read branding via /client/me instead).
agenciesRouter.get('/', requires('organization.view'), async (req, res) => {
  const actor = getActor(req);
  const [agency] = await db.select().from(agencies).where(eq(agencies.id, actor.agencyId)).limit(1);
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

const THEME_PRESETS = ['evergreen', 'goldcrest', 'tangerine'] as const;

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  logoUrl: z.string().url().nullable().optional(),
  brandColor: z.string().max(20).nullable().optional(),
  themePreset: z.enum(THEME_PRESETS).optional(),
});

agenciesRouter.patch('/', requires('organization.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = patchSchema.parse(req.body);
  const [before] = await db.select().from(agencies).where(eq(agencies.id, actor.agencyId)).limit(1);
  const patch: Partial<typeof agencies.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.logoUrl !== undefined) patch.logoUrl = body.logoUrl;
  if (body.brandColor !== undefined) patch.brandColor = body.brandColor;
  if (body.themePreset !== undefined) patch.themePreset = body.themePreset;

  await db.update(agencies).set(patch).where(eq(agencies.id, actor.agencyId));
  const [row] = await db.select().from(agencies).where(eq(agencies.id, actor.agencyId));
  await audit({
    agencyId: actor.agencyId,
    actorType: 'staff',
    actorId: actor.userId,
    action: 'agency.update',
    entityType: 'agency',
    entityId: actor.agencyId,
    metadata: {
      before: { name: before?.name, themePreset: before?.themePreset },
      after: { name: row!.name, themePreset: row!.themePreset },
    },
    ip: req.ip,
  });
  ok(res, {
    id: row!.id,
    name: row!.name,
    slug: row!.slug,
    logoUrl: row!.logoUrl,
    brandColor: row!.brandColor,
    themePreset: row!.themePreset,
  });
});

// GET /agency/usage — plan usage and limits.
agenciesRouter.get('/usage', requires('organization.view_usage'), async (req, res) => {
  const actor = getActor(req);
  const period = currentPeriod();

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.agencyId, actor.agencyId)).limit(1);
  let plan = null;
  if (sub) {
    const [p] = await db.select().from(plans).where(eq(plans.id, sub.planId)).limit(1);
    plan = p ?? null;
  }
  const [counter] = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.agencyId, actor.agencyId), eq(usageCounters.period, period)))
    .limit(1);
  const aiUsed = await db
    .select({ n: count() })
    .from(aiGenerations)
    .where(
      and(
        eq(aiGenerations.agencyId, actor.agencyId),
        eq(aiGenerations.period, period),
        eq(aiGenerations.status, 'succeeded'),
      ),
    );
  const [clientCount] = await db
    .select({ n: count() })
    .from(clients)
    .where(and(eq(clients.agencyId, actor.agencyId), eq(clients.status, 'active')));
  const [userCount] = await db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.agencyId, actor.agencyId), eq(users.kind, 'staff')));

  ok(res, {
    period,
    planName: plan?.name ?? null,
    ai: {
      used: aiUsed[0]?.n ?? 0,
      limit: plan?.maxAiGenerations ?? null,
      provider: env.AI_PROVIDER,
      model: env.GEMINI_MODEL,
    },
    storage: { usedBytes: counter?.storageBytesUsed ?? 0, limitBytes: plan?.maxStorageBytes ?? null },
    clients: { used: clientCount?.n ?? 0, limit: plan?.maxClients ?? null },
    team: { used: userCount?.n ?? 0, limit: plan?.maxTeamMembers ?? null },
    rateLimits: {
      global: { max: rateLimitConfig.global.max, windowMs: rateLimitConfig.global.windowMs },
      auth: { max: rateLimitConfig.auth.max, windowMs: rateLimitConfig.auth.windowMs },
      ai: { max: rateLimitConfig.ai.max, windowMs: rateLimitConfig.ai.windowMs },
    },
  });
});

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  action: z.string().max(80).optional(),
});

// GET /agency/audit-log — most recent events first.
agenciesRouter.get('/audit-log', requires('organization.view_audit_log'), async (req, res) => {
  const actor = getActor(req);
  const q = auditQuery.parse(req.query);
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      q.action
        ? and(eq(auditLog.agencyId, actor.agencyId), eq(auditLog.action, q.action))
        : eq(auditLog.agencyId, actor.agencyId),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(q.limit ?? 100);
  ok(
    res,
    rows.map((a) => {
      let metadata: unknown = null;
      try {
        metadata = a.metadataJson ? JSON.parse(a.metadataJson) : null;
      } catch {
        metadata = null;
      }
      return {
        id: a.id,
        actorType: a.actorType,
        actorId: a.actorId,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        metadata,
        createdAt: toIso(a.createdAt),
      };
    }),
  );
});
