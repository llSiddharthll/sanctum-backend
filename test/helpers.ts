import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { db, schema } from '../src/db/client.js';

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

/**
 * Invite a teammate through the real /team/invite endpoint, then complete the
 * real accept-invite flow (extract the token from the returned inviteUrl, set a
 * password via POST /auth/accept-invite). Returns a logged-in agent for that
 * member — exercising the exact path a real invited user takes.
 */
export async function createMemberSession(
  ownerAgent: Agent,
  opts: {
    role?: 'admin' | 'member';
    permissions?: Record<string, string>;
    fullName?: string;
    email?: string;
  } = {},
): Promise<MemberResult> {
  const email = opts.email ?? uniqueEmail('member');
  const password = 'Password123!';
  const invite = await ownerAgent.post(`${BASE}/team/invite`).send({
    fullName: opts.fullName ?? 'Member User',
    email,
    role: opts.role ?? 'member',
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
  });
  if (invite.status !== 201) {
    throw new Error(
      `invite failed ${invite.status}: ${JSON.stringify(invite.body)}`,
    );
  }
  const token = inviteToken(invite.body.data.inviteUrl);

  const agent = supertest.agent(app);
  const accept = await agent
    .post(`${BASE}/auth/accept-invite`)
    .send({ token, password });
  if (accept.status !== 200) {
    throw new Error(
      `accept-invite failed ${accept.status}: ${JSON.stringify(accept.body)}`,
    );
  }
  const me = await agent.get(`${BASE}/auth/me`);
  return { agent, email, password, user: me.body.data.user, inviteBody: invite.body.data };
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
