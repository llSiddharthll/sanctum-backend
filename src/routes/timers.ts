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
  attendancePolicy,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { notFound, conflict, forbidden } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import {
  resolvePolicy,
  dayKeyInTz,
  minutesIntoDayInTz,
  type ResolvedPolicy,
} from '../lib/attendance.js';
import { authenticate, getActor, requires } from '../authz/http.js';
import { authorize, check } from '../authz/engine.js';
import {
  actorAuditId,
  actorUserId,
  systemActor,
  type Actor,
} from '../authz/actor.js';
import {
  projectFacts,
  taskFacts,
  timeLogFacts,
  timerScopeFilter,
} from '../authz/policies/projects.js';

export const timersRouter = Router();
// Every route declares its permission; timers.use is own-only self-service
// (start/stop/read the caller's own timer). Editing a time log is authorized
// on the log itself (time_logs.update: own or organization).
timersRouter.use(authenticate);

/**
 * Who performed a timer write, for auditing. Accepts an engine Actor or the
 * legacy `{ agencyId, userId, role }` context still passed by un-migrated
 * callers (attendance check-out). TODO(authz phase 10): Actor only.
 */
export type TimerPrincipal = Actor | { agencyId: string; userId: string; role?: string };

function isActor(p: TimerPrincipal): p is Actor {
  return 'type' in p && 'grants' in p;
}

function principalAudit(p: TimerPrincipal): {
  agencyId: string;
  actorType: Actor['type'];
  actorId: string;
  userId: string | null;
} {
  if (isActor(p)) {
    return { agencyId: p.agencyId, actorType: p.type, actorId: actorAuditId(p), userId: actorUserId(p) };
  }
  return { agencyId: p.agencyId, actorType: 'staff', actorId: p.userId, userId: p.userId };
}

/** The staff user behind a timer request (timers are per user). */
function requireUserId(actor: Actor): string {
  const uid = actorUserId(actor);
  if (!uid || actor.type !== 'staff') throw forbidden('Only team members track time.');
  return uid;
}

