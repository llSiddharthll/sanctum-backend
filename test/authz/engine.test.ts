import { describe, it, expect } from 'vitest';
import {
  CATALOG_VERSION,
  PERMISSIONS,
  ROLE_TEMPLATES,
  SYSTEM_ROLES,
  closeOverRequires,
  fullGrants,
  grantsFromLegacy,
  isValidGrant,
  scopeCovers,
  validateGrantSet,
  type Grant,
} from '../../src/authz/catalog.js';
import { GrantSet, type Actor } from '../../src/authz/actor.js';
import { authorize, can, capabilities, check } from '../../src/authz/engine.js';
import { isManageable, uncovered } from '../../src/authz/admin.js';
import { diffOverrides } from '../../src/authz/migrate-legacy.js';
import { AppError } from '../../src/lib/errors.js';

const AG = 'agc_1';
const staff = (grants: Grant[], userId = 'usr_me'): Actor => ({
  type: 'staff',
  userId,
  agencyId: AG,
  sessionId: 'ses_1',
  authzVersion: 1,
  grants: new GrantSet(grants),
});
const client = (grants: Grant[], projectAccess = { mode: 'all' as const, projectIds: [] as string[] }): Actor => ({
  type: 'client',
  userId: 'usr_client',
  agencyId: AG,
  sessionId: 'ses_2',
  authzVersion: 1,
  clientId: 'cli_1',
  projectAccess,
  grants: new GrantSet(grants),
});
const g = (permission: string, scope: Grant['scope']): Grant => ({ permission, scope });

describe('catalog', () => {
  it('has unique, well-formed permissions with a stable version', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of PERMISSIONS) {
      expect(p.key).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(p.scopes.length).toBeGreaterThan(0);
    }
    expect(CATALOG_VERSION).toMatch(/^[a-z0-9]+$/);
  });

  it('every system role and template is a valid grant set', () => {
    for (const r of SYSTEM_ROLES) expect(validateGrantSet(r.grants(), r.actorType)).toEqual([]);
    for (const t of ROLE_TEMPLATES) expect(validateGrantSet(t.grants, t.actorType)).toEqual([]);
  });

  it('owner role covers every staff permission', () => {
    const owner = new GrantSet(fullGrants('staff'));
    for (const p of PERMISSIONS.filter((x) => x.actors.includes('staff'))) {
      expect(owner.has(p.key)).toBe(true);
    }
  });

  it('rejects unknown permissions, unsupported scopes and cross-actor grants', () => {
    expect(isValidGrant('nope.nope', 'organization')).toBe(false);
    expect(isValidGrant('projects.delete', 'own')).toBe(false);
    expect(validateGrantSet([g('posts.approve', 'organization')], 'staff')).not.toEqual([]);
    expect(validateGrantSet([g('users.invite', 'client')], 'client')).not.toEqual([]);
  });

  it('flags missing requirements and closeOverRequires fixes them', () => {
    const bad = [g('tasks.update', 'project')];
    expect(validateGrantSet(bad, 'staff').some((p) => p.includes('requires'))).toBe(true);
    expect(validateGrantSet(closeOverRequires(bad, 'staff'), 'staff')).toEqual([]);
  });

  it('scope coverage: organization covers staff sub-scopes only', () => {
    expect(scopeCovers('organization', 'own')).toBe(true);
    expect(scopeCovers('organization', 'project')).toBe(true);
    expect(scopeCovers('own', 'organization')).toBe(false);
    expect(scopeCovers('organization', 'client')).toBe(false);
  });

  it('legacy mapping: owners get finance, admins/members never do; view-level users only edit own/assigned tasks', () => {
    const owner = new GrantSet(grantsFromLegacy({ role: 'owner', levels: {} }));
    expect(owner.has('invoices.view')).toBe(true);
    const all = Object.fromEntries(['finance', 'business', 'projects'].map((m) => [m, 'manage']));
    const admin = new GrantSet(grantsFromLegacy({ role: 'admin', levels: { ...all, finance: 'none', business: 'none' } }));
    expect(admin.has('invoices.view')).toBe(false);
    const viewer = new GrantSet(grantsFromLegacy({ role: 'member', levels: { projects: 'view' } }));
    expect(viewer.scopes('tasks.update').sort()).toEqual(['assigned', 'own']);
    expect(viewer.has('projects.delete')).toBe(false);
  });

  it('diffOverrides reproduces the expected grant set exactly', () => {
    const role = [g('tasks.update', 'organization'), g('tasks.view', 'organization'), g('clients.view', 'organization')];
    const expected = [g('tasks.update', 'assigned'), g('tasks.view', 'organization'), g('deals.view', 'organization')];
    const overrides = diffOverrides(role, expected);
    // Apply with resolver precedence: role − denied, then + grants.
    const denied = new Set(overrides.filter((o) => o.effect === 'deny').map((o) => o.permission));
    const result = new Map<string, Grant>();
    for (const r of role) if (!denied.has(r.permission)) result.set(`${r.permission}|${r.scope}`, r);
    for (const o of overrides) if (o.effect === 'grant') result.set(`${o.permission}|${o.scope}`, g(o.permission, o.scope!));
    const sortKeys = (xs: Grant[]) => xs.map((x) => `${x.permission}|${x.scope}`).sort();
    expect(sortKeys([...result.values()])).toEqual(sortKeys(expected));
  });
});

