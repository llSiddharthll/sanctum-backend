import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, signupAgency, createMemberSession, data, type Agent } from './helpers';
import type { Grant } from '../src/authz/catalog.js';

const g = (permission: string, scope: Grant['scope'] = 'organization'): Grant => ({ permission, scope });

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

  it('denies a member without clients.view any access (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      grants: [g('organization.view')],
    });
    const res = await agent.get(`${BASE}/clients`);
    expect(res.status).toBe(403);
  });

  it('lets a clients.view member read but not create', async () => {
    const { agent } = await createMemberSession(owner, {
      grants: [g('clients.view')],
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
    expect(bView.status).toBe(404);
  });

  it('detail carries capabilities; money fields need clients.view_financials', async () => {
    const id = data(
      await owner.post(`${BASE}/clients`).send({ name: 'Money Co', gstNumber: 'GST-9', paymentTermsDays: 15 }),
    ).id;
    const own = data(await owner.get(`${BASE}/clients/${id}`));
    expect(own.gstNumber).toBe('GST-9');
    expect(own.outstanding).toBe(0);
    expect(own.capabilities['clients.update']).toBe(true);

    const { agent } = await createMemberSession(owner, { grants: [g('clients.view'), g('clients.update')] });
    const viewer = data(await agent.get(`${BASE}/clients/${id}`));
    expect(viewer.gstNumber).toBeNull();
    expect(viewer.paymentTermsDays).toBeNull();
    expect(viewer.invoiceCount).toBe(0);
    expect(viewer.outstanding).toBeNull();
    expect(viewer.capabilities['clients.update']).toBe(true);
    expect(viewer.capabilities['clients.archive']).toBe(false);
    const row = data(await agent.get(`${BASE}/clients`)).find((c: any) => c.id === id);
    expect(row.gstNumber).toBeNull();
  });
});
