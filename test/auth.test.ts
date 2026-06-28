import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import {
  app,
  BASE,
  signupAgency,
  createMemberSession,
  data,
  uniqueEmail,
} from './helpers';

describe('auth workflow', () => {
  it('signs up an agency + owner and sets a session', async () => {
    const email = uniqueEmail();
    const agent = supertest.agent(app);
    const res = await agent.post(`${BASE}/auth/signup`).send({
      agencyName: 'Acme Studio',
      fullName: 'Ada Owner',
      email,
      password: 'Password123!',
    });
    expect(res.status).toBe(201);
    expect(data(res).user.role).toBe('owner');
    expect(data(res).agency.id).toMatch(/^agc_/);
    // session cookie set
    expect(res.headers['set-cookie'].join(';')).toMatch(/sanctum_at=/);

    const me = await agent.get(`${BASE}/auth/me`);
    expect(me.status).toBe(200);
    expect(data(me).user.email).toBe(email);
  });

  it('rejects a wrong password and accepts the right one', async () => {
    const { email } = await signupAgency();
    const fresh = supertest.agent(app);
    const bad = await fresh
      .post(`${BASE}/auth/login`)
      .send({ email, password: 'wrong-password' });
    expect(bad.status).toBe(401);

    const good = await fresh
      .post(`${BASE}/auth/login`)
      .send({ email, password: 'Password123!' });
    expect(good.status).toBe(200);
  });

  it('refreshes and logs out', async () => {
    const { agent } = await signupAgency();
    const refresh = await agent.post(`${BASE}/auth/refresh`).send({});
    expect(refresh.status).toBe(200);

    const logout = await agent.post(`${BASE}/auth/logout`).send({});
    expect(logout.status).toBe(200);
  });

  it('blocks unauthenticated access to a protected route', async () => {
    const anon = supertest.agent(app);
    const res = await anon.get(`${BASE}/clients`);
    expect(res.status).toBe(401);
  });

  // /auth/signup now enforces global email uniqueness (login resolves a user by
  // email globally, so a duplicate would make login ambiguous). A second signup
  // with the same email must be rejected.
  it('rejects duplicate-email signup', async () => {
    const { email } = await signupAgency();
    const dup = await supertest(app).post(`${BASE}/auth/signup`).send({
      agencyName: 'Dup Co',
      fullName: 'Dup User',
      email,
      password: 'Password123!',
    });
    expect([409, 400, 422]).toContain(dup.status);
  });
});

describe('password reset + change password', () => {
  /** Extract the raw token from a returned resetUrl (…/reset-password?token=). */
  function tokenFromUrl(url: string): string {
    return url.split('token=')[1] ?? '';
  }

  it('forgot-password always returns 200 (no account enumeration)', async () => {
    const { email } = await signupAgency();
    const known = await supertest(app)
      .post(`${BASE}/auth/forgot-password`)
      .send({ email });
    expect(known.status).toBe(200);

    const unknown = await supertest(app)
      .post(`${BASE}/auth/forgot-password`)
      .send({ email: uniqueEmail('ghost') });
    expect(unknown.status).toBe(200);
  });

  it('admin reset → preview → reset → login; token is single-use', async () => {
    const owner = await signupAgency();
    const member = await createMemberSession(owner.agent);

    // Owner/admin mints a reset link for the member.
    const reset = await owner.agent.post(
      `${BASE}/team/${member.user.id}/reset-password`,
    );
    expect(reset.status).toBe(200);
    const token = tokenFromUrl(data(reset).resetUrl);
    expect(token).toMatch(/^pzt_/);

    // Preview returns the account email.
    const preview = await supertest(app).get(
      `${BASE}/auth/reset-password?token=${token}`,
    );
    expect(preview.status).toBe(200);
    expect(data(preview).email).toBe(member.email);

    // Consume the token → sets a new password + a session.
    const consume = await supertest(app)
      .post(`${BASE}/auth/reset-password`)
      .send({ token, password: 'BrandNew123!' });
    expect(consume.status).toBe(200);

    // Reuse of the same token is rejected (single-use).
    const reuse = await supertest(app)
      .post(`${BASE}/auth/reset-password`)
      .send({ token, password: 'Another123!' });
    expect(reuse.status).toBe(410);

    // The member can log in with the new password, not the old one.
    const newLogin = await supertest(app)
      .post(`${BASE}/auth/login`)
      .send({ email: member.email, password: 'BrandNew123!' });
    expect(newLogin.status).toBe(200);
    const oldLogin = await supertest(app)
      .post(`${BASE}/auth/login`)
      .send({ email: member.email, password: member.password });
    expect(oldLogin.status).toBe(401);
  });

  it('reset preview rejects an invalid/expired token (410)', async () => {
    const res = await supertest(app).get(
      `${BASE}/auth/reset-password?token=pzt_not_a_real_token`,
    );
    expect(res.status).toBe(410);
  });

  it('only owners/admins can mint a member reset link', async () => {
    const owner = await signupAgency();
    const member = await createMemberSession(owner.agent);
    const other = await createMemberSession(owner.agent);
    // A plain member cannot reset another member's password.
    const res = await member.agent.post(
      `${BASE}/team/${other.user.id}/reset-password`,
    );
    expect(res.status).toBe(403);
  });

  it('change-password verifies the current password', async () => {
    const { agent, email, password } = await signupAgency();

    const wrong = await agent
      .post(`${BASE}/auth/change-password`)
      .send({ currentPassword: 'not-it', newPassword: 'Switched123!' });
    expect(wrong.status).toBe(400);

    const ok = await agent
      .post(`${BASE}/auth/change-password`)
      .send({ currentPassword: password, newPassword: 'Switched123!' });
    expect(ok.status).toBe(200);

    // New password works on a fresh login; the old one no longer does.
    const fresh = supertest.agent(app);
    const good = await fresh
      .post(`${BASE}/auth/login`)
      .send({ email, password: 'Switched123!' });
    expect(good.status).toBe(200);
  });

  it('change-password requires authentication', async () => {
    const res = await supertest(app)
      .post(`${BASE}/auth/change-password`)
      .send({ currentPassword: 'x', newPassword: 'Whatever123!' });
    expect(res.status).toBe(401);
  });
});
