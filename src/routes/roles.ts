/**
 * Roles API (design §F). Roles are per-agency permission bundles; every write
 * is validated against the catalog and the admin guard (ceiling, no editing a
 * role you hold, locked roles immutable).
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, count, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roles, userRoles, users } from '../db/schema.js';
import { ok, created, param, toIso } from '../lib/http.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { auditAuthz } from '../services/audit.js';
import { authenticate, getActor, getStaffActor, requires } from '../authz/http.js';
import type { StaffActor } from '../authz/actor.js';
import { assertWithinCeiling, holdsOwnerRole } from '../authz/admin.js';
import {
  ROLE_TEMPLATES,
  SCOPES,
  publicCatalog,
  validateGrantSet,
  type ActorType,
  type Grant,
} from '../authz/catalog.js';
import { createRole, dedupeGrants, readRoleGrants, writeRoleGrants } from '../authz/roles-store.js';
import { bumpRoleHolders } from '../authz/resolver.js';

export const rolesRouter = Router();
rolesRouter.use(authenticate);

export const authzRouter = Router();
authzRouter.use(authenticate);

// GET /authz/catalog — the canonical permission catalog (all authenticated actors).
authzRouter.get('/catalog', (_req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=300');
  ok(res, publicCatalog());
});

type RoleRow = typeof roles.$inferSelect;

async function serializeRole(r: RoleRow, holderCount?: number) {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    kind: r.kind,
    actorType: r.actorType,
    isLocked: r.isLocked,
    colorToken: r.colorToken,
    templateKey: r.templateKey,
    archivedAt: toIso(r.archivedAt),
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
    grants: await readRoleGrants(db, r.id),
    ...(holderCount !== undefined ? { holderCount } : {}),
  };
}

async function loadRole(agencyId: string, id: string): Promise<RoleRow> {
  const [r] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, id), eq(roles.agencyId, agencyId)))
    .limit(1);
  if (!r) throw notFound('Role not found.');
  return r;
}

const grantSchema = z.object({ permission: z.string().min(1), scope: z.enum(SCOPES) });

/**
 * Who may define a role of this actor type with these grants?
 *  - staff roles: every grant must be within the actor's own grants (ceiling)
 *  - client roles: the actor must be able to manage client accounts org-wide
 *    (client permissions are never staff powers, so no cross-escalation exists)
 */
function assertCanDefine(actor: StaffActor, actorType: ActorType, grants: Grant[]): void {
  const problems = validateGrantSet(grants, actorType);
  if (problems.length) throw new AppError('VALIDATION_ERROR', problems[0]!, { problems });
  if (actorType === 'staff') {
    assertWithinCeiling(actor.grants, grants);
  } else if (!actor.grants.hasScope('client_users.update', 'organization')) {
    throw forbidden('You need organization-wide client account management to define client roles.');
  }
}

async function assertNotSelfRole(actor: StaffActor, roleId: string): Promise<void> {
  if (await holdsOwnerRole(actor.userId, actor.agencyId)) return;
  const [held] = await db
    .select({ one: sql`1` })
    .from(userRoles)
    .where(and(eq(userRoles.userId, actor.userId), eq(userRoles.roleId, roleId)))
    .limit(1);
  if (held) throw forbidden("You can't change a role you hold yourself.");
}

// GET /roles?actorType=&includeArchived=
rolesRouter.get('/', requires('roles.view'), async (req, res) => {
  const actor = getActor(req);
  const q = z
    .object({
      actorType: z.enum(['staff', 'client']).optional(),
      includeArchived: z.enum(['true', 'false']).optional(),
    })
    .parse(req.query);
  const rows = await db
    .select()
    .from(roles)
    .where(
      and(
        eq(roles.agencyId, actor.agencyId),
        q.actorType ? eq(roles.actorType, q.actorType) : sql`1`,
        q.includeArchived === 'true' ? sql`1` : isNull(roles.archivedAt),
      ),
    )
    .orderBy(asc(roles.kind), asc(roles.name));
  const counts = rows.length
    ? await db
        .select({ roleId: userRoles.roleId, n: count() })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(and(inArray(userRoles.roleId, rows.map((r) => r.id)), eq(users.status, 'active')))
        .groupBy(userRoles.roleId)
    : [];
  const byRole = new Map(counts.map((c) => [c.roleId, Number(c.n)]));
  ok(res, await Promise.all(rows.map((r) => serializeRole(r, byRole.get(r.id) ?? 0))));
});

