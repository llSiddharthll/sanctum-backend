import { Router } from 'express';
import { z } from 'zod';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  like,
  or,
  sql,
} from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  auditLog,
  clients,
  projects,
  projectTasks,
  projectMilestones,
  projectMembers,
  projectTaskLabels,
  projectTaskLabelLinks,
  projectTaskDependencies,
  projectTaskComments,
  taskAssignees,
  timeLogs,
  timers,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { AppError, notFound, conflict, forbidden } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import { listProjectTimers } from './timers.js';

// mergeParams keeps any parent params available (none today, but consistent
// with the other nested routers).
export const projectsRouter = Router({ mergeParams: true });
projectsRouter.use(requireAuth);
projectsRouter.use(requireModuleRW('projects'));

const PROJECT_TYPES = [
  'fixed_price',
  'retainer',
  'hourly',
  'milestone_based',
] as const;
const PROJECT_STATUSES = [
  'planning',
  'active',
  'on_hold',
  'completed',
  'cancelled',
] as const;
const PROJECT_HEALTH = ['on_track', 'at_risk', 'off_track'] as const;
const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
] as const;
const MILESTONE_STATUSES = ['pending', 'completed'] as const;
const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
const LABEL_COLORS = [
  'pine',
  'brass',
  'sky',
  'rose',
  'amber',
  'violet',
  'slate',
] as const;

// ---- Correlated count subqueries (tenant-implied via project FK) ----
const tasksTotalSq = sql<number>`(
  select count(*) from ${projectTasks}
  where ${projectTasks.projectId} = ${projects.id}
)`;
const tasksDoneSq = sql<number>`(
  select count(*) from ${projectTasks}
  where ${projectTasks.projectId} = ${projects.id}
    and ${projectTasks.status} = 'done'
)`;
const milestonesTotalSq = sql<number>`(
  select count(*) from ${projectMilestones}
  where ${projectMilestones.projectId} = ${projects.id}
)`;
const milestonesDoneSq = sql<number>`(
  select count(*) from ${projectMilestones}
  where ${projectMilestones.projectId} = ${projects.id}
    and ${projectMilestones.status} = 'completed'
)`;
const memberCountSq = sql<number>`(
  select count(*) from ${projectMembers}
  where ${projectMembers.projectId} = ${projects.id}
)`;

const projectSelection = {
  id: projects.id,
  clientId: projects.clientId,
  name: projects.name,
  description: projects.description,
  type: projects.type,
  status: projects.status,
  health: projects.health,
  contractValue: projects.contractValue,
  currency: projects.currency,
  startDate: projects.startDate,
  deadline: projects.deadline,
  createdBy: projects.createdBy,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
  clientName: clients.name,
  tasksTotal: tasksTotalSq,
  tasksDone: tasksDoneSq,
  milestonesTotal: milestonesTotalSq,
  milestonesDone: milestonesDoneSq,
  memberCount: memberCountSq,
};

type ProjectRow = {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  health: string;
  contractValue: number | null;
  currency: string;
  startDate: Date | null;
  deadline: Date | null;
  createdBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  clientName: string | null;
  tasksTotal: number;
  tasksDone: number;
  milestonesTotal: number;
  milestonesDone: number;
  memberCount: number;
};

function serializeProject(p: ProjectRow) {
  return {
    id: p.id,
    clientId: p.clientId,
    clientName: p.clientName,
    name: p.name,
    description: p.description,
    type: p.type,
    status: p.status,
    health: p.health,
    contractValue: p.contractValue ?? 0,
    currency: p.currency,
    startDate: toIso(p.startDate),
    deadline: toIso(p.deadline),
    tasksTotal: Number(p.tasksTotal ?? 0),
    tasksDone: Number(p.tasksDone ?? 0),
    milestonesTotal: Number(p.milestonesTotal ?? 0),
    milestonesDone: Number(p.milestonesDone ?? 0),
    memberCount: Number(p.memberCount ?? 0),
    createdBy: p.createdBy,
    createdAt: toIso(p.createdAt),
    updatedAt: toIso(p.updatedAt),
  };
}

function serializeTask(tk: typeof projectTasks.$inferSelect) {
  return {
    id: tk.id,
    projectId: tk.projectId,
    milestoneId: tk.milestoneId,
    title: tk.title,
    description: tk.description,
    status: tk.status,
    assigneeId: tk.assigneeId,
    priority: tk.priority,
    estimateMinutes: tk.estimateMinutes,
    startDate: toIso(tk.startDate),
    dueDate: toIso(tk.dueDate),
    completedAt: toIso(tk.completedAt),
    parentTaskId: tk.parentTaskId,
    position: tk.position,
    createdAt: toIso(tk.createdAt),
    updatedAt: toIso(tk.updatedAt),
  };
}

/** A label as returned to the client. */
function serializeLabel(l: typeof projectTaskLabels.$inferSelect) {
  return {
    id: l.id,
    projectId: l.projectId,
    name: l.name,
    color: l.color,
    createdAt: toIso(l.createdAt),
  };
}

type SerializedLabel = ReturnType<typeof serializeLabel>;
type SerializedTask = ReturnType<typeof serializeTask>;

/** A single assignee as returned to the client. */
type Assignee = { userId: string; name: string };

/** A task enriched with computed list-view fields. */
type EnrichedTask = SerializedTask & {
  assignees: Assignee[];
  labels: SerializedLabel[];
  subtaskCount: number;
  subtaskDoneCount: number;
  blockedByCount: number;
  commentCount: number;
};

/**
 * Bulk-load the assignees for a set of tasks and fold them onto each row as an
 * `assignees: { userId, name }[]` array (empty when none). One query joining
 * task_assignees -> users keeps this O(1) regardless of task count.
 */
async function attachAssignees<T extends { id: string }>(
  agencyId: string,
  tasks: T[],
): Promise<(T & { assignees: Assignee[] })[]> {
  const ids = tasks.map((t) => t.id);
  if (ids.length === 0) {
    return tasks.map((t) => ({ ...t, assignees: [] as Assignee[] }));
  }

  const rows = await db
    .select({
      taskId: taskAssignees.taskId,
      userId: taskAssignees.userId,
      name: users.fullName,
    })
    .from(taskAssignees)
    .innerJoin(users, eq(users.id, taskAssignees.userId))
    .where(
      and(
        eq(taskAssignees.agencyId, agencyId),
        inArray(taskAssignees.taskId, ids),
      ),
    )
    .orderBy(asc(taskAssignees.createdAt));

  const byTask = new Map<string, Assignee[]>();
  for (const r of rows) {
    const list = byTask.get(r.taskId) ?? [];
    list.push({ userId: r.userId, name: r.name ?? 'Member' });
    byTask.set(r.taskId, list);
  }

  return tasks.map((t) => ({ ...t, assignees: byTask.get(t.id) ?? [] }));
}

/**
 * Replace the assignee set for a task with `userIds` (deduped) inside the
 * caller's agency: clears existing rows then inserts the new ones. Used by the
 * create + update handlers to keep the join table in sync with the primary
 * `assigneeId` mirror.
 */
async function syncTaskAssignees(
  agencyId: string,
  taskId: string,
  userIds: string[],
): Promise<void> {
  await db
    .delete(taskAssignees)
    .where(
      and(
        eq(taskAssignees.agencyId, agencyId),
        eq(taskAssignees.taskId, taskId),
      ),
    );
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await db.insert(taskAssignees).values(
    unique.map((userId) => ({
      id: newId('tas'),
      agencyId,
      taskId,
      userId,
    })),
  );
}

/**
 * Bulk-load enrichment (labels, subtask counts, blocked-by, comments) for a
 * set of tasks and fold it onto the serialized rows. One query per facet keeps
 * this O(facets) rather than O(rows).
 */
