import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { app, BASE, uniqueEmail, data } from './helpers';

/**
 * Simulates iOS/iPadOS, where the cross-domain auth COOKIE (Vercel ↔ Render) is
 * blocked by WebKit ITP. The client must authenticate purely with the Bearer
 * token returned in the response body. Using plain `supertest(app)` (NOT
 * `.agent`) means there is no cookie jar — cookies are ignored between calls,
 * exactly like the iPad.
 */
describe('bearer-token auth (cookie-less / iPad scenario)', () => {
  it('login returns tokens; Bearer-only /me works; refresh via body works', async () => {
    const email = uniqueEmail();

    // Sign up — the response body must carry the session tokens.
    const signup = await supertest(app).post(`${BASE}/auth/signup`).send({
      agencyName: 'Bearer Studio',
      fullName: 'Ivy iPad',
      email,
      password: 'Password123!',
    });
    expect(signup.status).toBe(201);
    const tokens = data(signup).tokens;
    expect(tokens?.access).toBeTruthy();
    expect(tokens?.refresh).toBeTruthy();

    // /auth/me with ONLY the Bearer header and NO cookie → authenticated.
    const me = await supertest(app)
      .get(`${BASE}/auth/me`)
      .set('Authorization', `Bearer ${tokens.access}`);
    expect(me.status).toBe(200);
    expect(data(me).user.email).toBe(email);

    // A request with neither cookie nor header is unauthorized (sanity check).
    const anon = await supertest(app).get(`${BASE}/auth/me`);
    expect(anon.status).toBe(401);

    // Refresh with the refresh token in the BODY (no cookie) → rotated tokens.
    const refresh = await supertest(app)
      .post(`${BASE}/auth/refresh`)
      .send({ refreshToken: tokens.refresh });
    expect(refresh.status).toBe(200);
    const rotated = data(refresh).tokens;
    expect(rotated?.access).toBeTruthy();
    expect(rotated?.refresh).toBeTruthy();

    // The rotated access token authenticates too.
    const me2 = await supertest(app)
      .get(`${BASE}/auth/me`)
      .set('Authorization', `Bearer ${rotated.access}`);
    expect(me2.status).toBe(200);

    // Login for an existing user also returns tokens in the body.
    const login = await supertest(app)
      .post(`${BASE}/auth/login`)
      .send({ email, password: 'Password123!' });
    expect(login.status).toBe(200);
    expect(data(login).tokens?.access).toBeTruthy();
  });
});
