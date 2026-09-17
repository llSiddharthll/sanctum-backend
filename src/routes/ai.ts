import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  aiGenerations,
  brandStrategy,
  clients,
  contentPosts,
  plans,
  subscriptions,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId, currentPeriod } from '../lib/ids.js';
import { notFound, quotaExceeded } from '../lib/errors.js';
import { aiLimiter } from '../middleware/rate-limit.js';
import { generateMonth } from '../services/ai.js';
import { audit } from '../services/audit.js';
import { authenticate, getStaffActor, requires, requiresAny } from '../authz/http.js';
import { authorize, check } from '../authz/engine.js';
import { clientFacts } from '../authz/policies/clients.js';

/**
 * Client-scoped AI (content calendar generation), mounted at
 * /clients/:clientId/ai. Authorizes itself: the URL client must be in the
 * actor's scope for ai.generate_content (and posts.create, since drafts are
 * written into the calendar).
 */
export const aiRouter = Router({ mergeParams: true });
aiRouter.use(authenticate);

/** Start of the current (UTC) calendar month — the quota period. */
function periodStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
/** A pending run older than this is treated as crashed and stops counting. */
const PENDING_COUNTS_MS = 15 * 60_000;

const POST_TYPES = ['reel', 'story', 'carousel', 'post'] as const;

const generateSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  postsCount: z.number().int().min(1).max(31).default(12),
  postTypes: z.array(z.enum(POST_TYPES)).min(1).default(['post']),
  platforms: z.array(z.string()).min(1).default(['instagram']),
  useStoredStrategy: z.boolean().default(true),
  tone: z.string().optional(),
  audience: z.string().optional(),
  pillars: z.array(z.string()).optional(),
  dos: z.string().optional(),
  donts: z.string().optional(),
  extraNotes: z.string().optional(),
});

