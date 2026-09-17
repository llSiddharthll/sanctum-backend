/**
 * Permission resolver: roles + overrides → GrantSet.
 *
 *   G(user) = (⋃ grants of the user's active roles (matching actor type)
 *              − every role scope of permissions with a user deny override)
 *           ∪ user grant overrides
 *
 * Invalid rows (unknown permission, scope not supported for the actor type)
 * are ignored — fail closed. Results are cached by (userId, authz_version);
 * every mutation that can change a user's grants bumps users.authz_version, so
 * a stale cache entry is simply never hit again.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  rolePermissions,
  roles,
  userPermissionOverrides,
  userRoles,
  users,
} from '../db/schema.js';
import {
  getPermission,
  isScope,
  scopesForActor,
  type ActorType,
  type Grant,
  type Scope,
} from './catalog.js';
import { GrantSet } from './actor.js';

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 5_000;

interface Entry<T> {
  value: T;
  at: number;
}
const userCache = new Map<string, Entry<GrantSet>>();
const roleCache = new Map<string, Entry<GrantSet>>();

function cacheGet<T>(m: Map<string, Entry<T>>, k: string): T | undefined {
  const e = m.get(k);
  if (!e) return undefined;
  if (Date.now() - e.at > TTL_MS) {
    m.delete(k);
    return undefined;
  }
  return e.value;
}
function cacheSet<T>(m: Map<string, Entry<T>>, k: string, value: T): void {
  if (m.size >= MAX_ENTRIES) {
    const first = m.keys().next().value;
    if (first !== undefined) m.delete(first);
  }
  m.set(k, { value, at: Date.now() });
}

function validFor(actorType: ActorType, permission: string, scope: string): scope is Scope {
  const p = getPermission(permission);
  if (!p || !isScope(scope) || !p.actors.includes(actorType)) return false;
  return scopesForActor(p, actorType).includes(scope);
}

export interface GrantSource {
  permission: string;
  scope: Scope | null;
  via: 'role' | 'grant_override' | 'deny_override';
  roleId?: string;
  roleName?: string;
}

async function loadRaw(userId: string, actorType: ActorType) {
  const roleRows = await db
    .select({
      roleId: roles.id,
      roleName: roles.name,
      permission: rolePermissions.permission,
      scope: rolePermissions.scope,
    })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(
      and(
        eq(userRoles.userId, userId),
        isNull(roles.archivedAt),
        eq(roles.actorType, actorType),
        // Defense in depth: role must belong to the same agency as the assignment.
        sql`${roles.agencyId} = ${userRoles.agencyId}`,
      ),
    );
  const overrides = await db
    .select()
    .from(userPermissionOverrides)
    .where(eq(userPermissionOverrides.userId, userId));
  return { roleRows, overrides };
}

function compose(
  actorType: ActorType,
  raw: Awaited<ReturnType<typeof loadRaw>>,
): { grants: Grant[]; sources: GrantSource[] } {
  const sources: GrantSource[] = [];
  const grants = new Map<string, Grant>();
  for (const r of raw.roleRows) {
    if (!validFor(actorType, r.permission, r.scope)) continue;
    grants.set(`${r.permission}|${r.scope}`, { permission: r.permission, scope: r.scope });
    sources.push({
      permission: r.permission,
      scope: r.scope,
      via: 'role',
      roleId: r.roleId,
      roleName: r.roleName,
    });
  }
  // Precedence (design §F.7): role grants − denied permissions, then + user grants.
  const denied = new Set<string>();
  for (const o of raw.overrides) {
    if (o.effect === 'deny' && getPermission(o.permission)) {
      denied.add(o.permission);
      sources.push({ permission: o.permission, scope: null, via: 'deny_override' });
    }
  }
  for (const [k, g] of grants) {
    if (denied.has(g.permission)) grants.delete(k);
  }
  for (const o of raw.overrides) {
    if (o.effect !== 'grant' || !o.scope || !validFor(actorType, o.permission, o.scope)) continue;
    grants.set(`${o.permission}|${o.scope}`, { permission: o.permission, scope: o.scope });
    sources.push({ permission: o.permission, scope: o.scope, via: 'grant_override' });
  }
  return { grants: [...grants.values()], sources };
}

/** Effective grants of a user (staff or client). Cached by authz version. */
export async function grantsForUser(user: {
  id: string;
  kind: ActorType;
  authzVersion: number;
}): Promise<GrantSet> {
  const key = `${user.id}:${user.kind}:${user.authzVersion}`;
  const hit = cacheGet(userCache, key);
  if (hit) return hit;
  const { grants } = compose(user.kind, await loadRaw(user.id, user.kind));
  const set = new GrantSet(grants);
  cacheSet(userCache, key, set);
  return set;
}

