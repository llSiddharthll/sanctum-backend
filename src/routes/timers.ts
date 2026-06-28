import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  projects,
  projectTasks,
  timeLogs,
  timers,
  users,
} from '../db/schema.js';
import { ok, created, toIso } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound, conflict } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';

export const timersRouter = Router();
timersRouter.use(requireAuth);
// Timers track work on projects/tasks → part of the Projects module.
// GET=view, start/stop/edit=manage. Without this gate a projects:none member
// could start/stop timers (privilege leak).
timersRouter.use(requireModuleRW('projects'));

type Ctx = ReturnType<typeof getAuth>;

// ---- Helpers (exported — also used by the project-scoped routes) ----

/** Verify a project belongs to the caller's agency; return {id,name} or 404. */
async function requireAgencyProject(
  ctx: Ctx,
  projectId: string,
): Promise<{ id: string; name: string }> {
  const [row] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.agencyId, ctx.agencyId)),
    )
    .limit(1);
  if (!row) throw notFound('Project not found.');
  return row;
}

/**
 * Verify a task belongs to the agency (and, if a project is given, to that
 * project). Returns {id,title} or throws 404/409.
 */
async function requireAgencyTask(
  ctx: Ctx,
  taskId: string,
  projectId?: string,
): Promise<{ id: string; title: string }> {
  const [row] = await db
    .select({
      id: projectTasks.id,
      title: projectTasks.title,
      projectId: projectTasks.projectId,
    })
    .from(projectTasks)
    .where(
      and(eq(projectTasks.id, taskId), eq(projectTasks.agencyId, ctx.agencyId)),
    )
    .limit(1);
  if (!row) throw notFound('Task not found.');
  if (projectId && row.projectId !== projectId) {
    throw conflict('Task does not belong to the given project.');
  }
  return { id: row.id, title: row.title };
}

/** Whole minutes elapsed since `startedAt` (floored at 0). */
export function elapsedMinutes(startedAt: Date | null): number {
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 60000));
}

/** Minutes to bill for a stopped timer: at least 1, rounded to nearest. */
function billedMinutes(startedAt: Date): number {
  return Math.max(1, Math.round((Date.now() - startedAt.getTime()) / 60000));
}

type RunningTimerRow = {
  id: string;
  projectId: string;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  userId: string;
  userName: string | null;
  startedAt: Date | null;
  note: string | null;
};

const runningTimerSelection = {
  id: timers.id,
  projectId: timers.projectId,
  projectName: projects.name,
  taskId: timers.taskId,
  taskTitle: projectTasks.title,
  userId: timers.userId,
  userName: users.fullName,
  startedAt: timers.startedAt,
  note: timers.note,
};

/** Serialize a running timer (the full shape returned by start/active). */
function serializeRunning(r: RunningTimerRow) {
  return {
    id: r.id,
    projectId: r.projectId,
    projectName: r.projectName,
    taskId: r.taskId,
    taskTitle: r.taskTitle,
    userId: r.userId,
    userName: r.userName,
    startedAt: toIso(r.startedAt),
    note: r.note,
    elapsedMinutes: elapsedMinutes(r.startedAt),
  };
}

/** Fetch the current user's single running timer (joined), or null. */
async function fetchRunningTimer(
  ctx: Ctx,
  userId: string,
): Promise<RunningTimerRow | null> {
  const [row] = await db
    .select(runningTimerSelection)
    .from(timers)
    .leftJoin(projects, eq(projects.id, timers.projectId))
    .leftJoin(projectTasks, eq(projectTasks.id, timers.taskId))
    .leftJoin(users, eq(users.id, timers.userId))
    .where(and(eq(timers.agencyId, ctx.agencyId), eq(timers.userId, userId)))
    .limit(1);
  return (row as RunningTimerRow | undefined) ?? null;
}

/**
 * Resolve a task's title (for audit metadata) given a task id. Best-effort:
 * this only labels the audit log, so a failure (e.g. a transient Turso network
 * timeout) must NOT break starting/stopping a timer — degrade to null instead.
 */
async function taskTitleFor(
  ctx: Ctx,
  taskId: string | null,
): Promise<string | null> {
  if (!taskId) return null;
  try {
    const [row] = await db
      .select({ title: projectTasks.title })
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.id, taskId),
          eq(projectTasks.agencyId, ctx.agencyId),
        ),
      )
      .limit(1);
    return row?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * Stop a raw running timer row: write a time_log, delete the timer, audit it.
 * Returns the inserted minutes + timeLog id. Used by /stop and implicitly by
 * /start (auto-stop the previous timer).
 */
async function stopTimerRow(
  ctx: Ctx,
  timer: typeof timers.$inferSelect,
  taskTitle: string | null,
  ip?: string,
): Promise<{ minutes: number; timeLogId: string }> {
  const minutes = billedMinutes(timer.startedAt);
  const timeLogId = newId('tlg');
  await db.insert(timeLogs).values({
    id: timeLogId,
    agencyId: ctx.agencyId,
    userId: timer.userId,
    projectId: timer.projectId,
    taskId: timer.taskId ?? null,
    minutes,
    workDate: timer.startedAt,
    note: timer.note ?? null,
  });
  await db.delete(timers).where(eq(timers.id, timer.id));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'timer.stop',
    entityType: 'timer',
    entityId: timer.id,
    metadata: {
      projectId: timer.projectId,
      taskId: timer.taskId,
      taskTitle,
      minutes,
    },
    ip,
  });

  return { minutes, timeLogId };
}

/**
 * List ALL running timers for a project (who's working now). Exported so the
 * project-scoped routes + overview can reuse it.
 */
