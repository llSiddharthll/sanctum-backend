import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  attendanceRecords,
  auditLog,
  clientAssignments,
  clients,
  clientUserProjects,
  invites,
  projectMembers,
  projectTasks,
  projects,
  roles,
  timeLogs,
  userPermissionOverrides,
  userRoles,
  users,
} from '../db/schema.js';
import { dayKeyInTz } from '../lib/attendance.js';
import { loadPolicy } from '../services/attendance.js';
import { ok, created, toIso, param } from '../lib/http.js';
import { newId, newOpaqueToken } from '../lib/ids.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { audit, auditAuthz } from '../services/audit.js';
import { sendTeamInvite } from '../services/email.js';
import { createPasswordReset } from '../services/password-reset.js';
import { getFrontendOrigin } from '../lib/frontend-url.js';
import {
  authenticate,
  getActor,
  getStaffActor,
  requires,
  requiresAny,
} from '../authz/http.js';
import { authorize, can, canOrg, check } from '../authz/engine.js';
import type { StaffActor } from '../authz/actor.js';
import {
  assertOwnerRemains,
  assertWithinCeiling,
  holdsOwnerRole,
  loadAssignableRoles,
} from '../authz/admin.js';
import {
  assertCanManageUser,
  loadTarget,
  roleSummaries,
  setUserOverrides,
  setUserRoles,
} from '../authz/user-admin.js';
import { bumpUsers, explainUser } from '../authz/resolver.js';
import { revokeUserSessions } from '../authz/sessions.js';
import {
  assignRoles,
  readRoleGrants,
  syncLegacyRoleColumn,
  systemRoleId,
} from '../authz/roles-store.js';
import { SCOPES, type SystemRoleKey } from '../authz/catalog.js';
import { clientFacts, clientScopeFilter } from '../authz/policies/clients.js';

export const usersRouter = Router();
usersRouter.use(authenticate);

// ---- Helpers -------------------------------------------------

function parseSkills(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function skillsToCsv(input: string | string[] | undefined): string | undefined {
  if (input === undefined) return undefined;
  const arr = Array.isArray(input) ? input : input.split(',');
  return arr
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(',');
}

function startOfWeek(d = new Date()): Date {
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - diff);
  return start;
}

function utilizationPct(loggedMinutes: number, weeklyCapacityHrs: number): number {
  const capacityMin = (weeklyCapacityHrs ?? 0) * 60;
  if (!capacityMin) return 0;
  return Math.round((loggedMinutes / capacityMin) * 100);
}

type UserRow = typeof users.$inferSelect;
type RoleSummary = Awaited<ReturnType<typeof roleSummaries>>[number];

async function rolesByUser(userIds: string[]): Promise<Map<string, RoleSummary[]>> {
  const out = new Map<string, RoleSummary[]>();
  if (!userIds.length) return out;
  const rows = await db
    .select({
      userId: userRoles.userId,
      id: roles.id,
      key: roles.key,
      name: roles.name,
      kind: roles.kind,
      colorToken: roles.colorToken,
    })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(inArray(userRoles.userId, userIds));
  for (const r of rows) {
    const { userId, ...role } = r;
    out.set(userId, [...(out.get(userId) ?? []), role]);
  }
  return out;
}

/** Profile shape shared by list and detail. Compensation is permission-gated. */
function profileFields(u: UserRow, userRolesList: RoleSummary[], canSeeComp: boolean) {
  const isOwner = userRolesList.some((r) => r.key === 'owner');
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    kind: u.kind,
    roles: userRolesList,
    // legacy display fields (TODO authz phase 10)
    role: u.role,
    roleName: userRolesList.map((r) => r.name).join(', ') || null,
    isOwner,
    status: u.status,
    lastLoginAt: toIso(u.lastLoginAt),
    designation: u.designation,
    department: u.department,
    phone: u.phone,
    hourlyRate: canSeeComp ? u.hourlyRate : null,
    monthlySalaryPaise: canSeeComp ? u.monthlySalaryPaise : null,
    weeklyCapacityHrs: u.weeklyCapacityHrs ?? 0,
    skills: parseSkills(u.skills),
    joinedAt: toIso(u.createdAt),
  };
}

// ============================================================
//  GET /team — staff members
// ============================================================
const listQuery = z.object({
  search: z.string().optional(),
  activeOnly: z.union([z.literal('true'), z.literal('false'), z.boolean()]).optional(),
});

