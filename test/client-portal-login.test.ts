import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import { app, BASE, signupAgency, data, type Agent } from './helpers';

/**
 * Secure client-portal login: the agency provisions a role:'client' account for
 * a brand with a returned password, the client logs in with it at /auth/login,
 * resetting rotates the password (old one stops working), and the login email
 * must be unique within the agency.
 */
async function makeClient(
  owner: Agent,
  name = 'Login Co',
  contactEmail?: string,
): Promise<{ id: string; contactEmail?: string }> {
  const body: Record<string, unknown> = { name };
  if (contactEmail) body.contactEmail = contactEmail;
  return data(await owner.post(`${BASE}/clients`).send(body));
}

function login(email: string, password: string) {
  return supertest(app).post(`${BASE}/auth/login`).send({ email, password });
}

describe('secure client-portal login', () => {
  let owner: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  it('creates a login the client can actually sign in with', async () => {
    const email = `brandlogin.${Date.now()}@client.test`;
    const cli = await makeClient(owner, 'Sign-in Co', email);

    // Status before: no login yet, email defaulted to the contact email.
    const before = data(await owner.get(`${BASE}/clients/${cli.id}/portal-login`));
    expect(before.exists).toBe(false);
    expect(before.email).toBe(email);

    // Provision: returns the plaintext password ONCE + a 201.
    const res = await owner.post(`${BASE}/clients/${cli.id}/portal-login`).send({});
    expect(res.status).toBe(201);
    const creds = data(res);
    expect(creds.email).toBe(email);
    expect(typeof creds.password).toBe('string');
    expect(creds.password.length).toBeGreaterThanOrEqual(10);
    expect(creds.created).toBe(true);

    // The client can log in with those credentials, as a 'client'.
    const good = await login(email, creds.password);
    expect(good.status).toBe(200);
    expect(good.body.data.user.role).toBe('client');
    expect(good.body.data.tokens.access).toBeTruthy();

    // A wrong password fails.
    const bad = await login(email, 'not-the-password');
    expect(bad.status).toBe(401);

    // Status after: exists.
    const after = data(await owner.get(`${BASE}/clients/${cli.id}/portal-login`));
    expect(after.exists).toBe(true);
    expect(after.email).toBe(email);
  });

  it('resetting rotates the password — the old one stops working', async () => {
    const email = `reset.${Date.now()}@client.test`;
    const cli = await makeClient(owner, 'Reset Co', email);

    const first = data(await owner.post(`${BASE}/clients/${cli.id}/portal-login`).send({}));
    expect((await login(email, first.password)).status).toBe(200);

    // Reset → not "created", new password, same email.
    const res = await owner.post(`${BASE}/clients/${cli.id}/portal-login`).send({});
    expect(res.status).toBe(200);
    const second = data(res);
    expect(second.created).toBe(false);
    expect(second.password).not.toBe(first.password);

    expect((await login(email, second.password)).status).toBe(200); // new works
    expect((await login(email, first.password)).status).toBe(401); // old dead
  });

  it('accepts a custom email + password and rejects a duplicate email', async () => {
    const cli = await makeClient(owner, 'Custom Co'); // no contact email
    // No email anywhere → 400.
    const noEmail = await owner.post(`${BASE}/clients/${cli.id}/portal-login`).send({});
    expect(noEmail.status).toBe(400);

    const email = `custom.${Date.now()}@client.test`;
    const created = await owner
      .post(`${BASE}/clients/${cli.id}/portal-login`)
      .send({ email, password: 'MyChosenPass123' });
    expect(created.status).toBe(201);
    expect((await login(email, 'MyChosenPass123')).status).toBe(200);

    // A second, different client can't take the same login email.
    const other = await makeClient(owner, 'Other Co');
    const clash = await owner
      .post(`${BASE}/clients/${other.id}/portal-login`)
      .send({ email });
    expect(clash.status).toBe(409);
  });
});
