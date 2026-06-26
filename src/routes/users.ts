import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  clientAssignments,
  customRoles,
  invites,
  projectMembers,
  projectTasks,
  projects,
  timeLogs,
  users,
} from '../db/schema.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId, newOpaqueToken } from '../lib/ids.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { env } from '../env.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getAuth, isPrivileged, requireClientAccess } from '../middleware/tenant.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { audit } from '../services/audit.js';
import {
  resolvePermissions,
  serializeOverrides,
  sanitizeOverrides,
  parseOverrides,
} from '../lib/permissions.js';
import crypto from 'node:crypto';

export const usersRouter = Router();
usersRouter.use(requireAuth);
// Module gate: GET needs `view`, writes need `manage` on the Team module.
usersRouter.use(requireModuleRW('team'));

const FRONTEND_ORIGIN = env.FRONTEND_ORIGIN || 'http://localhost:3000';

// ---- Helpers -------------------------------------------------

/** Split a stored comma-separated skills string into a trimmed array. */
function parseSkills(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Normalize a csv-string OR string[] of skills down to a stored csv string. */
function skillsToCsv(input: string | string[] | undefined): string | undefined {
  if (input === undefined) return undefined;
  const arr = Array.isArray(input) ? input : input.split(',');
  return arr
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(',');
}

/** UTC start-of-week (Monday 00:00:00) for "this week" worklog windows. */
function startOfWeek(d = new Date()): Date {
  const day = d.getUTCDay(); // 0 = Sun ... 6 = Sat
  const diff = (day + 6) % 7; // days since Monday
  const start = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() - diff);
  return start;
}

/** Round a utilization percentage, guarding against zero capacity. */
function utilizationPct(loggedMinutes: number, weeklyCapacityHrs: number): number {
  const capacityMin = (weeklyCapacityHrs ?? 0) * 60;
  if (!capacityMin) return 0;
  return Math.round((loggedMinutes / capacityMin) * 100);
}

const memberBaseSelection = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  role: users.role,
  status: users.status,
  lastLoginAt: users.lastLoginAt,
  designation: users.designation,
  department: users.department,
  phone: users.phone,
  hourlyRate: users.hourlyRate,
  weeklyCapacityHrs: users.weeklyCapacityHrs,
  skills: users.skills,
  permissionsJson: users.permissionsJson,
  customRoleId: users.customRoleId,
  createdAt: users.createdAt,
};

type MemberBaseRow = {
  id: string;
  email: string;
  fullName: string | null;
  role: 'owner' | 'admin' | 'member';
  status: 'active' | 'disabled';
  lastLoginAt: Date | null;
  designation: string | null;
  department: string | null;
  phone: string | null;
  hourlyRate: number | null;
  weeklyCapacityHrs: number;
  skills: string | null;
  permissionsJson: string | null;
  customRoleId: string | null;
  createdAt: Date | null;
};

function builtinRoleLabel(role: 'owner' | 'admin' | 'member'): string {
  return role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member';
}

/** Common profile fields shared by list rows and the detail view. */
function profileFields(
  u: MemberBaseRow,
  roleDefaults?: string | null,
  customRolePermsJson?: string | null,
  customRoleName?: string | null,
) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    customRoleId: u.customRoleId,
    roleName: customRoleName ?? builtinRoleLabel(u.role),
    status: u.status,
    lastLoginAt: toIso(u.lastLoginAt),
    designation: u.designation,
    department: u.department,
    phone: u.phone,
    hourlyRate: u.hourlyRate,
    weeklyCapacityHrs: u.weeklyCapacityHrs ?? 0,
    skills: parseSkills(u.skills),
    // Effective: user override > custom role > agency role default > built-in.
    permissions: resolvePermissions(
      u.role,
      u.permissionsJson,
      roleDefaults ?? null,
      customRolePermsJson ?? null,
    ),
    joinedAt: toIso(u.createdAt),
  };
}

/** Fetch the agency's stored role-permission defaults JSON (or null). */
async function getAgencyRoleDefaults(agencyId: string): Promise<string | null> {
  const [row] = await db
    .select({ rolePermissionsJson: agencies.rolePermissionsJson })
    .from(agencies)
    .where(eq(agencies.id, agencyId))
    .limit(1);
  return row?.rolePermissionsJson ?? null;
}

