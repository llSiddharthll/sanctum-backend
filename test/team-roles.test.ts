import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  signupAgency,
  createMemberSession,
  data,
  uniqueEmail,
  type Agent,
} from './helpers';

// ============================================================
//  TEAM (users) module — list / invite / detail / patch / delete
// ============================================================
describe('team workflow', () => {
  let owner: Agent;
  let ownerId: string;

  beforeAll(async () => {
    const s = await signupAgency();
    owner = s.agent;
    ownerId = s.user.id;
  });

  it('owner invites a member → 201; member appears in GET /team', async () => {
    const email = uniqueEmail('member');
    const invite = await owner
      .post(`${BASE}/team/invite`)
      .send({ fullName: 'Invited Member', email, role: 'member' });
    expect(invite.status).toBe(201);
    // created(res, { member, inviteUrl }) → both live inside `data`.
    expect(data(invite).member.email).toBe(email.toLowerCase());
    expect(data(invite).member.role).toBe('member');
    expect(data(invite).inviteUrl).toContain('/accept-invite?token=');

    const memberId = data(invite).member.id;
    const list = await owner.get(`${BASE}/team`);
    expect(list.status).toBe(200);
    expect(data(list).some((m: any) => m.id === memberId)).toBe(true);
    // The owner (created at signup) is always present in the roster too.
    expect(data(list).some((m: any) => m.id === ownerId && m.role === 'owner')).toBe(
      true,
    );
  });

  it('GET /team/:id returns a member detail with effective permissions', async () => {
    const { user } = await createMemberSession(owner, { role: 'member' });
    const detail = await owner.get(`${BASE}/team/${user.id}`);
    expect(detail.status).toBe(200);
    expect(data(detail).id).toBe(user.id);
    // Default level is `manage` for every module when nothing is stored.
    expect(data(detail).permissions.clients).toBe('manage');
    expect(Array.isArray(data(detail).projects)).toBe(true);
    expect(Array.isArray(data(detail).timeLogs)).toBe(true);
  });

  it('a plain member CANNOT invite (403); an admin CAN', async () => {
    const { agent: memberAgent } = await createMemberSession(owner, {
      role: 'member',
    });
    const memberInvite = await memberAgent
      .post(`${BASE}/team/invite`)
      .send({ fullName: 'Nope', email: uniqueEmail('nope'), role: 'member' });
    expect(memberInvite.status).toBe(403);

    const { agent: adminAgent } = await createMemberSession(owner, {
      role: 'admin',
    });
    const adminInvite = await adminAgent
      .post(`${BASE}/team/invite`)
      .send({ fullName: 'Yes', email: uniqueEmail('yes'), role: 'member' });
    expect(adminInvite.status).toBe(201);
  });

  it('owner promotes a member member→admin; the change takes', async () => {
    const { user } = await createMemberSession(owner, { role: 'member' });
    const patch = await owner
      .patch(`${BASE}/team/${user.id}`)
      .send({ role: 'admin' });
    expect(patch.status).toBe(200);
    expect(data(patch).updated).toBe(true);

    const detail = await owner.get(`${BASE}/team/${user.id}`);
    expect(data(detail).role).toBe('admin');
  });

  it('owner can delete a member', async () => {
    const { user } = await createMemberSession(owner, { role: 'member' });
    const del = await owner.delete(`${BASE}/team/${user.id}`);
    expect(del.status).toBe(200);
    expect(data(del).deleted).toBe(true);

    const detail = await owner.get(`${BASE}/team/${user.id}`);
    expect(detail.status).toBe(404);
  });

  it('rejects an invite with a bad email (422)', async () => {
    const res = await owner
      .post(`${BASE}/team/invite`)
      .send({ fullName: 'Bad Email', email: 'not-an-email', role: 'member' });
    expect(res.status).toBe(422);
  });

  it('rejects an invite missing required fields (422)', async () => {
    const res = await owner
      .post(`${BASE}/team/invite`)
      .send({ email: uniqueEmail('nofields') }); // no fullName
    expect(res.status).toBe(422);
  });

  it('rejects a duplicate-email invite (409)', async () => {
    const email = uniqueEmail('dupe');
    const first = await owner
      .post(`${BASE}/team/invite`)
      .send({ fullName: 'First', email, role: 'member' });
    expect(first.status).toBe(201);
    const second = await owner
      .post(`${BASE}/team/invite`)
      .send({ fullName: 'Second', email, role: 'member' });
    expect(second.status).toBe(409);
  });
});