/** System principal that closes timers it does not own (explicit minimal grants). */
function timerSystemActor(job: string, agencyId: string) {
  return systemActor(job, agencyId, [{ permission: 'time_logs.create', scope: 'organization' }]);
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

/** Fetch a user's single running timer (joined), or null. */
async function fetchRunningTimer(
  agencyId: string,
  userId: string,
): Promise<RunningTimerRow | null> {
  const [row] = await db
    .select(runningTimerSelection)
    .from(timers)
    .leftJoin(projects, eq(projects.id, timers.projectId))
    .leftJoin(projectTasks, eq(projectTasks.id, timers.taskId))
    .leftJoin(users, eq(users.id, timers.userId))
    .where(and(eq(timers.agencyId, agencyId), eq(timers.userId, userId)))
    .limit(1);
  return (row as RunningTimerRow | undefined) ?? null;
}

/**
 * Resolve a task's title (for audit metadata) given a task id. Best-effort:
 * this only labels the audit log, so a failure (e.g. a transient Turso network
 * timeout) must NOT break starting/stopping a timer — degrade to null instead.
 */
async function taskTitleFor(
  agencyId: string,
  taskId: string | null,
): Promise<string | null> {
  if (!taskId) return null;
  try {
    const [row] = await db
      .select({ title: projectTasks.title })
      .from(projectTasks)
      .where(and(eq(projectTasks.id, taskId), eq(projectTasks.agencyId, agencyId)))
      .limit(1);
    return row?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * Stop a raw running timer row: write a time_log for the timer's OWNER, delete
 * the timer, audit it as `principal` (the owner themself, or a system actor
 * when closing someone else's timer). Returns the inserted minutes + log id.
 */
async function stopTimerRow(
  principal: TimerPrincipal,
  timer: typeof timers.$inferSelect,
  taskTitle: string | null,
  ip?: string,
  /** Cap the billed time at this instant (e.g. checkout / shift end) instead of
   * "now" — used to auto-close forgotten timers without runaway hours. */
  endAt?: Date,
  extraMeta: Record<string, unknown> = {},
): Promise<{ minutes: number; timeLogId: string }> {
  const who = principalAudit(principal);
  const minutes =
    endAt && timer.startedAt
      ? Math.max(
          1,
          Math.round((endAt.getTime() - timer.startedAt.getTime()) / 60000),
        )
      : billedMinutes(timer.startedAt);
  const timeLogId = newId('tlg');
  await db.insert(timeLogs).values({
    id: timeLogId,
    agencyId: timer.agencyId,
    userId: timer.userId,
    projectId: timer.projectId,
    taskId: timer.taskId ?? null,
    minutes,
    workDate: timer.startedAt,
    note: timer.note ?? null,
  });
  await db
    .delete(timers)
    .where(and(eq(timers.id, timer.id), eq(timers.agencyId, timer.agencyId)));

  await audit({
    agencyId: timer.agencyId,
    actorType: who.actorType,
    actorId: who.actorId,
    action: 'timer.stop',
    entityType: 'timer',
    entityId: timer.id,
    metadata: {
      projectId: timer.projectId,
      taskId: timer.taskId,
      taskTitle,
      minutes,
      ...(timer.userId !== who.userId ? { timerUserId: timer.userId } : {}),
      ...extraMeta,
    },
    ip,
  });

  return { minutes, timeLogId };
}

/**
 * Stop EVERY running timer attached to a task (across all users) — used when a
 * task is marked complete. The caller's own timer is stopped as the caller;
 * other users' timers are closed by a SYSTEM actor (audited with actorType
 * 'system' and the triggering principal recorded), never as the caller.
 * Each timer is committed to a time_log for its own owner.
 */
export async function stopTimersForTask(
  actor: Actor,
  taskId: string,
  taskTitle: string | null,
): Promise<number> {
  const running = await db
    .select()
    .from(timers)
    .where(and(eq(timers.agencyId, actor.agencyId), eq(timers.taskId, taskId)));
  const uid = actorUserId(actor);
  const sys = timerSystemActor('task_completion', actor.agencyId);
  let stopped = 0;
  for (const timer of running) {
    if (timer.userId === uid) {
      await stopTimerRow(actor, timer, taskTitle);
    } else {
      if (!check(sys, 'time_logs.create', { agencyId: timer.agencyId, ownerIds: [timer.userId] })) continue;
      await stopTimerRow(sys, timer, taskTitle, undefined, undefined, {
        reason: 'task_completed',
        triggeredBy: actorAuditId(actor),
      });
    }
    stopped += 1;
  }
  return stopped;
}

/**
 * Stop every running timer for a user, billing each only up to `endAt` (their
 * checkout instant). Called on check-out so a timer left running doesn't keep
 * accruing after the person has gone home. Self only: the principal must be
 * the timer owner (otherwise nothing is stopped).
 */
export async function stopTimersForUser(
  principal: TimerPrincipal,
  userId: string,
  endAt: Date,
): Promise<number> {
  const who = principalAudit(principal);
  if (who.userId !== userId) return 0;
  const running = await db
    .select()
    .from(timers)
    .where(and(eq(timers.agencyId, who.agencyId), eq(timers.userId, userId)));
  for (const timer of running) {
    await stopTimerRow(principal, timer, null, undefined, endAt);
  }
  return running.length;
}

/**
 * Shift-end safety sweep (cron): auto-close any timer still running past its
 * start-day's shift end — for people who forgot to stop it AND to check out.
 * Each timer is billed only up to the shift end, so an overnight / runaway
 * timer can never corrupt the totals. Runs as a per-agency SYSTEM actor.
 */
export async function sweepStaleTimers(): Promise<number> {
  const running = await db.select().from(timers);
  if (running.length === 0) return 0;

  const policyCache = new Map<string, ResolvedPolicy>();
  const now = new Date();
  let closed = 0;

  for (const timer of running) {
    try {
      if (!timer.startedAt) continue;
      let policy = policyCache.get(timer.agencyId);
      if (!policy) {
        const [row] = await db
          .select()
          .from(attendancePolicy)
          .where(eq(attendancePolicy.agencyId, timer.agencyId))
          .limit(1);
        policy = resolvePolicy(row ?? null);
        policyCache.set(timer.agencyId, policy);
      }

      const startDay = dayKeyInTz(timer.startedAt, policy.timezone);
      const nowDay = dayKeyInTz(now, policy.timezone);
      const startLocalMin = minutesIntoDayInTz(timer.startedAt, policy.timezone);
      const nowLocalMin = minutesIntoDayInTz(now, policy.timezone);

      // Past the start-day's shift end? (any later day always is.)
      const pastShiftEnd =
        startDay < nowDay ||
        (startDay === nowDay && nowLocalMin >= policy.shiftEndMin);
      if (!pastShiftEnd) continue;

      const elapsed = Math.max(
        1,
        Math.round((now.getTime() - timer.startedAt.getTime()) / 60000),
      );
      const untilShiftEnd = policy.shiftEndMin - startLocalMin;
      const capMinutes =
        untilShiftEnd > 0
          ? Math.min(elapsed, untilShiftEnd)
          : Math.min(elapsed, policy.fullDayMinutes); // started after hours
      const endAt = new Date(timer.startedAt.getTime() + capMinutes * 60000);

      const sys = timerSystemActor('timer_sweep', timer.agencyId);
      await stopTimerRow(sys, timer, null, undefined, endAt, { reason: 'shift_end' });
      closed += 1;
    } catch {
      /* keep sweeping the rest */
    }
  }
  return closed;
}

/**
 * Running timers for a project that the actor may see (own always; others via
 * timers.view scope). Exported for the project-scoped routes + overview.
 */
export async function listProjectTimers(actor: Actor, projectId: string) {
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
      and(
        eq(timers.agencyId, actor.agencyId),
        eq(timers.projectId, projectId),
        timerScopeFilter(actor),
      ),
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
//  POST /timers/start — timers.use (own). The project (projects.view) and
//  task (tasks.view) must be visible to the caller.
// ============================================================
const startSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1).nullable().optional(),
  note: z.string().trim().max(2000).optional(),
});

timersRouter.post('/start', requires('timers.use'), async (req, res) => {
  const actor = getActor(req);
  const uid = requireUserId(actor);
  const body = startSchema.parse(req.body);

  const pf = await projectFacts(actor, body.projectId);
  authorize(actor, 'projects.view', pf);
  const [project] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, body.projectId), eq(projects.agencyId, actor.agencyId)))
    .limit(1);
  if (!project) throw notFound('Project not found.');

  let task: { id: string; title: string } | null = null;
  if (body.taskId) {
    const tf = await taskFacts(actor, body.taskId);
    authorize(actor, 'tasks.view', tf);
    if (tf!.task.projectId !== body.projectId) {
      throw conflict('Task does not belong to the given project.');
    }
    task = { id: tf!.task.id, title: tf!.task.title };
  }

  // One running timer per user: stop any existing one first (writes its log).
  const [existing] = await db
    .select()
    .from(timers)
    .where(and(eq(timers.agencyId, actor.agencyId), eq(timers.userId, uid)))
    .limit(1);
  if (existing) {
    const prevTitle = await taskTitleFor(actor.agencyId, existing.taskId);
    await stopTimerRow(actor, existing, prevTitle, req.ip);
  }

  const id = newId('tmr');
  const startedAt = new Date();
  await db.insert(timers).values({
    id,
    agencyId: actor.agencyId,
    userId: uid,
    projectId: body.projectId,
    taskId: body.taskId ?? null,
    startedAt,
    note: body.note ?? null,
  });

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
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

  const running = await fetchRunningTimer(actor.agencyId, uid);
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
          userId: uid,
          userName: null,
          startedAt: toIso(startedAt),
          note: body.note ?? null,
          elapsedMinutes: 0,
        },
  );
});

