import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, signupAgency, createMemberSession, data, type Agent } from './helpers';

describe('clients workflow', () => {
  let owner: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  it('owner creates, lists, reads and updates a client', async () => {
    const create = await owner
      .post(`${BASE}/clients`)
      .send({ name: 'Aurora Cafe', contactEmail: 'hi@aurora.test' });
    expect(create.status).toBe(201);
    const id = data(create).id;
    expect(id).toMatch(/^cli_/);

    const list = await owner.get(`${BASE}/clients`);
    expect(list.status).toBe(200);
    expect(data(list).some((c: any) => c.id === id)).toBe(true);

    const get = await owner.get(`${BASE}/clients/${id}`);
    expect(get.status).toBe(200);
    expect(data(get).name).toBe('Aurora Cafe');

    const patch = await owner
      .patch(`${BASE}/clients/${id}`)
      .send({ name: 'Aurora Coffee' });
    expect(patch.status).toBe(200);
    expect(data(patch).name).toBe('Aurora Coffee');
  });

  it('denies a member with clients:none any access (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { clients: 'none' },
    });
    const res = await agent.get(`${BASE}/clients`);
    expect(res.status).toBe(403);
  });

  it('lets a clients:view member read but not create (role-gated write)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { clients: 'view' },
    });
    const list = await agent.get(`${BASE}/clients`);
    expect(list.status).toBe(200);

    const create = await agent.post(`${BASE}/clients`).send({ name: 'Nope Inc' });
    expect(create.status).toBe(403);
  });

  it("isolates tenants — agency B cannot see agency A's clients", async () => {
    const a = (await signupAgency()).agent;
    const created = await a.post(`${BASE}/clients`).send({ name: 'Secret A' });
    const aId = data(created).id;

    const b = (await signupAgency()).agent;
    const bView = await b.get(`${BASE}/clients/${aId}`);
    expect([403, 404]).toContain(bView.status);
  });
});