usersRouter.get('/', requires('users.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const q = listQuery.parse(req.query);
  const weekStart = startOfWeek();

  const filters = [eq(users.agencyId, actor.agencyId), eq(users.kind, 'staff')];
  if (q.activeOnly === true || q.activeOnly === 'true') filters.push(eq(users.status, 'active'));
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

  const baseRows = await db.select().from(users).where(and(...filters)).orderBy(desc(users.createdAt));
  const ids = baseRows.map((u) => u.id);
  const roleMap = await rolesByUser(ids);

  const taskCount = new Map<string, number>();
  const projectIds = new Map<string, Set<string>>();
  const weekMinutes = new Map<string, number>();
  const presence = new Map<string, { checkedIn: boolean; checkInAt: string | null; checkOutAt: string | null }>();
  const ensure = (m: Map<string, Set<string>>, k: string) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set<string>()));
    return s;
  };

  // Workload aggregates are only computed for data the actor may see.
  const seeWorkload = canOrg(actor, 'tasks.view');
  const seeTime = canOrg(actor, 'time_logs.view');
  const seeAttendance = canOrg(actor, 'attendance.view') || can(actor, 'attendance.view_live');

  if (ids.length) {
    if (seeWorkload) {
      const taskRows = await db
        .select({ uid: projectTasks.assigneeId, pid: projectTasks.projectId, status: projectTasks.status })
        .from(projectTasks)
        .where(and(eq(projectTasks.agencyId, actor.agencyId), inArray(projectTasks.assigneeId, ids)));
      for (const r of taskRows) {
        if (!r.uid) continue;
        if (r.status !== 'done') taskCount.set(r.uid, (taskCount.get(r.uid) ?? 0) + 1);
        ensure(projectIds, r.uid).add(r.pid);
      }
      const memberRows = await db
        .select({ uid: projectMembers.userId, pid: projectMembers.projectId })
        .from(projectMembers)
        .where(and(eq(projectMembers.agencyId, actor.agencyId), inArray(projectMembers.userId, ids)));
      for (const r of memberRows) ensure(projectIds, r.uid).add(r.pid);
    }
    if (seeTime) {
      const weekStartSec = Math.floor(weekStart.getTime() / 1000);
      const logRows = await db
        .select({ uid: timeLogs.userId, minutes: timeLogs.minutes })
        .from(timeLogs)
        .where(
          and(
            eq(timeLogs.agencyId, actor.agencyId),
            inArray(timeLogs.userId, ids),
            sql`${timeLogs.workDate} >= ${weekStartSec}`,
          ),
        );
      for (const r of logRows) weekMinutes.set(r.uid, (weekMinutes.get(r.uid) ?? 0) + Number(r.minutes ?? 0));
    }
    if (seeAttendance) {
      const policy = await loadPolicy(actor.agencyId);
      const today = dayKeyInTz(new Date(), policy.timezone);
      const attRows = await db
        .select({
          userId: attendanceRecords.userId,
          checkInAt: attendanceRecords.checkInAt,
          checkOutAt: attendanceRecords.checkOutAt,
        })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.agencyId, actor.agencyId),
            eq(attendanceRecords.day, today),
            inArray(attendanceRecords.userId, ids),
          ),
        );
      for (const r of attRows) {
        presence.set(r.userId, {
          checkedIn: !!r.checkInAt,
          checkInAt: toIso(r.checkInAt),
          checkOutAt: toIso(r.checkOutAt),
        });
      }
    }
  }

  const canSeeComp = can(actor, 'users.view_compensation');
  ok(
    res,
    baseRows.map((u) => {
      const loggedMinutesThisWeek = weekMinutes.get(u.id) ?? 0;
      const p = presence.get(u.id);
      return {
        ...profileFields(u, roleMap.get(u.id) ?? [], canSeeComp),
        activeTaskCount: taskCount.get(u.id) ?? 0,
        projectCount: projectIds.get(u.id)?.size ?? 0,
        loggedMinutesThisWeek,
        utilizationPct: utilizationPct(loggedMinutesThisWeek, u.weeklyCapacityHrs ?? 0),
        checkedInToday: p?.checkedIn ?? false,
        checkInAt: p?.checkInAt ?? null,
        checkOutAt: p?.checkOutAt ?? null,
        presence: p ? (p.checkOutAt ? ('out' as const) : ('in' as const)) : (null as null),
      };
    }),
  );
});

// ============================================================
//  CLIENT USERS (portal accounts)
// ============================================================

async function clientUserRowsFor(actor: StaffActor, idFilter?: string) {
  const scope = await clientScopeFilter(actor, 'client_users.view', users.clientId);
  const rows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      clientId: users.clientId,
      clientName: clients.name,
      clientProjectAccess: users.clientProjectAccess,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(clients, eq(clients.id, users.clientId))
    .where(
      and(
        eq(users.agencyId, actor.agencyId),
        eq(users.kind, 'client'),
        sql`lower(${users.email}) not like '%@portal.sanctum'`,
        scope,
        ...(idFilter ? [eq(users.id, idFilter)] : []),
      ),
    )
    .orderBy(desc(users.createdAt));
  const ids = rows.map((r) => r.id);
  const scopeCount = new Map<string, number>();
  if (ids.length) {
    const sc = await db
      .select({ userId: clientUserProjects.userId, n: sql<number>`count(*)` })
      .from(clientUserProjects)
      .where(and(eq(clientUserProjects.agencyId, actor.agencyId), inArray(clientUserProjects.userId, ids)))
      .groupBy(clientUserProjects.userId);
    for (const r of sc) scopeCount.set(r.userId, Number(r.n));
  }
  const roleMap = await rolesByUser(ids);
  return rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    email: r.email,
    status: r.status,
    lastLoginAt: toIso(r.lastLoginAt),
    clientId: r.clientId,
    clientName: r.clientName,
    roles: roleMap.get(r.id) ?? [],
    projectAccess: r.clientProjectAccess ?? 'all',
    projectScope: scopeCount.get(r.id) ?? 0,
    joinedAt: toIso(r.createdAt),
  }));
}

usersRouter.get('/client-users', requires('client_users.view'), async (req, res) => {
  ok(res, await clientUserRowsFor(getStaffActor(req)));
});