// ============================================================
//  PER-USER MODULE PERMISSION OVERRIDES
// ============================================================
describe('per-user permission overrides', () => {
  let owner: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  it('owner sets {finance:"none"} on a member → member is denied the Finance module', async () => {
    const { agent, user } = await createMemberSession(owner, { role: 'member' });
    // Baseline: with default `manage`, finance is reachable.
    const before = await agent.get(`${BASE}/finance/overview`);
    expect(before.status).toBe(200);

    const patch = await owner
      .patch(`${BASE}/team/${user.id}`)
      .send({ permissions: { finance: 'none' } });
    expect(patch.status).toBe(200);

    // The override is now reflected in the member detail...
    const detail = await owner.get(`${BASE}/team/${user.id}`);
    expect(data(detail).permissions.finance).toBe('none');

    // ...and the member is blocked at the module gate.
    const after = await agent.get(`${BASE}/finance/overview`);
    expect(after.status).toBe(403);
  });

  it('an invite-time {clients:"view"} override makes the module read-only', async () => {
    const { agent } = await createMemberSession(owner, {
      role: 'member',
      permissions: { clients: 'view' },
    });
    const read = await agent.get(`${BASE}/clients`);
    expect(read.status).toBe(200);
    const write = await agent.post(`${BASE}/clients`).send({ name: 'Blocked' });
    expect(write.status).toBe(403);
  });
});

// ============================================================
//  CUSTOM ROLES
// ============================================================
describe('custom roles', () => {
  let owner: Agent;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  it('owner creates a custom role → 201 and it lists', async () => {
    const create = await owner.post(`${BASE}/agency/custom-roles`).send({
      name: `Editor ${uniqueEmail('r')}`,
      baseRole: 'member',
      permissions: { clients: 'view', finance: 'none' },
    });
    expect(create.status).toBe(201);
    const role = data(create);
    expect(role.id).toMatch(/^crl_/);
    expect(role.baseRole).toBe('member');
    // serializeCustomRole returns the FULL effective map (preset over base tier).
    expect(role.permissions.clients).toBe('view');
    expect(role.permissions.finance).toBe('none');
    expect(role.permissions.projects).toBe('manage'); // untouched → default

    const list = await owner.get(`${BASE}/agency/custom-roles`);
    expect(list.status).toBe(200);
    expect(data(list).some((r: any) => r.id === role.id)).toBe(true);
  });

  it("assigning a custom role drives a member's effective permissions and CLEARS per-user overrides", async () => {
    // A member that starts with a personal override on `clients`.
    const { user } = await createMemberSession(owner, {
      role: 'member',
      permissions: { clients: 'manage' },
    });

    const roleRes = await owner.post(`${BASE}/agency/custom-roles`).send({
      name: `Locked ${uniqueEmail('lr')}`,
      baseRole: 'member',
      permissions: { clients: 'none', finance: 'view' },
    });
    const customRoleId = data(roleRes).id;

    const assign = await owner
      .patch(`${BASE}/team/${user.id}`)
      .send({ customRoleId });
    expect(assign.status).toBe(200);

    const detail = await owner.get(`${BASE}/team/${user.id}`);
    expect(data(detail).customRoleId).toBe(customRoleId);
    // The role's preset now drives the effective map...
    expect(data(detail).permissions.clients).toBe('none');
    expect(data(detail).permissions.finance).toBe('view');
    // ...and the prior personal override on `clients` was cleared (no longer
    // wins over the custom role). If the override had persisted it would read
    // 'manage'.
    expect(data(detail).permissions.clients).not.toBe('manage');
  });

  it('clearing customRoleId (null) reverts a member to their base tier', async () => {
    const { user } = await createMemberSession(owner, { role: 'member' });
    const roleRes = await owner.post(`${BASE}/agency/custom-roles`).send({
      name: `Temp ${uniqueEmail('tr')}`,
      baseRole: 'admin',
      permissions: { settings: 'view' },
    });
    const customRoleId = data(roleRes).id;

    // Assigning an admin-based custom role re-tiers the user to admin.
    await owner.patch(`${BASE}/team/${user.id}`).send({ customRoleId });
    let detail = await owner.get(`${BASE}/team/${user.id}`);
    expect(data(detail).role).toBe('admin');
    expect(data(detail).customRoleId).toBe(customRoleId);

    // Clearing it: the handler keeps role unless a new role is supplied.
    const clear = await owner
      .patch(`${BASE}/team/${user.id}`)
      .send({ customRoleId: null, role: 'member' });
    expect(clear.status).toBe(200);
    detail = await owner.get(`${BASE}/team/${user.id}`);
    expect(data(detail).customRoleId).toBeNull();
    expect(data(detail).role).toBe('member');
  });

  it('a member CANNOT manage custom roles (settings:manage gate, 403)', async () => {
    const { agent } = await createMemberSession(owner, {
      role: 'member',
      permissions: { settings: 'none' },
    });
    const res = await agent.post(`${BASE}/agency/custom-roles`).send({
      name: 'Hacker Role',
      baseRole: 'member',
    });
    expect(res.status).toBe(403);
  });
});