/** Grants of a single (client) role — used for portal-link actors. */
export async function grantsForRole(
  roleId: string,
  agencyId: string,
  actorType: ActorType,
): Promise<GrantSet> {
  const key = `${roleId}:${agencyId}:${actorType}`;
  const hit = cacheGet(roleCache, key);
  if (hit) return hit;
  const rows = await db
    .select({ permission: rolePermissions.permission, scope: rolePermissions.scope })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .where(
      and(
        eq(roles.id, roleId),
        eq(roles.agencyId, agencyId),
        eq(roles.actorType, actorType),
        isNull(roles.archivedAt),
      ),
    );
  const set = new GrantSet(
    rows.filter((r) => validFor(actorType, r.permission, r.scope)),
  );
  cacheSet(roleCache, key, set);
  return set;
}

/** Why does this user have (or lack) each permission? (§33 effective permissions view) */
export async function explainUser(user: {
  id: string;
  kind: ActorType;
}): Promise<{ grants: Grant[]; sources: GrantSource[] }> {
  return compose(user.kind, await loadRaw(user.id, user.kind));
}

/** Compute the grant set a user WOULD have with a different role/override state. */
export async function simulateUserGrants(input: {
  userId: string;
  kind: ActorType;
  roleIds?: string[];
  overrides?: Array<{ permission: string; scope: Scope | null; effect: 'grant' | 'deny' }>;
  /** Replace a role's grants (role being edited). */
  roleGrantsOverride?: { roleId: string; grants: Grant[] };
}): Promise<GrantSet> {
  const raw = await loadRaw(input.userId, input.kind);
  let roleRows = raw.roleRows;
  if (input.roleIds) {
    const ids = [...new Set(input.roleIds)];
    roleRows = ids.length
      ? await db
          .select({
            roleId: roles.id,
            roleName: roles.name,
            permission: rolePermissions.permission,
            scope: rolePermissions.scope,
          })
          .from(roles)
          .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
          .where(
            and(inArray(roles.id, ids), isNull(roles.archivedAt), eq(roles.actorType, input.kind)),
          )
      : [];
  }
  if (input.roleGrantsOverride) {
    const { roleId, grants } = input.roleGrantsOverride;
    const holds = roleRows.some((r) => r.roleId === roleId) ||
      (input.roleIds?.includes(roleId) ?? false);
    roleRows = roleRows.filter((r) => r.roleId !== roleId);
    if (holds) {
      roleRows.push(
        ...grants.map((g) => ({ roleId, roleName: '', permission: g.permission, scope: g.scope })),
      );
    }
  }
  const overrides = input.overrides
    ? input.overrides.map((o) => ({
        id: '', agencyId: '', userId: input.userId, permission: o.permission,
        scope: o.scope, effect: o.effect, reason: null, createdBy: null, createdAt: new Date(),
      }))
    : raw.overrides;
  return new GrantSet(compose(input.kind, { roleRows, overrides }).grants);
}

// ------------------------------------------------------------ invalidation

/** Bump authz_version for users → their next request re-resolves grants. */
export async function bumpUsers(userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return;
  await db
    .update(users)
    .set({ authzVersion: sql`${users.authzVersion} + 1` })
    .where(inArray(users.id, ids));
  for (const k of [...userCache.keys()]) {
    if (ids.some((id) => k.startsWith(`${id}:`))) userCache.delete(k);
  }
  onAuthzChanged?.(ids);
}

/** Bump every holder of a role (role edited/archived) and drop its role cache. */
export async function bumpRoleHolders(roleId: string): Promise<string[]> {
  const holders = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.roleId, roleId));
  for (const k of [...roleCache.keys()]) {
    if (k.startsWith(`${roleId}:`)) roleCache.delete(k);
  }
  const ids = holders.map((h) => h.userId);
  await bumpUsers(ids);
  onRoleChanged?.(roleId);
  return ids;
}

export function clearAuthzCaches(): void {
  userCache.clear();
  roleCache.clear();
}

/** Hooks wired by the realtime layer (authz:changed fan-out). */
let onAuthzChanged: ((userIds: string[]) => void) | undefined;
let onRoleChanged: ((roleId: string) => void) | undefined;
export function setAuthzChangeHooks(h: {
  users?: (userIds: string[]) => void;
  role?: (roleId: string) => void;
}): void {
  onAuthzChanged = h.users;
  onRoleChanged = h.role;
}

/**
 * Active staff users of an agency who hold `permission` (any scope, or the given
 * scope). Used to pick notification recipients by capability instead of role.
 */
export async function usersWithPermission(
  agencyId: string,
  permission: string,
  opts: { scope?: Scope; excludeUserId?: string } = {},
): Promise<string[]> {
  const rows = await db
    .select({ id: users.id, kind: users.kind, authzVersion: users.authzVersion })
    .from(users)
    .where(and(eq(users.agencyId, agencyId), eq(users.status, 'active'), eq(users.kind, 'staff')));
  const out: string[] = [];
  for (const u of rows) {
    if (u.id === opts.excludeUserId) continue;
    const g = await grantsForUser({ id: u.id, kind: u.kind, authzVersion: u.authzVersion });
    if (opts.scope ? g.hasScope(permission, opts.scope) : g.has(permission)) out.push(u.id);
  }
  return out;
}