async function enrichTasks(
  agencyId: string,
  rows: (typeof projectTasks.$inferSelect)[],
): Promise<EnrichedTask[]> {
  const ids = rows.map((r) => r.id);
  const base = rows.map(serializeTask);
  if (ids.length === 0) {
    return base.map((t) => ({
      ...t,
      assignees: [] as Assignee[],
      labels: [],
      subtaskCount: 0,
      subtaskDoneCount: 0,
      blockedByCount: 0,
      commentCount: 0,
    }));
  }

  // Labels (joined through the link table), grouped by task.
  const labelRows = await db
    .select({
      taskId: projectTaskLabelLinks.taskId,
      id: projectTaskLabels.id,
      projectId: projectTaskLabels.projectId,
      name: projectTaskLabels.name,
      color: projectTaskLabels.color,
      createdAt: projectTaskLabels.createdAt,
    })
    .from(projectTaskLabelLinks)
    .innerJoin(
      projectTaskLabels,
      eq(projectTaskLabels.id, projectTaskLabelLinks.labelId),
    )
    .where(
      and(
        eq(projectTaskLabelLinks.agencyId, agencyId),
        inArray(projectTaskLabelLinks.taskId, ids),
      ),
    )
    .orderBy(asc(projectTaskLabels.name));

  const labelsByTask = new Map<string, SerializedLabel[]>();
  for (const lr of labelRows) {
    const list = labelsByTask.get(lr.taskId) ?? [];
    list.push({
      id: lr.id,
      projectId: lr.projectId,
      name: lr.name,
      color: lr.color,
      createdAt: toIso(lr.createdAt),
    });
    labelsByTask.set(lr.taskId, list);
  }

  // Subtask totals + done counts, grouped by parent.
  const subtaskRows = await db
    .select({
      parentTaskId: projectTasks.parentTaskId,
      total: sql<number>`count(*)`,
      done: sql<number>`sum(case when ${projectTasks.status} = 'done' then 1 else 0 end)`,
    })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, agencyId),
        inArray(projectTasks.parentTaskId, ids),
      ),
    )
    .groupBy(projectTasks.parentTaskId);

  const subtaskByParent = new Map<
    string,
    { total: number; done: number }
  >();
  for (const sr of subtaskRows) {
    if (sr.parentTaskId)
      subtaskByParent.set(sr.parentTaskId, {
        total: Number(sr.total ?? 0),
        done: Number(sr.done ?? 0),
      });
  }

  // Blocked-by counts (this task is the blocked side of an edge).
  const blockedRows = await db
    .select({
      blockedTaskId: projectTaskDependencies.blockedTaskId,
      total: sql<number>`count(*)`,
    })
    .from(projectTaskDependencies)
    .where(
      and(
        eq(projectTaskDependencies.agencyId, agencyId),
        inArray(projectTaskDependencies.blockedTaskId, ids),
      ),
    )
    .groupBy(projectTaskDependencies.blockedTaskId);

  const blockedByTask = new Map<string, number>();
  for (const br of blockedRows) {
    blockedByTask.set(br.blockedTaskId, Number(br.total ?? 0));
  }

  // Comment counts (non-deleted only).
  const commentRows = await db
    .select({
      taskId: projectTaskComments.taskId,
      total: sql<number>`count(*)`,
    })
    .from(projectTaskComments)
    .where(
      and(
        eq(projectTaskComments.agencyId, agencyId),
        inArray(projectTaskComments.taskId, ids),
        isNull(projectTaskComments.deletedAt),
      ),
    )
    .groupBy(projectTaskComments.taskId);

  const commentsByTask = new Map<string, number>();
  for (const cr of commentRows) {
    commentsByTask.set(cr.taskId, Number(cr.total ?? 0));
  }

  // Assignees (joined through the M:N table), grouped by task.
  const withAssignees = await attachAssignees(agencyId, base);
  const assigneesByTask = new Map<string, Assignee[]>(
    withAssignees.map((t) => [t.id, t.assignees]),
  );

  return base.map((t) => {
    const sub = subtaskByParent.get(t.id);
    return {
      ...t,
      assignees: assigneesByTask.get(t.id) ?? [],
      labels: labelsByTask.get(t.id) ?? [],
      subtaskCount: sub?.total ?? 0,
      subtaskDoneCount: sub?.done ?? 0,
      blockedByCount: blockedByTask.get(t.id) ?? 0,
      commentCount: commentsByTask.get(t.id) ?? 0,
    };
  });
}

function serializeMilestone(m: typeof projectMilestones.$inferSelect) {
  return {
    id: m.id,
    projectId: m.projectId,
    title: m.title,
    description: m.description,
    dueDate: toIso(m.dueDate),
    status: m.status,
    completedAt: toIso(m.completedAt),
    position: m.position,
    createdAt: toIso(m.createdAt),
    updatedAt: toIso(m.updatedAt),
  };
}

/** Fetch a project (with computed counts) scoped to the caller's agency. */
async function getScopedProject(
  ctx: ReturnType<typeof getAuth>,
  projectId: string,
): Promise<ProjectRow> {
  const [row] = await db
    .select(projectSelection)
    .from(projects)
    .leftJoin(clients, eq(clients.id, projects.clientId))
    .where(
      and(eq(projects.id, projectId), eq(projects.agencyId, ctx.agencyId)),
    )
    .limit(1);
  if (!row) throw notFound('Project not found.');
  return row as ProjectRow;
}

/** Verify a client belongs to the caller's agency, or throw 404. */
async function requireAgencyClient(
  ctx: ReturnType<typeof getAuth>,
  clientId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);
  if (!row) throw notFound('Client not found.');
}

/** Verify a user belongs to the caller's agency, or throw 404. */
async function requireAgencyUser(
  ctx: ReturnType<typeof getAuth>,
  userId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.agencyId, ctx.agencyId)))
    .limit(1);
  if (!row) throw notFound('User not found.');
}

// ============================================================
//  PROJECTS
// ============================================================

// GET /projects?status=&health=&clientId=&search=
const listQuery = z.object({
  status: z.enum(PROJECT_STATUSES).optional(),
  health: z.enum(PROJECT_HEALTH).optional(),
  clientId: z.string().optional(),
  search: z.string().optional(),
});

projectsRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const q = listQuery.parse(req.query);

  const filters = [eq(projects.agencyId, ctx.agencyId)];
  if (q.status) filters.push(eq(projects.status, q.status));
  if (q.health) filters.push(eq(projects.health, q.health));
  if (q.clientId) filters.push(eq(projects.clientId, q.clientId));
  if (q.search && q.search.trim()) {
    filters.push(like(projects.name, `%${q.search.trim()}%`));
  }

  const rows = await db
    .select(projectSelection)
    .from(projects)
    .leftJoin(clients, eq(clients.id, projects.clientId))
    .where(and(...filters))
    .orderBy(asc(projects.createdAt));

  ok(res, (rows as ProjectRow[]).map(serializeProject));
});

// POST /projects
const createSchema = z.object({
  name: z.string().min(1).max(160),
  clientId: z.string().min(1),
  description: z.string().max(5000).optional(),
  type: z.enum(PROJECT_TYPES).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  health: z.enum(PROJECT_HEALTH).optional(),
  contractValue: z.number().int().min(0).optional(),
  currency: z.string().trim().max(8).optional(),
  startDate: z.coerce.date().optional(),
  deadline: z.coerce.date().optional(),
});

projectsRouter.post('/', async (req, res) => {
  const ctx = getAuth(req);
  const body = createSchema.parse(req.body);
  await requireAgencyClient(ctx, body.clientId);

  const id = newId('prj');
  await db.insert(projects).values({
    id,
    agencyId: ctx.agencyId,
    clientId: body.clientId,
    name: body.name,
    description: body.description ?? null,
    ...(body.type !== undefined ? { type: body.type } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.health !== undefined ? { health: body.health } : {}),
    ...(body.contractValue !== undefined
      ? { contractValue: body.contractValue }
      : {}),
    ...(body.currency !== undefined ? { currency: body.currency } : {}),
    startDate: body.startDate ?? null,
    deadline: body.deadline ?? null,
    createdBy: ctx.userId,
  });

  // The creator is automatically an 'owner' member of the project.
  await db.insert(projectMembers).values({
    id: newId('prm'),
    agencyId: ctx.agencyId,
    projectId: id,
    userId: ctx.userId,
    role: 'owner',
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'project.create',
    entityType: 'project',
    entityId: id,
    metadata: { projectId: id, name: body.name },
    ip: req.ip,
  });

  const row = await getScopedProject(ctx, id);
  created(res, serializeProject(row));
});

// GET /projects/:id
projectsRouter.get('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const row = await getScopedProject(ctx, param(req, 'id'));
  ok(res, serializeProject(row));
});

// PATCH /projects/:id
const updateSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  clientId: z.string().min(1).optional(),
  description: z.string().max(5000).nullable().optional(),
  type: z.enum(PROJECT_TYPES).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  health: z.enum(PROJECT_HEALTH).optional(),
  contractValue: z.number().int().min(0).optional(),
  currency: z.string().trim().max(8).optional(),
  startDate: z.coerce.date().nullable().optional(),
  deadline: z.coerce.date().nullable().optional(),
});

projectsRouter.patch('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const body = updateSchema.parse(req.body);

  if (body.clientId !== undefined) {
    await requireAgencyClient(ctx, body.clientId);
  }

  const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.clientId !== undefined) patch.clientId = body.clientId;
  if (body.description !== undefined) patch.description = body.description;
  if (body.type !== undefined) patch.type = body.type;
  if (body.status !== undefined) patch.status = body.status;
  if (body.health !== undefined) patch.health = body.health;
  if (body.contractValue !== undefined)
    patch.contractValue = body.contractValue;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.startDate !== undefined) patch.startDate = body.startDate;
  if (body.deadline !== undefined) patch.deadline = body.deadline;

  await db
    .update(projects)
    .set(patch)
    .where(
      and(eq(projects.id, projectId), eq(projects.agencyId, ctx.agencyId)),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'project.update',
    entityType: 'project',
    entityId: projectId,
    metadata: {
      projectId,
      ...(body.status !== undefined ? { status: body.status } : {}),
    },
    ip: req.ip,
  });

  const row = await getScopedProject(ctx, projectId);
  ok(res, serializeProject(row));
});

// DELETE /projects/:id (children cascade)
projectsRouter.delete('/:id', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);

  await db
    .delete(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.agencyId, ctx.agencyId)),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'project.delete',
    entityType: 'project',
    entityId: projectId,
    metadata: { projectId },
    ip: req.ip,
  });
  ok(res, { deleted: true });
});

// ============================================================
//  LABELS (project-scoped task labels)  §3.1
// ============================================================

