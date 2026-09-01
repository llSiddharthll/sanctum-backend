import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import { app, BASE, signupAgency, data, type Agent } from './helpers';

/**
 * A not-yet-executed agreement (draft/sent) can be deleted; once it is signed
 * (legally binding) deletion is blocked with a 400.
 */
describe('agreement delete', () => {
  let owner: Agent;
  let clientId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Del Co' })).id;
  });

  it('deletes a draft agreement and 404s afterwards', async () => {
    const a = data(
      await owner.post(`${BASE}/agreements`).send({
        title: 'Draft MSA',
        clientId,
        terms: { scope: 'work', clauses: ['1. A clause'] },
      }),
    );
    const del = await owner.delete(`${BASE}/agreements/${a.id}`);
    expect(del.status).toBe(200);
    expect(data(del).deleted).toBe(true);

    const after = await owner.get(`${BASE}/agreements/${a.id}`);
    expect(after.status).toBe(404);
  });

  it('persists custom sections through create + update (free-JSON terms)', async () => {
    const a = data(
      await owner.post(`${BASE}/agreements`).send({
        title: 'Sectioned MSA',
        clientId,
        terms: { scope: 'work', clauses: ['1. Clause'], sections: [{ heading: 'Background', body: 'Context here' }] },
      }),
    );
    const got = data(await owner.get(`${BASE}/agreements/${a.id}`));
    expect(got.terms.sections?.[0]?.heading).toBe('Background');
    // update adds a second section
    await owner.put(`${BASE}/agreements/${a.id}`).send({
      title: 'Sectioned MSA',
      terms: { scope: 'work', clauses: ['1. Clause'], sections: [
        { heading: 'Background', body: 'Context here' },
        { heading: 'Deliverables', body: 'The work' },
      ] },
    });
    const got2 = data(await owner.get(`${BASE}/agreements/${a.id}`));
    expect(got2.terms.sections).toHaveLength(2);
    expect(got2.terms.sections[1].heading).toBe('Deliverables');
  });

  it('refuses to delete a signed agreement', async () => {
    const a = data(
      await owner.post(`${BASE}/agreements`).send({
        title: 'Signed MSA',
        clientId,
        terms: { scope: 'work', clauses: ['1. Clause'] },
      }),
    );
    // Client signs it via the public token route.
    const signed = await supertest(app).post(`${BASE}/agreements/public/${a.token}/sign`).send({
      signerName: 'Jane Client',
      signerEmail: 'jane@client.com',
      signatureDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAhowever',
    });
    expect([200, 201]).toContain(signed.status);

    const del = await owner.delete(`${BASE}/agreements/${a.id}`);
    expect(del.status).toBe(400);
    expect(String(del.body?.error?.message ?? '')).toMatch(/signed|active|cannot/i);
  });
});
