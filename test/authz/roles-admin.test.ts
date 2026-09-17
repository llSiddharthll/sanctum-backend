import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  createMemberSession,
  createRole,
  data,
  signupAgency,
  systemRoleIdFor,
  uniqueEmail,
  type Agent,
} from '../helpers';
import type { Grant } from '../../src/authz/catalog.js';

const g = (permission: string, scope: Grant['scope'] = 'organization'): Grant => ({ permission, scope });

/** Grants for a "team admin": can invite, assign roles, manage exceptions, view roles. */
const TEAM_ADMIN: Grant[] = [
  g('organization.view'),
  g('users.view'),
  g('users.invite'),
  g('users.update'),
  g('users.disable'),
  g('users.delete'),
  g('users.assign_roles'),
  g('users.manage_permissions'),
  g('users.reset_password'),
  g('users.revoke_sessions'),
  g('roles.view'),
  g('roles.create'),
  g('roles.update'),
  g('roles.archive'),
  g('projects.view'),
];

describe('team: invite & roles', () => {
  let owner: Agent;
  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  it('new invites default to the Employee role and appear with roles', async () => {
    const email = uniqueEmail('emp');
    const res = await owner.post(`${BASE}/team/invite`).send({ fullName: 'Emp', email });
    expect(res.status).toBe(201);
    expect(data(res).inviteUrl).toContain('/accept-invite?token=');
    expect(data(res).member.roles.map((r: any) => r.key)).toEqual(['employee']);
    const list = await owner.get(`${BASE}/team`);
    expect(data(list).some((m: any) => m.email === email)).toBe(true);
  });

  it('validates invites (422) and duplicates (409)', async () => {
    expect((await owner.post(`${BASE}/team/invite`).send({ fullName: 'X', email: 'bad' })).status).toBe(422);
    const email = uniqueEmail('dup');
    await owner.post(`${BASE}/team/invite`).send({ fullName: 'A', email });
    expect((await owner.post(`${BASE}/team/invite`).send({ fullName: 'B', email })).status).toBe(409);
  });

  it('an Employee cannot invite; a team admin can but only within their ceiling', async () => {
    const employee = await createMemberSession(owner, { roleIds: [await systemRoleIdFor(owner, 'employee')] });
    expect((await employee.agent.post(`${BASE}/team/invite`).send({ fullName: 'N', email: uniqueEmail() })).status).toBe(403);

    const admin = await createMemberSession(owner, { grants: TEAM_ADMIN });
    // Employee role holds permissions the team admin lacks (e.g. tasks.create) → ceiling blocks it.
    const employeeRole = await systemRoleIdFor(owner, 'employee');
    const blocked = await admin.agent.post(`${BASE}/team/invite`).send({ fullName: 'N', email: uniqueEmail(), roleIds: [employeeRole] });
    expect(blocked.status).toBe(403);
    // A role inside the admin's grants is fine.
    const smallRole = await createRole(owner, [g('projects.view'), g('organization.view')]);
    const okInvite = await admin.agent.post(`${BASE}/team/invite`).send({ fullName: 'N', email: uniqueEmail(), roleIds: [smallRole] });
    expect(okInvite.status).toBe(201);
  });

  it('nobody but an owner can grant the Owner role', async () => {
    const admin = await createMemberSession(owner, { grants: TEAM_ADMIN });
    const target = await createMemberSession(owner, { grants: [g('projects.view')] });
    const ownerRole = await systemRoleIdFor(owner, 'owner');
    expect((await admin.agent.put(`${BASE}/team/${target.user.id}/roles`).send({ roleIds: [ownerRole] })).status).toBe(403);
    const byOwner = await owner.put(`${BASE}/team/${target.user.id}/roles`).send({ roleIds: [ownerRole] });
    expect(byOwner.status).toBe(200);
  });
});