/** Fetch a label scoped to the project + agency, or throw 404. */
async function getScopedLabel(
  ctx: ReturnType<typeof getAuth>,
  projectId: string,
  labelId: string,
) {
  const [row] = await db
    .select()
    .from(projectTaskLabels)
    .where(
      and(
        eq(projectTaskLabels.id, labelId),
        eq(projectTaskLabels.agencyId, ctx.agencyId),
        eq(projectTaskLabels.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Label not found.');
  return row;
}

// GET /projects/:id/labels
projectsRouter.get('/:id/labels', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);

  const rows = await db
    .select()
    .from(projectTaskLabels)
    .where(
      and(
        eq(projectTaskLabels.agencyId, ctx.agencyId),
        eq(projectTaskLabels.projectId, projectId),
      ),
    )
    .orderBy(asc(projectTaskLabels.name));

  ok(res, rows.map(serializeLabel));
});

// POST /projects/:id/labels
const createLabelSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.enum(LABEL_COLORS).optional(),
});

projectsRouter.post('/:id/labels', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const body = createLabelSchema.parse(req.body);

  // Enforce per-project unique name (case-sensitive, matches the unique index).
  const [dup] = await db
    .select({ id: projectTaskLabels.id })
    .from(projectTaskLabels)
    .where(
      and(
        eq(projectTaskLabels.projectId, projectId),
        eq(projectTaskLabels.name, body.name),
      ),
    )
    .limit(1);
  if (dup) throw conflict('A label with that name already exists.');

  const id = newId('plb');
  await db.insert(projectTaskLabels).values({
    id,
    agencyId: ctx.agencyId,
    projectId,
    name: body.name,
    ...(body.color !== undefined ? { color: body.color } : {}),
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'label.create',
    entityType: 'label',
    entityId: id,
    metadata: { projectId, name: body.name, color: body.color ?? 'pine' },
    ip: req.ip,
  });

  const [row] = await db
    .select()
    .from(projectTaskLabels)
    .where(eq(projectTaskLabels.id, id));
  created(res, serializeLabel(row!));
});

// PATCH /projects/:id/labels/:labelId
const updateLabelSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: z.enum(LABEL_COLORS).optional(),
});

projectsRouter.patch('/:id/labels/:labelId', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const label = await getScopedLabel(ctx, projectId, param(req, 'labelId'));
  const body = updateLabelSchema.parse(req.body);

  if (body.name !== undefined && body.name !== label.name) {
    const [dup] = await db
      .select({ id: projectTaskLabels.id })
      .from(projectTaskLabels)
      .where(
        and(
          eq(projectTaskLabels.projectId, projectId),
          eq(projectTaskLabels.name, body.name),
        ),
      )
      .limit(1);
    if (dup) throw conflict('A label with that name already exists.');
  }

  const patch: Partial<typeof projectTaskLabels.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.color !== undefined) patch.color = body.color;

  if (Object.keys(patch).length > 0) {
    await db
      .update(projectTaskLabels)
      .set(patch)
      .where(
        and(
          eq(projectTaskLabels.id, label.id),
          eq(projectTaskLabels.agencyId, ctx.agencyId),
        ),
      );
  }

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'label.update',
    entityType: 'label',
    entityId: label.id,
    metadata: { projectId, ...patch },
    ip: req.ip,
  });

  const [row] = await db
    .select()
    .from(projectTaskLabels)
    .where(eq(projectTaskLabels.id, label.id));
  ok(res, serializeLabel(row!));
});

// DELETE /projects/:id/labels/:labelId (cascades links)
projectsRouter.delete('/:id/labels/:labelId', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const label = await getScopedLabel(ctx, projectId, param(req, 'labelId'));

  await db
    .delete(projectTaskLabels)
    .where(
      and(
        eq(projectTaskLabels.id, label.id),
        eq(projectTaskLabels.agencyId, ctx.agencyId),
      ),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'label.delete',
    entityType: 'label',
    entityId: label.id,
    metadata: { projectId, name: label.name },
    ip: req.ip,
  });
  ok(res, { deleted: true });
});

// ============================================================
//  TASKS
// ============================================================

// GET /projects/:id/tasks — flexible, composable list  §3.6
const DUE_FILTERS = ['overdue', 'today', 'week', 'none'] as const;
const TASK_SORTS = [
  'manual',
  'priority',
  'due',
  'created',
  'updated',
  'title',
] as const;

/** Coerce a query param into a string[] whether it arrives as a or a[]. */
function toArray(v: unknown): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.map(String).filter((s) => s.length > 0);
  return [String(v)].filter((s) => s.length > 0);
}

const listTasksQuery = z.object({
  group: z
    .enum(['status', 'assignee', 'priority', 'label', 'milestone', 'none'])
    .optional(),
  due: z.enum(DUE_FILTERS).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(TASK_SORTS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  includeSubtasks: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v !== 'false'),
});

projectsRouter.get('/:id/tasks', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);

  const q = listTasksQuery.parse(req.query);
  const statusFilter = toArray(req.query['status[]'] ?? req.query.status).filter(
    (s): s is (typeof TASK_STATUSES)[number] =>
      (TASK_STATUSES as readonly string[]).includes(s),
  );
  const assigneeFilter = toArray(
    req.query['assignee[]'] ?? req.query.assignee,
  );
  const priorityFilter = toArray(
    req.query['priority[]'] ?? req.query.priority,
  ).filter((p): p is (typeof TASK_PRIORITIES)[number] =>
    (TASK_PRIORITIES as readonly string[]).includes(p),
  );
  const labelFilter = toArray(req.query['label[]'] ?? req.query.label);
  const milestoneFilter = toArray(
    req.query['milestone[]'] ?? req.query.milestone,
  );

  const filters = [
    eq(projectTasks.agencyId, ctx.agencyId),
    eq(projectTasks.projectId, projectId),
  ];

  if (!q.includeSubtasks) filters.push(isNull(projectTasks.parentTaskId));
  if (statusFilter.length > 0)
    filters.push(inArray(projectTasks.status, statusFilter));
  if (priorityFilter.length > 0)
    filters.push(inArray(projectTasks.priority, priorityFilter));
  if (milestoneFilter.length > 0)
    filters.push(inArray(projectTasks.milestoneId, milestoneFilter));

  if (assigneeFilter.length > 0) {
    const ids = assigneeFilter.filter((a) => a !== 'unassigned');
    const wantsUnassigned = assigneeFilter.includes('unassigned');
    const parts = [];
    // Match a task when ANY of its assignees is one of the requested users.
    if (ids.length > 0) {
      const assigned = db
        .select({ taskId: taskAssignees.taskId })
        .from(taskAssignees)
        .where(
          and(
            eq(taskAssignees.agencyId, ctx.agencyId),
            inArray(taskAssignees.userId, ids),
          ),
        );
      parts.push(inArray(projectTasks.id, assigned));
    }
    // Unassigned = no primary assignee (the mirror is kept in sync with the
    // join set, so this also means no taskAssignees rows).
    if (wantsUnassigned) parts.push(isNull(projectTasks.assigneeId));
    if (parts.length > 0) filters.push(or(...parts)!);
  }

  if (q.q && q.q.length > 0) {
    filters.push(like(projectTasks.title, `%${q.q}%`));
  }

  // Due-date buckets (computed against the server's "now").
  if (q.due) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
    const endOfWeek = new Date(startOfToday);
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    if (q.due === 'none') {
      filters.push(isNull(projectTasks.dueDate));
    } else if (q.due === 'overdue') {
      filters.push(
        sql`${projectTasks.dueDate} is not null and ${projectTasks.dueDate} < ${startOfToday}`,
      );
    } else if (q.due === 'today') {
      filters.push(
        sql`${projectTasks.dueDate} >= ${startOfToday} and ${projectTasks.dueDate} < ${startOfTomorrow}`,
      );
    } else if (q.due === 'week') {
      filters.push(
        sql`${projectTasks.dueDate} >= ${startOfToday} and ${projectTasks.dueDate} < ${endOfWeek}`,
      );
    }
  }

  // Restrict to tasks carrying any of the requested labels.
  if (labelFilter.length > 0) {
    const linked = db
      .select({ taskId: projectTaskLabelLinks.taskId })
      .from(projectTaskLabelLinks)
      .where(
        and(
          eq(projectTaskLabelLinks.agencyId, ctx.agencyId),
          inArray(projectTaskLabelLinks.labelId, labelFilter),
        ),
      );
    filters.push(inArray(projectTasks.id, linked));
  }

  // Sorting. `manual` (default) = position asc; priority uses an explicit rank
  // because the enum is text. Secondary key is position for stability.
  const dir = q.dir === 'desc' ? desc : asc;
  const sort = q.sort ?? 'manual';
  let orderBy;
  if (sort === 'priority') {
    const rank = sql`case ${projectTasks.priority}
      when 'urgent' then 0 when 'high' then 1 when 'medium' then 2
      when 'low' then 3 else 4 end`;
    orderBy = [dir(rank), asc(projectTasks.position)];
  } else if (sort === 'due') {
    orderBy = [
      sql`${projectTasks.dueDate} is null`,
      dir(projectTasks.dueDate),
      asc(projectTasks.position),
    ];
  } else if (sort === 'created') {
    orderBy = [dir(projectTasks.createdAt)];
  } else if (sort === 'updated') {
    orderBy = [dir(projectTasks.updatedAt)];
  } else if (sort === 'title') {
    orderBy = [dir(projectTasks.title)];
  } else {
    orderBy = [asc(projectTasks.position), asc(projectTasks.createdAt)];
  }

  const rows = await db
    .select()
    .from(projectTasks)
    .where(and(...filters))
    .orderBy(...orderBy);

  const enriched = await enrichTasks(ctx.agencyId, rows);
  ok(res, enriched);
});

