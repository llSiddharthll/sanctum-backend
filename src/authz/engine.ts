/**
 * Authorization engine: answers "can actor X perform permission P on object O?"
 *
 * Grants come from the resolver (roles + overrides). Scope relations are
 * evaluated against ObjectFacts that resource policies (src/authz/policies)
 * compute for the actor. Everything fails closed: an unknown permission, a
 * missing fact, or a tenant mismatch is a deny.
 */
import { forbidden, notFound, AppError } from '../lib/errors.js';
import { isPermissionKey, type Scope } from './catalog.js';
import { actorUserId, isClientSide, type Actor } from './actor.js';

/**
 * Facts about ONE object, relative to the actor evaluating it. Policies fill
 * only the facts their resource supports; absent facts never grant access.
 */
export interface ObjectFacts {
  /** Tenant of the object. Required. */
  agencyId: string;
  /** `own`: user ids that "own" the object (creator/author/subject). */
  ownerIds?: Array<string | null | undefined>;
  /** `assigned`: the actor is attached (member/assignee/assigned client/participant). */
  assigned?: boolean;
  /** `project`: the object sits in a project the actor is a member of. */
  projectMember?: boolean;
  /** `client`: brand the object belongs to. */
  clientId?: string | null;
  /** `client`: project the object belongs to (null = brand-level object). */
  projectId?: string | null;
  /** `client`: false when the object is not published to the client portal. */
  clientVisible?: boolean;
}

export function can(actor: Actor, permission: string): boolean {
  return isPermissionKey(permission) && actor.grants.has(permission);
}

export function canAny(actor: Actor, permissions: string[]): boolean {
  return permissions.some((p) => can(actor, p));
}

export function scopesOf(actor: Actor, permission: string): Scope[] {
  return isPermissionKey(permission) ? actor.grants.scopes(permission) : [];
}

/** True when the actor holds the permission at `organization` scope. */
export function canOrg(actor: Actor, permission: string): boolean {
  return (
    !isClientSide(actor) &&
    isPermissionKey(permission) &&
    actor.grants.hasScope(permission, 'organization')
  );
}

function relationHolds(actor: Actor, scope: Scope, f: ObjectFacts): boolean {
  switch (scope) {
    case 'organization':
      return !isClientSide(actor);
    case 'own': {
      const uid = actorUserId(actor);
      return !!uid && !!f.ownerIds?.some((id) => id === uid);
    }
    case 'assigned':
      return !isClientSide(actor) && f.assigned === true;
    case 'project':
      return !isClientSide(actor) && f.projectMember === true;
    case 'client': {
      if (!isClientSide(actor)) return false;
      if (!f.clientId || f.clientId !== actor.clientId) return false;
      if (f.clientVisible === false) return false;
      if (f.projectId && actor.projectAccess.mode === 'selected') {
        return actor.projectAccess.projectIds.includes(f.projectId);
      }
      return true;
    }
  }
}

/** Evaluate permission + scope against an object. Pure; never throws. */
export function check(
  actor: Actor,
  permission: string,
  facts: ObjectFacts | null | undefined,
): boolean {
  if (!facts || !facts.agencyId || facts.agencyId !== actor.agencyId) {
    return false;
  }
  if (!isPermissionKey(permission)) return false;
  for (const scope of actor.grants.scopes(permission)) {
    if (relationHolds(actor, scope, facts)) return true;
  }
  return false;
}

export interface AuthorizeOptions {
  /**
   * Permission that governs seeing the object. When the actor fails `permission`
   * AND cannot see the object, a 404 is thrown (existence is not leaked);
   * otherwise 403.
   */
  view?: string;
  /** Extra object policy; return a string (reason) or false to deny with 403. */
  condition?: () => boolean | string;
  message?: string;
}

/** Throwing variant for handlers. */
export function authorize(
  actor: Actor,
  permission: string,
  facts: ObjectFacts | null | undefined,
  opts: AuthorizeOptions = {},
): void {
  if (!facts || facts.agencyId !== actor.agencyId) {
    throw notFound();
  }
  if (!check(actor, permission, facts)) {
    if (opts.view && opts.view !== permission && !check(actor, opts.view, facts)) {
      throw notFound();
    }
    if (!opts.view && permission.endsWith('.view')) throw notFound();
    throw forbidden(opts.message ?? "You don't have permission to do that.");
  }
  if (opts.condition) {
    const r = opts.condition();
    if (r === false || typeof r === 'string') {
      throw new AppError(
        'FORBIDDEN',
        typeof r === 'string' ? r : (opts.message ?? "You can't do that."),
      );
    }
  }
}

/** Require a permission at ANY scope (non-object routes: create, lists). */
export function requirePermission(
  actor: Actor,
  permission: string,
  message?: string,
): void {
  if (!can(actor, permission)) {
    throw forbidden(message ?? "You don't have permission to do that.");
  }
}

/** Require several permissions (cross-module operations). */
export function requireAll(actor: Actor, permissions: string[]): void {
  for (const p of permissions) requirePermission(actor, p);
}

/**
 * Per-object capability map for clients: { action: boolean } for the given
 * permission keys (keyed by action, e.g. 'update').
 */
export function capabilities(
  actor: Actor,
  facts: ObjectFacts,
  permissions: string[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of permissions) out[p] = check(actor, p, facts);
  return out;
}
