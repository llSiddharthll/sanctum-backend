/**
 * Persistence helpers for roles and grants. All writes validate against the
 * catalog; no caller writes role_permissions / user_roles directly.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  rolePermissions,
  roles,
  userPermissionOverrides,
  userRoles,
  users,
} from '../db/schema.js';
import { newId } from '../lib/ids.js';
import {
  fullGrants,
  isValidGrant,
  SYSTEM_ROLES,
  type ActorType,
  type Grant,
  type Scope,
  type SystemRoleKey,
} from './catalog.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Conn = typeof db | Tx;

export function dedupeGrants(grants: Grant[]): Grant[] {
  const m = new Map<string, Grant>();
  for (const g of grants) m.set(`${g.permission}|${g.scope}`, g);
  return [...m.values()];
}

/** Replace a role's grants (validated). */
export async function writeRoleGrants(conn: Conn, roleId: string, grants: Grant[]): Promise<void> {
  const clean = dedupeGrants(grants).filter((g) => isValidGrant(g.permission, g.scope));
  await conn.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  // SQLite variable limit: chunk inserts.
  for (let i = 0; i < clean.length; i += 100) {
    await conn.insert(rolePermissions).values(
      clean.slice(i, i + 100).map((g) => ({ roleId, permission: g.permission, scope: g.scope })),
    );
  }
}

export async function readRoleGrants(conn: Conn, roleId: string): Promise<Grant[]> {
  const rows = await conn
    .select({ permission: rolePermissions.permission, scope: rolePermissions.scope })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((r) => ({ permission: r.permission, scope: r.scope as Scope }));
}

export async function createRole(
  conn: Conn,
  input: {
    agencyId: string;
    key?: string | null;
    name: string;
    description?: string | null;
    kind: 'system' | 'custom';
    actorType: ActorType;
    isLocked?: boolean;
    colorToken?: string;
    templateKey?: string | null;
    createdBy?: string | null;
    grants: Grant[];
  },
): Promise<string> {
  const id = newId('rol');
  await conn.insert(roles).values({
    id,
    agencyId: input.agencyId,
    key: input.key ?? null,
    name: input.name,
    description: input.description ?? null,
    kind: input.kind,
    actorType: input.actorType,
    isLocked: input.isLocked ?? false,
    colorToken: input.colorToken ?? 'pine',
    templateKey: input.templateKey ?? null,
    createdBy: input.createdBy ?? null,
  });
  await writeRoleGrants(conn, id, input.grants);
  return id;
}

/** Ensure every system role exists for the agency. Returns key → role id. */
export async function ensureSystemRoles(
  conn: Conn,
  agencyId: string,
  overrides: Partial<Record<SystemRoleKey, Grant[]>> = {},
): Promise<Record<SystemRoleKey, string>> {
  const existing = await conn
    .select({ id: roles.id, key: roles.key })
    .from(roles)
    .where(and(eq(roles.agencyId, agencyId), eq(roles.kind, 'system')));
  const byKey = new Map(existing.map((r) => [r.key, r.id]));
  const out = {} as Record<SystemRoleKey, string>;
  for (const def of SYSTEM_ROLES) {
    let id = byKey.get(def.key);
    if (!id) {
      id = await createRole(conn, {
        agencyId,
        key: def.key,
        name: def.name,
        description: def.description,
        kind: 'system',
        actorType: def.actorType,
        isLocked: def.locked,
        colorToken: def.colorToken,
        grants: overrides[def.key] ?? def.grants(),
      });
    }
    out[def.key] = id;
  }
  return out;
}

export async function assignRoles(
  conn: Conn,
  input: { agencyId: string; userId: string; roleIds: string[]; assignedBy?: string | null },
): Promise<void> {
  await conn.delete(userRoles).where(eq(userRoles.userId, input.userId));
  const ids = [...new Set(input.roleIds)];
  if (ids.length) {
    await conn.insert(userRoles).values(
      ids.map((roleId) => ({
        userId: input.userId,
        roleId,
        agencyId: input.agencyId,
        assignedBy: input.assignedBy ?? null,
      })),
    );
  }
}

