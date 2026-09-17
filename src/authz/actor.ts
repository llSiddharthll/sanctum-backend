/**
 * Actors: WHO is making a request. Every authorization decision starts from an
 * Actor; no code should branch on legacy role strings.
 */
import type { Grant, Scope } from './catalog.js';

export interface ProjectAccess {
  mode: 'all' | 'selected';
  /** Only meaningful when mode = 'selected'. Empty = no projects (fail closed). */
  projectIds: string[];
}

/**
 * Immutable, resolved set of (permission → scopes). Built by the resolver;
 * never mutated after construction.
 */
export class GrantSet {
  private readonly map: ReadonlyMap<string, ReadonlySet<Scope>>;

  constructor(grants: Iterable<Grant>) {
    const m = new Map<string, Set<Scope>>();
    for (const g of grants) {
      let s = m.get(g.permission);
      if (!s) m.set(g.permission, (s = new Set()));
      s.add(g.scope);
    }
    this.map = m;
  }

  static empty(): GrantSet {
    return new GrantSet([]);
  }

  has(permission: string): boolean {
    return (this.map.get(permission)?.size ?? 0) > 0;
  }

  scopes(permission: string): Scope[] {
    return [...(this.map.get(permission) ?? [])];
  }

  hasScope(permission: string, scope: Scope): boolean {
    return this.map.get(permission)?.has(scope) ?? false;
  }

  toGrants(): Grant[] {
    const out: Grant[] = [];
    for (const [permission, scopes] of this.map) {
      for (const scope of scopes) out.push({ permission, scope });
    }
    return out;
  }

  /** { permission: scopes[] } for the client contract. */
  toJSON(): Record<string, Scope[]> {
    const out: Record<string, Scope[]> = {};
    for (const [k, v] of [...this.map].sort(([a], [b]) => a.localeCompare(b))) {
      out[k] = [...v];
    }
    return out;
  }

  get size(): number {
    return this.map.size;
  }
}

interface ActorBase {
  agencyId: string;
  grants: GrantSet;
}

export interface StaffActor extends ActorBase {
  type: 'staff';
  userId: string;
  sessionId: string | null;
  authzVersion: number;
}

export interface ClientUserActor extends ActorBase {
  type: 'client';
  userId: string;
  sessionId: string | null;
  authzVersion: number;
  clientId: string;
  projectAccess: ProjectAccess;
}

export interface PortalLinkActor extends ActorBase {
  type: 'portal_link';
  tokenId: string;
  sessionId: string | null;
  clientId: string;
  roleId: string | null;
  projectAccess: ProjectAccess;
}

export interface SystemActor extends ActorBase {
  type: 'system';
  job: string;
}

export interface IntegrationActor extends ActorBase {
  type: 'integration';
  name: string;
}

export type Actor =
  | StaffActor
  | ClientUserActor
  | PortalLinkActor
  | SystemActor
  | IntegrationActor;

/** Client-side actors (client users + portal links) share the `client` scope. */
export type ClientSideActor = ClientUserActor | PortalLinkActor;

export function isClientSide(a: Actor): a is ClientSideActor {
  return a.type === 'client' || a.type === 'portal_link';
}

/** The user id behind an actor, or null for non-user principals. */
export function actorUserId(a: Actor): string | null {
  return a.type === 'staff' || a.type === 'client' ? a.userId : null;
}

/** Stable id for auditing. */
export function actorAuditId(a: Actor): string {
  switch (a.type) {
    case 'staff':
    case 'client':
      return a.userId;
    case 'portal_link':
      return a.tokenId;
    case 'system':
      return `system:${a.job}`;
    case 'integration':
      return `integration:${a.name}`;
  }
}

/** Explicit, minimal system actor for a background job (design §I.4). */
export function systemActor(
  job: string,
  agencyId: string,
  grants: Grant[],
): SystemActor {
  return { type: 'system', job, agencyId, grants: new GrantSet(grants) };
}

export function integrationActor(
  name: string,
  agencyId: string,
  grants: Grant[],
): IntegrationActor {
  return { type: 'integration', name, agencyId, grants: new GrantSet(grants) };
}
