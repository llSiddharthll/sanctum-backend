import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  projects,
  projectTasks,
  timeLogs,
  timers,
  users,
  attendancePolicy,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound, conflict, forbidden } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import {
  resolvePolicy,
  dayKeyInTz,
  minutesIntoDayInTz,
  isWorkingDayKey,
  weekdayForDayKey,
  type ResolvedPolicy,
} from '../lib/attendance.js';
import { authenticate, getActor, requires, requiresAny } from '../authz/http.js';
import { authorize, can, canOrg, check } from '../authz/engine.js';
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
//  TIMESHEET — day math in the agency's attendance timezone
// ============================================================
const dayKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a real date.');
const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h).');

/** Longest range a timesheet query may cover (about a quarter). */
const MAX_RANGE_DAYS = 92;

async function agencyPolicy(agencyId: string): Promise<ResolvedPolicy> {
  const [row] = await db
    .select()
    .from(attendancePolicy)
    .where(eq(attendancePolicy.agencyId, agencyId))
    .limit(1);
  return resolvePolicy(row ?? null);
}

/** Offset (ms) of `timezone` from UTC at `instant` (local wall clock − UTC). */
function tzOffsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight starting `day` in `timezone`. */
export function dayStartInTz(day: string, timezone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(new Date(guess), timezone);
  t = guess - tzOffsetMs(new Date(t), timezone); // settle across a DST edge
  return new Date(t);
}

/** `day` shifted by `n` calendar days ('YYYY-MM-DD'). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Every day key from `from` to `to` inclusive. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

interface DayRange {
  from: string;
  to: string;
  days: string[];
  start: Date;
  /** Exclusive end instant (local midnight after `to`). */
  end: Date;
}

/** Resolve ?from&to (defaults: the current Mon–Sun week in the agency tz). */
function resolveRange(
  from: string | undefined,
  to: string | undefined,
  timezone: string,
): DayRange {
  const today = dayKeyInTz(new Date(), timezone);
  const monday = addDays(today, -((weekdayForDayKey(today) + 6) % 7));
  const f = from ?? (to ? addDays(to, -6) : monday);
  const t = to ?? addDays(f, 6);
  if (f > t) throw badRequest('"from" must be on or before "to".');
  const days = daysBetween(f, t);
  if (days.length > MAX_RANGE_DAYS) {
    throw badRequest(`Pick a range of ${MAX_RANGE_DAYS} days or less.`);
  }
  return {
    from: f,
    to: t,
    days,
    start: dayStartInTz(f, timezone),
    end: dayStartInTz(addDays(t, 1), timezone),
  };
}

/** Expected minutes over the range: full-day minutes × working days. */
function targetFor(policy: ResolvedPolicy, days: string[]) {
  const workingDays = days.filter((d) => isWorkingDayKey(policy, d));
  return {
    dailyTargetMinutes: policy.fullDayMinutes,
    workingDays,
    targetMinutes: workingDays.length * policy.fullDayMinutes,
  };
}

/** A staff member of the actor's agency (404 otherwise — never leaks tenants). */
async function requireAgencyStaff(agencyId: string, userId: string) {
  const [u] = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.agencyId, agencyId), eq(users.kind, 'staff')))
    .limit(1);
  if (!u) throw notFound('Team member not found.');
  return u;
}

const logSelection = {
  id: timeLogs.id,
  userId: timeLogs.userId,
  userName: users.fullName,
  projectId: timeLogs.projectId,
  projectName: projects.name,
  clientName: clients.name,
  taskId: timeLogs.taskId,
  taskTitle: projectTasks.title,
  minutes: timeLogs.minutes,
  workDate: timeLogs.workDate,
  note: timeLogs.note,
  createdAt: timeLogs.createdAt,
};

type LogRow = {
  id: string;
  userId: string;
  userName: string | null;
  projectId: string | null;
  projectName: string | null;
  clientName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  minutes: number;
  workDate: Date;
  note: string | null;
  createdAt: Date;
};

function logQuery() {
  return db
    .select(logSelection)
    .from(timeLogs)
    .leftJoin(users, eq(users.id, timeLogs.userId))
    .leftJoin(projects, eq(projects.id, timeLogs.projectId))
    .leftJoin(clients, eq(clients.id, projects.clientId))
    .leftJoin(projectTasks, eq(projectTasks.id, timeLogs.taskId));
}

function serializeLog(actor: Actor, r: LogRow, timezone: string) {
  const facts = { agencyId: actor.agencyId, ownerIds: [r.userId] };
  return {
    id: r.id,
    userId: r.userId,
    userName: r.userName,
    projectId: r.projectId,
    projectName: r.projectName,
    clientName: r.clientName,
    taskId: r.taskId,
    taskTitle: r.taskTitle,
    minutes: r.minutes,
    workDate: toIso(r.workDate),
    day: dayKeyInTz(r.workDate, timezone),
    note: r.note,
    createdAt: toIso(r.createdAt),
    capabilities: {
      'time_logs.update': check(actor, 'time_logs.update', facts),
      'time_logs.delete': check(actor, 'time_logs.delete', facts),
    },
  };
}