/**
 * Verify a milestone exists in the SAME project + agency, or throw 404.
 * Used to validate a task's milestoneId link.
 */
async function requireProjectMilestone(
  ctx: ReturnType<typeof getAuth>,
  projectId: string,
  milestoneId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: projectMilestones.id })
    .from(projectMilestones)
    .where(
      and(
        eq(projectMilestones.id, milestoneId),
        eq(projectMilestones.agencyId, ctx.agencyId),
        eq(projectMilestones.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Milestone not found.');
}

/**
 * Verify a candidate parent task is a valid one-level parent in this project:
 * exists, same project/agency, and is itself a top-level task. Returns the
 * parent row (its milestoneId is inherited by new subtasks). Throws 422 on a
 * nesting violation, 404 if not found.
 */
async function requireValidParentTask(
  ctx: ReturnType<typeof getAuth>,
  projectId: string,
  parentTaskId: string,
  selfId?: string,
) {
  if (selfId && parentTaskId === selfId) {
    throw new AppError('VALIDATION_ERROR', 'A task cannot be its own parent.');
  }
  const parent = await getScopedTask(ctx, projectId, parentTaskId);
  if (parent.parentTaskId !== null) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Subtasks can only be nested one level deep.',
    );
  }
  return parent;
}

// POST /projects/:id/tasks
const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  milestoneId: z.string().min(1).nullable().optional(),
  assigneeId: z.string().min(1).optional(),
  assigneeIds: z.array(z.string().min(1)).max(20).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  estimateMinutes: z.number().int().min(0).nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().optional(),
  parentTaskId: z.string().min(1).nullable().optional(),
  position: z.number().int().min(0).optional(),
});

projectsRouter.post('/:id/tasks', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const body = createTaskSchema.parse(req.body);

  // Resolve the assignee set: explicit `assigneeIds` wins, else the legacy
  // single `assigneeId` (if any). Deduped; the first becomes the primary.
  const assigneeIds = [
    ...new Set(body.assigneeIds ?? (body.assigneeId ? [body.assigneeId] : [])),
  ];
  for (const uid of assigneeIds) {
    await requireAgencyUser(ctx, uid);
  }
  const primaryAssigneeId = assigneeIds[0] ?? null;

  // Subtasks inherit their parent's milestone when one isn't given.
  let parent: typeof projectTasks.$inferSelect | undefined;
  if (body.parentTaskId) {
    parent = await requireValidParentTask(ctx, projectId, body.parentTaskId);
  }

  let milestoneId = body.milestoneId ?? null;
  if (milestoneId) {
    await requireProjectMilestone(ctx, projectId, milestoneId);
  } else if (body.milestoneId === undefined && parent) {
    milestoneId = parent.milestoneId;
  }

  const id = newId('ptk');
  // status -> 'done' at creation stamps completedAt.
  const completedAt = body.status === 'done' ? new Date() : null;
  await db.insert(projectTasks).values({
    id,
    agencyId: ctx.agencyId,
    projectId,
    title: body.title,
    description: body.description ?? null,
    ...(body.status !== undefined ? { status: body.status } : {}),
    milestoneId,
    assigneeId: primaryAssigneeId,
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
    estimateMinutes: body.estimateMinutes ?? null,
    startDate: body.startDate ?? null,
    dueDate: body.dueDate ?? null,
    completedAt,
    parentTaskId: body.parentTaskId ?? null,
    ...(body.position !== undefined ? { position: body.position } : {}),
  });

  // Sync the M:N join table with the resolved assignee set.
  await syncTaskAssignees(ctx.agencyId, id, assigneeIds);

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: body.parentTaskId ? 'task.subtask_add' : 'task.create',
    entityType: 'task',
    entityId: id,
    metadata: {
      projectId,
      taskTitle: body.title,
      status: body.status ?? 'todo',
      ...(primaryAssigneeId ? { assigneeId: primaryAssigneeId } : {}),
      ...(milestoneId ? { milestoneId } : {}),
      ...(body.parentTaskId ? { parentTaskId: body.parentTaskId } : {}),
    },
    ip: req.ip,
  });

  const [row] = await db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.id, id));
  const [enriched] = await attachAssignees(ctx.agencyId, [
    serializeTask(row!),
  ]);
  created(res, enriched);
});

// POST /projects/:id/tasks/bulk — create many tasks from a list of titles.
const bulkCreateTaskSchema = z.object({
  titles: z.array(z.string().trim().min(1).max(200)).min(1),
  milestoneId: z.string().min(1).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
});

projectsRouter.post('/:id/tasks/bulk', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const body = bulkCreateTaskSchema.parse(req.body);

  if (body.milestoneId) {
    await requireProjectMilestone(ctx, projectId, body.milestoneId);
  }

  // Position new tasks sequentially after the current max in the project.
  const [{ maxPos } = { maxPos: null }] = await db
    .select({ maxPos: sql<number | null>`max(${projectTasks.position})` })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.projectId, projectId),
      ),
    );
  let position = (maxPos ?? -1) + 1;

  const ids: string[] = [];
  for (const title of body.titles) {
    const id = newId('ptk');
    ids.push(id);
    await db.insert(projectTasks).values({
      id,
      agencyId: ctx.agencyId,
      projectId,
      title,
      ...(body.status !== undefined ? { status: body.status } : {}),
      milestoneId: body.milestoneId ?? null,
      position: position++,
    });
  }

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'task.bulk_create',
    entityType: 'task',
    entityId: projectId,
    metadata: {
      projectId,
      count: ids.length,
      ...(body.milestoneId ? { milestoneId: body.milestoneId } : {}),
    },
    ip: req.ip,
  });

  const rows = await db
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.projectId, projectId),
        inArray(projectTasks.id, ids),
      ),
    )
    .orderBy(asc(projectTasks.position));

  created(res, await attachAssignees(ctx.agencyId, rows.map(serializeTask)));
});

/** Fetch a task scoped to the project + agency, or throw 404. */
async function getScopedTask(
  ctx: ReturnType<typeof getAuth>,
  projectId: string,
  taskId: string,
) {
  const [row] = await db
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.id, taskId),
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Task not found.');
  return row;
}

// PATCH /projects/:id/tasks/:taskId  §3.3
const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  milestoneId: z.string().min(1).nullable().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  assigneeIds: z.array(z.string().min(1)).max(20).nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  estimateMinutes: z.number().int().min(0).nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  parentTaskId: z.string().min(1).nullable().optional(),
  position: z.number().int().min(0).optional(),
});

projectsRouter.patch('/:id/tasks/:taskId', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));
  const body = updateTaskSchema.parse(req.body);

  // Resolve the next assignee set. `assigneeIds` (when present) is authoritative
  // and replaces the join; otherwise the legacy single `assigneeId` mirrors to
  // a one-or-zero element set. `nextAssigneeIds === undefined` => leave as-is.
  let nextAssigneeIds: string[] | undefined;
  if (body.assigneeIds !== undefined) {
    nextAssigneeIds = [...new Set(body.assigneeIds ?? [])];
  } else if (body.assigneeId !== undefined) {
    nextAssigneeIds = body.assigneeId ? [body.assigneeId] : [];
  }
  if (nextAssigneeIds !== undefined) {
    for (const uid of nextAssigneeIds) await requireAgencyUser(ctx, uid);
  }
  if (body.milestoneId) {
    await requireProjectMilestone(ctx, projectId, body.milestoneId);
  }

  // Re-parenting: the new parent must be a top-level task in this project, and
  // this task must not already have children (else it would create a 3rd level).
  if (body.parentTaskId) {
    await requireValidParentTask(ctx, projectId, body.parentTaskId, task.id);
    const [child] = await db
      .select({ id: projectTasks.id })
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.agencyId, ctx.agencyId),
          eq(projectTasks.parentTaskId, task.id),
        ),
      )
      .limit(1);
    if (child) {
      throw new AppError(
        'VALIDATION_ERROR',
        'A task with subtasks cannot become a subtask itself.',
      );
    }
  }

  const patch: Partial<typeof projectTasks.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.status !== undefined) patch.status = body.status;
  if (body.milestoneId !== undefined) patch.milestoneId = body.milestoneId;
  // Mirror the primary (first) assignee onto the column for backward-compat.
  const nextPrimaryAssigneeId =
    nextAssigneeIds !== undefined ? (nextAssigneeIds[0] ?? null) : undefined;
  if (nextPrimaryAssigneeId !== undefined)
    patch.assigneeId = nextPrimaryAssigneeId;
  if (body.priority !== undefined) patch.priority = body.priority;
  if (body.estimateMinutes !== undefined)
    patch.estimateMinutes = body.estimateMinutes;
  if (body.startDate !== undefined) patch.startDate = body.startDate;
  if (body.dueDate !== undefined) patch.dueDate = body.dueDate;
  if (body.parentTaskId !== undefined) patch.parentTaskId = body.parentTaskId;
  if (body.position !== undefined) patch.position = body.position;

  // completedAt is derived from status: entering 'done' stamps it; leaving
  // 'done' clears it. Only touch it when status actually changes.
  if (body.status !== undefined && body.status !== task.status) {
    patch.completedAt = body.status === 'done' ? new Date() : null;
  }

  await db
    .update(projectTasks)
    .set(patch)
    .where(
      and(
        eq(projectTasks.id, task.id),
        eq(projectTasks.agencyId, ctx.agencyId),
      ),
    );

  // Replace the M:N join set when assignees were touched (either field).
  if (nextAssigneeIds !== undefined) {
    await syncTaskAssignees(ctx.agencyId, task.id, nextAssigneeIds);
  }

  // Audit: a status change is its own action for the activity feed; otherwise
  // it's a generic task.update. Always carry the changed-field deltas.
  const statusChanged =
    body.status !== undefined && body.status !== task.status;
  const assigneeChanged =
    nextPrimaryAssigneeId !== undefined &&
    nextPrimaryAssigneeId !== task.assigneeId;
  const milestoneChanged =
    body.milestoneId !== undefined && body.milestoneId !== task.milestoneId;
  const priorityChanged =
    body.priority !== undefined && body.priority !== task.priority;
  const parentChanged =
    body.parentTaskId !== undefined &&
    body.parentTaskId !== task.parentTaskId;

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: statusChanged ? 'task.status_change' : 'task.update',
    entityType: 'task',
    entityId: task.id,
    metadata: {
      projectId,
      taskTitle: patch.title ?? task.title,
      ...(statusChanged
        ? { fromStatus: task.status, toStatus: body.status }
        : {}),
      ...(assigneeChanged ? { assigneeId: nextPrimaryAssigneeId } : {}),
      ...(milestoneChanged ? { milestoneId: body.milestoneId } : {}),
      ...(priorityChanged
        ? { fromPriority: task.priority, toPriority: body.priority }
        : {}),
      ...(parentChanged ? { parentTaskId: body.parentTaskId } : {}),
    },
    ip: req.ip,
  });

  const [row] = await db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.id, task.id));
  const [enriched] = await attachAssignees(ctx.agencyId, [serializeTask(row!)]);
  ok(res, enriched);
});

