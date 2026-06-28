import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  clients,
  projects,
  projectTasks,
  projectMilestones,
} from '../db/schema.js';
import { ok, created } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { aiLimiter } from '../middleware/rate-limit.js';
import { getAuth } from '../middleware/tenant.js';
import {
  DOCUMENT_TYPES,
  REPURPOSE_TARGETS,
  generateChatReply,
  generateDocument,
  generateTaskBreakdown,
  generateCaptions,
  generateHashtags,
  generateContentIdeas,
  repurposeContent,
} from '../services/ai.js';
import { audit } from '../services/audit.js';

/**
 * Agency-level AI assistant router. Distinct from the client-scoped
 * '/clients/:clientId/ai' router (content-calendar generation). Everything
 * here is requireAuth + agency-scoped via getAuth(req).agencyId.
 *
 * All endpoints degrade gracefully without GEMINI_API_KEY (the service layer
 * returns templates / canned replies), so they never 500 on a missing key.
 */
export const aiAssistantRouter = Router({ mergeParams: true });
aiAssistantRouter.use(requireAuth);
aiAssistantRouter.use(requireModuleRW('ai'));

const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
] as const;
const TASK_STATUS_SET = new Set<string>(TASK_STATUSES);

/**
 * Resolve an optional clientId to its name, scoped to the caller's agency.
 * Returns undefined when no id is given or the client isn't in this agency —
 * the social helpers treat the brand name as optional grounding, so a missing
 * client should never 404; it just drops the grounding.
 */
async function resolveClientName(
  ctx: ReturnType<typeof getAuth>,
  clientId?: string,
): Promise<string | undefined> {
  if (!clientId) return undefined;
  const [row] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);
  return row?.name;
}

/** Fetch a project scoped to the caller's agency, or throw 404. */
async function getScopedProjectRow(
  ctx: ReturnType<typeof getAuth>,
  projectId: string,
) {
  const [row] = await db
    .select()
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.agencyId, ctx.agencyId)),
    )
    .limit(1);
  if (!row) throw notFound('Project not found.');
  return row;
}

// ============================================================
//  POST /ai/generate-document
// ============================================================
const generateDocumentSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  title: z.string().max(200).optional(),
  context: z.string().min(1).max(10000),
});

aiAssistantRouter.post('/generate-document', aiLimiter, async (req, res) => {
  const ctx = getAuth(req);
  const body = generateDocumentSchema.parse(req.body);

  const result = await generateDocument({
    type: body.type,
    title: body.title,
    context: body.context,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'ai.generate_document',
    entityType: 'ai_document',
    entityId: body.type,
    metadata: { type: body.type, source: result.source },
    ip: req.ip,
  });

  ok(res, { title: result.title, content: result.content });
});

// ============================================================
//  POST /ai/chat
// ============================================================
const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(10000),
      }),
    )
    .min(1),
  projectId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
});

/** Build a short grounding context string for the chat system prompt. */
async function buildChatContext(
  ctx: ReturnType<typeof getAuth>,
  projectId?: string,
  clientId?: string,
): Promise<string> {
  const lines: string[] = [];

  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, ctx.agencyId))
    .limit(1);
  lines.push(`Agency: ${agency?.name ?? 'Unknown'}.`);

  const projectRows = await db
    .select({ name: projects.name, status: projects.status })
    .from(projects)
    .where(eq(projects.agencyId, ctx.agencyId))
    .orderBy(asc(projects.createdAt))
    .limit(10);
  if (projectRows.length) {
    lines.push(
      `Projects (${projectRows.length}): ` +
        projectRows.map((p) => `${p.name} [${p.status}]`).join('; ') +
        '.',
    );
  }

  const clientRows = await db
    .select({ name: clients.name, status: clients.status })
    .from(clients)
    .where(eq(clients.agencyId, ctx.agencyId))
    .orderBy(asc(clients.createdAt))
    .limit(10);
  if (clientRows.length) {
    lines.push(
      `Clients (${clientRows.length}): ` +
        clientRows.map((c) => `${c.name} [${c.status}]`).join('; ') +
        '.',
    );
  }

  if (projectId) {
    const [proj] = await db
      .select({
        name: projects.name,
        description: projects.description,
      })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.agencyId, ctx.agencyId),
        ),
      )
      .limit(1);
    if (proj) {
      const milestoneRows = await db
        .select({ title: projectMilestones.title })
        .from(projectMilestones)
        .where(
          and(
            eq(projectMilestones.agencyId, ctx.agencyId),
            eq(projectMilestones.projectId, projectId),
          ),
        )
        .orderBy(asc(projectMilestones.position))
        .limit(20);
      const [{ total, done } = { total: 0, done: 0 }] = await db
        .select({
          total: sql<number>`count(*)`,
          done: sql<number>`sum(case when ${projectTasks.status} = 'done' then 1 else 0 end)`,
        })
        .from(projectTasks)
        .where(
          and(
            eq(projectTasks.agencyId, ctx.agencyId),
            eq(projectTasks.projectId, projectId),
          ),
        );
      lines.push(
        `Focused project: ${proj.name}.` +
          (proj.description ? ` Description: ${proj.description}.` : '') +
          (milestoneRows.length
            ? ` Milestones: ${milestoneRows.map((m) => m.title).join('; ')}.`
            : '') +
          ` Tasks: ${Number(done ?? 0)}/${Number(total ?? 0)} done.`,
      );
    }
  }

  if (clientId) {
    const [client] = await db
      .select({
        name: clients.name,
        status: clients.status,
        industry: clients.industry,
        website: clients.website,
        relationshipHealth: clients.relationshipHealth,
        internalNotes: clients.internalNotes,
      })
      .from(clients)
      .where(
        and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)),
      )
      .limit(1);
    if (client) {
      lines.push(
        `Focused client: ${client.name} [${client.status}].` +
          (client.industry ? ` Industry: ${client.industry}.` : '') +
          (client.website ? ` Website: ${client.website}.` : '') +
          (client.relationshipHealth
            ? ` Relationship health: ${client.relationshipHealth}.`
            : '') +
          (client.internalNotes ? ` Notes: ${client.internalNotes}.` : ''),
      );
    }
  }

  return lines.join('\n');
}

