import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import type { Agent } from 'supertest';
import { app, BASE, signupAgency, createMemberSession, data } from './helpers';

function portal(token: string) {
  return {
    get: (path: string) =>
      supertest(app)
        .get(`${BASE}/portal${path}`)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string) =>
      supertest(app)
        .post(`${BASE}/portal${path}`)
        .set('Authorization', `Bearer ${token}`),
  };
}

const RAW_DOC = (name: string) => ({
  name,
  fileUrl: `https://res.cloudinary.com/demo/raw/upload/${encodeURIComponent(name)}`,
  resourceType: 'raw' as const,
});

// ===========================================================================
// CRUD tiers: none < view < edit < manage.  GET→view, POST/PATCH→edit,
// DELETE→manage.  An "edit" member can create + update but never delete.
// ===========================================================================
describe('RBAC — CRUD tiers (none/view/edit/manage)', () => {
  it('edit can create + update but NOT delete; view blocks writes; owner deletes', async () => {
    const owner = (await signupAgency()).agent;
    const editor = await createMemberSession(owner, {
      permissions: { documents: 'edit' },
    });
    const viewer = await createMemberSession(owner, {
      permissions: { documents: 'view' },
    });

    // Editor: CREATE (POST) ok.
    const create = await editor.agent
      .post(`${BASE}/documents`)
      .send(RAW_DOC('Brief.pdf'));
    expect(create.status).toBe(201);
    const docId = data(create).id as string;

    // Editor: UPDATE (PATCH) ok.
    const patch = await editor.agent
      .patch(`${BASE}/documents/${docId}`)
      .send({ name: 'Brief v2.pdf' });
    expect(patch.status).toBe(200);

    // Editor: DELETE blocked (needs manage).
    const del = await editor.agent.delete(`${BASE}/documents/${docId}`);
    expect(del.status).toBe(403);

    // Viewer: READ ok, CREATE blocked.
    expect((await viewer.agent.get(`${BASE}/documents`)).status).toBe(200);
    const vCreate = await viewer.agent
      .post(`${BASE}/documents`)
      .send(RAW_DOC('nope.pdf'));
    expect(vCreate.status).toBe(403);

    // Owner (full): DELETE ok.
    expect((await owner.delete(`${BASE}/documents/${docId}`)).status).toBe(200);
  });

  it('GET /auth/me surfaces the resolved tier (including edit) for UI gating', async () => {
    const owner = (await signupAgency()).agent;
    const m = await createMemberSession(owner, {
      permissions: { projects: 'edit', finance: 'none' },
    });
    const me = await m.agent.get(`${BASE}/auth/me`);
    expect(data(me).permissions.projects).toBe('edit');
    expect(data(me).permissions.finance).toBe('none');
  });
});

// ===========================================================================
// Predefined role presets (Manager / Employee / Accountant).
// ===========================================================================
describe('RBAC — predefined role presets', () => {
  it('GET /agency/roles exposes the presets with their maps', async () => {
    const owner = (await signupAgency()).agent;
    const res = await owner.get(`${BASE}/agency/roles`);
    expect(res.status).toBe(200);
    const presets = data(res).presets as Array<{
      key: string;
      permissions: Record<string, string>;
    }>;
    expect(presets.map((p) => p.key).sort()).toEqual(['employee', 'manager']);
    expect(presets.find((p) => p.key === 'manager')!.permissions.finance).toBe(
      'view',
    );
    expect(presets.find((p) => p.key === 'employee')!.permissions.projects).toBe(
      'edit',
    );
  });

  it('applying the Manager preset enforces its map on the assigned member', async () => {
    const owner = (await signupAgency()).agent;
    const manager = (
      data(await owner.get(`${BASE}/agency/roles`)).presets as any[]
    ).find((p) => p.key === 'manager');

    // Apply preset → create a custom role.
    const created = await owner.post(`${BASE}/agency/custom-roles`).send({
      name: manager.name,
      baseRole: manager.baseRole,
      colorToken: manager.colorToken,
      permissions: manager.permissions,
    });
    expect(created.status).toBe(201);
    expect(data(created).permissions.finance).toBe('view');
    const customRoleId = data(created).id as string;

    // Assign to a member.
    const m = await createMemberSession(owner);
    const assign = await owner
      .patch(`${BASE}/team/${m.user.id}`)
      .send({ customRoleId });
    expect(assign.status).toBe(200);

    // Manager can VIEW finance…
    expect((await m.agent.get(`${BASE}/finance/overview`)).status).toBe(200);
    // …but cannot WRITE finance (view < edit) — the module gate blocks the POST.
    const exp = await m.agent
      .post(`${BASE}/expenses`)
      .send({ amountCents: 1000, category: 'misc', incurredOn: '2026-07-01' });
    expect(exp.status).toBe(403);
  });
});

// ===========================================================================
// Client portal roles: approver (Client Admin) vs reviewer (Client Employee).
// ===========================================================================
describe('RBAC — client portal roles', () => {
  async function setup(owner: Agent, portalRole: 'approver' | 'reviewer') {
    const c = await owner
      .post(`${BASE}/clients`)
      .send({ name: 'Portal Client', contactEmail: 'p@c.test', portalRole });
    expect(c.status).toBe(201);
    expect(data(c).portalRole).toBe(portalRole);
    const clientId = data(c).id as string;

    const create = await owner
      .post(`${BASE}/clients/${clientId}/posts`)
      .send({ postType: 'post' });
    const postId = data(create).id as string;
    await owner
      .post(`${BASE}/clients/${clientId}/posts/${postId}/transition`)
      .send({ to: 'pending_approval' });

    const tok = await owner
      .post(`${BASE}/clients/${clientId}/portal-tokens`)
      .send({});
    return { clientId, postId, token: data(tok).token as string };
  }

  it('reviewer cannot approve (canApprove=false + 403) but can request changes; approver can approve', async () => {
    const owner = (await signupAgency()).agent;

    // Reviewer (Client Employee).
    const r = await setup(owner, 'reviewer');
    const rResolve = await portal(r.token).get('/resolve');
    expect(data(rResolve).portal.canApprove).toBe(false);
    expect(data(rResolve).portal.portalRole).toBe('reviewer');

    const rApprove = await portal(r.token)
      .post(`/posts/${r.postId}/decision`)
      .send({ decision: 'approved' });
    expect(rApprove.status).toBe(403);

    const rChanges = await portal(r.token)
      .post(`/posts/${r.postId}/decision`)
      .send({ decision: 'changes_requested' });
    expect(rChanges.status).toBe(200);

    // Approver (Client Admin) — default.
    const a = await setup(owner, 'approver');
    const aResolve = await portal(a.token).get('/resolve');
    expect(data(aResolve).portal.canApprove).toBe(true);

    const aApprove = await portal(a.token)
      .post(`/posts/${a.postId}/decision`)
      .send({ decision: 'approved' });
    expect(aApprove.status).toBe(200);
  });
});
