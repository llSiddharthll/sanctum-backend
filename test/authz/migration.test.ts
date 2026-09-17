import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  agencies,
  clients,
  customRoles,
  portalTokens,
  roles,
  userRoles,
  users,
  clientUserProjects,
  projects,
} from '../../src/db/schema.js';
import { newId } from '../../src/lib/ids.js';
import { migrateAgency } from '../../src/authz/migrate-legacy.js';
import { grantsForUser } from '../../src/authz/resolver.js';

/**
 * Seeds an agency the way the LEGACY model stored it (users.role,
 * users.permissions_json, custom_roles, agencies.role_permissions_json,
 * clients.portal_role, portal tokens without expiry) and verifies the backfill
 * preserves effective access — plus the intentional security fixes.
 */
describe('legacy RBAC → roles/grants migration', () => {
  const agencyId = newId('agc');
  const ids = {
    owner: newId('usr'),
    admin: newId('usr'),
    member: newId('usr'),
    viewer: newId('usr'),
    custom: newId('usr'),
    adminCustom: newId('usr'),
    client: newId('usr'),
    clientScoped: newId('usr'),
    portalSynthetic: newId('usr'),
  };
  const approverBrand = newId('cli');
  const reviewerBrand = newId('cli');
  const crManager = newId('crl');
  const crAdmin = newId('crl');
  const tokenId = newId('ptk');
  const projectId = newId('prj');

  const grants = async (userId: string) => {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    return grantsForUser({ id: u!.id, kind: u!.kind, authzVersion: u!.authzVersion });
  };

  beforeAll(async () => {
    await db.insert(agencies).values({
      id: agencyId,
      name: 'Legacy Co',
      slug: `legacy-${agencyId}`,
      // Agency restricted members' clients module to view.
      rolePermissionsJson: JSON.stringify({ member: { clients: 'view' }, admin: { settings: 'view' } }),
    });
    await db.insert(clients).values([
      { id: approverBrand, agencyId, name: 'Approver Brand', portalRole: 'approver' },
      { id: reviewerBrand, agencyId, name: 'Reviewer Brand', portalRole: 'reviewer' },
    ]);
    await db.insert(projects).values({ id: projectId, agencyId, clientId: approverBrand, name: 'P' });
    await db.insert(customRoles).values([
      { id: crManager, agencyId, name: 'Manager', baseRole: 'member', permissionsJson: JSON.stringify({ projects: 'manage', team: 'view', finance: 'manage' }) },
      { id: crAdmin, agencyId, name: 'Ops Admin', baseRole: 'admin', permissionsJson: JSON.stringify({ documents: 'view' }) },
    ]);
    const base = { agencyId, passwordHash: 'x', status: 'active' as const };
    await db.insert(users).values([
      { ...base, id: ids.owner, email: `o-${agencyId}@t.local`, role: 'owner' },
      { ...base, id: ids.admin, email: `a-${agencyId}@t.local`, role: 'admin' },
      { ...base, id: ids.member, email: `m-${agencyId}@t.local`, role: 'member' },
      { ...base, id: ids.viewer, email: `v-${agencyId}@t.local`, role: 'member', permissionsJson: JSON.stringify({ projects: 'view', attendance: 'none' }) },
      { ...base, id: ids.custom, email: `c-${agencyId}@t.local`, role: 'member', customRoleId: crManager },
      { ...base, id: ids.adminCustom, email: `ac-${agencyId}@t.local`, role: 'admin', customRoleId: crAdmin },
      { ...base, id: ids.client, email: `cl-${agencyId}@t.local`, role: 'client', clientId: reviewerBrand },
      { ...base, id: ids.clientScoped, email: `cs-${agencyId}@t.local`, role: 'client', clientId: approverBrand },
      { ...base, id: ids.portalSynthetic, email: `portal.${approverBrand}@portal.sanctum`, role: 'client', clientId: approverBrand },
    ]);
    await db.insert(clientUserProjects).values({ id: newId('cup'), agencyId, userId: ids.clientScoped, projectId });
    await db.insert(portalTokens).values({ id: tokenId, agencyId, clientId: reviewerBrand, tokenHash: `h-${tokenId}` });

    await migrateAgency(agencyId);
  });

  it('marks the agency migrated and is idempotent', async () => {
    const [a] = await db.select().from(agencies).where(eq(agencies.id, agencyId));
    expect(a!.authzMigratedAt).toBeTruthy();
    const before = await db.select().from(roles).where(eq(roles.agencyId, agencyId));
    await migrateAgency(agencyId);
    const after = await db.select().from(roles).where(eq(roles.agencyId, agencyId));
    expect(after.length).toBe(before.length);
  });

  it('owner → Owner role with everything', async () => {
    const gs = await grants(ids.owner);
    expect(gs.has('invoices.view')).toBe(true);
    expect(gs.has('roles.update')).toBe(true);
  });

  it('admin keeps admin powers per agency defaults, never finance/business', async () => {
    const gs = await grants(ids.admin);
    expect(gs.has('users.invite')).toBe(true);
    expect(gs.has('roles.view')).toBe(true); // settings: view
    expect(gs.has('roles.update')).toBe(false); // settings was only view
    expect(gs.has('invoices.view')).toBe(false);
  });

  it('members become Employees (no separate Member role); agency member defaults shape the Employee role', async () => {
    const gs = await grants(ids.member);
    expect(gs.has('clients.view')).toBe(true);
    expect(gs.has('clients.update')).toBe(false); // agency default clients: view
    expect(gs.has('tasks.create')).toBe(true); // Employee baseline
    expect(gs.has('projects.delete')).toBe(false); // Employee baseline, not legacy "manage everything"
    expect(gs.has('users.invite')).toBe(false);
    const roleRows = await db
      .select({ key: roles.key, name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, ids.member));
    expect(roleRows).toEqual([{ key: 'employee', name: 'Employee' }]);
    const memberRoles = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, 'Member'));
    expect(memberRoles).toEqual([]);
  });

  it('per-user overrides are preserved as exceptions, including the security fix for view-level tasks', async () => {
    const gs = await grants(ids.viewer);
    expect(gs.has('projects.view')).toBe(true);
    expect(gs.has('projects.update')).toBe(false);
    expect(gs.scopes('tasks.update').sort()).toEqual(['assigned', 'own']);
    expect(gs.has('attendance.check_in')).toBe(false); // explicit attendance: none
    expect(gs.has('clients.view')).toBe(true); // agency member defaults
  });

  it('custom roles become custom roles; finance never leaks through them', async () => {
    const gs = await grants(ids.custom);
    expect(gs.has('projects.delete')).toBe(true);
    expect(gs.has('users.view')).toBe(true);
    expect(gs.has('users.invite')).toBe(false);
    expect(gs.has('invoices.view')).toBe(false);
    const adminish = await grants(ids.adminCustom);
    expect(adminish.has('users.invite')).toBe(true); // baseRole admin privileges
    expect(adminish.has('documents.upload')).toBe(false); // documents: view
  });

  it('client users get client roles by brand portal role and keep project scoping', async () => {
    const reviewer = await grants(ids.client);
    expect(reviewer.has('posts.approve')).toBe(false);
    expect(reviewer.has('posts.view')).toBe(true);
    const approver = await grants(ids.clientScoped);
    expect(approver.has('posts.approve')).toBe(true);
    const [scoped] = await db.select().from(users).where(eq(users.id, ids.clientScoped));
    expect(scoped!.kind).toBe('client');
    expect(scoped!.clientProjectAccess).toBe('selected');
  });

  it('synthetic share-link users are disabled; tokens get a role and an expiry', async () => {
    const [synthetic] = await db.select().from(users).where(eq(users.id, ids.portalSynthetic));
    expect(synthetic!.status).toBe('disabled');
    const [t] = await db.select().from(portalTokens).where(eq(portalTokens.id, tokenId));
    expect(t!.expiresAt).toBeTruthy();
    const [role] = await db.select().from(roles).where(eq(roles.id, t!.roleId!));
    expect(role!.key).toBe('share_link_reviewer');
  });
});