// POST /clients/:clientId/ai/generate-month
aiRouter.post('/generate-month', requires('ai.generate_content', 'posts.create'), aiLimiter, async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const facts = await clientFacts(ctx, clientId);
  // Cross-module: generating writes draft posts → both permissions on the client.
  authorize(ctx, 'ai.generate_content', facts, { view: 'clients.view' });
  authorize(ctx, 'posts.create', facts, { view: 'clients.view' });
  const [client] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);
  if (!client) throw notFound('Client not found.');
  const body = generateSchema.parse(req.body);

  // Note: AI generation never returns 501. When no Gemini key is configured,
  // services/ai.ts produces deterministic fallback drafts instead.

  // ---- Per-plan monthly quota: runs STARTED in the current billing period,
  // whatever month they generate for (keying on the requested month let callers
  // reset the limit). In-flight runs count too, so concurrent requests can't
  // all pass the check. ----
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.agencyId, ctx.agencyId))
    .limit(1);
  let limit: number | null = null;
  if (sub) {
    const [plan] = await db
      .select()
      .from(plans)
      .where(eq(plans.id, sub.planId))
      .limit(1);
    limit = plan?.maxAiGenerations ?? null;
  }
  if (limit != null) {
    const runs = await db
      .select({ id: aiGenerations.id })
      .from(aiGenerations)
      .where(
        and(
          eq(aiGenerations.agencyId, ctx.agencyId),
          gte(aiGenerations.createdAt, periodStart()),
          or(
            eq(aiGenerations.status, 'succeeded'),
            and(
              inArray(aiGenerations.status, ['pending']),
              gte(aiGenerations.createdAt, new Date(Date.now() - PENDING_COUNTS_MS)),
            ),
          ),
        ),
      );
    if (runs.length >= limit) {
      throw quotaExceeded('Monthly AI generation limit reached.', {
        resource: 'ai_generations',
        limit,
        used: runs.length,
        period: currentPeriod(),
      });
    }
  }

  // Merge stored brand strategy if requested.
  let stored:
    | {
        tone: string | null;
        audience: string | null;
        pillarsJson: string | null;
        dos: string | null;
        donts: string | null;
      }
    | undefined;
  if (body.useStoredStrategy) {
    const [row] = await db
      .select()
      .from(brandStrategy)
      .where(
        and(
          eq(brandStrategy.agencyId, ctx.agencyId),
          eq(brandStrategy.clientId, clientId),
        ),
      )
      .limit(1);
    stored = row;
  }
  const storedPillars = stored?.pillarsJson
    ? (JSON.parse(stored.pillarsJson) as string[])
    : undefined;

  // Record a pending generation row.
  const genId = newId('aig');
  await db.insert(aiGenerations).values({
    id: genId,
    agencyId: ctx.agencyId,
    clientId,
    requestedBy: ctx.userId,
    period: body.month,
    status: 'pending',
    promptSummary: `${body.postsCount} posts for ${body.month}`,
  });

  try {
    const result = await generateMonth({
      month: body.month,
      postsCount: body.postsCount,
      postTypes: body.postTypes,
      platforms: body.platforms,
      clientName: client.name,
      tone: body.tone ?? stored?.tone ?? undefined,
      audience: body.audience ?? stored?.audience ?? undefined,
      pillars: body.pillars ?? storedPillars,
      dos: body.dos ?? stored?.dos ?? undefined,
      donts: body.donts ?? stored?.donts ?? undefined,
      extraNotes: body.extraNotes,
    });

    // Persist generated posts as drafts.
    const [year, mon] = body.month.split('-').map(Number);
    const createdPosts = [];
    for (const gp of result.posts) {
      const id = newId('post');
      const scheduledAt = new Date(
        Date.UTC(year!, mon! - 1, gp.dayOfMonth, 9, 0, 0),
      );
      await db.insert(contentPosts).values({
        id,
        agencyId: ctx.agencyId,
        clientId,
        postType: gp.postType,
        caption: gp.caption,
        platformsJson: JSON.stringify(gp.platforms),
        scheduledAt,
        status: 'draft',
        createdBy: ctx.userId,
        aiGenerationId: genId,
      });
      createdPosts.push({
        id,
        postType: gp.postType,
        caption: gp.caption,
        platforms: gp.platforms,
        scheduledAt: scheduledAt.toISOString(),
        status: 'draft',
        pillar: gp.pillar ?? null,
        aiGenerationId: genId,
      });
    }

    await db
      .update(aiGenerations)
      .set({
        status: 'succeeded',
        model: result.model,
        postsCreated: createdPosts.length,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        completedAt: new Date(),
      })
      .where(eq(aiGenerations.id, genId));

    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.type,
      actorId: ctx.userId,
      action: 'ai.generate_month',
      entityType: 'ai_generation',
      entityId: genId,
      metadata: {
        postsCreated: createdPosts.length,
        month: body.month,
        source: result.source,
      },
      ip: req.ip,
    });

    created(res, {
      generationId: genId,
      clientId,
      month: body.month,
      model: result.model,
      source: result.source,
      status: 'succeeded',
      postsCreated: createdPosts.length,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
      posts: createdPosts,
    });
  } catch (err) {
    // On failure, mark the run failed — quota is NOT consumed.
    await db
      .update(aiGenerations)
      .set({
        status: 'failed',
        error: err instanceof Error ? err.message : 'unknown',
        completedAt: new Date(),
      })
      .where(eq(aiGenerations.id, genId));
    throw err;
  }
});

// GET /clients/:clientId/ai/generations
aiRouter.get('/generations', requiresAny('ai.generate_content', 'posts.view'), async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const facts = await clientFacts(ctx, clientId);
  if (!check(ctx, 'ai.generate_content', facts)) {
    authorize(ctx, 'posts.view', facts, { view: 'clients.view' });
  }

  const rows = await db
    .select()
    .from(aiGenerations)
    .where(
      and(
        eq(aiGenerations.agencyId, ctx.agencyId),
        eq(aiGenerations.clientId, clientId),
      ),
    )
    .orderBy(desc(aiGenerations.createdAt))
    .limit(50);

  ok(
    res,
    rows.map((g) => ({
      id: g.id,
      period: g.period,
      status: g.status,
      model: g.model,
      postsCreated: g.postsCreated,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      createdAt: toIso(g.createdAt),
      completedAt: toIso(g.completedAt),
    })),
  );
});