// GET /projects/:id/tasks/:taskId/subtasks  §3.4
projectsRouter.get('/:id/tasks/:taskId/subtasks', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));

  const rows = await db
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.projectId, projectId),
        eq(projectTasks.parentTaskId, task.id),
      ),
    )
    .orderBy(asc(projectTasks.position), asc(projectTasks.createdAt));

  ok(res, await enrichTasks(ctx.agencyId, rows));
});

// DELETE /projects/:id/tasks/:taskId
projectsRouter.delete('/:id/tasks/:taskId', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));

  await db
    .delete(projectTasks)
    .where(
      and(
        eq(projectTasks.id, task.id),
        eq(projectTasks.agencyId, ctx.agencyId),
      ),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'task.delete',
    entityType: 'task',
    entityId: task.id,
    metadata: { projectId, taskTitle: task.title },
    ip: req.ip,
  });
  ok(res, { deleted: true });
});

// ============================================================
//  TASK LABEL LINKS  §3.2
// ============================================================

// PUT /projects/:id/tasks/:taskId/labels — replace the full label set.
const putTaskLabelsSchema = z.object({
  labelIds: z.array(z.string().min(1)).max(50),
});

projectsRouter.put('/:id/tasks/:taskId/labels', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));
  const body = putTaskLabelsSchema.parse(req.body);

  // De-dupe and validate every requested label belongs to this project.
  const wanted = [...new Set(body.labelIds)];
  if (wanted.length > 0) {
    const valid = await db
      .select({ id: projectTaskLabels.id })
      .from(projectTaskLabels)
      .where(
        and(
          eq(projectTaskLabels.agencyId, ctx.agencyId),
          eq(projectTaskLabels.projectId, projectId),
          inArray(projectTaskLabels.id, wanted),
        ),
      );
    if (valid.length !== wanted.length) {
      throw new AppError(
        'VALIDATION_ERROR',
        'One or more labels do not belong to this project.',
      );
    }
  }

  // Replace the full set: delete-then-insert in a transaction.
  await db.transaction(async (tx) => {
    await tx
      .delete(projectTaskLabelLinks)
      .where(
        and(
          eq(projectTaskLabelLinks.agencyId, ctx.agencyId),
          eq(projectTaskLabelLinks.taskId, task.id),
        ),
      );
    if (wanted.length > 0) {
      await tx.insert(projectTaskLabelLinks).values(
        wanted.map((labelId) => ({
          agencyId: ctx.agencyId,
          taskId: task.id,
          labelId,
        })),
      );
    }
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'task.label_change',
    entityType: 'task',
    entityId: task.id,
    metadata: { projectId, labelIds: wanted },
    ip: req.ip,
  });

  // Return the resolved labels for the task.
  const labels =
    wanted.length === 0
      ? []
      : (
          await db
            .select()
            .from(projectTaskLabels)
            .where(
              and(
                eq(projectTaskLabels.agencyId, ctx.agencyId),
                inArray(projectTaskLabels.id, wanted),
              ),
            )
            .orderBy(asc(projectTaskLabels.name))
        ).map(serializeLabel);

  ok(res, labels);
});

// ============================================================
//  TASK DEPENDENCIES (blocks / blocked-by)  §3.5
// ============================================================

/**
 * Detect whether adding edge (blocker -> blocked) would create a cycle, by a
 * bounded BFS over the project's existing dependency graph: starting from
 * `blocked`, follow blocker->blocked edges; if we can reach `blocker`, the new
 * edge would close a loop. Bounded by total edge count.
 */
async function dependencyWouldCycle(
  agencyId: string,
  projectId: string,
  blockerTaskId: string,
  blockedTaskId: string,
): Promise<boolean> {
  // A direct 2-cycle (the reverse edge already exists) is the trivial case.
  const edges = await db
    .select({
      blocker: projectTaskDependencies.blockerTaskId,
      blocked: projectTaskDependencies.blockedTaskId,
    })
    .from(projectTaskDependencies)
    .where(
      and(
        eq(projectTaskDependencies.agencyId, agencyId),
        eq(projectTaskDependencies.projectId, projectId),
      ),
    );

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.blocker) ?? [];
    list.push(e.blocked);
    adj.set(e.blocker, list);
  }

  // BFS from blockedTaskId following downstream edges; reaching blockerTaskId
  // means blocker already (transitively) depends on blocked -> cycle.
  const visited = new Set<string>();
  const queue = [blockedTaskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === blockerTaskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adj.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return false;
}

// GET /projects/:id/tasks/:taskId/dependencies -> { blockedBy, blocks }
projectsRouter.get('/:id/tasks/:taskId/dependencies', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));

  const deps = await loadTaskDependencies(ctx.agencyId, task.id);
  ok(res, deps);
});

/** Resolve a task's blocked-by + blocks lists into serialized tasks + dep ids. */
async function loadTaskDependencies(agencyId: string, taskId: string) {
  // Edges where this task is the blocked side -> its blockers.
  const blockedByEdges = await db
    .select({
      depId: projectTaskDependencies.id,
      task: projectTasks,
    })
    .from(projectTaskDependencies)
    .innerJoin(
      projectTasks,
      eq(projectTasks.id, projectTaskDependencies.blockerTaskId),
    )
    .where(
      and(
        eq(projectTaskDependencies.agencyId, agencyId),
        eq(projectTaskDependencies.blockedTaskId, taskId),
      ),
    )
    .orderBy(asc(projectTaskDependencies.createdAt));

  // Edges where this task is the blocker -> the tasks it blocks.
  const blocksEdges = await db
    .select({
      depId: projectTaskDependencies.id,
      task: projectTasks,
    })
    .from(projectTaskDependencies)
    .innerJoin(
      projectTasks,
      eq(projectTasks.id, projectTaskDependencies.blockedTaskId),
    )
    .where(
      and(
        eq(projectTaskDependencies.agencyId, agencyId),
        eq(projectTaskDependencies.blockerTaskId, taskId),
      ),
    )
    .orderBy(asc(projectTaskDependencies.createdAt));

  return {
    blockedBy: blockedByEdges.map((e) => ({
      depId: e.depId,
      task: serializeTask(e.task),
    })),
    blocks: blocksEdges.map((e) => ({
      depId: e.depId,
      task: serializeTask(e.task),
    })),
  };
}

// POST /projects/:id/tasks/:taskId/dependencies { type, otherTaskId }
const createDependencySchema = z.object({
  type: z.enum(['blocks', 'blocked_by']),
  otherTaskId: z.string().min(1),
});

projectsRouter.post('/:id/tasks/:taskId/dependencies', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));
  const body = createDependencySchema.parse(req.body);

  if (body.otherTaskId === task.id) {
    throw new AppError(
      'VALIDATION_ERROR',
      'A task cannot depend on itself.',
    );
  }
  // The other task must also live in this project.
  const other = await getScopedTask(ctx, projectId, body.otherTaskId);

  // Normalize to canonical (blocker -> blocked).
  const blockerTaskId = body.type === 'blocks' ? task.id : other.id;
  const blockedTaskId = body.type === 'blocks' ? other.id : task.id;

  // Reject duplicate (also guarded by the unique index).
  const [dup] = await db
    .select({ id: projectTaskDependencies.id })
    .from(projectTaskDependencies)
    .where(
      and(
        eq(projectTaskDependencies.blockerTaskId, blockerTaskId),
        eq(projectTaskDependencies.blockedTaskId, blockedTaskId),
      ),
    )
    .limit(1);
  if (dup) throw conflict('That dependency already exists.');

  // Reject any edge that would introduce a cycle (covers 2-cycles too).
  if (
    await dependencyWouldCycle(
      ctx.agencyId,
      projectId,
      blockerTaskId,
      blockedTaskId,
    )
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      'That dependency would create a cycle.',
    );
  }

  const id = newId('pdp');
  await db.insert(projectTaskDependencies).values({
    id,
    agencyId: ctx.agencyId,
    projectId,
    blockerTaskId,
    blockedTaskId,
    createdBy: ctx.userId,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'task.dependency_add',
    entityType: 'task',
    entityId: task.id,
    metadata: { projectId, blockerTaskId, blockedTaskId },
    ip: req.ip,
  });

  created(res, await loadTaskDependencies(ctx.agencyId, task.id));
});