/** Load a client user the actor may act on for `permission`, or 404/403. */
async function scopedClientUser(actor: StaffActor, id: string, permission: string) {
  const target = await loadTarget(actor.agencyId, id).catch(() => null);
  if (!target || target.kind !== 'client' || !target.clientId) throw notFound('Client account not found.');
  const facts = await clientFacts(actor, target.clientId);
  authorize(actor, permission, facts, { view: 'client_users.view' });
  return target;
}

const updateClientUserSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  roleIds: z.array(z.string().min(1)).min(1).max(5).optional(),
  projectAccess: z.enum(['all', 'selected']).optional(),
  projectIds: z.array(z.string().min(1)).max(200).optional(),
});

usersRouter.patch('/client-users/:id', requiresAny('client_users.update', 'client_users.disable'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = updateClientUserSchema.parse(req.body);
  const touchesProfile =
    body.fullName !== undefined || body.email !== undefined || body.roleIds !== undefined ||
    body.projectAccess !== undefined || body.projectIds !== undefined;
  const cu = await scopedClientUser(
    actor,
    param(req, 'id'),
    touchesProfile ? 'client_users.update' : 'client_users.disable',
  );
  if (body.status !== undefined) {
    authorize(actor, 'client_users.disable', await clientFacts(actor, cu.clientId!));
  }

  const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (body.fullName !== undefined) patch.fullName = body.fullName;
  if (body.status !== undefined) patch.status = body.status;

  const nextEmail = body.email?.trim().toLowerCase();
  const emailChanged = !!nextEmail && nextEmail !== cu.email.toLowerCase();
  if (emailChanged) {
    const [dupe] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.agencyId, actor.agencyId), sql`lower(${users.email}) = ${nextEmail}`))
      .limit(1);
    if (dupe) throw conflict('That email is already in use.');
    patch.email = nextEmail!;
  }

  if (body.projectAccess !== undefined || body.projectIds !== undefined) {
    const mode = body.projectAccess ?? (body.projectIds ? 'selected' : cu.clientProjectAccess ?? 'all');
    const ids = mode === 'selected' ? await validateBrandProjects(actor.agencyId, cu.clientId!, body.projectIds ?? []) : [];
    patch.clientProjectAccess = mode;
    await db.delete(clientUserProjects).where(eq(clientUserProjects.userId, cu.id));
    if (ids.length) {
      await db.insert(clientUserProjects).values(
        ids.map((projectId) => ({ id: newId('cup'), agencyId: actor.agencyId, userId: cu.id, projectId })),
      );
    }
  }

  await db.update(users).set(patch).where(eq(users.id, cu.id));
  if (body.roleIds) {
    const assignable = await loadAssignableRoles(actor.agencyId, body.roleIds, 'client');
    await db.transaction(async (tx) => {
      await assignRoles(tx, { agencyId: actor.agencyId, userId: cu.id, roleIds: assignable.map((r) => r.id), assignedBy: actor.userId });
    });
  }
  const accessChanged =
    body.status !== undefined || body.roleIds !== undefined ||
    body.projectAccess !== undefined || body.projectIds !== undefined || emailChanged;
  if (accessChanged) await bumpUsers([cu.id]);
  if (body.status === 'disabled' || emailChanged) {
    await revokeUserSessions(cu.id, body.status === 'disabled' ? 'disabled' : 'email_changed');
  }
  if (emailChanged) {
    // The link goes ONLY to the new address; it is never returned to the caller.
    await createPasswordReset(
      { id: cu.id, agencyId: cu.agencyId, email: nextEmail!, fullName: patch.fullName ?? cu.fullName },
      { byAdmin: true, req },
    );
  }

  await auditAuthz({
    actor,
    action: 'client_user.update',
    entityType: 'client_user',
    entityId: cu.id,
    before: { status: cu.status, email: cu.email, projectAccess: cu.clientProjectAccess },
    after: { status: patch.status ?? cu.status, email: patch.email ?? cu.email, roleIds: body.roleIds, projectAccess: patch.clientProjectAccess },
    ip: req.ip,
  });
  const [updated] = await clientUserRowsFor(actor, cu.id);
  ok(res, { ...updated, emailChanged });
});

usersRouter.delete('/client-users/:id', requires('client_users.disable'), async (req, res) => {
  const actor = getStaffActor(req);
  const cu = await scopedClientUser(actor, param(req, 'id'), 'client_users.disable');
  await revokeUserSessions(cu.id, 'deleted');
  await db.delete(users).where(and(eq(users.id, cu.id), eq(users.agencyId, actor.agencyId)));
  await auditAuthz({ actor, action: 'client_user.delete', entityType: 'client_user', entityId: cu.id, before: { email: cu.email }, ip: req.ip });
  ok(res, { deleted: true });
});

usersRouter.post('/client-users/:id/reset-password', requires('client_users.reset_password'), async (req, res) => {
  const actor = getStaffActor(req);
  const cu = await scopedClientUser(actor, param(req, 'id'), 'client_users.reset_password');
  if (cu.status !== 'active') throw conflict('This account is not active.');
  await createPasswordReset(cu, { byAdmin: true, req });
  await auditAuthz({ actor, action: 'client_user.password_reset', entityType: 'client_user', entityId: cu.id, ip: req.ip });
  ok(res, { ok: true, emailed: true });
});

