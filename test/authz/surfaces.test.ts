import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { app, BASE, data, inviteToken, signupAgency, uniqueEmail } from '../helpers';

/**
 * Surface separation: client-side actors (client users, share links) may only use
 * the client API (/client, /portal); the agency API answers 403 — never data, and
 * never 401 (which would log a valid client session out).
 */
describe('staff vs client API surfaces', () => {
  it('client users get 403 on staff APIs and 200 on the client API', async () => {
    const owner = (await signupAgency()).agent;
    const client = data(await owner.post(`${BASE}/clients`).send({ name: 'Surface Co' }));
    await owner.post(`${BASE}/projects`).send({ name: 'Surface project', clientId: client.id });

    const email = uniqueEmail('client');
    const invite = await owner
      .post(`${BASE}/team/invite`)
      .send({ fullName: 'Client Person', email, kind: 'client', clientId: client.id });
    expect(invite.status).toBe(201);
    const accept = await supertest(app)
      .post(`${BASE}/auth/accept-invite`)
      .send({ token: inviteToken(data(invite).inviteUrl), password: 'Password123!' });
    expect(accept.status).toBe(200);
    const access = data(accept).tokens.access as string;
    const as = (path: string) => supertest(app).get(`${BASE}${path}`).set('Authorization', `Bearer ${access}`);

    for (const path of ['/projects', '/clients', '/invoices', '/documents', '/team', '/roles', '/messages/threads']) {
      const res = await as(path);
      expect(res.status, path).toBe(403);
      expect(res.body.data, path).toBeUndefined();
    }
    expect((await as('/client/projects')).status).toBe(200);
    expect((await as('/auth/me')).status).toBe(200);
  });

  it('anonymous public document routes inside staff routers still work without a token', async () => {
    const res = await supertest(app).get(`${BASE}/proposals/public/not-a-real-token`);
    expect([404, 410]).toContain(res.status);
  });
});
