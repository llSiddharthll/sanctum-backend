/**
 * Module-level RBAC: a fixed catalog of product "modules" (mirroring the
 * sidebar) and a per-user access level for each one.
 *
 * Access levels are ordered: none < view < manage.
 *   - none   → the module is hidden / fully blocked (403)
 *   - view   → read-only access (GET endpoints)
 *   - manage → full access (read + write)
 *
 * Roles still govern tenancy + the existing owner/admin write gates; module
 * permissions are an ADDITIONAL restriction layer on top. The default level
 * (when nothing is stored for a user) is `manage`, so the feature is purely
 * additive — existing users keep full access until an owner/admin dials a
 * specific module back. The OWNER is always full-access and can never be
 * restricted.
 */
import type { Role } from './jwt.js';

export const MODULES = [
  'dashboard',
  'clients',
  'projects',
  'team',
  'attendance',
  'calendar',
  'messages',
  'documents',
  'sheets',
  'ai',
  'finance',
  'settings',
] as const;

export type ModuleKey = (typeof MODULES)[number];

export const ACCESS_LEVELS = ['none', 'view', 'manage'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export type PermissionMap = Record<ModuleKey, AccessLevel>;

/** Roles whose defaults are configurable (owner is always full access). */
export const CONFIGURABLE_ROLES = ['admin', 'member'] as const;
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

/** Per-agency role defaults: a partial map per configurable role. */
export type RoleDefaults = Record<ConfigurableRole, Partial<PermissionMap>>;

/** Numeric rank for comparisons (higher = more access). */
const RANK: Record<AccessLevel, number> = { none: 0, view: 1, manage: 2 };

/** The level assumed for a module when a user has no explicit override. */
const DEFAULT_LEVEL: AccessLevel = 'manage';

const MODULE_SET = new Set<string>(MODULES);
const LEVEL_SET = new Set<string>(ACCESS_LEVELS);

/** Human labels for surfacing in the API / UI. */
export const MODULE_LABELS: Record<ModuleKey, string> = {
  dashboard: 'Dashboard',
  clients: 'Clients',
  projects: 'Projects',
  team: 'Team',
  attendance: 'Attendance',
  calendar: 'Calendar',
  messages: 'Messages',
  documents: 'Documents',
  sheets: 'Sheets',
  ai: 'AI Assistant',
  finance: 'Finance',
  settings: 'Settings',
};

/** A permission map granting `manage` on every module. */
export function fullAccess(): PermissionMap {
  return MODULES.reduce((acc, m) => {
    acc[m] = 'manage';
    return acc;
  }, {} as PermissionMap);
}

/** `true` when `have` satisfies the `required` access level. */
export function meetsLevel(have: AccessLevel, required: AccessLevel): boolean {
  return RANK[have] >= RANK[required];
}

/**
 * Parse a stored overrides JSON string into a validated partial map. Unknown
 * keys / invalid levels are dropped; malformed JSON yields {}.
 */
export function parseOverrides(
  raw: string | null | undefined,
): Partial<PermissionMap> {
  if (!raw) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  return sanitizeOverrides(obj);
}

/** Keep only valid {module: level} pairs from arbitrary input. */
export function sanitizeOverrides(input: unknown): Partial<PermissionMap> {
  const out: Partial<PermissionMap> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (MODULE_SET.has(k) && typeof v === 'string' && LEVEL_SET.has(v)) {
      out[k as ModuleKey] = v as AccessLevel;
    }
  }
  return out;
}

/**
 * Resolve a user's EFFECTIVE permission map.
 *
 * Precedence (highest first):
 *   1. the user's own override for the module
 *   2. the agency's role default for the user's role
 *   3. the built-in default level (manage)
 *
 * Owner is always full access.
 */