async function validateBrandProjects(agencyId: string, clientId: string, projectIds: string[]): Promise<string[]> {
  const ids = [...new Set(projectIds)];
  if (!ids.length) return [];
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.agencyId, agencyId), eq(projects.clientId, clientId), inArray(projects.id, ids)));
  if (rows.length !== ids.length) throw badRequest('One or more projects do not belong to this client.');
  return rows.map((r) => r.id);
}

// ============================================================
//  POST /team/invite — staff member or client user
// ============================================================
const LEGACY_ROLE_TO_SYSTEM: Record<string, SystemRoleKey> = {
  admin: 'admin',
  member: 'employee',
};

const inviteSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    email: z.string().email(),
    kind: z.enum(['staff', 'client']).optional(),
    roleIds: z.array(z.string().min(1)).min(1).max(5).optional(),
    /** Legacy: 'admin' | 'member' | 'client' (maps to system roles). */
    role: z.enum(['admin', 'member', 'client']).optional(),
    clientId: z.string().min(1).optional(),
    projectIds: z.array(z.string().min(1)).max(200).optional(),
    /** Client invites: 'all' brand projects or only 'selected' (projectIds, non-empty). */
    projectAccess: z.enum(['all', 'selected']).optional(),
    phone: z.string().trim().max(40).optional(),
    designation: z.string().trim().max(120).optional(),
    department: z.string().trim().max(120).optional(),
    hourlyRate: z.number().int().min(0).optional(),
    monthlySalaryPaise: z.number().int().min(0).optional(),
    weeklyCapacityHrs: z.number().int().min(0).max(168).optional(),
    skills: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .transform((d) => ({ ...d, kind: d.kind ?? (d.role === 'client' ? 'client' : 'staff') }))
  .refine((d) => d.kind !== 'client' || !!d.clientId, {
    message: 'A client invite requires a clientId.',
    path: ['clientId'],
  });

usersRouter.post('/invite', requiresAny('users.invite', 'client_users.invite'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = inviteSchema.parse(req.body);
  const email = body.email.toLowerCase();
  const isClient = body.kind === 'client';

  let roleIds: string[];
  let clientScopeProjectIds: string[] = [];
  if (isClient) {
    const facts = await clientFacts(actor, body.clientId!);
    authorize(actor, 'client_users.invite', facts, { view: 'clients.view' });
    const [brand] = await db
      .select({ portalRole: clients.portalRole })
      .from(clients)
      .where(eq(clients.id, body.clientId!))
      .limit(1);
    clientScopeProjectIds = await validateBrandProjects(actor.agencyId, body.clientId!, body.projectIds ?? []);
    const wantsSelected = body.projectAccess === 'selected' || (body.projectAccess === undefined && clientScopeProjectIds.length > 0);
    if (wantsSelected && clientScopeProjectIds.length === 0) {
      throw badRequest('Select at least one project, or give access to all projects.');
    }
    if (body.roleIds) {
      roleIds = (await loadAssignableRoles(actor.agencyId, body.roleIds, 'client')).map((r) => r.id);
    } else {
      const key: SystemRoleKey = brand?.portalRole === 'reviewer' ? 'client_reviewer' : 'client_approver';
      const id = await systemRoleId(actor.agencyId, key);
      if (!id) throw conflict('Client roles are not configured for this agency.');
      roleIds = [id];
    }
  } else {
    if (!can(actor, 'users.invite')) throw forbidden("You don't have permission to invite team members.");
    const explicitRoles = body.roleIds;
    if (explicitRoles) {
      if (!can(actor, 'users.assign_roles')) throw forbidden("You don't have permission to assign roles.");
      roleIds = (await loadAssignableRoles(actor.agencyId, explicitRoles, 'staff')).map((r) => r.id);
    } else {
      const key = LEGACY_ROLE_TO_SYSTEM[body.role ?? 'member'] ?? 'employee';
      if (key !== 'employee' && !can(actor, 'users.assign_roles')) {
        throw forbidden("You don't have permission to assign roles.");
      }
      const id = await systemRoleId(actor.agencyId, key);
      if (!id) throw conflict('System roles are not configured for this agency.');
      roleIds = [id];
    }
    const roleRows = await loadAssignableRoles(actor.agencyId, roleIds, 'staff');
    if (roleRows.some((r) => r.key === 'owner') && !(await holdsOwnerRole(actor.userId, actor.agencyId))) {
      throw forbidden('Only owners can grant the Owner role.');
    }
    // Ceiling: the invitee can never receive more than the inviter holds.
    for (const r of roleRows) assertWithinCeiling(actor.grants, await readRoleGrants(db, r.id));
    if ((body.hourlyRate !== undefined || body.monthlySalaryPaise !== undefined) && !can(actor, 'users.update_compensation')) {
      throw forbidden("You don't have permission to set compensation.");
    }
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.agencyId, actor.agencyId), sql`lower(${users.email}) = ${email}`))
    .limit(1);
  if (existing) throw conflict('A member with that email already exists.');

  const userId = newId('usr');
  const randomPassword = crypto.randomBytes(24).toString('base64url');
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      agencyId: actor.agencyId,
      email,
      passwordHash: await hashPassword(randomPassword),
      fullName: body.fullName,
      role: isClient ? 'client' : body.role === 'admin' ? 'admin' : 'member',
      kind: isClient ? 'client' : 'staff',
      status: 'active',
      clientId: isClient ? body.clientId! : null,
      clientProjectAccess: isClient ? (clientScopeProjectIds.length ? 'selected' : 'all') : null,
      phone: body.phone ?? null,
      designation: body.designation ?? null,
      department: body.department ?? null,
      hourlyRate: isClient ? null : (body.hourlyRate ?? null),
      monthlySalaryPaise: isClient ? null : (body.monthlySalaryPaise ?? null),
      ...(body.weeklyCapacityHrs !== undefined ? { weeklyCapacityHrs: body.weeklyCapacityHrs } : {}),
      skills: skillsToCsv(body.skills) ?? null,
    });
    await assignRoles(tx, { agencyId: actor.agencyId, userId, roleIds, assignedBy: actor.userId });
    if (!isClient) await syncLegacyRoleColumn(tx, userId);
    if (isClient && clientScopeProjectIds.length) {
      await tx.insert(clientUserProjects).values(
        clientScopeProjectIds.map((projectId) => ({ id: newId('cup'), agencyId: actor.agencyId, userId, projectId })),
      );
    }
  });

  const { raw, hash } = newOpaqueToken();
  await db.insert(invites).values({
    id: newId('inv'),
    agencyId: actor.agencyId,
    email,
    role: isClient ? 'client' : body.role === 'admin' ? 'admin' : 'member',
    clientId: isClient ? body.clientId! : null,
    projectScopeJson: isClient && clientScopeProjectIds.length ? JSON.stringify(clientScopeProjectIds) : null,
    tokenHash: hash,
    invitedBy: actor.userId,
    status: 'pending',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  const assigned = await roleSummaries(userId);
  await auditAuthz({
    actor,
    action: isClient ? 'client_user.invite' : 'user.invite',
    entityType: isClient ? 'client_user' : 'user',
    entityId: userId,
    after: { email, roles: assigned.map((r) => r.name), clientId: body.clientId ?? null },
    ip: req.ip,
  });

  // The invite link is for a brand-new account whose authority is already
  // capped by the inviter's own (ceiling above), so it may be shown to copy
  // when email delivery isn't configured.
  const inviteUrl = `${getFrontendOrigin(req)}/accept-invite?token=${raw}`;
  const [ag] = await db.select({ name: agencies.name }).from(agencies).where(eq(agencies.id, actor.agencyId)).limit(1);
  void sendTeamInvite({ to: email, agencyName: ag?.name ?? 'your team', acceptUrl: inviteUrl }).catch((err) => {
    console.error('[email:invite:error]', err);
  });

  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  created(res, {
    member: {
      ...profileFields(row!, assigned, can(actor, 'users.view_compensation')),
      activeTaskCount: 0,
      projectCount: 0,
      loggedMinutesThisWeek: 0,
      utilizationPct: 0,
    },
    inviteUrl,
  });
});