// GET /roles/templates — role templates (pre-fill "create role").
rolesRouter.get('/templates', requires('roles.view'), (_req, res) => {
  ok(res, ROLE_TEMPLATES);
});

// GET /roles/:id
rolesRouter.get('/:id', requires('roles.view'), async (req, res) => {
  const actor = getActor(req);
  ok(res, await serializeRole(await loadRole(actor.agencyId, param(req, 'id'))));
});

// GET /roles/:id/holders
rolesRouter.get('/:id/holders', requires('roles.view', 'users.view'), async (req, res) => {
  const actor = getActor(req);
  const role = await loadRole(actor.agencyId, param(req, 'id'));
  const rows = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email, status: users.status, kind: users.kind })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(eq(userRoles.roleId, role.id));
  ok(res, rows);
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  actorType: z.enum(['staff', 'client']).default('staff'),
  colorToken: z.enum(['pine', 'brass', 'sky', 'rose', 'amber', 'violet', 'slate', 'ocean']).optional(),
  grants: z.array(grantSchema).max(500).optional(),
  templateKey: z.string().optional(),
  cloneFromRoleId: z.string().optional(),
});

// POST /roles — create a custom role (from scratch, a template, or a clone).
rolesRouter.post('/', requires('roles.create'), async (req, res) => {
  const actor = getStaffActor(req);
  const body = createSchema.parse(req.body);

  let grants: Grant[] = body.grants ?? [];
  let actorType: ActorType = body.actorType;
  if (!body.grants && body.templateKey) {
    const t = ROLE_TEMPLATES.find((x) => x.key === body.templateKey);
    if (!t) throw badRequest('Unknown template.');
    grants = t.grants;
    actorType = t.actorType;
  }
  if (!body.grants && body.cloneFromRoleId) {
    const src = await loadRole(actor.agencyId, body.cloneFromRoleId);
    grants = await readRoleGrants(db, src.id);
    actorType = src.actorType;
  }
  grants = dedupeGrants(grants);
  assertCanDefine(actor, actorType, grants);

  const [dupe] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.agencyId, actor.agencyId), sql`lower(${roles.name}) = ${body.name.toLowerCase()}`, isNull(roles.archivedAt)))
    .limit(1);
  if (dupe) throw conflict('A role with that name already exists.');

  const id = await createRole(db, {
    agencyId: actor.agencyId,
    name: body.name,
    description: body.description ?? null,
    kind: 'custom',
    actorType,
    colorToken: body.colorToken,
    templateKey: body.templateKey ?? null,
    createdBy: actor.userId,
    grants,
  });
  await auditAuthz({
    actor,
    action: 'role.create',
    entityType: 'role',
    entityId: id,
    after: { name: body.name, actorType, grants },
    ip: req.ip,
  });
  created(res, await serializeRole(await loadRole(actor.agencyId, id), 0));
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  colorToken: z.enum(['pine', 'brass', 'sky', 'rose', 'amber', 'violet', 'slate', 'ocean']).optional(),
  grants: z.array(grantSchema).max(500).optional(),
});