// ============================================================
//  GET /team — list members (ARRAY shape — consumers depend on it)
// ============================================================
const listQuery = z.object({
  role: z.enum(['owner', 'admin', 'member']).optional(),
  search: z.string().optional(),
  activeOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional(),
});

usersRouter.get('/', async (req, res) => {
  const ctx = getAuth(req);
  const q = listQuery.parse(req.query);
  const weekStart = startOfWeek();

  const filters = [eq(users.agencyId, ctx.agencyId)];
  if (q.role) filters.push(eq(users.role, q.role));
  if (q.activeOnly === true || q.activeOnly === 'true') {
    filters.push(eq(users.status, 'active'));
  }
  if (q.search && q.search.trim()) {
    const term = `%${q.search.trim().toLowerCase()}%`;
    filters.push(
      sql`(
        lower(coalesce(${users.fullName}, '')) like ${term}
        or lower(${users.email}) like ${term}
        or lower(coalesce(${users.designation}, '')) like ${term}
      )`,
    );
  }

  const baseRows = await db
    .select({
      ...memberBaseSelection,
      customRolePermsJson: customRoles.permissionsJson,
      customRoleName: customRoles.name,
    })
    .from(users)
    .leftJoin(customRoles, eq(customRoles.id, users.customRoleId))
    .where(and(...filters))
    .orderBy(desc(users.createdAt));

  const roleDefaults = await getAgencyRoleDefaults(ctx.agencyId);

  // Per-user aggregates via plain grouped queries. (The earlier correlated
  // subqueries didn't bind the outer user row, so every count came back 0.)
  const ids = baseRows.map((u) => u.id);
  const taskCount = new Map<string, number>();
  const projectIds = new Map<string, Set<string>>();
  const weekMinutes = new Map<string, number>();
  const ensure = (m: Map<string, Set<string>>, k: string) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set<string>()));
    return s;
  };

  if (ids.length) {
    const weekStartSec = Math.floor(weekStart.getTime() / 1000);

    const taskRows = await db
      .select({
        uid: projectTasks.assigneeId,
        pid: projectTasks.projectId,
        status: projectTasks.status,
      })
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.agencyId, ctx.agencyId),
          inArray(projectTasks.assigneeId, ids),
        ),
      );
    for (const r of taskRows) {
      if (!r.uid) continue;
      if (r.status !== 'done') {
        taskCount.set(r.uid, (taskCount.get(r.uid) ?? 0) + 1);
      }
      ensure(projectIds, r.uid).add(r.pid);
    }

    const memberRows = await db
      .select({ uid: projectMembers.userId, pid: projectMembers.projectId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.agencyId, ctx.agencyId),
          inArray(projectMembers.userId, ids),
        ),
      );
    for (const r of memberRows) ensure(projectIds, r.uid).add(r.pid);

    const logRows = await db
      .select({ uid: timeLogs.userId, minutes: timeLogs.minutes })
      .from(timeLogs)
      .where(
        and(
          eq(timeLogs.agencyId, ctx.agencyId),
          inArray(timeLogs.userId, ids),
          sql`${timeLogs.workDate} >= ${weekStartSec}`,
        ),
      );
    for (const r of logRows) {
      weekMinutes.set(r.uid, (weekMinutes.get(r.uid) ?? 0) + Number(r.minutes ?? 0));
    }
  }

  ok(
    res,
    baseRows.map((u) => {
      const loggedMinutesThisWeek = weekMinutes.get(u.id) ?? 0;
      return {
        ...profileFields(
          u as MemberBaseRow,
          roleDefaults,
          u.customRolePermsJson,
          u.customRoleName,
        ),
        activeTaskCount: taskCount.get(u.id) ?? 0,
        projectCount: projectIds.get(u.id)?.size ?? 0,
        loggedMinutesThisWeek,
        utilizationPct: utilizationPct(
          loggedMinutesThisWeek,
          u.weeklyCapacityHrs ?? 0,
        ),
      };
    }),
  );
});

// ============================================================
//  POST /team/invite — create a real (active) member + an invite token
// ============================================================
const inviteSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.string().email(),
  role: z.enum(['admin', 'member']).default('member'),
  phone: z.string().trim().max(40).optional(),
  designation: z.string().trim().max(120).optional(),
  department: z.string().trim().max(120).optional(),
  hourlyRate: z.number().int().min(0).optional(),
  weeklyCapacityHrs: z.number().int().min(0).max(168).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  // Optional module permission overrides ({ moduleKey: 'none'|'view'|'manage' }).
  permissions: z.record(z.string(), z.string()).optional(),
});

