import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { app, BASE, signupAgency, data } from './helpers';

/** Portal requests carry a Bearer token, not a session cookie. */
function portalGet(token: string, path: string) {
  return supertest(app)
    .get(`${BASE}/portal${path}`)
    .set('Authorization', `Bearer ${token}`);
}

/**
 * Project files feature: documents filed under a project are either INTERNAL
 * (agency-only) or CLIENT-FACING (clientVisible). The client portal must surface
 * only the client-facing ones — for docs on the client directly OR on a project
 * that belongs to the client — and never the internal ones.
 */
describe('project documents — internal vs client-facing + portal exposure', () => {
  it('client-visible docs reach the portal; internal docs never do; clientVisible coerces 1 -> true', async () => {
    const owner = (await signupAgency()).agent;

    const c = await owner
      .post(`${BASE}/clients`)
      .send({ name: 'Doc Client', contactEmail: 'doc@client.test' });
    expect(c.status).toBe(201);
    const clientId = data(c).id as string;

    const proj = await owner
      .post(`${BASE}/projects`)
      .send({ name: 'Doc Project', clientId });
    expect(proj.status).toBe(201);
    const projectId = data(proj).id as string;

    // Internal (agency-only) project doc.
    const internal = await owner.post(`${BASE}/documents`).send({
      name: 'Internal Brief.pdf',
      fileUrl: 'https://res.cloudinary.com/demo/raw/upload/internal.pdf',
      projectId,
      resourceType: 'raw',
      clientVisible: false,
    });
    expect(internal.status).toBe(201);
    expect(data(internal).clientVisible).toBe(false);

    // Client-facing project doc — sent as `1` to exercise the boolean coercion.
    const external = await owner.post(`${BASE}/documents`).send({
      name: 'Final Deliverable.pdf',
      fileUrl: 'https://res.cloudinary.com/demo/raw/upload/final.pdf',
      projectId,
      resourceType: 'raw',
      clientVisible: 1,
    });
    expect(external.status).toBe(201);
    expect(data(external).clientVisible).toBe(true);

    // Client-facing doc attached directly to the client (no project).
    const direct = await owner.post(`${BASE}/documents`).send({
      name: 'Contract.pdf',
      fileUrl: 'https://res.cloudinary.com/demo/raw/upload/contract.pdf',
      clientId,
      resourceType: 'raw',
      clientVisible: true,
    });
    expect(direct.status).toBe(201);

    // Agency list filtered by project returns BOTH internal + client-facing.
    const list = await owner.get(`${BASE}/documents?projectId=${projectId}`);
    expect(list.status).toBe(200);
    expect(
      (data(list) as Array<{ name: string }>).map((d) => d.name).sort(),
    ).toEqual(['Final Deliverable.pdf', 'Internal Brief.pdf']);

    // Portal resolve: only client-facing docs, never the internal one.
    const tokRes = await owner
      .post(`${BASE}/clients/${clientId}/portal-tokens`)
      .send({});
    const token = data(tokRes).token as string;
    expect(typeof token).toBe('string');

    const resolved = await portalGet(token, '/resolve');
    expect(resolved.status).toBe(200);
    const docs = data(resolved).documents as Array<{
      name: string;
      projectName: string | null;
    }>;
    const names = docs.map((d) => d.name).sort();
    expect(names).toContain('Final Deliverable.pdf');
    expect(names).toContain('Contract.pdf');
    expect(names).not.toContain('Internal Brief.pdf');
    expect(
      docs.find((d) => d.name === 'Final Deliverable.pdf')?.projectName,
    ).toBe('Doc Project');
  });
});
