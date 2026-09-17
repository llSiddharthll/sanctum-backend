import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { db, schema } from '../src/db/client.js';
import { testOutbox } from '../src/services/email.js';
import {
  closeOverRequires,
  grantsFromLegacy,
  LEGACY_MODULES,
  type Grant,
  type LegacyLevel,
  type LegacyModule,
} from '../src/authz/catalog.js';

/** The in-process Express app under test (no Socket.IO; broadcasts are no-ops). */
export const app = createApp();

/** API mount prefix. */
export const BASE = '/api/v1';

export type Agent = ReturnType<typeof supertest.agent>;

let seq = 0;
/** Globally-unique email for a fresh tenant/member. */
export function uniqueEmail(prefix = 'owner'): string {
  seq += 1;
  return `${prefix}.${Date.now()}.${seq}@test.local`;
}

export interface SignupResult {
  agent: Agent;
  email: string;
  password: string;
  user: { id: string; email: string; fullName: string; role: string };
  agency: { id: string; name: string; slug: string };
}

/** Create a brand-new agency + owner and return a cookie-bearing agent. */
export async function signupAgency(
  overrides: Partial<{
    agencyName: string;
    fullName: string;
    email: string;
    password: string;
  }> = {},
): Promise<SignupResult> {
  seq += 1;
  const agent = supertest.agent(app);
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? 'Password123!';
  const res = await agent.post(`${BASE}/auth/signup`).send({
    agencyName: overrides.agencyName ?? `Agency ${seq}`,
    fullName: overrides.fullName ?? 'Owner User',
    email,
    password,
  });
  if (res.status !== 201) {
    throw new Error(`signup failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return {
    agent,
    email,
    password,
    user: res.body.data.user,
    agency: res.body.data.agency,
  };
}

export interface MemberResult {
  agent: Agent;
  email: string;
  password: string;
  user: { id: string; email: string; role: string };
  inviteBody: unknown;
}

let roleSeq = 0;

/**
 * Create a custom role through the real /roles API and return its id.
 * `grants` are explicit (permission, scope) pairs.
 */
export async function createRole(
  ownerAgent: Agent,
  grants: Grant[],
  opts: { name?: string; actorType?: 'staff' | 'client' } = {},
): Promise<string> {
  roleSeq += 1;
  const res = await ownerAgent.post(`${BASE}/roles`).send({
    name: opts.name ?? `Test role ${Date.now()}-${roleSeq}`,
    actorType: opts.actorType ?? 'staff',
    grants,
  });
  if (res.status !== 201) {
    throw new Error(`role create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.id;
}

/**
 * Explicit grants equivalent to a LEGACY module-level permission map (unset
 * modules = manage, finance/business none), via the catalog's own legacy rules.
 * Lets older suites express intent ("projects: view") in the new model.
 */
export function legacyGrants(
  permissions: Record<string, string> = {},
  role: 'admin' | 'member' = 'member',
): Grant[] {
  const levels = Object.fromEntries(
    LEGACY_MODULES.map((m) => [m, (permissions[m] as LegacyLevel) ?? 'manage']),
  ) as Record<LegacyModule, LegacyLevel>;
  levels.finance = 'none';
  levels.business = 'none';
  return closeOverRequires(grantsFromLegacy({ role, levels }), 'staff');
}

/**
 * Invite a teammate through the real /team/invite endpoint, then complete the
 * real accept-invite flow. Access is set by:
 *   - `roleIds` (explicit roles), or
 *   - `grants` (a fresh custom role with exactly these grants), or
 *   - legacy `role` + `permissions` (translated to an equivalent custom role).
 */
export async function createMemberSession(
  ownerAgent: Agent,
  opts: {
    role?: 'admin' | 'member';
    permissions?: Record<string, string>;
    grants?: Grant[];
    roleIds?: string[];
    fullName?: string;
    email?: string;
  } = {},
): Promise<MemberResult> {
  const email = opts.email ?? uniqueEmail('member');
  const password = 'Password123!';
  let roleIds = opts.roleIds;
  if (!roleIds) {
    if (opts.grants) {
      roleIds = [await createRole(ownerAgent, opts.grants)];
    } else if (opts.role === 'admin' && !opts.permissions) {
      roleIds = undefined; // system Administrator role via legacy `role`
    } else {
      roleIds = [await createRole(ownerAgent, legacyGrants(opts.permissions, opts.role ?? 'member'))];
    }
  }
  const invite = await ownerAgent.post(`${BASE}/team/invite`).send({
    fullName: opts.fullName ?? 'Member User',
    email,
    ...(roleIds ? { roleIds } : { role: opts.role ?? 'member' }),
  });
  if (invite.status !== 201) {
    throw new Error(`invite failed ${invite.status}: ${JSON.stringify(invite.body)}`);
  }
  const token = inviteToken(invite.body.data.inviteUrl);

  const agent = supertest.agent(app);
  const accept = await agent.post(`${BASE}/auth/accept-invite`).send({ token, password });
  if (accept.status !== 200) {
    throw new Error(`accept-invite failed ${accept.status}: ${JSON.stringify(accept.body)}`);
  }
  const me = await agent.get(`${BASE}/auth/me`);
  return { agent, email, password, user: me.body.data.user, inviteBody: invite.body.data };
}

/** Most recent email sent to `to` (test outbox). */
export function lastEmailTo(to: string) {
  const all = testOutbox.filter((m) => m.to.toLowerCase() === to.toLowerCase());
  return all[all.length - 1];
}

/** Extract a `token=` value from the text of an email. */
export function tokenFromEmail(to: string): string {
  const msg = lastEmailTo(to);
  const m = msg && /token=([A-Za-z0-9_-]+)/.exec(msg.text);
  if (!m) throw new Error(`no token email for ${to}`);
  return m[1]!;
}

/** Pull the raw invite token out of an inviteUrl (…/accept-invite?token=…). */
export function inviteToken(inviteUrl: string): string {
  const token = new URL(inviteUrl).searchParams.get('token');
  if (!token) throw new Error(`inviteUrl missing token: ${inviteUrl}`);
  return token;
}

/** Unwrap the standard `{ data, ...extra }` envelope. */
export function data<T = any>(res: { body: { data: T } }): T {
  return res.body.data;
}

export { db, schema };

/** Id of a system role (owner, admin, employee, client_approver, …) in the caller's agency. */
export async function systemRoleIdFor(agent: Agent, key: string): Promise<string> {
  const res = await agent.get(`${BASE}/roles?includeArchived=false`);
  if (res.status !== 200) throw new Error(`roles list failed ${res.status}`);
  const role = (res.body.data as Array<{ id: string; key: string | null }>).find((r) => r.key === key);
  if (!role) throw new Error(`system role ${key} not found`);
  return role.id;
}