usersRouter.post('/invite', requireRole('owner', 'admin'), async (req, res) => {
  const ctx = getAuth(req);
  const body = inviteSchema.parse(req.body);
  const email = body.email.toLowerCase();

  // Enforce the unique (agencyId, lower(email)) up front for a clean 409.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.agencyId, ctx.agencyId),
        sql`lower(${users.email}) = ${email}`,
      ),
    )
    .limit(1);
  if (existing) throw conflict('A member with that email already exists.');

  const userId = newId('usr');
  // Random password — the member sets a real one later via accept-invite.
  const randomPassword = crypto.randomBytes(24).toString('base64url');

  const permissionsJson = body.permissions
    ? serializeOverrides(body.permissions)
    : null;

  await db.insert(users).values({
    id: userId,
    agencyId: ctx.agencyId,
    email,
    passwordHash: await hashPassword(randomPassword),
    fullName: body.fullName,
    role: body.role,
    status: 'active',
    phone: body.phone ?? null,
    designation: body.designation ?? null,
    department: body.department ?? null,
    hourlyRate: body.hourlyRate ?? null,
    ...(body.weeklyCapacityHrs !== undefined
      ? { weeklyCapacityHrs: body.weeklyCapacityHrs }
      : {}),
    skills: skillsToCsv(body.skills) ?? null,
    permissionsJson,
  });

  // Pending invite row (token) — best-effort accept flow.
  const { raw, hash } = newOpaqueToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await db.insert(invites).values({
    id: newId('inv'),
    agencyId: ctx.agencyId,
    email,
    role: body.role,
    tokenHash: hash,
    invitedBy: ctx.userId,
    status: 'pending',
    expiresAt,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'team.invite',
    entityType: 'user',
    entityId: userId,
    metadata: { email, role: body.role },
    ip: req.ip,
  });

  const roleDefaults = await getAgencyRoleDefaults(ctx.agencyId);
  const member = {
    ...profileFields(
      {
        id: userId,
        email,
        fullName: body.fullName,
        role: body.role,
        status: 'active',
        lastLoginAt: null,
        designation: body.designation ?? null,
        department: body.department ?? null,
        phone: body.phone ?? null,
        hourlyRate: body.hourlyRate ?? null,
        weeklyCapacityHrs: body.weeklyCapacityHrs ?? 40,
        skills: skillsToCsv(body.skills) ?? null,
        permissionsJson,
        customRoleId: null,
        createdAt: new Date(),
      },
      roleDefaults,
    ),
    activeTaskCount: 0,
    projectCount: 0,
    loggedMinutesThisWeek: 0,
    utilizationPct: 0,
  };

  const inviteUrl = `${FRONTEND_ORIGIN}/accept-invite?token=${raw}`;
  created(res, { member, inviteUrl });
});