// DELETE /projects/:id/tasks/:taskId/dependencies/:depId
projectsRouter.delete(
  '/:id/tasks/:taskId/dependencies/:depId',
  async (req, res) => {
    const ctx = getAuth(req);
    const projectId = param(req, 'id');
    await getScopedProject(ctx, projectId);
    const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));
    const depId = param(req, 'depId');

    const [dep] = await db
      .select()
      .from(projectTaskDependencies)
      .where(
        and(
          eq(projectTaskDependencies.id, depId),
          eq(projectTaskDependencies.agencyId, ctx.agencyId),
          eq(projectTaskDependencies.projectId, projectId),
        ),
      )
      .limit(1);
    if (!dep) throw notFound('Dependency not found.');
    // The dep must touch this task (either side of the edge).
    if (dep.blockerTaskId !== task.id && dep.blockedTaskId !== task.id) {
      throw notFound('Dependency not found.');
    }

    await db
      .delete(projectTaskDependencies)
      .where(
        and(
          eq(projectTaskDependencies.id, depId),
          eq(projectTaskDependencies.agencyId, ctx.agencyId),
        ),
      );

    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'task.dependency_remove',
      entityType: 'task',
      entityId: task.id,
      metadata: {
        projectId,
        blockerTaskId: dep.blockerTaskId,
        blockedTaskId: dep.blockedTaskId,
      },
      ip: req.ip,
    });

    ok(res, await loadTaskDependencies(ctx.agencyId, task.id));
  },
);

// ============================================================
//  TASK COMMENTS  §3.8
// ============================================================

/** Serialize a comment row joined with its author's name. */
function serializeComment(c: {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  mentionsJson: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  deletedAt: Date | null;
  authorName: string | null;
}) {
  return {
    id: c.id,
    taskId: c.taskId,
    authorId: c.authorId,
    authorName: c.authorName,
    body: c.body,
    mentions: c.mentionsJson
      ? (JSON.parse(c.mentionsJson) as string[])
      : [],
    createdAt: toIso(c.createdAt),
    updatedAt: toIso(c.updatedAt),
    deletedAt: toIso(c.deletedAt),
  };
}

const commentSelection = {
  id: projectTaskComments.id,
  taskId: projectTaskComments.taskId,
  authorId: projectTaskComments.authorId,
  body: projectTaskComments.body,
  mentionsJson: projectTaskComments.mentionsJson,
  createdAt: projectTaskComments.createdAt,
  updatedAt: projectTaskComments.updatedAt,
  deletedAt: projectTaskComments.deletedAt,
  authorName: users.fullName,
};

/**
 * Parse explicit `mentions` (array of userIds) plus any `@token`s in the body,
 * resolved against agency users, and intersect with the project's members.
 * Returns the validated, de-duped set of mentioned userIds.
 */
async function resolveMentions(
  agencyId: string,
  body: string,
  explicit: string[] | undefined,
): Promise<string[]> {
  const ids = new Set<string>(explicit ?? []);

  // Lightweight @-token parse: @ followed by name-ish chars (handles @jane or
  // @"Jane Doe"-style single tokens). Matched against user full names/emails.
  const tokens = [...body.matchAll(/@([\w.\-]+)/g)].map((m) => m[1]!);
  if (tokens.length > 0) {
    const candidates = await db
      .select({ id: users.id, email: users.email, fullName: users.fullName })
      .from(users)
      .where(eq(users.agencyId, agencyId));
    for (const tok of tokens) {
      const low = tok.toLowerCase();
      const hit = candidates.find(
        (u) =>
          u.email.toLowerCase().startsWith(low) ||
          (u.fullName ?? '').toLowerCase().replace(/\s+/g, '').startsWith(low),
      );
      if (hit) ids.add(hit.id);
    }
  }

  if (ids.size === 0) return [];

  // Keep only ids that are real agency users.
  const valid = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.agencyId, agencyId), inArray(users.id, [...ids])));
  return valid.map((u) => u.id);
}

// GET /projects/:id/tasks/:taskId/comments (non-deleted, oldest-first)
projectsRouter.get('/:id/tasks/:taskId/comments', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));

  const rows = await db
    .select(commentSelection)
    .from(projectTaskComments)
    .leftJoin(users, eq(users.id, projectTaskComments.authorId))
    .where(
      and(
        eq(projectTaskComments.agencyId, ctx.agencyId),
        eq(projectTaskComments.taskId, task.id),
        isNull(projectTaskComments.deletedAt),
      ),
    )
    .orderBy(asc(projectTaskComments.createdAt));

  ok(res, rows.map(serializeComment));
});

// POST /projects/:id/tasks/:taskId/comments { body, mentions? }
const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  mentions: z.array(z.string().min(1)).optional(),
});

projectsRouter.post('/:id/tasks/:taskId/comments', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));
  const body = createCommentSchema.parse(req.body);

  const mentions = await resolveMentions(
    ctx.agencyId,
    body.body,
    body.mentions,
  );

  const id = newId('pcm');
  await db.insert(projectTaskComments).values({
    id,
    agencyId: ctx.agencyId,
    taskId: task.id,
    authorId: ctx.userId,
    body: body.body,
    mentionsJson: mentions.length > 0 ? JSON.stringify(mentions) : null,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'task.comment_add',
    entityType: 'task',
    entityId: task.id,
    metadata: {
      projectId,
      commentId: id,
      ...(mentions.length > 0 ? { mentions } : {}),
    },
    ip: req.ip,
  });

  const [row] = await db
    .select(commentSelection)
    .from(projectTaskComments)
    .leftJoin(users, eq(users.id, projectTaskComments.authorId))
    .where(eq(projectTaskComments.id, id));
  created(res, serializeComment(row!));
});

/** Fetch a comment scoped to its task + agency (incl. soft-deleted), or 404. */
async function getScopedComment(
  ctx: ReturnType<typeof getAuth>,
  taskId: string,
  commentId: string,
) {
  const [row] = await db
    .select()
    .from(projectTaskComments)
    .where(
      and(
        eq(projectTaskComments.id, commentId),
        eq(projectTaskComments.agencyId, ctx.agencyId),
        eq(projectTaskComments.taskId, taskId),
      ),
    )
    .limit(1);
  if (!row || row.deletedAt) throw notFound('Comment not found.');
  return row;
}

// PATCH /projects/:id/tasks/:taskId/comments/:commentId (author-only)
const updateCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  mentions: z.array(z.string().min(1)).optional(),
});

projectsRouter.patch(
  '/:id/tasks/:taskId/comments/:commentId',
  async (req, res) => {
    const ctx = getAuth(req);
    const projectId = param(req, 'id');
    await getScopedProject(ctx, projectId);
    const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));
    const comment = await getScopedComment(
      ctx,
      task.id,
      param(req, 'commentId'),
    );
    if (comment.authorId !== ctx.userId) {
      throw forbidden('You can only edit your own comments.');
    }
    const body = updateCommentSchema.parse(req.body);

    const mentions = await resolveMentions(
      ctx.agencyId,
      body.body,
      body.mentions,
    );

    await db
      .update(projectTaskComments)
      .set({
        body: body.body,
        mentionsJson: mentions.length > 0 ? JSON.stringify(mentions) : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectTaskComments.id, comment.id),
          eq(projectTaskComments.agencyId, ctx.agencyId),
        ),
      );

    const [row] = await db
      .select(commentSelection)
      .from(projectTaskComments)
      .leftJoin(users, eq(users.id, projectTaskComments.authorId))
      .where(eq(projectTaskComments.id, comment.id));
    ok(res, serializeComment(row!));
  },
);

// DELETE /projects/:id/tasks/:taskId/comments/:commentId (author-only soft delete)
projectsRouter.delete(
  '/:id/tasks/:taskId/comments/:commentId',
  async (req, res) => {
    const ctx = getAuth(req);
    const projectId = param(req, 'id');
    await getScopedProject(ctx, projectId);
    const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));
    const comment = await getScopedComment(
      ctx,
      task.id,
      param(req, 'commentId'),
    );
    if (comment.authorId !== ctx.userId) {
      throw forbidden('You can only delete your own comments.');
    }

    await db
      .update(projectTaskComments)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(projectTaskComments.id, comment.id),
          eq(projectTaskComments.agencyId, ctx.agencyId),
        ),
      );

    ok(res, { deleted: true });
  },
);

// ============================================================
//  SINGLE TASK DETAIL  §3.7
// ============================================================