async function fetchLog(actor: Actor, logId: string): Promise<LogRow | null> {
  const [row] = await logQuery()
    .where(and(eq(timeLogs.id, logId), eq(timeLogs.agencyId, actor.agencyId)))
    .limit(1);
  return (row as LogRow | undefined) ?? null;
}

/** The project (projects.view) and optional task (tasks.view, in that project). */
async function requireLoggableTarget(
  actor: Actor,
  projectId: string,
  taskId: string | null | undefined,
): Promise<void> {
  const pf = await projectFacts(actor, projectId);
  authorize(actor, 'projects.view', pf);
  if (taskId) {
    const tf = await taskFacts(actor, taskId);
    authorize(actor, 'tasks.view', tf);
    if (tf!.task.projectId !== projectId) {
      throw conflict('Task does not belong to the given project.');
    }
  }
}

/** May the actor see their OWN time (self-service via timers.use, or time_logs.view own). */
function canSeeOwnTime(actor: Actor, uid: string): boolean {
  return (
    can(actor, 'timers.use') ||
    check(actor, 'time_logs.view', { agencyId: actor.agencyId, ownerIds: [uid] })
  );
}

// ============================================================
//  GET /timers/logs?from&to[&userId] — a person's time entries over a range
//  (default: this Mon–Sun week, agency timezone), across every project.
//  Own entries: timers.use or time_logs.view (own). Someone else's: only with
//  organization-wide time_logs.view (managers/owners), same agency only.
// ============================================================
const logsQuerySchema = z.object({
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
  userId: z.string().min(1).optional(),
});

timersRouter.get('/logs', requiresAny('timers.use', 'time_logs.view'), async (req, res) => {
  const actor = getActor(req);
  const uid = requireUserId(actor);
  const q = logsQuerySchema.parse(req.query);
  const policy = await agencyPolicy(actor.agencyId);
  const range = resolveRange(q.from, q.to, policy.timezone);

  const targetId = q.userId ?? uid;
  let person: { id: string; fullName: string | null };
  if (targetId === uid) {
    if (!canSeeOwnTime(actor, uid)) throw forbidden('You cannot view time logs.');
    person = await requireAgencyStaff(actor.agencyId, uid);
  } else {
    if (!canOrg(actor, 'time_logs.view')) {
      throw forbidden("Only managers can see other people's time.");
    }
    person = await requireAgencyStaff(actor.agencyId, targetId);
  }

  const rows = (await logQuery()
    .where(
      and(
        eq(timeLogs.agencyId, actor.agencyId),
        eq(timeLogs.userId, targetId),
        gte(timeLogs.workDate, range.start),
        lt(timeLogs.workDate, range.end),
      ),
    )
    .orderBy(desc(timeLogs.workDate), desc(timeLogs.createdAt))) as LogRow[];

  const logs = rows.map((r) => serializeLog(actor, r, policy.timezone));
  const perDay = new Map(range.days.map((d) => [d, 0]));
  for (const l of logs) perDay.set(l.day, (perDay.get(l.day) ?? 0) + l.minutes);

  ok(res, {
    from: range.from,
    to: range.to,
    timezone: policy.timezone,
    ...targetFor(policy, range.days),
    user: { id: person.id, name: person.fullName },
    totalMinutes: logs.reduce((s, l) => s + l.minutes, 0),
    days: range.days.map((date) => ({ date, minutes: perDay.get(date) ?? 0 })),
    logs,
  });
});

// ============================================================
//  GET /timers/summary?from&to — team view: per-person and per-day totals.
//  Organization-wide time_logs.view only (managers/owners). Running timers
//  are included per person when the actor also has timers.view (organization).
// ============================================================
const summaryQuerySchema = z.object({
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
});

