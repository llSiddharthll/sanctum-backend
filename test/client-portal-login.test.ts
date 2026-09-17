import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import { app, BASE, signupAgency, data, lastEmailTo, type Agent } from './helpers';

/**
 * Client-portal login provisioning (clients.manage_portal):
 *  - POST creates a NEW client account for an email that has none on the brand
 *    and returns the generated password once;
 *  - for an existing account it changes nothing and emails a reset link to the
 *    account's own address (no password is returned or set);
 *  - staff can't choose passwords; login email must be globally unused;
 *  - the login email can only go to the account's own address.
 */
async function makeClient(owner: Agent, name = 'Login Co', contactEmail?: string): Promise<{ id: string }> {
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

    const before = data(await owner.get(`${BASE}/clients/${cli.id}/portal-login`));
    expect(before.exists).toBe(false);
    expect(before.email).toBe(email);
    expect(before.accounts).toEqual([]);

    const res = await owner.post(`${BASE}/clients/${cli.id}/portal-login`).send({});
    expect(res.status).toBe(201);
    const creds = data(res);
    expect(creds.email).toBe(email);
    expect(typeof creds.password).toBe('string');
    expect(creds.password.length).toBeGreaterThanOrEqual(8);
    expect(creds.created).toBe(true);
    expect(creds.userId).toMatch(/^usr_/);

    const good = await login(email, creds.password);
    expect(good.status).toBe(200);
    expect(good.body.data.user.role).toBe('client');

    expect((await login(email, 'not-the-password')).status).toBe(401);

    const after = data(await owner.get(`${BASE}/clients/${cli.id}/portal-login`));
    expect(after.exists).toBe(true);
    expect(after.email).toBe(email);
    expect(after.accounts).toHaveLength(1);
  });

  it('an existing account is never reset by staff: only a reset link to its own email', async () => {
    const email = `reset.${Date.now()}@client.test`;
    const cli = await makeClient(owner, 'Reset Co', email);

    const first = data(await owner.post(`${BASE}/clients/${cli.id}/portal-login`).send({}));
    expect((await login(email, first.password)).status).toBe(200);

    const res = await owner.post(`${BASE}/clients/${cli.id}/portal-login`).send({});
    expect(res.status).toBe(200);
    const second = data(res);
    expect(second.created).toBe(false);
    expect(second.password).toBeNull();
    expect(second.resetSent).toBe(true);
    expect(second.userId).toBe(first.userId);

    // Password unchanged; a reset link went to the account's own address.
    expect((await login(email, first.password)).status).toBe(200);
    expect(lastEmailTo(email)?.text).toMatch(/reset-password\?token=/);
  });

  it('rejects staff-chosen passwords, a missing email and a duplicate email', async () => {
    const cli = await makeClient(owner, 'Custom Co'); // no contact email
    expect((await owner.post(`${BASE}/clients/${cli.id}/portal-login`).send({})).status).toBe(400);

    const email = `custom.${Date.now()}@client.test`;
    const chosen = await owner
      .post(`${BASE}/clients/${cli.id}/portal-login`)
      .send({ email, password: 'MyChosenPass123' });
    expect(chosen.status).toBe(400);

    const createdRes = await owner.post(`${BASE}/clients/${cli.id}/portal-login`).send({ email });
    expect(createdRes.status).toBe(201);

    // Another client can't take the same login email.
    const other = await makeClient(owner, 'Other Co');
    const clash = await owner.post(`${BASE}/clients/${other.id}/portal-login`).send({ email });
    expect(clash.status).toBe(409);
  });

  it('emails login details only to the account itself, with its real password or none', async () => {
    const email = `emaillink.${Date.now()}@client.test`;
    const cli = await makeClient(owner, 'Email Co', email);
    const creds = data(await owner.post(`${BASE}/clients/${cli.id}/portal-login`).send({}));

    const withPw = await owner
      .post(`${BASE}/clients/${cli.id}/portal-login-email`)
      .send({ email, password: creds.password, note: 'A new invoice is ready to view in your portal.' });
    expect(withPw.status).toBe(200);
    expect(data(withPw).to).toBe(email);

    const noPw = await owner
      .post(`${BASE}/clients/${cli.id}/portal-login-email`)
      .send({ email, note: 'A new invoice is ready to view in your portal.' });
    expect(noPw.status).toBe(200);

    // A made-up password is refused (no phishing with agency branding).
    const fake = await owner
      .post(`${BASE}/clients/${cli.id}/portal-login-email`)
      .send({ email, password: 'Secret123' });
    expect(fake.status).toBe(400);

    // Arbitrary recipients are refused.
    const redirect = await owner
      .post(`${BASE}/clients/${cli.id}/portal-login-email`)
      .send({ email, sendTo: 'attacker@evil.test' });
    expect(redirect.status).toBe(400);
    expect(lastEmailTo('attacker@evil.test')).toBeUndefined();

    // Unknown account → 404.
    const unknown = await owner
      .post(`${BASE}/clients/${cli.id}/portal-login-email`)
      .send({ email: `nobody.${Date.now()}@client.test` });
    expect(unknown.status).toBe(404);
  });
});
