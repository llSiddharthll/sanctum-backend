/**
 * One-time, idempotent migration of the legacy module-level RBAC into roles,
 * grants, assignments and overrides (design §J.1). Runs at boot for every
 * agency with authz_migrated_at IS NULL, each agency in its own transaction.
 *
 * Goal: every existing user keeps EXACTLY the access they effectively had,
 * except for the intentional security fixes encoded in the catalog's legacy
 * rules (e.g. view-level project users can no longer edit other people's tasks).
 *
 * This file intentionally re-implements the tiny legacy parsers so it does not
 * depend on src/lib/permissions.ts (which is deleted in phase 10).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  clientUserProjects,
  clients,
  customRoles,
  portalTokens,
  users,
} from '../db/schema.js';
import {
  closeOverRequires,
  grantsFromLegacy,
  LEGACY_LEVELS,
  LEGACY_MODULES,
  type Grant,
  type LegacyLevel,
  type LegacyModule,
  type LegacyRole,
} from './catalog.js';
import {
  assignRoles,
  createRole,
  dedupeGrants,
  ensureSystemRoles,
  writeOverrides,
} from './roles-store.js';

type LevelMap = Partial<Record<LegacyModule, LegacyLevel>>;

function parseLevels(raw: string | null | undefined): LevelMap {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: LevelMap = {};
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (
        (LEGACY_MODULES as readonly string[]).includes(k) &&
        typeof v === 'string' &&
        (LEGACY_LEVELS as readonly string[]).includes(v)
      ) {
        out[k as LegacyModule] = v as LegacyLevel;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function parseRoleDefaults(raw: string | null | undefined): { admin: LevelMap; member: LevelMap } {
  if (!raw) return { admin: {}, member: {} };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      admin: parseLevels(JSON.stringify(obj?.admin ?? {})),
      member: parseLevels(JSON.stringify(obj?.member ?? {})),
    };
  } catch {
    return { admin: {}, member: {} };
  }
}

/** Legacy resolvePermissions: user › custom role › agency default › manage; finance/business none for non-owners. */
function effectiveLevels(role: LegacyRole, layers: LevelMap[]): Record<LegacyModule, LegacyLevel> {
  const out = {} as Record<LegacyModule, LegacyLevel>;
  for (const m of LEGACY_MODULES) {
    if (role === 'owner') out[m] = 'manage';
    else if (role === 'client') out[m] = 'none';
    else out[m] = layers.find((l) => l[m] !== undefined)?.[m] ?? 'manage';
  }
  if (role !== 'owner') {
    out.finance = 'none';
    out.business = 'none';
  }
  return out;
}

function key(g: Grant) {
  return `${g.permission}|${g.scope}`;
}

/** Overrides that turn role grants R into expected grants E (deny then grant). */
export function diffOverrides(roleGrants: Grant[], expected: Grant[]) {
  const R = new Map(roleGrants.map((g) => [key(g), g]));
  const E = new Map(expected.map((g) => [key(g), g]));
  const overrides: Array<{ permission: string; scope: Grant['scope'] | null; effect: 'grant' | 'deny' }> = [];
  const denyPerms = new Set<string>();
  for (const g of R.values()) if (!E.has(key(g))) denyPerms.add(g.permission);
  for (const p of denyPerms) overrides.push({ permission: p, scope: null, effect: 'deny' });
  for (const g of E.values()) {
    // Re-grant every expected scope of a denied permission, plus anything new.
    if (denyPerms.has(g.permission) || !R.has(key(g))) {
      overrides.push({ permission: g.permission, scope: g.scope, effect: 'grant' });
    }
  }
  return overrides;
}