// ============================================================
//  GET /team/:userId — member detail
// ============================================================
usersRouter.get('/:userId', async (req, res) => {
  const ctx = getAuth(req);
  const userId = param(req, 'userId');

  const [u] = await db
    .select({
      ...memberBaseSelection,
      customRolePermsJson: customRoles.permissionsJson,
      customRoleName: customRoles.name,
    })
    .from(users)
    .leftJoin(customRoles, eq(customRoles.id, users.customRoleId))
    .where(and(eq(users.id, userId), eq(users.agencyId, ctx.agencyId)))
    .limit(1);
  if (!u) throw notFound('Member not found.');

  const roleDefaults = await getAgencyRoleDefaults(ctx.agencyId);

  // Projects: explicit memberships joined to project details, unioned with
  // projects the user has tasks in (distinct by project id).
  const memberProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.agencyId, ctx.agencyId),
        eq(projectMembers.userId, userId),
      ),
    );

  const taskProjects = await db
    .selectDistinct({
      id: projects.id,
      name: projects.name,
      status: projects.status,
    })
    .from(projectTasks)
    .innerJoin(projects, eq(projects.id, projectTasks.projectId))
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.assigneeId, userId),
      ),
    );

  const projectMap = new Map<
    string,
    { id: string; name: string; status: string; role: string | null }
  >();
  for (const p of memberProjects) {
    projectMap.set(p.id, {
      id: p.id,
      name: p.name,
      status: p.status,
      role: p.role,
    });
  }
  for (const p of taskProjects) {
    if (!projectMap.has(p.id)) {
      projectMap.set(p.id, {
        id: p.id,
        name: p.name,
        status: p.status,
        role: null,
      });
    }
  }
  const projectList = Array.from(projectMap.values());

  // Active tasks (assigned, not done) with project name.
  const activeTasks = await db
    .select({
      id: projectTasks.id,
      title: projectTasks.title,
      status: projectTasks.status,
      projectId: projectTasks.projectId,
      projectName: projects.name,
      dueDate: projectTasks.dueDate,
    })
    .from(projectTasks)
    .leftJoin(projects, eq(projects.id, projectTasks.projectId))
    .where(
      and(
        eq(projectTasks.agencyId, ctx.agencyId),
        eq(projectTasks.assigneeId, userId),
        ne(projectTasks.status, 'done'),
      ),
    )
    .orderBy(desc(projectTasks.dueDate));

  // Recent time logs (~20) with project name.
  const recentLogs = await db
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
    .where(
      and(eq(timeLogs.agencyId, ctx.agencyId), eq(timeLogs.userId, userId)),
    )
    .orderBy(desc(timeLogs.workDate))
    .limit(20);

  // Aggregates.
  const [{ total } = { total: 0 }] = await db
    .select({
      total: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
    })
    .from(timeLogs)
    .where(
      and(eq(timeLogs.agencyId, ctx.agencyId), eq(timeLogs.userId, userId)),
    );
  const totalLoggedMinutes = Number(total ?? 0);

  ok(res, {
    ...profileFields(
      u as MemberBaseRow,
      roleDefaults,
      u.customRolePermsJson,
      u.customRoleName,
    ),
    projects: projectList,
    activeTasks: activeTasks.map((tk) => ({
      id: tk.id,
      title: tk.title,
      status: tk.status,
      projectId: tk.projectId,
      projectName: tk.projectName,
      dueDate: toIso(tk.dueDate),
    })),
    timeLogs: recentLogs.map((l) => ({
      id: l.id,
      minutes: l.minutes,
      workDate: toIso(l.workDate),
      note: l.note,
      projectId: l.projectId,
      projectName: l.projectName,
      taskId: l.taskId,
    })),
    totalLoggedMinutes,
    activeTaskCount: activeTasks.length,
    projectCount: projectList.length,
    utilizationPct: utilizationPct(
      // "this week" utilization for the detail header.
      await loggedMinutesThisWeekForUser(ctx.agencyId, userId),
      u.weeklyCapacityHrs ?? 0,
    ),
  });
});

