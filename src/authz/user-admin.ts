/**
 * Shared logic for administering users' authorization (team + client users):
 * loading a target's effective authority and applying role/override changes
 * behind the admin guard, with audit + cache/session propagation.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roles, userPermissionOverrides, userRoles, users } from '../db/schema.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { auditAuthz } from '../services/audit.js';
import type { Actor, GrantSet, StaffActor } from './actor.js';
import {
  assertManageable,
  assertOwnerRemains,
  assertWithinCeiling,
  holdsOwnerRole,
  loadAssignableRoles,
} from './admin.js';
import type { Scope } from './catalog.js';
import { validateGrantSet } from './catalog.js';
import { bumpUsers, grantsForUser, simulateUserGrants } from './resolver.js';
import { assignRoles, readRoleGrants, syncLegacyRoleColumn, writeOverrides } from './roles-store.js';

export type TargetUser = typeof users.$inferSelect;

export async function loadTarget(agencyId: string, userId: string): Promise<TargetUser> {
  const [u] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.agencyId, agencyId)))
    .limit(1);
  if (!u) throw notFound('User not found.');
  return u;
}

export async function targetAuthority(t: TargetUser): Promise<{ grants: GrantSet; isOwner: boolean }> {
  return {
    grants: await grantsForUser({ id: t.id, kind: t.kind, authzVersion: t.authzVersion }),
    isOwner: t.kind === 'staff' && (await holdsOwnerRole(t.id, t.agencyId)),
  };
}

/** Throws unless `actor` may administer `target` (not self; strictly more authority, or owner). */
export async function assertCanManageUser(actor: StaffActor, target: TargetUser): Promise<void> {
  const [actorIsOwner, t] = await Promise.all([
    holdsOwnerRole(actor.userId, actor.agencyId),
    targetAuthority(target),
  ]);
  assertManageable({
    actorId: actor.userId,
    actorGrants: actor.grants,
    actorIsOwner,
    targetId: target.id,
    targetGrants: t.grants,
    targetIsOwner: t.isOwner,
  });
}

export async function roleSummaries(userId: string) {
  return db
    .select({ id: roles.id, key: roles.key, name: roles.name, kind: roles.kind, colorToken: roles.colorToken })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), isNull(roles.archivedAt)));
}

/**
 * Replace a user's role assignments. Enforces: target manageable, every
 * assigned role within the actor's ceiling, actor type match, Owner role only by
 * owners, and the ≥1-owner invariant.
 */
export async function setUserRoles(input: {
  actor: StaffActor;
  target: TargetUser;
  roleIds: string[];
  ip?: string;
}): Promise<void> {
  const { actor, target } = input;
  await assertCanManageUser(actor, target);
  const assignable = await loadAssignableRoles(actor.agencyId, input.roleIds, target.kind);
  if (!assignable.length) throw badRequest('At least one role is required.');

  const actorIsOwner = await holdsOwnerRole(actor.userId, actor.agencyId);
  const before = await roleSummaries(target.id);
  const wasOwner = before.some((r) => r.key === 'owner');
  const willBeOwner = assignable.some((r) => r.key === 'owner');
  if ((willBeOwner || wasOwner) && !actorIsOwner) {
    throw new AppError('FORBIDDEN', 'Only owners can grant or remove the Owner role.');
  }
  if (target.kind === 'staff') {
    for (const r of assignable) assertWithinCeiling(actor.grants, await readRoleGrants(db, r.id));
  }
  if (wasOwner && !willBeOwner) await assertOwnerRemains(actor.agencyId, [target.id]);

  await db.transaction(async (tx) => {
    await assignRoles(tx, {
      agencyId: actor.agencyId,
      userId: target.id,
      roleIds: assignable.map((r) => r.id),
      assignedBy: actor.userId,
    });
    await syncLegacyRoleColumn(tx, target.id);
  });
  await bumpUsers([target.id]);
  await auditAuthz({
    actor,
    action: 'user.roles.set',
    entityType: target.kind === 'client' ? 'client_user' : 'user',
    entityId: target.id,
    before: before.map((r) => r.name),
    after: assignable.map((r) => r.name),
    ip: input.ip,
  });
}

export interface OverrideInput {
  permission: string;
  scope: Scope | null;
  effect: 'grant' | 'deny';
  reason?: string | null;
}

/** Replace a staff user's permission exceptions behind the admin guard. */
export async function setUserOverrides(input: {
  actor: StaffActor;
  target: TargetUser;
  overrides: OverrideInput[];
  ip?: string;
}): Promise<void> {
  const { actor, target, overrides } = input;
  if (target.kind !== 'staff') throw badRequest('Exceptions apply to staff accounts only.');
  await assertCanManageUser(actor, target);

  const grants = overrides.filter((o) => o.effect === 'grant');
  for (const o of overrides) {
    if (o.effect === 'grant' && !o.scope) throw badRequest(`Grant "${o.permission}" needs a scope.`);
    if (o.effect === 'deny' && o.scope) throw badRequest(`Deny "${o.permission}" can't have a scope.`);
  }
  const problems = validateGrantSet(
    grants.map((g) => ({ permission: g.permission, scope: g.scope! })),
    'staff',
  ).filter((p) => !p.includes('requires'));
  if (problems.length) throw new AppError('VALIDATION_ERROR', problems[0]!, { problems });
  assertWithinCeiling(actor.grants, grants.map((g) => ({ permission: g.permission, scope: g.scope! })));

  // Resulting state must still be manageable by the actor (no lateral escalation).
  const resulting = await simulateUserGrants({ userId: target.id, kind: 'staff', overrides });
  const actorIsOwner = await holdsOwnerRole(actor.userId, actor.agencyId);
  const t = await targetAuthority(target);
  assertManageable({
    actorId: actor.userId,
    actorGrants: actor.grants,
    actorIsOwner,
    targetId: target.id,
    targetGrants: resulting,
    targetIsOwner: t.isOwner,
  });

  const before = await db
    .select({
      permission: userPermissionOverrides.permission,
      scope: userPermissionOverrides.scope,
      effect: userPermissionOverrides.effect,
    })
    .from(userPermissionOverrides)
    .where(eq(userPermissionOverrides.userId, target.id));
  await writeOverrides(db, {
    agencyId: actor.agencyId,
    userId: target.id,
    overrides,
    createdBy: actor.userId,
  });
  await bumpUsers([target.id]);
  await auditAuthz({
    actor,
    action: 'user.overrides.set',
    entityType: 'user',
    entityId: target.id,
    before,
    after: overrides,
    ip: input.ip,
  });
}

export function isStaffActor(a: Actor): a is StaffActor {
  return a.type === 'staff';
}