describe('engine.check / authorize', () => {
  const task = { agencyId: AG, ownerIds: ['usr_other'], assigned: false, projectMember: true };

  it('fails closed: unknown permission, no grant, tenant mismatch, missing facts', () => {
    const a = staff([g('tasks.update', 'organization')]);
    expect(check(a, 'tasks.nonsense', task)).toBe(false);
    expect(check(a, 'tasks.delete', task)).toBe(false);
    expect(check(a, 'tasks.update', { ...task, agencyId: 'agc_other' })).toBe(false);
    expect(check(a, 'tasks.update', null)).toBe(false);
    expect(can(a, 'tasks.nonsense')).toBe(false);
  });

  it('evaluates each scope relation', () => {
    expect(check(staff([g('tasks.update', 'own')]), 'tasks.update', task)).toBe(false);
    expect(check(staff([g('tasks.update', 'own')], 'usr_other'), 'tasks.update', task)).toBe(true);
    expect(check(staff([g('tasks.update', 'assigned')]), 'tasks.update', task)).toBe(false);
    expect(check(staff([g('tasks.update', 'assigned')]), 'tasks.update', { ...task, assigned: true })).toBe(true);
    expect(check(staff([g('tasks.update', 'project')]), 'tasks.update', task)).toBe(true);
    expect(check(staff([g('tasks.update', 'project')]), 'tasks.update', { ...task, projectMember: false })).toBe(false);
  });

  it('union of scopes from multiple grants', () => {
    const a = staff([g('tasks.update', 'own'), g('tasks.update', 'assigned')]);
    expect(check(a, 'tasks.update', { ...task, assigned: true })).toBe(true);
  });

  it('client scope: brand, visibility and selected projects (empty = none)', () => {
    const facts = { agencyId: AG, clientId: 'cli_1', projectId: 'prj_1', clientVisible: true };
    expect(check(client([g('documents.view', 'client')]), 'documents.view', facts)).toBe(true);
    expect(check(client([g('documents.view', 'client')]), 'documents.view', { ...facts, clientId: 'cli_2' })).toBe(false);
    expect(check(client([g('documents.view', 'client')]), 'documents.view', { ...facts, clientVisible: false })).toBe(false);
    const selectedNone = client([g('documents.view', 'client')], { mode: 'selected', projectIds: [] });
    expect(check(selectedNone, 'documents.view', facts)).toBe(false);
    expect(check(selectedNone, 'documents.view', { ...facts, projectId: null })).toBe(true);
    // Client actors never satisfy staff scopes.
    expect(check(client([g('documents.view', 'organization')]), 'documents.view', facts)).toBe(false);
  });

  it('authorize: 404 when the object cannot be seen, 403 when it can', () => {
    const viewer = staff([g('tasks.view', 'organization')]);
    const blind = staff([]);
    const tryIt = (a: Actor) => {
      try {
        authorize(a, 'tasks.delete', task, { view: 'tasks.view' });
        return 200;
      } catch (e) {
        return (e as AppError).status;
      }
    };
    expect(tryIt(viewer)).toBe(403);
    expect(tryIt(blind)).toBe(404);
  });

  it('authorize runs conditions after the permission', () => {
    const a = staff([g('leaves.approve', 'organization')]);
    expect(() =>
      authorize(a, 'leaves.approve', { agencyId: AG, ownerIds: ['usr_me'] }, {
        condition: () => "You can't approve your own request.",
      }),
    ).toThrow(/own request/);
  });

  it('capabilities are keyed by permission', () => {
    const a = staff([g('tasks.update', 'organization')]);
    expect(capabilities(a, task, ['tasks.update', 'tasks.delete'])).toEqual({
      'tasks.update': true,
      'tasks.delete': false,
    });
  });
});

describe('admin guard', () => {
  const small = new GrantSet([g('tasks.view', 'organization')]);
  const big = new GrantSet([g('tasks.view', 'organization'), g('users.view', 'organization')]);

  it('ceiling: organization covers narrower scopes, not broader', () => {
    expect(uncovered(new GrantSet([g('tasks.update', 'organization')]), [g('tasks.update', 'own')])).toEqual([]);
    expect(uncovered(new GrantSet([g('tasks.update', 'own')]), [g('tasks.update', 'organization')])).toHaveLength(1);
  });

  it('manageable only when strictly more authority, never self, owners manage all', () => {
    const base = { actorIsOwner: false, targetIsOwner: false };
    expect(isManageable({ ...base, actorId: 'a', targetId: 'b', actorGrants: big, targetGrants: small })).toBe(true);
    expect(isManageable({ ...base, actorId: 'a', targetId: 'b', actorGrants: big, targetGrants: big })).toBe(false);
    expect(isManageable({ ...base, actorId: 'a', targetId: 'a', actorGrants: big, targetGrants: small })).toBe(false);
    expect(isManageable({ ...base, actorId: 'a', targetId: 'b', actorGrants: big, targetGrants: small, targetIsOwner: true })).toBe(false);
    expect(isManageable({ actorIsOwner: true, targetIsOwner: true, actorId: 'a', targetId: 'b', actorGrants: small, targetGrants: big })).toBe(true);
  });
});