export async function writeOverrides(
  conn: Conn,
  input: {
    agencyId: string;
    userId: string;
    overrides: Array<{ permission: string; scope: Scope | null; effect: 'grant' | 'deny'; reason?: string | null }>;
    createdBy?: string | null;
  },
): Promise<void> {
  await conn.delete(userPermissionOverrides).where(eq(userPermissionOverrides.userId, input.userId));
  const seen = new Set<string>();
  const rows = input.overrides.filter((o) => {
    if (o.effect === 'grant' && (!o.scope || !isValidGrant(o.permission, o.scope))) return false;
    if (o.effect === 'deny' && o.scope !== null) return false;
    const k = `${o.permission}|${o.effect}|${o.scope ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  for (let i = 0; i < rows.length; i += 100) {
    await conn.insert(userPermissionOverrides).values(
      rows.slice(i, i + 100).map((o) => ({
        id: newId('upo'),
        agencyId: input.agencyId,
        userId: input.userId,
        permission: o.permission,
        scope: o.scope,
        effect: o.effect,
        reason: o.reason ?? null,
        createdBy: input.createdBy ?? null,
      })),
    );
  }
}

/** Keep every Owner role in sync with the (possibly grown) catalog. */
export async function syncOwnerRoles(): Promise<void> {
  const owners = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'owner'));
  const full = fullGrants('staff');
  for (const r of owners) {
    const current = await readRoleGrants(db, r.id);
    const want = new Set(full.map((g) => `${g.permission}|${g.scope}`));
    const have = new Set(current.map((g) => `${g.permission}|${g.scope}`));
    const same = want.size === have.size && [...want].every((k) => have.has(k));
    if (!same) await writeRoleGrants(db, r.id, full);
  }
}

/**
 * Fail-closed hygiene at boot: drop grants/overrides that no longer exist in the
 * catalog (a removed permission must never linger as a live grant).
 */
export async function purgeInvalidGrants(): Promise<number> {
  let removed = 0;
  const rp = await db.select().from(rolePermissions);
  for (const r of rp) {
    if (!isValidGrant(r.permission, r.scope)) {
      await db
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, r.roleId),
            eq(rolePermissions.permission, r.permission),
            eq(rolePermissions.scope, r.scope),
          ),
        );
      removed++;
    }
  }
  const ov = await db.select().from(userPermissionOverrides);
  const bad = ov.filter((o) =>
    o.effect === 'grant' ? !o.scope || !isValidGrant(o.permission, o.scope) : !isValidGrant(o.permission, 'organization') && !isValidGrant(o.permission, 'own') && !isValidGrant(o.permission, 'client') && !isValidGrant(o.permission, 'assigned') && !isValidGrant(o.permission, 'project'),
  );
  if (bad.length) {
    await db.delete(userPermissionOverrides).where(inArray(userPermissionOverrides.id, bad.map((b) => b.id)));
    removed += bad.length;
  }
  return removed;
}

/** New agency (signup): system roles + owner assignment; marks agency migrated. */
export async function initAgencyAuthorization(agencyId: string, ownerUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const ids = await ensureSystemRoles(tx, agencyId);
    await assignRoles(tx, { agencyId, userId: ownerUserId, roleIds: [ids.owner] });
    await tx.update(agencies).set({ authzMigratedAt: new Date() }).where(eq(agencies.id, agencyId));
  });
}

export async function systemRoleId(agencyId: string, key: SystemRoleKey): Promise<string | null> {
  const [r] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.agencyId, agencyId), eq(roles.key, key), isNull(roles.archivedAt)))
    .limit(1);
  return r?.id ?? null;
}

export async function userRoleIds(userId: string): Promise<string[]> {
  const rows = await db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleId);
}

/**
 * Compatibility: keep users.role (legacy display/compat column) consistent with
 * role assignments while un-migrated code still reads it.
 * TODO(authz phase 10): drop users.role.
 */
export async function syncLegacyRoleColumn(conn: Conn, userId: string): Promise<void> {
  const rows = await conn
    .select({ key: roles.key, actorType: roles.actorType })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
  const [u] = await conn.select({ kind: users.kind }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return;
  const role =
    u.kind === 'client'
      ? 'client'
      : rows.some((r) => r.key === 'owner')
        ? 'owner'
        : rows.some((r) => r.key === 'admin')
          ? 'admin'
          : 'member';
  await conn.update(users).set({ role }).where(eq(users.id, userId));
}