// ============================================================
//  CLIENT ASSIGNMENTS
// ============================================================
usersRouter.get('/clients/:clientId/assignments', requires('clients.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const facts = await clientFacts(actor, param(req, 'clientId'));
  authorize(actor, 'clients.view', facts);
  const rows = await db
    .select({ id: clientAssignments.id, userId: clientAssignments.userId })
    .from(clientAssignments)
    .where(and(eq(clientAssignments.agencyId, actor.agencyId), eq(clientAssignments.clientId, param(req, 'clientId'))));
  ok(res, rows);
});

const assignSchema = z.object({ userId: z.string().min(1) });

usersRouter.post('/clients/:clientId/assignments', requires('clients.manage_assignments'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  authorize(actor, 'clients.manage_assignments', await clientFacts(actor, clientId), { view: 'clients.view' });
  const body = assignSchema.parse(req.body);
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, body.userId), eq(users.agencyId, actor.agencyId), eq(users.kind, 'staff'), eq(users.status, 'active')))
    .limit(1);
  if (!user) throw notFound('User not found.');

  await db
    .insert(clientAssignments)
    .values({ id: newId('asn'), agencyId: actor.agencyId, clientId, userId: body.userId, assignedBy: actor.userId })
    .onConflictDoNothing();
  await bumpUsers([body.userId]);
  await audit({
    agencyId: actor.agencyId,
    actorType: 'staff',
    actorId: actor.userId,
    action: 'client.assign',
    entityType: 'client',
    entityId: clientId,
    metadata: { userId: body.userId },
    ip: req.ip,
  });
  ok(res, { assigned: true });
});

usersRouter.delete('/clients/:clientId/assignments/:userId', requires('clients.manage_assignments'), async (req, res) => {
  const actor = getStaffActor(req);
  const clientId = param(req, 'clientId');
  authorize(actor, 'clients.manage_assignments', await clientFacts(actor, clientId), { view: 'clients.view' });
  const userId = param(req, 'userId');
  await db
    .delete(clientAssignments)
    .where(
      and(
        eq(clientAssignments.agencyId, actor.agencyId),
        eq(clientAssignments.clientId, clientId),
        eq(clientAssignments.userId, userId),
      ),
    );
  await bumpUsers([userId]);
  await audit({
    agencyId: actor.agencyId,
    actorType: 'staff',
    actorId: actor.userId,
    action: 'client.unassign',
    entityType: 'client',
    entityId: clientId,
    metadata: { userId },
    ip: req.ip,
  });
  ok(res, { unassigned: true });
});