timersRouter.get('/summary', requires('time_logs.view'), async (req, res) => {
  const actor = getActor(req);
  if (!canOrg(actor, 'time_logs.view')) {
    throw forbidden('Only managers can see the team timesheet.');
  }
  const q = summaryQuerySchema.parse(req.query);
  const policy = await agencyPolicy(actor.agencyId);
  const range = resolveRange(q.from, q.to, policy.timezone);

  const staff = await db
    .select({ id: users.id, fullName: users.fullName, status: users.status })
    .from(users)
    .where(and(eq(users.agencyId, actor.agencyId), eq(users.kind, 'staff')))
    .orderBy(asc(users.fullName));

  const rows = await db
    .select({ userId: timeLogs.userId, minutes: timeLogs.minutes, workDate: timeLogs.workDate })
    .from(timeLogs)
    .where(
      and(
        eq(timeLogs.agencyId, actor.agencyId),
        gte(timeLogs.workDate, range.start),
        lt(timeLogs.workDate, range.end),
      ),
    );

  type Person = {
    userId: string;
    name: string | null;
    totalMinutes: number;
    entries: number;
    days: Record<string, number>;
    running: { projectName: string | null; taskTitle: string | null; startedAt: string | null } | null;
  };
  const blankDays = () => Object.fromEntries(range.days.map((d) => [d, 0])) as Record<string, number>;
  const people = new Map<string, Person>();
  for (const u of staff) {
    if (u.status !== 'active') continue;
    people.set(u.id, { userId: u.id, name: u.fullName, totalMinutes: 0, entries: 0, days: blankDays(), running: null });
  }
  const names = new Map(staff.map((u) => [u.id, u.fullName]));
  const perDay = new Map(range.days.map((d) => [d, 0]));
  for (const r of rows) {
    let p = people.get(r.userId);
    if (!p) {
      // Logged time by someone since disabled: still counts toward the totals.
      p = { userId: r.userId, name: names.get(r.userId) ?? null, totalMinutes: 0, entries: 0, days: blankDays(), running: null };
      people.set(r.userId, p);
    }
    const day = dayKeyInTz(r.workDate, policy.timezone);
    p.totalMinutes += r.minutes;
    p.entries += 1;
    p.days[day] = (p.days[day] ?? 0) + r.minutes;
    perDay.set(day, (perDay.get(day) ?? 0) + r.minutes);
  }

  if (canOrg(actor, 'timers.view')) {
    const running = await db
      .select({
        userId: timers.userId,
        projectName: projects.name,
        taskTitle: projectTasks.title,
        startedAt: timers.startedAt,
      })
      .from(timers)
      .leftJoin(projects, eq(projects.id, timers.projectId))
      .leftJoin(projectTasks, eq(projectTasks.id, timers.taskId))
      .where(eq(timers.agencyId, actor.agencyId));
    for (const t of running) {
      const p = people.get(t.userId);
      if (p) p.running = { projectName: t.projectName, taskTitle: t.taskTitle, startedAt: toIso(t.startedAt) };
    }
  }

  const list = [...people.values()].sort(
    (a, b) => b.totalMinutes - a.totalMinutes || (a.name ?? '').localeCompare(b.name ?? ''),
  );
  ok(res, {
    from: range.from,
    to: range.to,
    timezone: policy.timezone,
    ...targetFor(policy, range.days),
    totalMinutes: list.reduce((s, p) => s + p.totalMinutes, 0),
    days: range.days.map((date) => ({ date, minutes: perDay.get(date) ?? 0 })),
    people: list,
  });
});

// ============================================================
//  POST /timers/logs — add a manual entry for YOURSELF (forgot the timer).
//  Self-service like the timer itself: timers.use, or time_logs.create (own).
//  Give `minutes`, or `startTime` + `endTime` (HH:MM, agency timezone).
// ============================================================
const createLogSchema = z
  .object({
    projectId: z.string().min(1),
    taskId: z.string().min(1).nullable().optional(),
    date: dayKeySchema,
    minutes: z.number().int().min(1).max(1440).optional(),
    startTime: clockSchema.optional(),
    endTime: clockSchema.optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.startTime || b.endTime) {
      if (!b.startTime || !b.endTime) {
        ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'Give both a start and an end time.' });
      } else if (b.endTime <= b.startTime) {
        ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'End time must be after the start time.' });
      }
    } else if (b.minutes == null) {
      ctx.addIssue({ code: 'custom', path: ['minutes'], message: 'Give the time spent, or a start and end time.' });
    }
  });

function clockToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

timersRouter.post('/logs', requiresAny('timers.use', 'time_logs.create'), async (req, res) => {
  const actor = getActor(req);
  const uid = requireUserId(actor);
  const allowed =
    can(actor, 'timers.use') ||
    check(actor, 'time_logs.create', { agencyId: actor.agencyId, ownerIds: [uid] });
  if (!allowed) throw forbidden('You cannot log time.');
  const body = createLogSchema.parse(req.body);
  const policy = await agencyPolicy(actor.agencyId);

  if (body.date > dayKeyInTz(new Date(), policy.timezone)) {
    throw badRequest("You can't log time for a future date.");
  }
  await requireLoggableTarget(actor, body.projectId, body.taskId);

  const startMin = body.startTime ? clockToMinutes(body.startTime) : null;
  const minutes =
    body.startTime && body.endTime
      ? clockToMinutes(body.endTime) - clockToMinutes(body.startTime)
      : body.minutes!;
  // Anchor the entry inside its day: at the start time, else midday.
  const workDate = new Date(
    dayStartInTz(body.date, policy.timezone).getTime() + (startMin ?? 12 * 60) * 60000,
  );

  const id = newId('tlg');
  const note = body.note && body.note.length > 0 ? body.note : null;
  await db.insert(timeLogs).values({
    id,
    agencyId: actor.agencyId,
    userId: uid,
    projectId: body.projectId,
    taskId: body.taskId ?? null,
    minutes,
    workDate,
    note,
  });
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: 'timer.log.create',
    entityType: 'time_log',
    entityId: id,
    metadata: { projectId: body.projectId, taskId: body.taskId ?? null, minutes, manual: true },
    ip: req.ip,
  });

  const row = await fetchLog(actor, id);
  created(res, serializeLog(actor, row!, policy.timezone));
});