/** Sum of minutes a user logged in the current week (detail-view helper). */
async function loggedMinutesThisWeekForUser(
  agencyId: string,
  userId: string,
): Promise<number> {
  const weekStartSec = Math.floor(startOfWeek().getTime() / 1000);
  const [{ total } = { total: 0 }] = await db
    .select({
      total: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)`,
    })
    .from(timeLogs)
    .where(
      and(
        eq(timeLogs.agencyId, agencyId),
        eq(timeLogs.userId, userId),
        sql`${timeLogs.workDate} >= ${weekStartSec}`,
      ),
    );
  return Number(total ?? 0);
}

// ============================================================
//  PATCH /team/:userId — role/status + profile (owner/admin)
// ============================================================
const patchSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  // Assign a custom role (sets the user's tier to the role's baseRole); null
  // clears it back to the built-in role.
  customRoleId: z.string().nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  fullName: z.string().trim().min(1).max(120).optional(),
  designation: z.string().trim().max(120).nullable().optional(),
  department: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  hourlyRate: z.number().int().min(0).nullable().optional(),
  weeklyCapacityHrs: z.number().int().min(0).max(168).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  // Full or partial module permission map ({ moduleKey: 'none'|'view'|'manage' }).
  permissions: z.record(z.string(), z.string()).optional(),
});

usersRouter.patch(
  '/:userId',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    const body = patchSchema.parse(req.body);
    const [target] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.id, param(req, 'userId')),
          eq(users.agencyId, ctx.agencyId),
        ),
      )
      .limit(1);
    if (!target) throw notFound('User not found.');
    // The owner's role/status/permissions can never be changed (always full).
    if (
      target.role === 'owner' &&
      (body.role !== undefined ||
        body.customRoleId !== undefined ||
        body.status !== undefined ||
        body.permissions !== undefined)
    ) {
      throw conflict('Cannot modify the owner.');
    }

    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    // Role assignment: a custom role sets the tier from its baseRole; a built-in
    // role clears any custom role.
    if (body.customRoleId !== undefined) {
      if (body.customRoleId) {
        const [cr] = await db
          .select()
          .from(customRoles)
          .where(
            and(
              eq(customRoles.id, body.customRoleId),
              eq(customRoles.agencyId, ctx.agencyId),
            ),
          )
          .limit(1);
        if (!cr) throw notFound('Custom role not found.');
        patch.customRoleId = cr.id;
        patch.role = cr.baseRole;
        // The role's preset now drives — clear any personal overrides.
        patch.permissionsJson = null;
      } else {
        patch.customRoleId = null;
        if (body.role !== undefined) patch.role = body.role;
      }
    } else if (body.role !== undefined) {
      patch.role = body.role;
      patch.customRoleId = null;
    }
    if (body.status !== undefined) patch.status = body.status;
    if (body.fullName !== undefined) patch.fullName = body.fullName;
    if (body.designation !== undefined) patch.designation = body.designation;
    if (body.department !== undefined) patch.department = body.department;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.hourlyRate !== undefined) patch.hourlyRate = body.hourlyRate;
    if (body.weeklyCapacityHrs !== undefined)
      patch.weeklyCapacityHrs = body.weeklyCapacityHrs;
    if (body.skills !== undefined) patch.skills = skillsToCsv(body.skills) ?? null;
    // Merge incoming permission overrides onto any existing ones, then persist.
    // serializeOverrides drops invalid keys/levels and returns null when empty.
    if (body.permissions !== undefined) {
      const merged = {
        ...parseOverrides(target.permissionsJson),
        ...sanitizeOverrides(body.permissions),
      };
      patch.permissionsJson = serializeOverrides(merged);
    }

    await db.update(users).set(patch).where(eq(users.id, target.id));
    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'team.update',
      entityType: 'user',
      entityId: target.id,
      ip: req.ip,
    });
    ok(res, { updated: true });
  },
);

// ============================================================
//  DELETE /team/:userId — hard-delete a member (owner/admin)
// ============================================================
usersRouter.delete(
  '/:userId',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    const userId = param(req, 'userId');
    const [target] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.agencyId, ctx.agencyId)))
      .limit(1);
    if (!target) throw notFound('Member not found.');
    if (target.role === 'owner') {
      throw conflict('Cannot delete the owner.');
    }

    // FK behavior handles the rest: project_members/client_assignments/
    // time_logs cascade; assigned tasks' assigneeId is set null.
    await db
      .delete(users)
      .where(and(eq(users.id, userId), eq(users.agencyId, ctx.agencyId)));

    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'team.delete',
      entityType: 'user',
      entityId: userId,
      ip: req.ip,
    });
    ok(res, { deleted: true });
  },
);

// ============================================================
//  TIME LOGS — POST/GET /team/:userId/time-logs
// ============================================================

/** Verify a user belongs to the caller's agency; return its id or throw 404. */
async function requireAgencyMember(
  agencyId: string,
  userId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.agencyId, agencyId)))
    .limit(1);
  if (!row) throw notFound('Member not found.');
}

const createTimeLogSchema = z.object({
  minutes: z.number().int().positive(),
  projectId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  workDate: z.coerce.date().optional(),
  note: z.string().trim().max(2000).optional(),
});

// POST /team/:userId/time-logs (self, or owner/admin)
usersRouter.post('/:userId/time-logs', async (req, res) => {
  const ctx = getAuth(req);
  const userId = param(req, 'userId');
  if (userId !== ctx.userId && !isPrivileged(ctx.role)) {
    throw forbidden('You can only log time for yourself.');
  }
  await requireAgencyMember(ctx.agencyId, userId);
  const body = createTimeLogSchema.parse(req.body);

  // Validate optional project/task belong to the agency.
  if (body.projectId) {
    const [p] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, body.projectId),
          eq(projects.agencyId, ctx.agencyId),
        ),
      )
      .limit(1);
    if (!p) throw notFound('Project not found.');
  }
  if (body.taskId) {
    const [tk] = await db
      .select({ id: projectTasks.id, projectId: projectTasks.projectId })
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.id, body.taskId),
          eq(projectTasks.agencyId, ctx.agencyId),
        ),
      )
      .limit(1);
    if (!tk) throw notFound('Task not found.');
    // If a project was also supplied, the task must belong to it.
    if (body.projectId && tk.projectId !== body.projectId) {
      throw conflict('Task does not belong to the given project.');
    }
  }

  const id = newId('tlg');
  const workDate = body.workDate ?? new Date();
  await db.insert(timeLogs).values({
    id,
    agencyId: ctx.agencyId,
    userId,
    projectId: body.projectId ?? null,
    taskId: body.taskId ?? null,
    minutes: body.minutes,
    workDate,
    note: body.note ?? null,
  });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'team.time_log.create',
    entityType: 'user',
    entityId: userId,
    metadata: { timeLogId: id, minutes: body.minutes },
    ip: req.ip,
  });

  const [row] = await db
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
    .where(eq(timeLogs.id, id))
    .limit(1);

  created(res, {
    id: row!.id,
    minutes: row!.minutes,
    workDate: toIso(row!.workDate),
    note: row!.note,
    projectId: row!.projectId,
    projectName: row!.projectName,
    taskId: row!.taskId,
  });
});

// GET /team/:userId/time-logs — recent logs (self, or owner/admin)
usersRouter.get('/:userId/time-logs', async (req, res) => {
  const ctx = getAuth(req);
  const userId = param(req, 'userId');
  if (userId !== ctx.userId && !isPrivileged(ctx.role)) {
    throw forbidden('You can only view your own time logs.');
  }
  await requireAgencyMember(ctx.agencyId, userId);

  const rows = await db
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
    .where(
      and(eq(timeLogs.agencyId, ctx.agencyId), eq(timeLogs.userId, userId)),
    )
    .orderBy(desc(timeLogs.workDate))
    .limit(50);

  ok(
    res,
    rows.map((l) => ({
      id: l.id,
      minutes: l.minutes,
      workDate: toIso(l.workDate),
      note: l.note,
      projectId: l.projectId,
      projectName: l.projectName,
      taskId: l.taskId,
    })),
  );
});

// ============================================================
//  CLIENT ASSIGNMENTS (owner/admin) — UNCHANGED behavior
// ============================================================

// GET /team/clients/:clientId/assignments
usersRouter.get(
  '/clients/:clientId/assignments',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    await requireClientAccess(ctx, param(req, 'clientId'));
    const rows = await db
      .select({
        id: clientAssignments.id,
        userId: clientAssignments.userId,
      })
      .from(clientAssignments)
      .where(
        and(
          eq(clientAssignments.agencyId, ctx.agencyId),
          eq(clientAssignments.clientId, param(req, 'clientId')),
        ),
      );
    ok(res, rows);
  },
);

// POST /team/clients/:clientId/assignments  { userId }
const assignSchema = z.object({ userId: z.string().min(1) });

usersRouter.post(
  '/clients/:clientId/assignments',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    await requireClientAccess(ctx, param(req, 'clientId'));
    const body = assignSchema.parse(req.body);

    // The assignee must belong to this agency.
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.id, body.userId), eq(users.agencyId, ctx.agencyId)),
      )
      .limit(1);
    if (!user) throw notFound('User not found.');

    await db
      .insert(clientAssignments)
      .values({
        id: newId('asn'),
        agencyId: ctx.agencyId,
        clientId: param(req, 'clientId'),
        userId: body.userId,
        assignedBy: ctx.userId,
      })
      .onConflictDoNothing();

    await audit({
      agencyId: ctx.agencyId,
      actorType: ctx.role,
      actorId: ctx.userId,
      action: 'client.assign',
      entityType: 'client',
      entityId: param(req, 'clientId'),
      metadata: { userId: body.userId },
      ip: req.ip,
    });
    ok(res, { assigned: true });
  },
);

// DELETE /team/clients/:clientId/assignments/:userId
usersRouter.delete(
  '/clients/:clientId/assignments/:userId',
  requireRole('owner', 'admin'),
  async (req, res) => {
    const ctx = getAuth(req);
    await requireClientAccess(ctx, param(req, 'clientId'));
    await db
      .delete(clientAssignments)
      .where(
        and(
          eq(clientAssignments.agencyId, ctx.agencyId),
          eq(clientAssignments.clientId, param(req, 'clientId')),
          eq(clientAssignments.userId, param(req, 'userId')),
        ),
      );
    ok(res, { unassigned: true });
  },
);