// ============================================================
//  GET /team/:userId — member detail
// ============================================================
usersRouter.get('/:userId', requires('users.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const userId = param(req, 'userId');
  const u = await loadTarget(actor.agencyId, userId);
  if (u.kind !== 'staff') throw notFound('Member not found.');
  const isSelf = userId === actor.userId;

  const seeWork = isSelf || canOrg(actor, 'tasks.view');
  const seeTime = isSelf ? can(actor, 'time_logs.view') : canOrg(actor, 'time_logs.view');

  const memberProjects = seeWork
    ? await db
        .select({ id: projects.id, name: projects.name, status: projects.status, role: projectMembers.role })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(and(eq(projectMembers.agencyId, actor.agencyId), eq(projectMembers.userId, userId)))
    : [];
  const taskProjects = seeWork
    ? await db
        .selectDistinct({ id: projects.id, name: projects.name, status: projects.status })
        .from(projectTasks)
        .innerJoin(projects, eq(projects.id, projectTasks.projectId))
        .where(and(eq(projectTasks.agencyId, actor.agencyId), eq(projectTasks.assigneeId, userId)))
    : [];
  const projectMap = new Map<string, { id: string; name: string; status: string; role: string | null }>();
  for (const p of memberProjects) projectMap.set(p.id, { ...p });
  for (const p of taskProjects) if (!projectMap.has(p.id)) projectMap.set(p.id, { ...p, role: null });
  const projectList = [...projectMap.values()];

  const activeTasks = seeWork
    ? await db
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
        .where(and(eq(projectTasks.agencyId, actor.agencyId), eq(projectTasks.assigneeId, userId), ne(projectTasks.status, 'done')))
        .orderBy(desc(projectTasks.dueDate))
    : [];

  const recentLogs = seeTime
    ? await db
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
        .where(and(eq(timeLogs.agencyId, actor.agencyId), eq(timeLogs.userId, userId)))
        .orderBy(desc(timeLogs.workDate))
        .limit(20)
    : [];
  const totalLoggedMinutes = seeTime ? await totalMinutes(actor.agencyId, userId) : 0;
  const weekMinutes = seeTime ? await loggedMinutesThisWeekForUser(actor.agencyId, userId) : 0;

  let checkInAt: string | null = null;
  let checkOutAt: string | null = null;
  let checkedInToday = false;
  if (isSelf || canOrg(actor, 'attendance.view') || can(actor, 'attendance.view_live')) {
    const policy = await loadPolicy(actor.agencyId);
    const today = dayKeyInTz(new Date(), policy.timezone);
    const [todayRec] = await db
      .select({ checkInAt: attendanceRecords.checkInAt, checkOutAt: attendanceRecords.checkOutAt })
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.agencyId, actor.agencyId), eq(attendanceRecords.userId, userId), eq(attendanceRecords.day, today)))
      .limit(1);
    checkedInToday = !!todayRec?.checkInAt;
    checkInAt = todayRec ? toIso(todayRec.checkInAt) : null;
    checkOutAt = todayRec ? toIso(todayRec.checkOutAt) : null;
  }

  const userRolesList = await roleSummaries(userId);
  ok(res, {
    ...profileFields(u, userRolesList, can(actor, 'users.view_compensation')),
    checkedInToday,
    checkInAt,
    checkOutAt,
    presence: checkInAt ? (checkOutAt ? ('out' as const) : ('in' as const)) : (null as null),
    projects: projectList,
    activeTasks: activeTasks.map((tk) => ({ ...tk, dueDate: toIso(tk.dueDate) })),
    timeLogs: recentLogs.map((l) => ({ ...l, workDate: toIso(l.workDate) })),
    totalLoggedMinutes,
    activeTaskCount: activeTasks.length,
    projectCount: projectList.length,
    utilizationPct: utilizationPct(weekMinutes, u.weeklyCapacityHrs ?? 0),
  });
});