describe('privilege escalation', () => {
  let owner: Agent;
  let ownerId: string;
  let admin: Awaited<ReturnType<typeof createMemberSession>>;
  beforeAll(async () => {
    const s = await signupAgency();
    owner = s.agent;
    ownerId = s.user.id;
    admin = await createMemberSession(owner, { grants: TEAM_ADMIN });
  });

  it('cannot create a role with permissions the creator lacks', async () => {
    const res = await admin.agent.post(`${BASE}/roles`).send({
      name: 'Sneaky',
      grants: [g('invoices.view'), g('users.view')],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.details.missing).toContain('invoices.view:organization');
  });

  it('cannot broaden scope beyond what is held', async () => {
    const scoped = await createMemberSession(owner, {
      grants: [g('roles.view'), g('roles.create'), g('tasks.view', 'own'), g('tasks.update', 'own')],
    });
    const res = await scoped.agent.post(`${BASE}/roles`).send({
      name: 'Broad',
      grants: [g('tasks.view'), g('tasks.update')],
    });
    expect(res.status).toBe(403);
  });

  it('cannot edit a role they hold (no self-escalation through own role)', async () => {
    const roleId = await createRole(owner, TEAM_ADMIN, { name: `Held ${Date.now()}` });
    const holder = await createMemberSession(owner, { roleIds: [roleId] });
    const res = await holder.agent.patch(`${BASE}/roles/${roleId}`).send({ grants: TEAM_ADMIN.slice(0, 3) });
    expect(res.status).toBe(403);
  });

  it('cannot change their own roles or exceptions', async () => {
    const smallRole = await createRole(owner, [g('users.view')]);
    expect((await admin.agent.put(`${BASE}/team/${admin.user.id}/roles`).send({ roleIds: [smallRole] })).status).toBe(403);
    expect(
      (await admin.agent.put(`${BASE}/team/${admin.user.id}/overrides`).send({
        overrides: [{ permission: 'invoices.view', scope: 'organization', effect: 'grant' }],
      })).status,
    ).toBe(403);
  });

  it('cannot manage a peer with equal authority, nor the owner', async () => {
    const peer = await createMemberSession(owner, { grants: TEAM_ADMIN });
    expect((await admin.agent.patch(`${BASE}/team/${peer.user.id}`).send({ status: 'disabled' })).status).toBe(403);
    expect((await admin.agent.post(`${BASE}/team/${peer.user.id}/reset-password`)).status).toBe(403);
    expect((await admin.agent.delete(`${BASE}/team/${ownerId}`)).status).toBe(403);
  });

  it('cannot grant an exception above their ceiling to a manageable member', async () => {
    const junior = await createMemberSession(owner, { grants: [g('projects.view')] });
    const res = await admin.agent.put(`${BASE}/team/${junior.user.id}/overrides`).send({
      overrides: [{ permission: 'finance.view_overview', scope: 'organization', effect: 'grant' }],
    });
    expect(res.status).toBe(403);
    const ok = await admin.agent.put(`${BASE}/team/${junior.user.id}/overrides`).send({
      overrides: [{ permission: 'users.view', scope: 'organization', effect: 'grant' }],
    });
    expect(ok.status).toBe(200);
  });

  it('client roles cannot be assigned to staff (actor type separation)', async () => {
    const clientRole = await systemRoleIdFor(owner, 'client_approver');
    const junior = await createMemberSession(owner, { grants: [g('projects.view')] });
    expect((await owner.put(`${BASE}/team/${junior.user.id}/roles`).send({ roleIds: [clientRole] })).status).toBe(400);
  });

  it('owners manage owners; nobody changes their own roles; an owner always remains', async () => {
    const s = await signupAgency();
    const ownerRole = await systemRoleIdFor(s.agent, 'owner');
    const employeeRole = await systemRoleIdFor(s.agent, 'employee');
    const co = await createMemberSession(s.agent, { roleIds: [ownerRole] });
    // A co-owner may demote the original owner while another owner remains.
    expect((await co.agent.put(`${BASE}/team/${s.user.id}/roles`).send({ roleIds: [employeeRole] })).status).toBe(200);
    // The remaining owner cannot demote themselves (self-change) — so the last owner can't vanish.
    expect((await co.agent.put(`${BASE}/team/${co.user.id}/roles`).send({ roleIds: [employeeRole] })).status).toBe(403);
    expect((await co.agent.patch(`${BASE}/team/${co.user.id}`).send({ status: 'disabled' })).status).toBe(403);
    // The demoted user lost owner powers immediately.
    expect((await s.agent.get(`${BASE}/roles`)).status).toBe(403);
  });
});

describe('roles API', () => {
  let owner: Agent;
  beforeAll(async () => {
    owner = (await signupAgency()).agent;
  });

  it('lists system roles; owner role is locked and cannot be edited or archived', async () => {
    const list = data(await owner.get(`${BASE}/roles`));
    const keys = list.map((r: any) => r.key);
    for (const k of ['owner', 'admin', 'employee', 'client_approver', 'client_reviewer', 'share_link', 'share_link_reviewer']) {
      expect(keys).toContain(k);
    }
    const ownerRole = list.find((r: any) => r.key === 'owner');
    expect(ownerRole.isLocked).toBe(true);
    expect((await owner.patch(`${BASE}/roles/${ownerRole.id}`).send({ grants: [] })).status).toBe(403);
    expect((await owner.post(`${BASE}/roles/${ownerRole.id}/archive`)).status).toBe(403);
  });

  it('creates from a template, clones, validates requirements, archives and restores', async () => {
    const fromTemplate = await owner.post(`${BASE}/roles`).send({ name: 'Books', templateKey: 'accountant' });
    expect(fromTemplate.status).toBe(201);
    expect(data(fromTemplate).grants.some((x: any) => x.permission === 'invoices.create')).toBe(true);

    const clone = await owner.post(`${BASE}/roles`).send({ name: 'Books 2', cloneFromRoleId: data(fromTemplate).id });
    expect(clone.status).toBe(201);
    expect(data(clone).grants.length).toBe(data(fromTemplate).grants.length);

    const invalid = await owner.post(`${BASE}/roles`).send({ name: 'Broken', grants: [g('tasks.update', 'project')] });
    expect(invalid.status).toBe(422);

    const dupe = await owner.post(`${BASE}/roles`).send({ name: 'books', grants: [g('projects.view')] });
    expect(dupe.status).toBe(409);

    const holder = await createMemberSession(owner, { roleIds: [data(clone).id] });
    const archived = await owner.post(`${BASE}/roles/${data(clone).id}/archive`);
    expect(archived.status).toBe(200);
    expect(data(archived).affectedUsers).toBe(1);
    // Holder lost the role immediately (next request).
    expect((await holder.agent.get(`${BASE}/invoices`)).status).toBe(403);
    expect((await owner.post(`${BASE}/roles/${data(clone).id}/restore`)).status).toBe(200);
  });

  it('editing a role takes effect for holders on their next request', async () => {
    const roleId = await createRole(owner, [g('organization.view'), g('projects.view')]);
    const holder = await createMemberSession(owner, { roleIds: [roleId] });
    expect((await holder.agent.get(`${BASE}/projects`)).status).toBe(200);
    const edit = await owner.patch(`${BASE}/roles/${roleId}`).send({ grants: [g('organization.view')] });
    expect(edit.status).toBe(200);
    expect((await holder.agent.get(`${BASE}/projects`)).status).toBe(403);
    const me = data(await holder.agent.get(`${BASE}/auth/me`));
    expect(me.authorization.grants['projects.view']).toBeUndefined();
  });

  it('effective permissions explain their source', async () => {
    const roleId = await createRole(owner, [g('projects.view')], { name: `Explained ${Date.now()}` });
    const m = await createMemberSession(owner, { roleIds: [roleId] });
    await owner.put(`${BASE}/team/${m.user.id}/overrides`).send({
      overrides: [
        { permission: 'projects.view', scope: null, effect: 'deny', reason: 'on leave' },
        { permission: 'clients.view', scope: 'organization', effect: 'grant' },
      ],
    });
    const explain = data(await owner.get(`${BASE}/team/${m.user.id}/authorization`));
    expect(explain.grants.some((x: any) => x.permission === 'projects.view')).toBe(false);
    expect(explain.grants.some((x: any) => x.permission === 'clients.view')).toBe(true);
    expect(explain.sources.some((s: any) => s.via === 'deny_override' && s.permission === 'projects.view')).toBe(true);
    expect(explain.sources.some((s: any) => s.via === 'role' && s.roleId === roleId)).toBe(true);
  });

  it('a user without roles.view/create is denied the roles API', async () => {
    const m = await createMemberSession(owner, { grants: [g('projects.view')] });
    expect((await m.agent.get(`${BASE}/roles`)).status).toBe(403);
    expect((await m.agent.post(`${BASE}/roles`).send({ name: 'x', grants: [] })).status).toBe(403);
  });

  it('serves the catalog to authenticated actors', async () => {
    const res = await owner.get(`${BASE}/authz/catalog`);
    expect(res.status).toBe(200);
    expect(data(res).permissions.length).toBeGreaterThan(100);
    expect(data(res).permissions[0]).not.toHaveProperty('legacy');
  });
});

describe('member administration', () => {
  it('disable ends sessions and blocks access; delete keeps the owner invariant', async () => {
    const s = await signupAgency();
    const m = await createMemberSession(s.agent, { grants: [g('projects.view')] });
    expect((await m.agent.get(`${BASE}/projects`)).status).toBe(200);
    expect((await s.agent.patch(`${BASE}/team/${m.user.id}`).send({ status: 'disabled' })).status).toBe(200);
    expect((await m.agent.get(`${BASE}/projects`)).status).toBe(401);
    expect((await s.agent.delete(`${BASE}/team/${s.user.id}`)).status).toBe(403); // self
  });

  it('compensation is hidden and not writable without its permissions', async () => {
    const s = await signupAgency();
    const viewer = await createMemberSession(s.agent, { grants: [g('users.view'), g('users.update')] });
    const target = await createMemberSession(s.agent, { grants: [g('projects.view')] });
    await s.agent.patch(`${BASE}/team/${target.user.id}`).send({ monthlySalaryPaise: 5_000_00 });
    const seen = data(await viewer.agent.get(`${BASE}/team/${target.user.id}`));
    expect(seen.monthlySalaryPaise).toBeNull();
    expect((await viewer.agent.patch(`${BASE}/team/${target.user.id}`).send({ monthlySalaryPaise: 1 })).status).toBe(403);
    expect(data(await s.agent.get(`${BASE}/team/${target.user.id}`)).monthlySalaryPaise).toBe(5_000_00);
  });

  it('admin password reset never returns the link', async () => {
    const s = await signupAgency();
    const m = await createMemberSession(s.agent, { grants: [g('projects.view')] });
    const res = await s.agent.post(`${BASE}/team/${m.user.id}/reset-password`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('token=');
  });

  it('usage and audit log are permission-gated; audit log is newest-first', async () => {
    const s = await signupAgency();
    const m = await createMemberSession(s.agent, { grants: [g('projects.view')] });
    expect((await m.agent.get(`${BASE}/agency/usage`)).status).toBe(403);
    expect((await m.agent.get(`${BASE}/agency/audit-log`)).status).toBe(403);
    expect((await s.agent.get(`${BASE}/agency/usage`)).status).toBe(200);
    const log = data(await s.agent.get(`${BASE}/agency/audit-log`));
    const times = log.map((e: any) => Date.parse(e.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('storage endpoints are platform-only', async () => {
    const s = await signupAgency();
    expect((await s.agent.get(`${BASE}/agency/storage`)).status).toBe(403);
  });
});

describe('tenant isolation (team & roles)', () => {
  it("agency B cannot read/modify agency A's members or use A's roles", async () => {
    const a = await signupAgency();
    const b = await signupAgency();
    const aMember = await createMemberSession(a.agent, { grants: [g('projects.view')] });
    const aRole = await createRole(a.agent, [g('projects.view')]);
    const bMember = await createMemberSession(b.agent, { grants: [g('projects.view')] });

    expect((await b.agent.get(`${BASE}/team/${aMember.user.id}`)).status).toBe(404);
    expect((await b.agent.patch(`${BASE}/team/${aMember.user.id}`).send({ fullName: 'x' })).status).toBe(404);
    expect((await b.agent.get(`${BASE}/roles/${aRole}`)).status).toBe(404);
    expect((await b.agent.put(`${BASE}/team/${bMember.user.id}/roles`).send({ roleIds: [aRole] })).status).toBe(404);
  });
});