export async function migrateAgency(agencyId: string): Promise<void> {
  const [agency] = await db.select().from(agencies).where(eq(agencies.id, agencyId)).limit(1);
  if (!agency || agency.authzMigratedAt) return;

  const defaults = parseRoleDefaults(agency.rolePermissionsJson);
  const agencyUsers = await db.select().from(users).where(eq(users.agencyId, agencyId));
  const custom = await db.select().from(customRoles).where(eq(customRoles.agencyId, agencyId));
  const brandRoles = await db
    .select({ id: clients.id, portalRole: clients.portalRole })
    .from(clients)
    .where(eq(clients.agencyId, agencyId));
  const approverBrand = new Map(brandRoles.map((c) => [c.id, c.portalRole !== 'reviewer']));
  const clientProjectRows = await db
    .select({ userId: clientUserProjects.userId })
    .from(clientUserProjects)
    .where(eq(clientUserProjects.agencyId, agencyId));
  const usersWithProjectRows = new Set(clientProjectRows.map((r) => r.userId));

  const adminLevels = effectiveLevels('admin', [defaults.admin]);
  const memberLevels = effectiveLevels('member', [defaults.member]);
  const adminGrants = closeOverRequires(grantsFromLegacy({ role: 'admin', levels: adminLevels }), 'staff');
  const memberGrants = closeOverRequires(grantsFromLegacy({ role: 'member', levels: memberLevels }), 'staff');

  await db.transaction(async (tx) => {
    const sys = await ensureSystemRoles(tx, agencyId, { admin: adminGrants });

    // Legacy "member" defaults become a custom role so existing members keep access.
    let memberRoleId: string | null = null;
    const needsMemberRole = agencyUsers.some(
      (u) => u.role === 'member' && !(u.customRoleId && custom.some((c) => c.id === u.customRoleId)),
    );
    if (needsMemberRole) {
      memberRoleId = await createRole(tx, {
        agencyId,
        name: 'Member',
        description: 'Migrated from the previous default member access.',
        kind: 'custom',
        actorType: 'staff',
        colorToken: 'slate',
        templateKey: 'legacy_member',
        grants: memberGrants,
      });
    }

    const reserved = new Set(['owner', 'administrator', 'employee', 'member']);
    const customRoleIds = new Map<string, { id: string; grants: Grant[] }>();
    for (const cr of custom) {
      const base: LegacyRole = cr.baseRole === 'admin' ? 'admin' : 'member';
      const levels = effectiveLevels(base, [
        parseLevels(cr.permissionsJson),
        base === 'admin' ? defaults.admin : defaults.member,
      ]);
      const grants = closeOverRequires(grantsFromLegacy({ role: base, levels }), 'staff');
      const name = reserved.has(cr.name.trim().toLowerCase()) ? `${cr.name} (custom)` : cr.name;
      const id = await createRole(tx, {
        agencyId,
        name,
        kind: 'custom',
        actorType: 'staff',
        colorToken: cr.colorToken,
        templateKey: 'legacy_custom_role',
        grants,
      });
      customRoleIds.set(cr.id, { id, grants });
    }

    for (const u of agencyUsers) {
      // Synthetic share-link users (portal.<clientId>@portal.sanctum) gave every
      // link holder a full client session that survived link revocation. Links
      // now get their own session type; disable these accounts outright.
      if (u.role === 'client' && u.email.toLowerCase().endsWith('@portal.sanctum')) {
        await tx.update(users).set({ kind: 'client', status: 'disabled' }).where(eq(users.id, u.id));
        continue;
      }
      if (u.role === 'client') {
        const approver = u.clientId ? (approverBrand.get(u.clientId) ?? true) : false;
        await assignRoles(tx, {
          agencyId,
          userId: u.id,
          roleIds: [approver ? sys.client_approver : sys.client_reviewer],
        });
        await tx
          .update(users)
          .set({
            kind: 'client',
            clientProjectAccess: usersWithProjectRows.has(u.id) ? 'selected' : 'all',
          })
          .where(eq(users.id, u.id));
        continue;
      }

      const legacyRole = u.role as LegacyRole;
      let roleId: string;
      let roleGrants: Grant[];
      const cr = u.customRoleId ? customRoleIds.get(u.customRoleId) : undefined;
      if (legacyRole === 'owner') {
        roleId = sys.owner;
        roleGrants = [];
      } else if (cr) {
        roleId = cr.id;
        roleGrants = cr.grants;
      } else if (legacyRole === 'admin') {
        roleId = sys.admin;
        roleGrants = adminGrants;
      } else {
        roleId = memberRoleId!;
        roleGrants = memberGrants;
      }
      await assignRoles(tx, { agencyId, userId: u.id, roleIds: [roleId] });
      await tx.update(users).set({ kind: 'staff' }).where(eq(users.id, u.id));

      if (legacyRole !== 'owner' && u.permissionsJson) {
        const customRow = custom.find((c) => c.id === u.customRoleId);
        const levels = effectiveLevels(legacyRole, [
          parseLevels(u.permissionsJson),
          parseLevels(customRow?.permissionsJson),
          legacyRole === 'admin' ? defaults.admin : defaults.member,
        ]);
        const expected = closeOverRequires(
          dedupeGrants(grantsFromLegacy({ role: legacyRole, levels })),
          'staff',
        );
        const overrides = diffOverrides(roleGrants, expected);
        if (overrides.length) {
          await writeOverrides(tx, { agencyId, userId: u.id, overrides });
        }
      }
    }

    // Share links: role from the brand's legacy portalRole; mandatory expiry.
    const tokens = await tx
      .select({ id: portalTokens.id, clientId: portalTokens.clientId, expiresAt: portalTokens.expiresAt })
      .from(portalTokens)
      .where(and(eq(portalTokens.agencyId, agencyId), isNull(portalTokens.roleId)));
    const in90d = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    for (const t of tokens) {
      const approver = approverBrand.get(t.clientId) ?? true;
      await tx
        .update(portalTokens)
        .set({
          roleId: approver ? sys.share_link : sys.share_link_reviewer,
          ...(t.expiresAt ? {} : { expiresAt: in90d }),
        })
        .where(eq(portalTokens.id, t.id));
    }

    await tx.update(agencies).set({ authzMigratedAt: new Date() }).where(eq(agencies.id, agencyId));
  });
}

export async function migrateAllAgencies(): Promise<number> {
  const pending = await db
    .select({ id: agencies.id })
    .from(agencies)
    .where(isNull(agencies.authzMigratedAt));
  for (const a of pending) await migrateAgency(a.id);
  return pending.length;
}