// GET /projects/:id/tasks/:taskId — full detail bundle.
projectsRouter.get('/:id/tasks/:taskId', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const taskRow = await getScopedTask(ctx, projectId, param(req, 'taskId'));

  const [enrichedTask] = await enrichTasks(ctx.agencyId, [taskRow]);

  // Subtasks (children by position).
  const subtaskRows = await db
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.projectId, projectId),
        eq(projectTasks.parentTaskId, taskRow.id),
      ),
    )
    .orderBy(asc(projectTasks.position), asc(projectTasks.createdAt));
  const subtasks = await enrichTasks(ctx.agencyId, subtaskRows);

  const dependencies = await loadTaskDependencies(ctx.agencyId, taskRow.id);

  // Comments (non-deleted, oldest-first) with author names.
  const commentRows = await db
    .select(commentSelection)
    .from(projectTaskComments)
    .leftJoin(users, eq(users.id, projectTaskComments.authorId))
    .where(
      and(
        eq(projectTaskComments.agencyId, ctx.agencyId),
        eq(projectTaskComments.taskId, taskRow.id),
        isNull(projectTaskComments.deletedAt),
      ),
    )
    .orderBy(asc(projectTaskComments.createdAt));
  const comments = commentRows.map(serializeComment);

  // Activity = audit entries for this task entity, with actor names.
  const activityRows = await db
    .select({
      id: auditLog.id,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      action: auditLog.action,
      metadataJson: auditLog.metadataJson,
      createdAt: auditLog.createdAt,
      actorName: users.fullName,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(
      and(
        eq(auditLog.agencyId, ctx.agencyId),
        eq(auditLog.entityType, 'task'),
        eq(auditLog.entityId, taskRow.id),
      ),
    )
    .orderBy(asc(auditLog.createdAt));
  const activity = activityRows.map((a) => ({
    id: a.id,
    actorType: a.actorType,
    actorId: a.actorId,
    actorName: a.actorName,
    action: a.action,
    metadata: a.metadataJson ? JSON.parse(a.metadataJson) : null,
    createdAt: toIso(a.createdAt),
  }));

  // Merged chronological feed: activity + comments, each tagged by kind.
  const feed = [
    ...activity.map((a) => ({
      kind: 'activity' as const,
      at: a.createdAt,
      activity: a,
    })),
    ...comments.map((c) => ({
      kind: 'comment' as const,
      at: c.createdAt,
      comment: c,
    })),
  ].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));

  ok(res, {
    task: enrichedTask,
    subtasks,
    labels: enrichedTask?.labels ?? [],
    dependencies,
    comments,
    activity,
    feed,
  });
});

// ============================================================
//  MILESTONES
// ============================================================

// GET /projects/:id/milestones
projectsRouter.get('/:id/milestones', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);

  const rows = await db
    .select()
    .from(projectMilestones)
    .where(
      and(
        eq(projectMilestones.agencyId, ctx.agencyId),
        eq(projectMilestones.projectId, projectId),
      ),
    )
    .orderBy(
      asc(projectMilestones.position),
      asc(projectMilestones.createdAt),
    );

  ok(res, rows.map(serializeMilestone));
});

// POST /projects/:id/milestones
const createMilestoneSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  dueDate: z.coerce.date().optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  position: z.number().int().min(0).optional(),
});

projectsRouter.post('/:id/milestones', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const body = createMilestoneSchema.parse(req.body);

  const id = newId('pms');
  await db.insert(projectMilestones).values({
    id,
    agencyId: ctx.agencyId,
    projectId,
    title: body.title,
    description: body.description ?? null,
    dueDate: body.dueDate ?? null,
    ...(body.status !== undefined ? { status: body.status } : {}),
    // Setting a milestone as completed at creation stamps completedAt.
    ...(body.status === 'completed' ? { completedAt: new Date() } : {}),
    ...(body.position !== undefined ? { position: body.position } : {}),
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'milestone.create',
    entityType: 'milestone',
    entityId: id,
    metadata: {
      projectId,
      milestoneTitle: body.title,
      status: body.status ?? 'pending',
    },
    ip: req.ip,
  });

  const [row] = await db
    .select()
    .from(projectMilestones)
    .where(eq(projectMilestones.id, id));
  created(res, serializeMilestone(row!));
});

/** Fetch a milestone scoped to the project + agency, or throw 404. */
async function getScopedMilestone(
  ctx: ReturnType<typeof getAuth>,
  projectId: string,
  milestoneId: string,
) {
  const [row] = await db
    .select()
    .from(projectMilestones)
    .where(
      and(
        eq(projectMilestones.id, milestoneId),
        eq(projectMilestones.agencyId, ctx.agencyId),
        eq(projectMilestones.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Milestone not found.');
  return row;
}

// PATCH /projects/:id/milestones/:milestoneId
const updateMilestoneSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  position: z.number().int().min(0).optional(),
});

projectsRouter.patch('/:id/milestones/:milestoneId', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const milestone = await getScopedMilestone(
    ctx,
    projectId,
    param(req, 'milestoneId'),
  );
  const body = updateMilestoneSchema.parse(req.body);

  const patch: Partial<typeof projectMilestones.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.dueDate !== undefined) patch.dueDate = body.dueDate;
  if (body.position !== undefined) patch.position = body.position;
  if (body.status !== undefined) {
    patch.status = body.status;
    // Completing stamps completedAt; un-completing clears it.
    if (body.status === 'completed') {
      patch.completedAt =
        milestone.completedAt ?? new Date();
    } else {
      patch.completedAt = null;
    }
  }

  await db
    .update(projectMilestones)
    .set(patch)
    .where(
      and(
        eq(projectMilestones.id, milestone.id),
        eq(projectMilestones.agencyId, ctx.agencyId),
      ),
    );

  const mStatusChanged =
    body.status !== undefined && body.status !== milestone.status;

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'milestone.update',
    entityType: 'milestone',
    entityId: milestone.id,
    metadata: {
      projectId,
      milestoneTitle: patch.title ?? milestone.title,
      ...(mStatusChanged
        ? { fromStatus: milestone.status, toStatus: body.status }
        : {}),
    },
    ip: req.ip,
  });

  const [row] = await db
    .select()
    .from(projectMilestones)
    .where(eq(projectMilestones.id, milestone.id));
  ok(res, serializeMilestone(row!));
});

// DELETE /projects/:id/milestones/:milestoneId
projectsRouter.delete('/:id/milestones/:milestoneId', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const milestone = await getScopedMilestone(
    ctx,
    projectId,
    param(req, 'milestoneId'),
  );

  await db
    .delete(projectMilestones)
    .where(
      and(
        eq(projectMilestones.id, milestone.id),
        eq(projectMilestones.agencyId, ctx.agencyId),
      ),
    );

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'milestone.delete',
    entityType: 'milestone',
    entityId: milestone.id,
    metadata: { projectId, milestoneTitle: milestone.title },
    ip: req.ip,
  });
  ok(res, { deleted: true });
});

// ============================================================
//  MEMBERS
// ============================================================

// GET /projects/:id/members
projectsRouter.get('/:id/members', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);

  const rows = await db
    .select({
      id: projectMembers.id,
      userId: projectMembers.userId,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
      userName: users.fullName,
      userEmail: users.email,
    })
    .from(projectMembers)
    .leftJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.agencyId, ctx.agencyId),
        eq(projectMembers.projectId, projectId),
      ),
    )
    .orderBy(asc(projectMembers.createdAt));

  ok(
    res,
    rows.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      userName: m.userName,
      userEmail: m.userEmail,
      createdAt: toIso(m.createdAt),
    })),
  );
});

// POST /projects/:id/members
const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.string().trim().max(40).optional(),
});

projectsRouter.post('/:id/members', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const body = addMemberSchema.parse(req.body);
  await requireAgencyUser(ctx, body.userId);

  const id = newId('prm');
  await db
    .insert(projectMembers)
    .values({
      id,
      agencyId: ctx.agencyId,
      projectId,
      userId: body.userId,
      role: body.role ?? null,
    })
    .onConflictDoNothing();

  const [row] = await db
    .select({
      id: projectMembers.id,
      userId: projectMembers.userId,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
      userName: users.fullName,
      userEmail: users.email,
    })
    .from(projectMembers)
    .leftJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.agencyId, ctx.agencyId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, body.userId),
      ),
    )
    .limit(1);

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'member.add',
    entityType: 'project_member',
    entityId: row!.id,
    metadata: {
      projectId,
      userId: body.userId,
      userName: row!.userName,
      role: body.role ?? null,
    },
    ip: req.ip,
  });

  created(res, {
    id: row!.id,
    userId: row!.userId,
    role: row!.role,
    userName: row!.userName,
    userEmail: row!.userEmail,
    createdAt: toIso(row!.createdAt),
  });
});

// DELETE /projects/:id/members/:memberId
projectsRouter.delete('/:id/members/:memberId', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);

  const result = await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.id, param(req, 'memberId')),
        eq(projectMembers.agencyId, ctx.agencyId),
        eq(projectMembers.projectId, projectId),
      ),
    )
    .returning({ id: projectMembers.id, userId: projectMembers.userId });
  if (!result.length) throw notFound('Member not found.');

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'member.remove',
    entityType: 'project_member',
    entityId: result[0]!.id,
    metadata: { projectId, userId: result[0]!.userId },
    ip: req.ip,
  });

  ok(res, { deleted: true });
});

// ============================================================
//  TIME TRACKING (project-scoped reads; mutations live in timers.ts)
// ============================================================

