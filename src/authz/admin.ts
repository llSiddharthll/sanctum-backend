/**
 * Authorization-administration guard (design §F.4). Prevents privilege
 * escalation when roles, role assignments and overrides change.
 *
 *  - Ceiling: every grant an actor gives (to a role or a user) must be covered
 *    by the actor's own grants (same scope, or organization ⊒ own/assigned/project).
 *  - Manageable: an actor may manage user U only if the actor holds the Owner
 *    role, or G(U) is STRICTLY covered by G(actor). Peers can't manage peers;
 *    only owners manage owners.
 *  - No self-modification of authorization.
 *  - Owner invariant: every agency keeps ≥1 active user holding the Owner role.
 */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roles, userRoles, users } from '../db/schema.js';
import { AppError, forbidden } from '../lib/errors.js';
import { scopeCovers, type Grant } from './catalog.js';
import type { GrantSet } from './actor.js';

export function uncovered(held: GrantSet, wanted: Iterable<Grant>): Grant[] {
  const out: Grant[] = [];
  for (const w of wanted) {
    if (!held.scopes(w.permission).some((h) => scopeCovers(h, w.scope))) out.push(w);
  }
  return out;
}

export function covers(held: GrantSet, wanted: GrantSet): boolean {
  return uncovered(held, wanted.toGrants()).length === 0;
}

export function assertWithinCeiling(held: GrantSet, wanted: Iterable<Grant>): void {
  const missing = uncovered(held, wanted);
  if (missing.length) {
    throw new AppError(
      'FORBIDDEN',
      'You can only grant permissions you hold yourself (at the same or a narrower scope).',
      {
        missing: missing
          .slice(0, 20)
          .map((m) => `${m.permission}:${m.scope}`),
      },
    );
  }
}

export async function ownerRoleId(agencyId: string): Promise<string | null> {
  const [r] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.agencyId, agencyId), eq(roles.key, 'owner')))
    .limit(1);
  return r?.id ?? null;
}

export async function holdsOwnerRole(userId: string, agencyId: string): Promise<boolean> {
  const [r] = await db
    .select({ one: sql`1` })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(roles.agencyId, agencyId),
        eq(roles.key, 'owner'),
      ),
    )
    .limit(1);
  return !!r;
}

/** Can `actor` (grants + owner flag) manage `target` (grants + owner flag)? */
export function isManageable(input: {
  actorId: string;
  actorGrants: GrantSet;
  actorIsOwner: boolean;
  targetId: string;
  targetGrants: GrantSet;
  targetIsOwner: boolean;
}): boolean {
  if (input.actorId === input.targetId) return false;
  if (input.actorIsOwner) return true;
  if (input.targetIsOwner) return false;
  return (
    covers(input.actorGrants, input.targetGrants) &&
    !covers(input.targetGrants, input.actorGrants)
  );
}

export function assertManageable(input: Parameters<typeof isManageable>[0]): void {
  if (input.actorId === input.targetId) {
    throw forbidden("You can't change your own access or account status.");
  }
  if (!isManageable(input)) {
    throw forbidden(
      "You can't manage this person: they have as much access as you or more.",
    );
  }
}

/**
 * Throw if, after removing `removingUserIds` from the Owner role (or disabling /
 * deleting them), no active owner would remain.
 */
export async function assertOwnerRemains(
  agencyId: string,
  removingUserIds: string[],
): Promise<void> {
  const ownerId = await ownerRoleId(agencyId);
  if (!ownerId) return;
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(
        eq(userRoles.roleId, ownerId),
        eq(users.status, 'active'),
        removingUserIds.length ? sql`${userRoles.userId} NOT IN (${sql.join(removingUserIds.map((id) => sql`${id}`), sql`, `)})` : sql`1=1`,
      ),
    );
  if (!rows.length) {
    throw new AppError('CONFLICT', 'The agency must keep at least one active owner.');
  }
}

/** Roles (by id) must all exist in the agency, be active, and match the actor type. */
export async function loadAssignableRoles(
  agencyId: string,
  roleIds: string[],
  actorType: 'staff' | 'client',
) {
  const ids = [...new Set(roleIds)];
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(roles)
    .where(and(eq(roles.agencyId, agencyId), inArray(roles.id, ids), isNull(roles.archivedAt)));
  if (rows.length !== ids.length) {
    throw new AppError('NOT_FOUND', 'One or more roles were not found.');
  }
  const wrong = rows.find((r) => r.actorType !== actorType);
  if (wrong) {
    throw new AppError(
      'BAD_REQUEST',
      `Role "${wrong.name}" is for ${wrong.actorType} accounts and can't be assigned here.`,
    );
  }
  return rows;
}

export async function roleHolderIds(roleId: string, exceptUserId?: string): Promise<string[]> {
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(
      exceptUserId
        ? and(eq(userRoles.roleId, roleId), ne(userRoles.userId, exceptUserId))
        : eq(userRoles.roleId, roleId),
    );
  return rows.map((r) => r.userId);
}