// ============================================================
//  POST /timers/stop — timers.use: stop the CURRENT user's running timer
// ============================================================
timersRouter.post('/stop', requires('timers.use'), async (req, res) => {
  const actor = getActor(req);
  const uid = requireUserId(actor);

  const [timer] = await db
    .select()
    .from(timers)
    .where(and(eq(timers.agencyId, actor.agencyId), eq(timers.userId, uid)))
    .limit(1);
  if (!timer) throw notFound('No running timer.');

  const taskTitle = await taskTitleFor(actor.agencyId, timer.taskId);
  const { minutes, timeLogId } = await stopTimerRow(actor, timer, taskTitle, req.ip);

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
    .where(and(eq(timeLogs.id, timeLogId), eq(timeLogs.agencyId, actor.agencyId)))
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
//  GET /timers/active — timers.use: current user's running timer (or null)
// ============================================================
timersRouter.get('/active', requires('timers.use'), async (req, res) => {
  const actor = getActor(req);
  const uid = requireUserId(actor);
  const running = await fetchRunningTimer(actor.agencyId, uid);
  ok(res, running ? serializeRunning(running) : null);
});

// ============================================================
//  PATCH /timers/logs/:logId — edit a logged entry's note.
//  time_logs.update on the log (own, or organization).
// ============================================================
const editLogSchema = z.object({
  note: z.string().trim().max(2000).nullable(),
});

timersRouter.patch('/logs/:logId', requires('time_logs.update'), async (req, res) => {
  const actor = getActor(req);
  const logId = param(req, 'logId');
  const facts = await timeLogFacts(actor, logId);
  authorize(actor, 'time_logs.update', facts, { view: 'time_logs.view' });
  const existing = facts!.log;
  const body = editLogSchema.parse(req.body);

  const note = body.note && body.note.length > 0 ? body.note : null;
  await db
    .update(timeLogs)
    .set({ note })
    .where(and(eq(timeLogs.id, logId), eq(timeLogs.agencyId, actor.agencyId)));

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: 'timer.log.edit',
    entityType: 'time_log',
    entityId: logId,
    metadata: {
      projectId: existing.projectId,
      taskId: existing.taskId,
      ...(existing.userId !== actorUserId(actor) ? { logUserId: existing.userId } : {}),
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