// PATCH /roles/:id
rolesRouter.patch('/:id', requires('roles.update'), async (req, res) => {
  const actor = getStaffActor(req);
  const role = await loadRole(actor.agencyId, param(req, 'id'));
  const body = updateSchema.parse(req.body);
  if (role.archivedAt) throw conflict('Archived roles cannot be edited.');
  if (role.isLocked) throw forbidden('This role is locked and cannot be changed.');
  if (role.kind === 'system' && body.name !== undefined && body.name !== role.name) {
    throw forbidden('System roles cannot be renamed.');
  }
  await assertNotSelfRole(actor, role.id);

  const beforeGrants = await readRoleGrants(db, role.id);
  let nextGrants: Grant[] | undefined;
  if (body.grants) {
    nextGrants = dedupeGrants(body.grants);
    assertCanDefine(actor, role.actorType, nextGrants);
    // Removing a grant the actor can't hold would also be out of bounds: an
    // actor may only reshape roles entirely within their own authority.
    if (role.actorType === 'staff') assertWithinCeiling(actor.grants, beforeGrants);
  }
  if (body.name && body.name.toLowerCase() !== role.name.toLowerCase()) {
    const [dupe] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.agencyId, actor.agencyId), sql`lower(${roles.name}) = ${body.name.toLowerCase()}`, isNull(roles.archivedAt)))
      .limit(1);
    if (dupe) throw conflict('A role with that name already exists.');
  }

  await db.transaction(async (tx) => {
    await tx
      .update(roles)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.colorToken !== undefined ? { colorToken: body.colorToken } : {}),
        updatedAt: new Date(),
      })
      .where(eq(roles.id, role.id));
    if (nextGrants) await writeRoleGrants(tx, role.id, nextGrants);
  });
  const affected = nextGrants ? await bumpRoleHolders(role.id) : [];
  await auditAuthz({
    actor,
    action: 'role.update',
    entityType: 'role',
    entityId: role.id,
    before: { name: role.name, grants: nextGrants ? beforeGrants : undefined },
    after: { name: body.name ?? role.name, grants: nextGrants },
    ip: req.ip,
  });
  ok(res, { ...(await serializeRole(await loadRole(actor.agencyId, role.id))), affectedUsers: affected.length });
});

// POST /roles/:id/archive — custom roles only; holders lose the role.
rolesRouter.post('/:id/archive', requires('roles.archive'), async (req, res) => {
  const actor = getStaffActor(req);
  const role = await loadRole(actor.agencyId, param(req, 'id'));
  if (role.kind === 'system') throw forbidden('System roles cannot be archived.');
  if (role.archivedAt) return ok(res, await serializeRole(role));
  await assertNotSelfRole(actor, role.id);
  const grants = await readRoleGrants(db, role.id);
  if (role.actorType === 'staff') assertWithinCeiling(actor.grants, grants);

  const affected = await bumpRoleHolders(role.id);
  await db.transaction(async (tx) => {
    await tx.update(roles).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(roles.id, role.id));
    await tx.delete(userRoles).where(eq(userRoles.roleId, role.id));
  });
  await auditAuthz({
    actor,
    action: 'role.archive',
    entityType: 'role',
    entityId: role.id,
    before: { name: role.name, holders: affected },
    ip: req.ip,
  });
  ok(res, { ...(await serializeRole(await loadRole(actor.agencyId, role.id))), affectedUsers: affected.length });
});

// POST /roles/:id/restore
rolesRouter.post('/:id/restore', requires('roles.archive'), async (req, res) => {
  const actor = getStaffActor(req);
  const role = await loadRole(actor.agencyId, param(req, 'id'));
  if (!role.archivedAt) return ok(res, await serializeRole(role));
  const grants = await readRoleGrants(db, role.id);
  if (role.actorType === 'staff') assertWithinCeiling(actor.grants, grants);
  const [dupe] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.agencyId, actor.agencyId), sql`lower(${roles.name}) = ${role.name.toLowerCase()}`, isNull(roles.archivedAt)))
    .limit(1);
  if (dupe) throw conflict('An active role with that name already exists.');
  await db.update(roles).set({ archivedAt: null, updatedAt: new Date() }).where(and(eq(roles.id, role.id), isNotNull(roles.archivedAt)));
  await auditAuthz({ actor, action: 'role.restore', entityType: 'role', entityId: role.id, ip: req.ip });
  ok(res, await serializeRole(await loadRole(actor.agencyId, role.id)));
});