// GET /projects/:id/timers — ALL running timers for the project
projectsRouter.get('/:id/timers', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  ok(res, await listProjectTimers(ctx, projectId));
});

// GET /projects/:id/time-summary
projectsRouter.get('/:id/time-summary', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);

  const [{ totalMinutes, logCount } = { totalMinutes: 0, logCount: 0 }] =
    await db
      .select({
        totalMinutes: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
        logCount: sql<number>`count(*)`,
      })
      .from(timeLogs)
      .where(
        and(
          eq(timeLogs.agencyId, ctx.agencyId),
          eq(timeLogs.projectId, projectId),
        ),
      );

  const byMemberRows = await db
    .select({
      userId: timeLogs.userId,
      userName: users.fullName,
      minutes: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
    })
    .from(timeLogs)
    .leftJoin(users, eq(users.id, timeLogs.userId))
    .where(
      and(
        eq(timeLogs.agencyId, ctx.agencyId),
        eq(timeLogs.projectId, projectId),
      ),
    )
    .groupBy(timeLogs.userId, users.fullName)
    .orderBy(desc(sql`sum(${timeLogs.minutes})`));

  const byTaskRows = await db
    .select({
      taskId: timeLogs.taskId,
      taskTitle: projectTasks.title,
      minutes: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
    })
    .from(timeLogs)
    .leftJoin(projectTasks, eq(projectTasks.id, timeLogs.taskId))
    .where(
      and(
        eq(timeLogs.agencyId, ctx.agencyId),
        eq(timeLogs.projectId, projectId),
      ),
    )
    .groupBy(timeLogs.taskId, projectTasks.title)
    .orderBy(desc(sql`sum(${timeLogs.minutes})`))
    .limit(15);

  const activeTimers = await listProjectTimers(ctx, projectId);

  ok(res, {
    totalMinutes: Number(totalMinutes ?? 0),
    byMember: byMemberRows.map((m) => ({
      userId: m.userId,
      userName: m.userName,
      minutes: Number(m.minutes ?? 0),
    })),
    byTask: byTaskRows.map((tk) => ({
      taskId: tk.taskId,
      taskTitle: tk.taskId ? tk.taskTitle : 'No task',
      minutes: Number(tk.minutes ?? 0),
    })),
    activeTimers,
    logCount: Number(logCount ?? 0),
  });
});

// GET /projects/:id/time-logs?limit
const projectLogsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

projectsRouter.get('/:id/time-logs', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const q = projectLogsQuery.parse(req.query);

  const rows = await db
    .select({
      id: timeLogs.id,
      minutes: timeLogs.minutes,
      workDate: timeLogs.workDate,
      note: timeLogs.note,
      userId: timeLogs.userId,
      userName: users.fullName,
      taskId: timeLogs.taskId,
      taskTitle: projectTasks.title,
    })
    .from(timeLogs)
    .leftJoin(users, eq(users.id, timeLogs.userId))
    .leftJoin(projectTasks, eq(projectTasks.id, timeLogs.taskId))
    .where(
      and(
        eq(timeLogs.agencyId, ctx.agencyId),
        eq(timeLogs.projectId, projectId),
      ),
    )
    .orderBy(desc(timeLogs.workDate))
    .limit(q.limit ?? 50);

  ok(
    res,
    rows.map((l) => ({
      id: l.id,
      minutes: l.minutes,
      workDate: toIso(l.workDate),
      note: l.note,
      userId: l.userId,
      userName: l.userName,
      taskId: l.taskId,
      taskTitle: l.taskTitle,
    })),
  );
});

// GET /projects/:id/tasks/:taskId/time-logs — task-scoped timeline.
// Returns the task's logged entries (newest first), a summed total, and how
// many timers are running on THIS task right now, so the task panel can show
// "Total tracked: 3h 20m" alongside a per-entry timeline (who · start→end ·
// duration · note).
projectsRouter.get('/:id/tasks/:taskId/time-logs', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));

  const rows = await db
    .select({
      id: timeLogs.id,
      minutes: timeLogs.minutes,
      workDate: timeLogs.workDate,
      note: timeLogs.note,
      userId: timeLogs.userId,
      userName: users.fullName,
    })
    .from(timeLogs)
    .leftJoin(users, eq(users.id, timeLogs.userId))
    .where(
      and(
        eq(timeLogs.agencyId, ctx.agencyId),
        eq(timeLogs.taskId, task.id),
      ),
    )
    .orderBy(desc(timeLogs.workDate));

  const [{ totalMinutes } = { totalMinutes: 0 }] = await db
    .select({
      totalMinutes: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
    })
    .from(timeLogs)
    .where(
      and(eq(timeLogs.agencyId, ctx.agencyId), eq(timeLogs.taskId, task.id)),
    );

  const [{ activeCount } = { activeCount: 0 }] = await db
    .select({ activeCount: sql<number>`count(*)` })
    .from(timers)
    .where(
      and(eq(timers.agencyId, ctx.agencyId), eq(timers.taskId, task.id)),
    );

  ok(res, {
    totalMinutes: Number(totalMinutes ?? 0),
    logCount: rows.length,
    activeTimerCount: Number(activeCount ?? 0),
    logs: rows.map((l) => ({
      id: l.id,
      minutes: l.minutes,
      // start (workDate) → end derived client-side from start + minutes.
      workDate: toIso(l.workDate),
      note: l.note,
      userId: l.userId,
      userName: l.userName,
    })),
  });
});

// ============================================================
//  ACTIVITY FEED
// ============================================================

type ActivityRow = {
  id: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  metadataJson: string | null;
  createdAt: Date | null;
};

function serializeActivity(r: ActivityRow) {
  let metadata: Record<string, unknown> | null = null;
  if (r.metadataJson) {
    try {
      metadata = JSON.parse(r.metadataJson);
    } catch {
      metadata = null;
    }
  }
  return {
    id: r.id,
    action: r.action,
    actorId: r.actorId,
    actorName: r.actorName,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata,
    createdAt: toIso(r.createdAt),
  };
}

/**
 * Read the audit feed for a project: rows whose metadata json has the matching
 * projectId. Uses json_extract with a LIKE fallback for robustness.
 */
async function fetchProjectActivity(
  ctx: ReturnType<typeof getAuth>,
  projectId: string,
  limit: number,
): Promise<ReturnType<typeof serializeActivity>[]> {
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
        sql`(
          json_extract(${auditLog.metadataJson}, '$.projectId') = ${projectId}
          or ${auditLog.metadataJson} like ${'%"projectId":"' + projectId + '"%'}
        )`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);

  return (rows as ActivityRow[]).map(serializeActivity);
}

// GET /projects/:id/activity?limit=50
const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

projectsRouter.get('/:id/activity', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const q = activityQuery.parse(req.query);
  ok(res, await fetchProjectActivity(ctx, projectId, q.limit ?? 50));
});

// ============================================================
//  OVERVIEW (boss dashboard tab)
// ============================================================

projectsRouter.get('/:id/overview', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);

  // Tasks grouped by status.
  const taskStatusRows = await db
    .select({
      status: projectTasks.status,
      count: sql<number>`count(*)`,
    })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.projectId, projectId),
      ),
    )
    .groupBy(projectTasks.status);

  const tasksByStatus = {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
  };
  for (const r of taskStatusRows) {
    if (r.status in tasksByStatus) {
      tasksByStatus[r.status as keyof typeof tasksByStatus] = Number(
        r.count ?? 0,
      );
    }
  }
  const taskTotal =
    tasksByStatus.backlog +
    tasksByStatus.todo +
    tasksByStatus.in_progress +
    tasksByStatus.in_review +
    tasksByStatus.done;
  const taskDone = tasksByStatus.done;

  // Milestones.
  const [{ milestoneTotal, milestoneDone } = { milestoneTotal: 0, milestoneDone: 0 }] =
    await db
      .select({
        milestoneTotal: sql<number>`count(*)`,
        milestoneDone: sql<number>`coalesce(sum(case when ${projectMilestones.status} = 'completed' then 1 else 0 end), 0)`,
      })
      .from(projectMilestones)
      .where(
        and(
          eq(projectMilestones.agencyId, ctx.agencyId),
          eq(projectMilestones.projectId, projectId),
        ),
      );

  // Members.
  const [{ memberCount } = { memberCount: 0 }] = await db
    .select({ memberCount: sql<number>`count(*)` })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.agencyId, ctx.agencyId),
        eq(projectMembers.projectId, projectId),
      ),
    );

  // Logged time.
  const [{ totalTimeMinutes } = { totalTimeMinutes: 0 }] = await db
    .select({
      totalTimeMinutes: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
    })
    .from(timeLogs)
    .where(
      and(
        eq(timeLogs.agencyId, ctx.agencyId),
        eq(timeLogs.projectId, projectId),
      ),
    );

  const activeTimers = await listProjectTimers(ctx, projectId);
  const recentActivity = await fetchProjectActivity(ctx, projectId, 6);

  ok(res, {
    tasksByStatus,
    taskTotal,
    taskDone,
    milestoneTotal: Number(milestoneTotal ?? 0),
    milestoneDone: Number(milestoneDone ?? 0),
    memberCount: Number(memberCount ?? 0),
    totalTimeMinutes: Number(totalTimeMinutes ?? 0),
    activeTimerCount: activeTimers.length,
    recentActivity,
  });
});
