import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { eq } from 'drizzle-orm';
import {
  app,
  BASE,
  signupAgency,
  data,
  uniqueEmail,
  inviteToken,
  db,
  schema,
  type Agent,
} from './helpers';

describe('accept-invite workflow', () => {
  async function invite(owner: Agent, email: string, role: 'admin' | 'member' = 'member') {
    const res = await owner
      .post(`${BASE}/team/invite`)
      .send({ fullName: 'Invitee', email, role });
    expect(res.status).toBe(201);
    expect(data(res).inviteUrl).toContain('/accept-invite?token=');
    return inviteToken(data(res).inviteUrl);
  }

  it('previews a pending invite without consuming it', async () => {
    const { agent: owner, agency } = await signupAgency();
    const email = uniqueEmail('inv');
    const token = await invite(owner, email);

    const peek = await supertest(app).get(`${BASE}/auth/invite`).query({ token });
    expect(peek.status).toBe(200);
    expect(data(peek).email).toBe(email);
    expect(data(peek).agencyName).toBe(agency.name);
    expect(data(peek).role).toBe('member');

    // Preview does not consume — still usable.
    const again = await supertest(app).get(`${BASE}/auth/invite`).query({ token });
    expect(again.status).toBe(200);
  });

  it('accepts an invite: sets password, logs in, and the member can re-login', async () => {
    const { agent: owner } = await signupAgency();
    const email = uniqueEmail('inv');
    const token = await invite(owner, email);

    const agent = supertest.agent(app);
    const accept = await agent
      .post(`${BASE}/auth/accept-invite`)
      .send({ token, password: 'NewPass123!', fullName: 'Real Name' });
    expect(accept.status).toBe(200);
    expect(data(accept).user.email).toBe(email);
    // Session cookie was set → an authenticated call works immediately.
    expect(accept.headers['set-cookie'].join(';')).toMatch(/sanctum_at=/);

    const me = await agent.get(`${BASE}/auth/me`);
    expect(me.status).toBe(200);
    expect(data(me).user.fullName).toBe('Real Name');

    // And the member can sign in fresh with the password they chose.
    const fresh = supertest.agent(app);
    const login = await fresh
      .post(`${BASE}/auth/login`)
      .send({ email, password: 'NewPass123!' });
    expect(login.status).toBe(200);
  });

  it('rejects a reused invite token (410) and preview reflects it', async () => {
    const { agent: owner } = await signupAgency();
    const email = uniqueEmail('inv');
    const token = await invite(owner, email);

    const first = await supertest(app)
      .post(`${BASE}/auth/accept-invite`)
      .send({ token, password: 'NewPass123!' });
    expect(first.status).toBe(200);

    const second = await supertest(app)
      .post(`${BASE}/auth/accept-invite`)
      .send({ token, password: 'NewPass123!' });
    expect(second.status).toBe(410);

    const peek = await supertest(app).get(`${BASE}/auth/invite`).query({ token });
    expect(peek.status).toBe(410);
  });

  it('rejects an invalid token (404) and a missing token (400)', async () => {
    const bad = await supertest(app)
      .post(`${BASE}/auth/accept-invite`)
      .send({ token: 'pzt_does_not_exist', password: 'NewPass123!' });
    expect(bad.status).toBe(404);

    const peekBad = await supertest(app)
      .get(`${BASE}/auth/invite`)
      .query({ token: 'pzt_does_not_exist' });
    expect(peekBad.status).toBe(404);

    const missing = await supertest(app).get(`${BASE}/auth/invite`);
    expect(missing.status).toBe(400);
  });

  it('rejects a too-short password (422)', async () => {
    const { agent: owner } = await signupAgency();
    const email = uniqueEmail('inv');
    const token = await invite(owner, email);
    const res = await supertest(app)
      .post(`${BASE}/auth/accept-invite`)
      .send({ token, password: 'short' });
    expect(res.status).toBe(422);
  });

  it('rejects an expired invite (410)', async () => {
    const { agent: owner } = await signupAgency();
    const email = uniqueEmail('inv');
    const token = await invite(owner, email);

    // Force-expire the pending invite, then try to accept it.
    await db
      .update(schema.invites)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.invites.email, email));
    const res = await supertest(app)
      .post(`${BASE}/auth/accept-invite`)
      .send({ token, password: 'NewPass123!' });
    expect(res.status).toBe(410);
  });
});
