import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  projects,
  projectTasks,
  projectMilestones,
  projectMembers,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { getAuth } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';

// mergeParams keeps any parent params available (none today, but consistent
// with the other nested routers).
export const projectsRouter = Router({ mergeParams: true });
projectsRouter.use(requireAuth);

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
    dueDate: toIso(tk.dueDate),
    position: tk.position,
    createdAt: toIso(tk.createdAt),
    updatedAt: toIso(tk.updatedAt),
  };
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
    ip: req.ip,
  });
  ok(res, { deleted: true });
});

// ============================================================
//  TASKS
// ============================================================

// GET /projects/:id/tasks
projectsRouter.get('/:id/tasks', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);

  const rows = await db
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.projectId, projectId),
      ),
    )
    .orderBy(asc(projectTasks.position), asc(projectTasks.createdAt));

  ok(res, rows.map(serializeTask));
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

// POST /projects/:id/tasks
const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  milestoneId: z.string().min(1).nullable().optional(),
  assigneeId: z.string().min(1).optional(),
  dueDate: z.coerce.date().optional(),
  position: z.number().int().min(0).optional(),
});

projectsRouter.post('/:id/tasks', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const body = createTaskSchema.parse(req.body);

  if (body.assigneeId !== undefined) {
    await requireAgencyUser(ctx, body.assigneeId);
  }
  if (body.milestoneId) {
    await requireProjectMilestone(ctx, projectId, body.milestoneId);
  }

  const id = newId('ptk');
  await db.insert(projectTasks).values({
    id,
    agencyId: ctx.agencyId,
    projectId,
    title: body.title,
    description: body.description ?? null,
    ...(body.status !== undefined ? { status: body.status } : {}),
    milestoneId: body.milestoneId ?? null,
    assigneeId: body.assigneeId ?? null,
    dueDate: body.dueDate ?? null,
    ...(body.position !== undefined ? { position: body.position } : {}),
  });

  const [row] = await db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.id, id));
  created(res, serializeTask(row!));
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

  created(res, rows.map(serializeTask));
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

// PATCH /projects/:id/tasks/:taskId
const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  milestoneId: z.string().min(1).nullable().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  position: z.number().int().min(0).optional(),
});

projectsRouter.patch('/:id/tasks/:taskId', async (req, res) => {
  const ctx = getAuth(req);
  const projectId = param(req, 'id');
  await getScopedProject(ctx, projectId);
  const task = await getScopedTask(ctx, projectId, param(req, 'taskId'));
  const body = updateTaskSchema.parse(req.body);

  if (body.assigneeId) {
    await requireAgencyUser(ctx, body.assigneeId);
  }
  if (body.milestoneId) {
    await requireProjectMilestone(ctx, projectId, body.milestoneId);
  }

  const patch: Partial<typeof projectTasks.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.status !== undefined) patch.status = body.status;
  if (body.milestoneId !== undefined) patch.milestoneId = body.milestoneId;
  if (body.assigneeId !== undefined) patch.assigneeId = body.assigneeId;
  if (body.dueDate !== undefined) patch.dueDate = body.dueDate;
  if (body.position !== undefined) patch.position = body.position;

  await db
    .update(projectTasks)
    .set(patch)
    .where(
      and(
        eq(projectTasks.id, task.id),
        eq(projectTasks.agencyId, ctx.agencyId),
      ),
    );

  const [row] = await db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.id, task.id));
  ok(res, serializeTask(row!));
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
  ok(res, { deleted: true });
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
    .returning({ id: projectMembers.id });
  if (!result.length) throw notFound('Member not found.');

  ok(res, { deleted: true });
});