// ============================================================
//  ROLE DEFAULTS MATRIX (GET/PUT /agency/roles)
// ============================================================
describe('role defaults matrix', () => {
  it('GET /agency/roles returns the module catalog + per-role matrix', async () => {
    const owner = (await signupAgency()).agent;
    const res = await owner.get(`${BASE}/agency/roles`);
    expect(res.status).toBe(200);
    const body = data(res);
    expect(Array.isArray(body.modules)).toBe(true);
    expect(body.modules.some((m: any) => m.key === 'finance')).toBe(true);
    // Owner is always full access and not editable.
    expect(body.roles.owner.finance).toBe('manage');
    // Fresh agency: members default to `manage` everywhere.
    expect(body.roles.member.finance).toBe('manage');
  });

  it('PUT a member role default → a member with that role inherits it', async () => {
    const owner = (await signupAgency()).agent;
    // Dial the member default for `finance` down to `none` agency-wide.
    const put = await owner
      .put(`${BASE}/agency/roles`)
      .send({ member: { finance: 'none' } });
    expect(put.status).toBe(200);
    expect(data(put).roles.member.finance).toBe('none');

    // A member invited AFTER the default change inherits it (no personal override).
    const { agent, user } = await createMemberSession(owner, { role: 'member' });
    const detail = await owner.get(`${BASE}/team/${user.id}`);
    expect(data(detail).permissions.finance).toBe('none');

    // And it is enforced at the module gate.
    const blocked = await agent.get(`${BASE}/finance/overview`);
    expect(blocked.status).toBe(403);
  });
});

// ============================================================
//  OWNER IMMUTABILITY
// ============================================================
describe('owner immutability', () => {
  it('rejects downgrading the owner role (409)', async () => {
    const { agent: owner, user } = await signupAgency();
    const res = await owner
      .patch(`${BASE}/team/${user.id}`)
      .send({ role: 'member' });
    expect(res.status).toBe(409);
  });

  it('rejects disabling the owner (409)', async () => {
    const { agent: owner, user } = await signupAgency();
    const res = await owner
      .patch(`${BASE}/team/${user.id}`)
      .send({ status: 'disabled' });
    expect(res.status).toBe(409);
  });

  it('rejects deleting the owner (409)', async () => {
    const { agent: owner, user } = await signupAgency();
    const res = await owner.delete(`${BASE}/team/${user.id}`);
    expect(res.status).toBe(409);
  });
});

// ============================================================
//  USAGE
// ============================================================
describe('agency usage', () => {
  it('GET /agency/usage returns plan limits + counts', async () => {
    const owner = (await signupAgency()).agent;
    const res = await owner.get(`${BASE}/agency/usage`);
    expect(res.status).toBe(200);
    const body = data(res);
    expect(body).toHaveProperty('period');
    expect(body.ai).toHaveProperty('used');
    expect(body.ai).toHaveProperty('limit');
    expect(body.storage).toHaveProperty('usedBytes');
    expect(body.clients).toHaveProperty('used');
    // The owner counts as one team member on a fresh agency.
    expect(body.team.used).toBeGreaterThanOrEqual(1);
    expect(body.rateLimits).toHaveProperty('global');
  });

  it('a member is denied /agency/usage (owner/admin only, 403)', async () => {
    const owner = (await signupAgency()).agent;
    const { agent } = await createMemberSession(owner, { role: 'member' });
    const res = await agent.get(`${BASE}/agency/usage`);
    expect(res.status).toBe(403);
  });
});

// ============================================================
//  TENANT ISOLATION
// ============================================================
describe('tenant isolation', () => {
  it("agency B cannot GET or PATCH agency A's member", async () => {
    const a = (await signupAgency()).agent;
    const { user: aMember } = await createMemberSession(a, { role: 'member' });

    const b = (await signupAgency()).agent;

    const view = await b.get(`${BASE}/team/${aMember.id}`);
    expect([403, 404]).toContain(view.status);

    const patch = await b
      .patch(`${BASE}/team/${aMember.id}`)
      .send({ role: 'admin' });
    expect([403, 404]).toContain(patch.status);

    const del = await b.delete(`${BASE}/team/${aMember.id}`);
    expect([403, 404]).toContain(del.status);
  });

  it("agency B cannot assign agency A's custom role to its own member", async () => {
    const a = (await signupAgency()).agent;
    const aRole = await a.post(`${BASE}/agency/custom-roles`).send({
      name: `A-Role ${uniqueEmail('ar')}`,
      baseRole: 'member',
    });
    const aRoleId = data(aRole).id;

    const b = (await signupAgency()).agent;
    const { user: bMember } = await createMemberSession(b, { role: 'member' });
    const res = await b
      .patch(`${BASE}/team/${bMember.id}`)
      .send({ customRoleId: aRoleId });
    // The custom role belongs to agency A → not found for B.
    expect([403, 404]).toContain(res.status);
  });
});