aiAssistantRouter.post('/chat', aiLimiter, async (req, res) => {
  const ctx = getAuth(req);
  const body = chatSchema.parse(req.body);

  if (body.projectId) {
    // Validate scope; throws 404 if the project isn't in this agency.
    await getScopedProjectRow(ctx, body.projectId);
  }

  const systemContext = await buildChatContext(
    ctx,
    body.projectId,
    body.clientId,
  );
  const result = await generateChatReply({
    systemContext,
    messages: body.messages,
  });

  ok(res, { reply: result.reply, source: result.source });
});

// ============================================================
//  POST /ai/task-breakdown
// ============================================================
const taskBreakdownSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().max(5000).optional(),
});

aiAssistantRouter.post('/task-breakdown', aiLimiter, async (req, res) => {
  const ctx = getAuth(req);
  const body = taskBreakdownSchema.parse(req.body);
  const project = await getScopedProjectRow(ctx, body.projectId);

  const result = await generateTaskBreakdown({
    projectName: project.name,
    projectDescription: project.description,
    prompt: body.prompt,
  });

  // Position new milestones / tasks after any existing ones in the project.
  const [{ maxMsPos } = { maxMsPos: null }] = await db
    .select({ maxMsPos: sql<number | null>`max(${projectMilestones.position})` })
    .from(projectMilestones)
    .where(
      and(
        eq(projectMilestones.agencyId, ctx.agencyId),
        eq(projectMilestones.projectId, body.projectId),
      ),
    );
  let milestonePosition = (maxMsPos ?? -1) + 1;

  const [{ maxTaskPos } = { maxTaskPos: null }] = await db
    .select({ maxTaskPos: sql<number | null>`max(${projectTasks.position})` })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.projectId, body.projectId),
      ),
    );
  let taskPosition = (maxTaskPos ?? -1) + 1;

  const createdMilestones: Array<{
    id: string;
    title: string;
    position: number;
    tasks: Array<{
      id: string;
      title: string;
      status: string;
      position: number;
    }>;
  }> = [];

  for (const ms of result.milestones) {
    const milestoneId = newId('pms');
    await db.insert(projectMilestones).values({
      id: milestoneId,
      agencyId: ctx.agencyId,
      projectId: body.projectId,
      title: ms.title,
      position: milestonePosition++,
    });

    const tasks: Array<{
      id: string;
      title: string;
      status: string;
      position: number;
    }> = [];
    for (const tk of ms.tasks) {
      const taskId = newId('ptk');
      const status =
        tk.status && TASK_STATUS_SET.has(tk.status) ? tk.status : 'todo';
      const position = taskPosition++;
      await db.insert(projectTasks).values({
        id: taskId,
        agencyId: ctx.agencyId,
        projectId: body.projectId,
        milestoneId,
        title: tk.title,
        status: status as (typeof TASK_STATUSES)[number],
        position,
      });
      tasks.push({ id: taskId, title: tk.title, status, position });
    }

    createdMilestones.push({
      id: milestoneId,
      title: ms.title,
      position: milestonePosition - 1,
      tasks,
    });
  }

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'ai.task_breakdown',
    entityType: 'project',
    entityId: body.projectId,
    metadata: {
      source: result.source,
      milestonesCreated: createdMilestones.length,
      tasksCreated: createdMilestones.reduce(
        (n, m) => n + m.tasks.length,
        0,
      ),
    },
    ip: req.ip,
  });

  created(res, {
    projectId: body.projectId,
    source: result.source,
    milestones: createdMilestones,
  });
});

