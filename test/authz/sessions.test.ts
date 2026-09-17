import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { SignJWT } from 'jose';
import { app, BASE, createMemberSession, createRole, data, signupAgency } from '../helpers';
import type { Grant } from '../../src/authz/catalog.js';

const g = (permission: string, scope: Grant['scope'] = 'organization'): Grant => ({ permission, scope });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(email: string, password: string) {
  const res = await supertest(app).post(`${BASE}/auth/login`).send({ email, password });
  expect(res.status).toBe(200);
  return data(res).tokens as { access: string; refresh: string };
}

describe('sessions', () => {
  it('anonymous → 401; garbage token → 401', async () => {
    expect((await supertest(app).get(`${BASE}/auth/me`)).status).toBe(401);
    expect((await supertest(app).get(`${BASE}/auth/me`).set(bearer('nope'))).status).toBe(401);
  });

  it('access tokens carry identity only (no role / permissions)', async () => {
    const s = await signupAgency();
    const t = await login(s.email, s.password);
    const payload = JSON.parse(Buffer.from(t.access.split('.')[1]!, 'base64url').toString());
    expect(payload.sid).toMatch(/^ses_/);
    expect(payload.role).toBeUndefined();
    expect(payload.permissions).toBeUndefined();
  });

  it('logout ends the session for both access and refresh tokens', async () => {
    const s = await signupAgency();
    const t = await login(s.email, s.password);
    expect((await supertest(app).post(`${BASE}/auth/logout`).set(bearer(t.access))).status).toBe(200);
    expect((await supertest(app).get(`${BASE}/auth/me`).set(bearer(t.access))).status).toBe(401);
    expect((await supertest(app).post(`${BASE}/auth/refresh`).send({ refreshToken: t.refresh })).status).toBe(401);
  });

  it('refresh rotates; replaying an old refresh token revokes the session', async () => {
    const s = await signupAgency();
    const t = await login(s.email, s.password);
    const r1 = await supertest(app).post(`${BASE}/auth/refresh`).send({ refreshToken: t.refresh });
    expect(r1.status).toBe(200);
    const rotated = data(r1).tokens;
    // Replay the original (stolen) refresh token.
    expect((await supertest(app).post(`${BASE}/auth/refresh`).send({ refreshToken: t.refresh })).status).toBe(401);
    // The whole session is now dead — even the legitimately rotated tokens.
    expect((await supertest(app).get(`${BASE}/auth/me`).set(bearer(rotated.access))).status).toBe(401);
    expect((await supertest(app).post(`${BASE}/auth/refresh`).send({ refreshToken: rotated.refresh })).status).toBe(401);
  });

  it('password change ends every other session but keeps the current one', async () => {
    const s = await signupAgency();
    const a = await login(s.email, s.password);
    const b = await login(s.email, s.password);
    const res = await supertest(app)
      .post(`${BASE}/auth/change-password`)
      .set(bearer(a.access))
      .send({ currentPassword: s.password, newPassword: 'Changed123!' });
    expect(res.status).toBe(200);
    expect((await supertest(app).get(`${BASE}/auth/me`).set(bearer(a.access))).status).toBe(200);
    expect((await supertest(app).get(`${BASE}/auth/me`).set(bearer(b.access))).status).toBe(401);
  });

  it('users can list and end their own sessions', async () => {
    const s = await signupAgency();
    const a = await login(s.email, s.password);
    const b = await login(s.email, s.password);
    const list = data(await supertest(app).get(`${BASE}/auth/sessions`).set(bearer(a.access)));
    const others = list.filter((x: any) => !x.current);
    expect(others.length).toBeGreaterThanOrEqual(1);
    for (const o of others) {
      expect((await supertest(app).delete(`${BASE}/auth/sessions/${o.id}`).set(bearer(a.access))).status).toBe(200);
    }
    expect((await supertest(app).get(`${BASE}/auth/me`).set(bearer(a.access))).status).toBe(200);
    expect((await supertest(app).get(`${BASE}/auth/me`).set(bearer(b.access))).status).toBe(401);
  });

  it('admin "sign out everywhere" and account deletion end sessions immediately', async () => {
    const s = await signupAgency();
    const m = await createMemberSession(s.agent, { grants: [g('projects.view')] });
    const t = await login(m.email, m.password);
    expect((await s.agent.post(`${BASE}/team/${m.user.id}/sessions/revoke`)).status).toBe(200);
    expect((await supertest(app).get(`${BASE}/auth/me`).set(bearer(t.access))).status).toBe(401);

    const m2 = await createMemberSession(s.agent, { grants: [g('projects.view')] });
    const t2 = await login(m2.email, m2.password);
    expect((await s.agent.delete(`${BASE}/team/${m2.user.id}`)).status).toBe(200);
    expect((await supertest(app).get(`${BASE}/projects`).set(bearer(t2.access))).status).toBe(401);
  });

  it('permission changes apply on the very next request with the same token', async () => {
    const s = await signupAgency();
    const roleId = await createRole(s.agent, [g('organization.view'), g('projects.view')]);
    const m = await createMemberSession(s.agent, { roleIds: [roleId] });
    const t = await login(m.email, m.password);
    expect((await supertest(app).get(`${BASE}/projects`).set(bearer(t.access))).status).toBe(200);
    await s.agent.put(`${BASE}/team/${m.user.id}/overrides`).send({
      overrides: [{ permission: 'projects.view', scope: null, effect: 'deny' }],
    });
    expect((await supertest(app).get(`${BASE}/projects`).set(bearer(t.access))).status).toBe(403);
  });

  it('a legacy role-claim token cannot escalate: authority comes from grants, not the claim', async () => {
    const s = await signupAgency();
    const m = await createMemberSession(s.agent, { grants: [g('organization.view')] });
    // Forge-free: a genuinely signed legacy token claiming role "owner".
    const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!);
    const agencyId = data(await m.agent.get(`${BASE}/auth/me`)).agency.id;
    const legacy = await new SignJWT({ agencyId, role: 'owner', type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(m.user.id)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    expect((await supertest(app).get(`${BASE}/roles`).set(bearer(legacy))).status).toBe(403);
    expect((await supertest(app).get(`${BASE}/agency`).set(bearer(legacy))).status).toBe(200);
  });

  it('/auth/me returns the authorization contract', async () => {
    const s = await signupAgency();
    const me = data(await s.agent.get(`${BASE}/auth/me`));
    expect(me.authorization.actorType).toBe('staff');
    expect(me.authorization.roles.map((r: any) => r.key)).toEqual(['owner']);
    expect(me.authorization.grants['invoices.view']).toEqual(['organization']);
    expect(typeof me.authorization.version).toBe('string');
  });
});