// ============================================================
//  PATCH /timers/logs/:logId — edit an entry (note, time spent, date,
//  project/task). time_logs.update on the log (own, or organization).
// ============================================================
const editLogSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
  minutes: z.number().int().min(1).max(1440).optional(),
  date: dayKeySchema.optional(),
  projectId: z.string().min(1).optional(),
  taskId: z.string().min(1).nullable().optional(),
});

timersRouter.patch('/logs/:logId', requires('time_logs.update'), async (req, res) => {
  const actor = getActor(req);
  const logId = param(req, 'logId');
  const facts = await timeLogFacts(actor, logId);
  authorize(actor, 'time_logs.update', facts, { view: 'time_logs.view' });
  const existing = facts!.log;
  const body = editLogSchema.parse(req.body);
  const policy = await agencyPolicy(actor.agencyId);

  const patch: Partial<typeof timeLogs.$inferInsert> = {};
  if (body.note !== undefined) patch.note = body.note && body.note.length > 0 ? body.note : null;
  if (body.minutes !== undefined) patch.minutes = body.minutes;
  if (body.date !== undefined) {
    if (body.date > dayKeyInTz(new Date(), policy.timezone)) {
      throw badRequest("You can't log time for a future date.");
    }
    // Keep the entry's time of day; move it to the new date.
    const minuteOfDay = minutesIntoDayInTz(existing.workDate, policy.timezone);
    patch.workDate = new Date(dayStartInTz(body.date, policy.timezone).getTime() + minuteOfDay * 60000);
  }
  const projectChanged = body.projectId !== undefined && body.projectId !== existing.projectId;
  if (projectChanged || body.taskId !== undefined) {
    const projectId = body.projectId ?? existing.projectId;
    if (!projectId) throw badRequest('Pick a project for this entry.');
    // A task that isn't in the new project is dropped unless a new one is given.
    const taskId = body.taskId !== undefined ? body.taskId : projectChanged ? null : existing.taskId;
    await requireLoggableTarget(actor, projectId, taskId);
    patch.projectId = projectId;
    patch.taskId = taskId ?? null;
  }

  if (Object.keys(patch).length > 0) {
    await db
      .update(timeLogs)
      .set(patch)
      .where(and(eq(timeLogs.id, logId), eq(timeLogs.agencyId, actor.agencyId)));
  }

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: 'timer.log.edit',
    entityType: 'time_log',
    entityId: logId,
    metadata: {
      projectId: patch.projectId ?? existing.projectId,
      taskId: patch.taskId !== undefined ? patch.taskId : existing.taskId,
      fields: Object.keys(patch),
      ...(patch.minutes !== undefined ? { minutes: patch.minutes, previousMinutes: existing.minutes } : {}),
      ...(existing.userId !== actorUserId(actor) ? { logUserId: existing.userId } : {}),
    },
    ip: req.ip,
  });

  const row = await fetchLog(actor, logId);
  ok(res, serializeLog(actor, row!, policy.timezone));
});

// ============================================================
//  DELETE /timers/logs/:logId — remove an entry.
//  time_logs.delete on the log (own, or organization).
// ============================================================
timersRouter.delete('/logs/:logId', requires('time_logs.delete'), async (req, res) => {
  const actor = getActor(req);
  const logId = param(req, 'logId');
  const facts = await timeLogFacts(actor, logId);
  authorize(actor, 'time_logs.delete', facts, { view: 'time_logs.view' });
  const existing = facts!.log;

  await db
    .delete(timeLogs)
    .where(and(eq(timeLogs.id, logId), eq(timeLogs.agencyId, actor.agencyId)));

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: 'timer.log.delete',
    entityType: 'time_log',
    entityId: logId,
    metadata: {
      projectId: existing.projectId,
      taskId: existing.taskId,
      minutes: existing.minutes,
      ...(existing.userId !== actorUserId(actor) ? { logUserId: existing.userId } : {}),
    },
    ip: req.ip,
  });

  ok(res, { id: logId, deleted: true });
});