export function resolvePermissions(
  role: Role,
  overrides: string | null | undefined | Partial<PermissionMap>,
  roleDefaults?: RoleDefaults | string | null,
  customRolePermissions?: string | null | Partial<PermissionMap>,
): PermissionMap {
  if (role === 'owner') return fullAccess();
  const userOverrides =
    typeof overrides === 'string' || overrides == null
      ? parseOverrides(overrides as string | null | undefined)
      : sanitizeOverrides(overrides);
  const customMap =
    typeof customRolePermissions === 'string' || customRolePermissions == null
      ? parseOverrides(customRolePermissions as string | null | undefined)
      : sanitizeOverrides(customRolePermissions);
  const defaults = parseRoleDefaults(roleDefaults);
  const roleMap = defaults[role as ConfigurableRole] ?? {};
  // Precedence: per-user override > custom role > agency role default > built-in.
  return MODULES.reduce((acc, m) => {
    acc[m] = userOverrides[m] ?? customMap[m] ?? roleMap[m] ?? DEFAULT_LEVEL;
    return acc;
  }, {} as PermissionMap);
}

/** Serialize a sanitized overrides map for storage (or null when empty). */
export function serializeOverrides(input: unknown): string | null {
  const clean = sanitizeOverrides(input);
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

// ============================================================
//  ROLE DEFAULTS (per-agency, configurable from the admin UI)
// ============================================================

const ROLE_SET = new Set<string>(CONFIGURABLE_ROLES);

/** Validate arbitrary input into a clean RoleDefaults object. */
export function sanitizeRoleDefaults(input: unknown): RoleDefaults {
  const out: RoleDefaults = { admin: {}, member: {} };
  if (!input || typeof input !== 'object') return out;
  for (const [role, map] of Object.entries(input as Record<string, unknown>)) {
    if (ROLE_SET.has(role)) {
      out[role as ConfigurableRole] = sanitizeOverrides(map);
    }
  }
  return out;
}

/** Parse stored role-defaults JSON (or a pre-parsed object) safely. */
export function parseRoleDefaults(
  raw: string | null | undefined | RoleDefaults,
): RoleDefaults {
  if (raw && typeof raw === 'object') return sanitizeRoleDefaults(raw);
  if (!raw) return { admin: {}, member: {} };
  try {
    return sanitizeRoleDefaults(JSON.parse(raw));
  } catch {
    return { admin: {}, member: {} };
  }
}

/** Serialize role defaults for storage (null when no entries set). */
export function serializeRoleDefaults(input: unknown): string | null {
  const clean = sanitizeRoleDefaults(input);
  const hasAny =
    Object.keys(clean.admin).length > 0 ||
    Object.keys(clean.member).length > 0;
  return hasAny ? JSON.stringify(clean) : null;
}

/**
 * Resolve the FULL effective permission map for each role, given the agency's
 * stored role defaults. Owner is always full access. Used by the admin
 * Roles & Permissions matrix.
 */
export function resolveRolePermissions(
  raw: string | null | undefined | RoleDefaults,
): Record<Role, PermissionMap> {
  const defaults = parseRoleDefaults(raw);
  const forRole = (role: ConfigurableRole): PermissionMap =>
    MODULES.reduce((acc, m) => {
      acc[m] = defaults[role][m] ?? DEFAULT_LEVEL;
      return acc;
    }, {} as PermissionMap);
  return {
    owner: fullAccess(),
    admin: forRole('admin'),
    member: forRole('member'),
  };
}

/** The module catalog as a serializable list (key + label + description). */
export const MODULE_DESCRIPTIONS: Record<ModuleKey, string> = {
  dashboard: 'Agency overview and metrics',
  clients: 'Client directory, CRM, and portals',
  projects: 'Projects, tasks, and time tracking',
  team: 'Members, roles, and utilization',
  attendance: 'Check-in/out, leaves, and holidays',
  calendar: 'Content calendar and scheduling',
  messages: 'Internal threads and chat',
  documents: 'Document hub and uploads',
  sheets: 'Spreadsheets',
  ai: 'AI document & content generation',
  finance: 'Invoices, expenses, and reports',
  settings: 'Agency branding and settings',
};

export function moduleCatalog(): Array<{
  key: ModuleKey;
  label: string;
  description: string;
}> {
  return MODULES.map((key) => ({
    key,
    label: MODULE_LABELS[key],
    description: MODULE_DESCRIPTIONS[key],
  }));
}
