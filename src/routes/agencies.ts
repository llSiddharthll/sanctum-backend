import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
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
import { notFound } from '../lib/errors.js';
import { currentPeriod } from '../lib/ids.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getAuth } from '../middleware/tenant.js';
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
    status: agency.status,
  });
});

// PATCH /agency — owner/admin edit branding.
const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  logoUrl: z.string().url().nullable().optional(),
  brandColor: z.string().max(20).nullable().optional(),
});

agenciesRouter.patch('/', requireRole('owner', 'admin'), async (req, res) => {
  const ctx = getAuth(req);
  const body = patchSchema.parse(req.body);
  const patch: Partial<typeof agencies.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.logoUrl !== undefined) patch.logoUrl = body.logoUrl;
  if (body.brandColor !== undefined) patch.brandColor = body.brandColor;

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