export async function listProjectTimers(ctx: Ctx, projectId: string) {
  const rows = await db
    .select({
      userId: timers.userId,
      userName: users.fullName,
      taskId: timers.taskId,
      taskTitle: projectTasks.title,
      startedAt: timers.startedAt,
    })
    .from(timers)
    .leftJoin(users, eq(users.id, timers.userId))
    .leftJoin(projectTasks, eq(projectTasks.id, timers.taskId))
    .where(
      and(eq(timers.agencyId, ctx.agencyId), eq(timers.projectId, projectId)),
    )
    .orderBy(desc(timers.startedAt));

  return rows.map((r) => ({
    userId: r.userId,
    userName: r.userName,
    taskId: r.taskId,
    taskTitle: r.taskTitle,
    startedAt: toIso(r.startedAt),
    elapsedMinutes: elapsedMinutes(r.startedAt),
  }));
}

// ============================================================
//  POST /timers/start
// ============================================================
const startSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1).nullable().optional(),
  note: z.string().trim().max(2000).optional(),
});

timersRouter.post('/start', async (req, res) => {
  const ctx = getAuth(req);
  const body = startSchema.parse(req.body);

  const project = await requireAgencyProject(ctx, body.projectId);
  let task: { id: string; title: string } | null = null;
  if (body.taskId) {
    task = await requireAgencyTask(ctx, body.taskId, body.projectId);
  }

  // One running timer per user: stop any existing one first (writes its log).
  const [existing] = await db
    .select()
    .from(timers)
    .where(
      and(eq(timers.agencyId, ctx.agencyId), eq(timers.userId, ctx.userId)),
    )
    .limit(1);
  if (existing) {
    const prevTitle = await taskTitleFor(ctx, existing.taskId);
    await stopTimerRow(ctx, existing, prevTitle, req.ip);
  }

  const id = newId('tmr');
  const startedAt = new Date();
  await db.insert(timers).values({
    id,
    agencyId: ctx.agencyId,
    userId: ctx.userId,
    projectId: body.projectId,
    taskId: body.taskId ?? null,
    startedAt,
    note: body.note ?? null,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'timer.start',
    entityType: 'timer',
    entityId: id,
    metadata: {
      projectId: body.projectId,
      taskId: body.taskId ?? null,
      taskTitle: task?.title ?? null,
    },
    ip: req.ip,
  });

  const running = await fetchRunningTimer(ctx, ctx.userId);
  created(
    res,
    running
      ? serializeRunning(running)
      : {
          id,
          projectId: body.projectId,
          projectName: project.name,
          taskId: body.taskId ?? null,
          taskTitle: task?.title ?? null,
          userId: ctx.userId,
          userName: null,
          startedAt: toIso(startedAt),
          note: body.note ?? null,
          elapsedMinutes: 0,
        },
  );
});

// ============================================================
//  POST /timers/stop — stop the CURRENT user's running timer
// ============================================================
timersRouter.post('/stop', async (req, res) => {
  const ctx = getAuth(req);

  const [timer] = await db
    .select()
    .from(timers)
    .where(
      and(eq(timers.agencyId, ctx.agencyId), eq(timers.userId, ctx.userId)),
    )
    .limit(1);
  if (!timer) throw notFound('No running timer.');

  const taskTitle = await taskTitleFor(ctx, timer.taskId);
  const { minutes, timeLogId } = await stopTimerRow(
    ctx,
    timer,
    taskTitle,
    req.ip,
  );

  // Re-read the inserted time-log (with project name) for the response.
  const [log] = await db
    .select({
      id: timeLogs.id,
      minutes: timeLogs.minutes,
      workDate: timeLogs.workDate,
      note: timeLogs.note,
      projectId: timeLogs.projectId,
      projectName: projects.name,
      taskId: timeLogs.taskId,
    })
    .from(timeLogs)
    .leftJoin(projects, eq(projects.id, timeLogs.projectId))
    .where(eq(timeLogs.id, timeLogId))
    .limit(1);

  ok(res, {
    stopped: true,
    minutes,
    timeLog: {
      id: log!.id,
      minutes: log!.minutes,
      workDate: toIso(log!.workDate),
      note: log!.note,
      projectId: log!.projectId,
      projectName: log!.projectName,
      taskId: log!.taskId,
      taskTitle,
    },
  });
});

// ============================================================
//  GET /timers/active — current user's running timer (or null)
// ============================================================
timersRouter.get('/active', async (req, res) => {
  const ctx = getAuth(req);
  const running = await fetchRunningTimer(ctx, ctx.userId);
  ok(res, running ? serializeRunning(running) : null);
});

// ============================================================
//  PATCH /timers/logs/:logId — edit a logged entry's note
//  (tenant-scoped; lets a user annotate a time log after stopping).
// ============================================================
const editLogSchema = z.object({
  note: z.string().trim().max(2000).nullable(),
});

timersRouter.patch('/logs/:logId', async (req, res) => {
  const ctx = getAuth(req);
  const logId = req.params.logId;
  const body = editLogSchema.parse(req.body);

  const [existing] = await db
    .select({
      id: timeLogs.id,
      projectId: timeLogs.projectId,
      taskId: timeLogs.taskId,
    })
    .from(timeLogs)
    .where(and(eq(timeLogs.id, logId), eq(timeLogs.agencyId, ctx.agencyId)))
    .limit(1);
  if (!existing) throw notFound('Time log not found.');

  const note = body.note && body.note.length > 0 ? body.note : null;
  await db.update(timeLogs).set({ note }).where(eq(timeLogs.id, logId));

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'timer.log.edit',
    entityType: 'time_log',
    entityId: logId,
    metadata: {
      projectId: existing.projectId,
      taskId: existing.taskId,
    },
    ip: req.ip,
  });

  ok(res, {
    id: logId,
    note,
    projectId: existing.projectId,
    taskId: existing.taskId,
  });
});