// ============================================================
//  POST /ai/captions — write/rewrite caption variations
// ============================================================
const captionsSchema = z.object({
  brief: z.string().min(1).max(5000),
  platform: z.string().min(1).max(40).default('instagram'),
  tone: z.string().max(40).optional(),
  rewrite: z.boolean().default(false),
  clientId: z.string().min(1).optional(),
  variations: z.number().int().min(1).max(5).optional(),
});

aiAssistantRouter.post('/captions', aiLimiter, async (req, res) => {
  const ctx = getAuth(req);
  const body = captionsSchema.parse(req.body);
  const brandName = await resolveClientName(ctx, body.clientId);

  const result = await generateCaptions({
    brief: body.brief,
    platform: body.platform,
    tone: body.tone,
    rewrite: body.rewrite,
    brandName,
    variations: body.variations,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'ai.captions',
    entityType: 'ai_caption',
    entityId: body.platform,
    metadata: {
      source: result.source,
      platform: body.platform,
      rewrite: body.rewrite,
      count: result.variations.length,
    },
    ip: req.ip,
  });

  ok(res, { variations: result.variations, source: result.source });
});

// ============================================================
//  POST /ai/hashtags — grouped hashtag suggestions
// ============================================================
const hashtagsSchema = z.object({
  topic: z.string().min(1).max(5000),
  platform: z.string().min(1).max(40).default('instagram'),
  clientId: z.string().min(1).optional(),
});

aiAssistantRouter.post('/hashtags', aiLimiter, async (req, res) => {
  const ctx = getAuth(req);
  const body = hashtagsSchema.parse(req.body);
  const brandName = await resolveClientName(ctx, body.clientId);

  const result = await generateHashtags({
    topic: body.topic,
    platform: body.platform,
    brandName,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'ai.hashtags',
    entityType: 'ai_hashtags',
    entityId: body.platform,
    metadata: { source: result.source, platform: body.platform },
    ip: req.ip,
  });

  ok(res, { groups: result.groups, source: result.source });
});

// ============================================================
//  POST /ai/content-ideas — brainstorm post ideas
// ============================================================
const contentIdeasSchema = z.object({
  niche: z.string().min(1).max(2000),
  count: z.number().int().min(1).max(12).optional(),
  platform: z.string().max(40).optional(),
  audience: z.string().max(500).optional(),
  clientId: z.string().min(1).optional(),
});

aiAssistantRouter.post('/content-ideas', aiLimiter, async (req, res) => {
  const ctx = getAuth(req);
  const body = contentIdeasSchema.parse(req.body);
  // If a clientId is given, prefer its name as the niche grounding.
  const brandName = await resolveClientName(ctx, body.clientId);

  const result = await generateContentIdeas({
    niche: brandName ? `${brandName} (${body.niche})` : body.niche,
    count: body.count,
    platform: body.platform,
    audience: body.audience,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'ai.content_ideas',
    entityType: 'ai_ideas',
    entityId: body.platform ?? 'all',
    metadata: { source: result.source, count: result.ideas.length },
    ip: req.ip,
  });

  ok(res, { ideas: result.ideas, source: result.source });
});

// ============================================================
//  POST /ai/repurpose — adapt content for another platform
// ============================================================
const repurposeSchema = z.object({
  content: z.string().min(1).max(10000),
  target: z.enum(REPURPOSE_TARGETS),
  tone: z.string().max(40).optional(),
  clientId: z.string().min(1).optional(),
});

aiAssistantRouter.post('/repurpose', aiLimiter, async (req, res) => {
  const ctx = getAuth(req);
  const body = repurposeSchema.parse(req.body);
  const brandName = await resolveClientName(ctx, body.clientId);

  const result = await repurposeContent({
    content: body.content,
    target: body.target,
    tone: body.tone,
    brandName,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'ai.repurpose',
    entityType: 'ai_repurpose',
    entityId: body.target,
    metadata: { source: result.source, target: body.target },
    ip: req.ip,
  });

  ok(res, {
    content: result.content,
    targetLabel: result.targetLabel,
    source: result.source,
  });
});