async function totalMinutes(agencyId: string, userId: string): Promise<number> {
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)` })
    .from(timeLogs)
    .where(and(eq(timeLogs.agencyId, agencyId), eq(timeLogs.userId, userId)));
  return Number(total ?? 0);
}

async function loggedMinutesThisWeekForUser(agencyId: string, userId: string): Promise<number> {
  const weekStartSec = Math.floor(startOfWeek().getTime() / 1000);
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`coalesce(sum(${timeLogs.minutes}), 0)` })
    .from(timeLogs)
    .where(and(eq(timeLogs.agencyId, agencyId), eq(timeLogs.userId, userId), sql`${timeLogs.workDate} >= ${weekStartSec}`));
  return Number(total ?? 0);
}

// ============================================================
//  PATCH /team/:userId — profile, compensation, status
// ============================================================
const patchSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  fullName: z.string().trim().min(1).max(120).optional(),
  designation: z.string().trim().max(120).nullable().optional(),
  department: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  hourlyRate: z.number().int().min(0).nullable().optional(),
  monthlySalaryPaise: z.number().int().min(0).nullable().optional(),
  weeklyCapacityHrs: z.number().int().min(0).max(168).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  /** Legacy single-role change (old app builds) → PUT /team/:id/roles. */
  role: z.enum(['owner', 'admin', 'member']).optional(),
});

usersRouter.patch('/:userId', requiresAny('users.update', 'users.disable', 'users.update_compensation', 'users.assign_roles'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = patchSchema.parse(req.body);
  const target = await loadTarget(actor.agencyId, param(req, 'userId'));
  if (target.kind !== 'staff') throw notFound('Member not found.');
  await assertCanManageUser(actor, target);

  const profileKeys = ['fullName', 'designation', 'department', 'phone', 'weeklyCapacityHrs', 'skills'] as const;
  const touchesProfile = profileKeys.some((k) => body[k] !== undefined);
  const touchesComp = body.hourlyRate !== undefined || body.monthlySalaryPaise !== undefined;
  if (touchesProfile && !can(actor, 'users.update')) throw forbidden("You don't have permission to edit members.");
  if (touchesComp && !can(actor, 'users.update_compensation')) throw forbidden("You don't have permission to change compensation.");
  if (body.status !== undefined && !can(actor, 'users.disable')) throw forbidden("You don't have permission to change account status.");

  if (body.role !== undefined) {
    if (!can(actor, 'users.assign_roles')) throw forbidden("You don't have permission to assign roles.");
    const key: SystemRoleKey = body.role === 'owner' ? 'owner' : body.role === 'admin' ? 'admin' : 'employee';
    const id = await systemRoleId(actor.agencyId, key);
    if (!id) throw notFound('Role not found.');
    await setUserRoles({ actor, target, roleIds: [id], ip: req.ip });
  }

  const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (body.status !== undefined && body.status !== target.status) {
    if (body.status === 'disabled') await assertOwnerRemains(actor.agencyId, [target.id]);
    patch.status = body.status;
  }
  if (body.fullName !== undefined) patch.fullName = body.fullName;
  if (body.designation !== undefined) patch.designation = body.designation;
  if (body.department !== undefined) patch.department = body.department;
  if (body.phone !== undefined) patch.phone = body.phone;
  if (body.hourlyRate !== undefined) patch.hourlyRate = body.hourlyRate;
  if (body.monthlySalaryPaise !== undefined) patch.monthlySalaryPaise = body.monthlySalaryPaise;
  if (body.weeklyCapacityHrs !== undefined) patch.weeklyCapacityHrs = body.weeklyCapacityHrs;
  if (body.skills !== undefined) patch.skills = skillsToCsv(body.skills) ?? null;

  await db.update(users).set(patch).where(eq(users.id, target.id));
  if (patch.status) {
    await bumpUsers([target.id]);
    if (patch.status === 'disabled') await revokeUserSessions(target.id, 'disabled');
    await auditAuthz({
      actor,
      action: patch.status === 'disabled' ? 'user.disable' : 'user.enable',
      entityType: 'user',
      entityId: target.id,
      before: { status: target.status },
      after: { status: patch.status },
      ip: req.ip,
    });
  }
  if (touchesProfile || touchesComp) {
    await audit({
      agencyId: actor.agencyId,
      actorType: 'staff',
      actorId: actor.userId,
      action: touchesComp ? 'team.update.compensation' : 'team.update',
      entityType: 'user',
      entityId: target.id,
      ip: req.ip,
    });
  }
  ok(res, { updated: true });
});

// ============================================================
//  Authorization administration for a member
// ============================================================
usersRouter.get('/:userId/authorization', requires('users.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const target = await loadTarget(actor.agencyId, param(req, 'userId'));
  const explained = await explainUser({ id: target.id, kind: target.kind });
  const actorIsOwner = await holdsOwnerRole(actor.userId, actor.agencyId);
  let manageable = false;
  try {
    await assertCanManageUser(actor, target);
    manageable = true;
  } catch {
    manageable = false;
  }
  ok(res, {
    userId: target.id,
    kind: target.kind,
    roles: await roleSummaries(target.id),
    grants: explained.grants,
    sources: explained.sources,
    overrides: await db
      .select({
        permission: userPermissionOverrides.permission,
        scope: userPermissionOverrides.scope,
        effect: userPermissionOverrides.effect,
        reason: userPermissionOverrides.reason,
      })
      .from(userPermissionOverrides)
      .where(eq(userPermissionOverrides.userId, target.id)),
    manageable,
    actorIsOwner,
  });
});

const rolesBody = z.object({ roleIds: z.array(z.string().min(1)).min(1).max(10) });

usersRouter.put('/:userId/roles', requires('users.assign_roles'), async (req, res) => {
  const actor = getStaffActor(req);
  const target = await loadTarget(actor.agencyId, param(req, 'userId'));
  if (target.kind !== 'staff') throw badRequest('Use /team/client-users for client accounts.');
  const { roleIds } = rolesBody.parse(req.body);
  await setUserRoles({ actor, target, roleIds, ip: req.ip });
  ok(res, { roles: await roleSummaries(target.id) });
});

const overridesBody = z.object({
  overrides: z
    .array(
      z.object({
        permission: z.string().min(1),
        scope: z.enum(SCOPES).nullable(),
        effect: z.enum(['grant', 'deny']),
        reason: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .max(200),
});

usersRouter.put('/:userId/overrides', requires('users.manage_permissions'), async (req, res) => {
  const actor = getStaffActor(req);
  const target = await loadTarget(actor.agencyId, param(req, 'userId'));
  const { overrides } = overridesBody.parse(req.body);
  await setUserOverrides({ actor, target, overrides, ip: req.ip });
  ok(res, { updated: true });
});

usersRouter.post('/:userId/sessions/revoke', requires('users.revoke_sessions'), async (req, res) => {
  const actor = getStaffActor(req);
  const target = await loadTarget(actor.agencyId, param(req, 'userId'));
  await assertCanManageUser(actor, target);
  const ended = await revokeUserSessions(target.id, 'admin_revoke');
  await auditAuthz({ actor, action: 'user.sessions.revoke', entityType: 'user', entityId: target.id, after: { ended }, ip: req.ip });
  ok(res, { revoked: ended });
});

usersRouter.delete('/:userId', requires('users.delete'), async (req, res) => {
  const actor = getStaffActor(req);
  const target = await loadTarget(actor.agencyId, param(req, 'userId'));
  if (target.kind !== 'staff') throw notFound('Member not found.');
  await assertCanManageUser(actor, target);
  await assertOwnerRemains(actor.agencyId, [target.id]);
  await revokeUserSessions(target.id, 'deleted');
  await db.delete(users).where(and(eq(users.id, target.id), eq(users.agencyId, actor.agencyId)));
  await auditAuthz({
    actor,
    action: 'user.delete',
    entityType: 'user',
    entityId: target.id,
    before: { email: target.email, roles: (await roleSummaries(target.id)).map((r) => r.name) },
    ip: req.ip,
  });
  ok(res, { deleted: true });
});

// Admin-initiated reset: the link is EMAILED to the member only, never returned.
usersRouter.post('/:userId/reset-password', requires('users.reset_password'), async (req, res) => {
  const actor = getStaffActor(req);
  const member = await loadTarget(actor.agencyId, param(req, 'userId'));
  if (member.kind !== 'staff') throw badRequest('Use /team/client-users for client accounts.');
  await assertCanManageUser(actor, member);
  if (member.status !== 'active') throw conflict('This member is not active.');
  await createPasswordReset(member, { byAdmin: true, req });
  await auditAuthz({ actor, action: 'user.password_reset', entityType: 'user', entityId: member.id, ip: req.ip });
  ok(res, { ok: true, emailed: true });
});

// ============================================================
//  TIME LOGS — POST/GET /team/:userId/time-logs
// ============================================================
const createTimeLogSchema = z.object({
  minutes: z.number().int().positive(),
  projectId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  workDate: z.coerce.date().optional(),
  note: z.string().trim().max(2000).optional(),
});

function subjectFacts(agencyId: string, userId: string) {
  return { agencyId, ownerIds: [userId] };
}

usersRouter.post('/:userId/time-logs', requires('time_logs.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const userId = param(req, 'userId');
  const target = await loadTarget(actor.agencyId, userId);
  if (target.kind !== 'staff') throw notFound('Member not found.');
  authorize(actor, 'time_logs.create', subjectFacts(actor.agencyId, userId));
  const body = createTimeLogSchema.parse(req.body);

  if (body.projectId) {
    const [p] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, body.projectId), eq(projects.agencyId, actor.agencyId)))
      .limit(1);
    if (!p) throw notFound('Project not found.');
  }
  if (body.taskId) {
    const [tk] = await db
      .select({ id: projectTasks.id, projectId: projectTasks.projectId })
      .from(projectTasks)
      .where(and(eq(projectTasks.id, body.taskId), eq(projectTasks.agencyId, actor.agencyId)))
      .limit(1);
    if (!tk) throw notFound('Task not found.');
    if (body.projectId && tk.projectId !== body.projectId) throw conflict('Task does not belong to the given project.');
  }

  const id = newId('tlg');
  await db.insert(timeLogs).values({
    id,
    agencyId: actor.agencyId,
    userId,
    projectId: body.projectId ?? null,
    taskId: body.taskId ?? null,
    minutes: body.minutes,
    workDate: body.workDate ?? new Date(),
    note: body.note ?? null,
  });
  await audit({
    agencyId: actor.agencyId,
    actorType: 'staff',
    actorId: actor.userId,
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
  created(res, { ...row!, workDate: toIso(row!.workDate) });
});

usersRouter.get('/:userId/time-logs', requires('time_logs.view'), async (req, res) => {
  const actor = getStaffActor(req);
  const userId = param(req, 'userId');
  await loadTarget(actor.agencyId, userId);
  authorize(actor, 'time_logs.view', subjectFacts(actor.agencyId, userId), { message: 'You can only view your own time logs.' });
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
    .where(and(eq(timeLogs.agencyId, actor.agencyId), eq(timeLogs.userId, userId)))
    .orderBy(desc(timeLogs.workDate))
    .limit(50);
  ok(res, rows.map((l) => ({ ...l, workDate: toIso(l.workDate) })));
});

// ============================================================
//  ACTIVITY — GET /team/:userId/activity
// ============================================================
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

usersRouter.get('/:userId/activity', requires('users.view_activity'), async (req, res) => {
  const actor = getActor(req);
  const userId = param(req, 'userId');
  await loadTarget(actor.agencyId, userId);
  if (!check(actor, 'users.view_activity', subjectFacts(actor.agencyId, userId))) {
    throw forbidden('You can only view your own activity.');
  }
  const { limit } = activityQuery.parse(req.query);
  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      metadataJson: auditLog.metadataJson,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(and(eq(auditLog.agencyId, actor.agencyId), eq(auditLog.actorId, userId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit ?? 40);
  ok(
    res,
    rows.map((r) => {
      let metadata: Record<string, unknown> | null = null;
      if (r.metadataJson) {
        try {
          metadata = JSON.parse(r.metadataJson) as Record<string, unknown>;
        } catch {
          metadata = null;
        }
      }
      return { id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId, metadata, createdAt: toIso(r.createdAt) };
    }),
  );
});
