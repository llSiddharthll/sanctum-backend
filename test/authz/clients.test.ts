import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import { eq } from 'drizzle-orm';
import {
  app,
  BASE,
  createMemberSession,
  data,
  db,
  schema,
  signupAgency,
  systemRoleIdFor,
  type Agent,
} from '../helpers';
import type { Grant } from '../../src/authz/catalog.js';

const g = (permission: string, scope: Grant['scope'] = 'organization'): Grant => ({ permission, scope });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Clients & CRM authorization scenarios: assignment scope, notes ownership,
 * deal value field permissions, URL-parent binding, tenant isolation, share
 * links (mandatory expiry + revoke cascade), portal logins, pinned messages.
 */
describe('authz: clients & CRM', () => {
  let owner: Agent;
  let c1: string; // member is assigned
  let c2: string; // member is NOT assigned
  let member: Awaited<ReturnType<typeof createMemberSession>>;

  const MEMBER_GRANTS: Grant[] = [
    g('clients.view', 'assigned'),
    g('clients.update', 'assigned'),
    g('contacts.manage', 'assigned'),
    g('client_notes.create', 'assigned'),
    g('client_notes.update', 'own'),
    g('client_notes.delete', 'own'),
    g('deals.view', 'assigned'),
    g('deals.create', 'assigned'),
    g('deals.update', 'assigned'),
    g('messages.view', 'assigned'),
  ];

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    c1 = data(await owner.post(`${BASE}/clients`).send({ name: 'Assigned Co', gstNumber: 'GST-1' })).id;
    c2 = data(await owner.post(`${BASE}/clients`).send({ name: 'Other Co' })).id;
    member = await createMemberSession(owner, { grants: MEMBER_GRANTS, fullName: 'Scoped Member' });
    const assign = await owner.post(`${BASE}/team/clients/${c1}/assignments`).send({ userId: member.user.id });
    expect(assign.status).toBe(200);
  });

  // ------------------------------------------------------------ assignment scope
  it('assigned-scope member sees only assigned clients (list + detail 404)', async () => {
    const list = await member.agent.get(`${BASE}/clients`);
    expect(list.status).toBe(200);
    const ids = data(list).map((c: any) => c.id);
    expect(ids).toContain(c1);
    expect(ids).not.toContain(c2);

    expect((await member.agent.get(`${BASE}/clients/${c2}`)).status).toBe(404);

    const detail = await member.agent.get(`${BASE}/clients/${c1}`);
    expect(detail.status).toBe(200);
    const d = data(detail);
    // financial fields redacted without clients.view_financials
    expect(d.gstNumber).toBeNull();
    expect(d.outstanding).toBeNull();
    expect(d.capabilities['clients.update']).toBe(true);
    expect(d.capabilities['clients.archive']).toBe(false);
    expect(d.capabilities['clients.view_financials']).toBe(false);

    // owner sees financials
    const ownerDetail = data(await owner.get(`${BASE}/clients/${c1}`));
    expect(ownerDetail.gstNumber).toBe('GST-1');
    expect(ownerDetail.outstanding).toBe(0);
    expect(ownerDetail.capabilities['clients.manage_portal']).toBe(true);
  });

  it('assignment scope applies to follow-ups and CRM child lists', async () => {
    const due = new Date(Date.now() + 86_400_000).toISOString();
    await owner.patch(`${BASE}/clients/${c1}`).send({ nextFollowUpAt: due });
    await owner.patch(`${BASE}/clients/${c2}`).send({ nextFollowUpAt: due });
    const fu = data(await member.agent.get(`${BASE}/crm/follow-ups`)).map((f: any) => f.id);
    expect(fu).toContain(c1);
    expect(fu).not.toContain(c2);

    expect((await member.agent.get(`${BASE}/crm/clients/${c2}/contacts`)).status).toBe(404);
    expect((await member.agent.get(`${BASE}/crm/clients/${c2}/notes`)).status).toBe(404);
    expect((await member.agent.get(`${BASE}/crm/clients/${c1}/notes`)).status).toBe(200);
  });

  it('member cannot edit a non-assigned client; field rules on PATCH', async () => {
    expect((await member.agent.patch(`${BASE}/clients/${c2}`).send({ name: 'hax' })).status).toBe(404);
    expect((await member.agent.patch(`${BASE}/clients/${c1}`).send({ name: 'Assigned Co 2' })).status).toBe(200);

    // owner change needs clients.manage_assignments
    expect((await member.agent.patch(`${BASE}/clients/${c1}`).send({ ownerId: member.user.id })).status).toBe(403);
    // portal settings need clients.manage_portal
    expect((await member.agent.patch(`${BASE}/clients/${c1}`).send({ portalRole: 'reviewer' })).status).toBe(403);
    expect(
      (await member.agent.patch(`${BASE}/clients/${c1}`).send({ portalVisibleStatuses: ['draft'] })).status,
    ).toBe(403);
    // billing needs clients.view_financials
    expect((await member.agent.patch(`${BASE}/clients/${c1}`).send({ gstNumber: 'X' })).status).toBe(403);
    // resending unchanged values is fine (edit forms send everything)
    expect(
      (await member.agent.patch(`${BASE}/clients/${c1}`).send({ isActive: true, portalRole: 'approver' })).status,
    ).toBe(200);
    // archiving via PATCH is not possible, even for the owner
    expect((await member.agent.patch(`${BASE}/clients/${c1}`).send({ isActive: false })).status).toBe(400);
    expect((await owner.patch(`${BASE}/clients/${c1}`).send({ status: 'archived' })).status).toBe(400);
    // member has no clients.archive
    expect((await member.agent.post(`${BASE}/clients/${c1}/archive`)).status).toBe(403);
  });

  it('ownerId must be active staff of the agency', async () => {
    const other = await signupAgency();
    expect((await owner.patch(`${BASE}/clients/${c2}`).send({ ownerId: other.user.id })).status).toBe(400);
    expect((await owner.post(`${BASE}/clients`).send({ name: 'Bad owner', ownerId: other.user.id })).status).toBe(400);
  });

  it('archive + restore via dedicated endpoints', async () => {
    const id = data(await owner.post(`${BASE}/clients`).send({ name: 'Archivable' })).id;
    expect((await owner.post(`${BASE}/clients/${id}/archive`)).status).toBe(200);
    expect(data(await owner.get(`${BASE}/clients/${id}`)).status).toBe('archived');
    expect((await owner.post(`${BASE}/clients/${id}/restore`)).status).toBe(200);
    expect(data(await owner.get(`${BASE}/clients/${id}`)).status).toBe('active');
  });

  // ------------------------------------------------------------ notes
  it('notes: members edit/delete their own notes only; organization edits any', async () => {
    const ownerNote = data(await owner.post(`${BASE}/crm/clients/${c1}/notes`).send({ body: 'by owner' }));
    const mine = await member.agent.post(`${BASE}/crm/clients/${c1}/notes`).send({ body: 'by member' });
    expect(mine.status).toBe(201);
    const myNote = data(mine);
    expect(myNote.capabilities['client_notes.update']).toBe(true);

    expect((await member.agent.patch(`${BASE}/crm/notes/${myNote.id}`).send({ body: 'edited' })).status).toBe(200);
    expect((await member.agent.patch(`${BASE}/crm/notes/${ownerNote.id}`).send({ body: 'hax' })).status).toBe(403);
    expect((await member.agent.delete(`${BASE}/crm/notes/${ownerNote.id}`)).status).toBe(403);

    const list = data(await member.agent.get(`${BASE}/crm/clients/${c1}/notes`));
    const o = list.find((n: any) => n.id === ownerNote.id);
    expect(o.capabilities['client_notes.update']).toBe(false);

    expect((await owner.patch(`${BASE}/crm/notes/${myNote.id}`).send({ pinned: true })).status).toBe(200);
    expect((await member.agent.delete(`${BASE}/crm/notes/${myNote.id}`)).status).toBe(200);
  });

  // ------------------------------------------------------------ deals
  it('deal value is hidden without deals.view_value and cannot be written without deals.update_value', async () => {
    const d1 = data(await owner.post(`${BASE}/crm/clients/${c1}/deals`).send({ title: 'Big', valuePaise: 500_000 }));
    const d2 = data(await owner.post(`${BASE}/crm/clients/${c2}/deals`).send({ title: 'Hidden', valuePaise: 1 }));
    expect(d1.valuePaise).toBe(500_000);

    const pipeline = data(await member.agent.get(`${BASE}/crm/deals`));
    const ids = pipeline.map((x: any) => x.id);
    expect(ids).toContain(d1.id);
    expect(ids).not.toContain(d2.id);
    const seen = pipeline.find((x: any) => x.id === d1.id);
    expect(seen.valuePaise).toBeNull();
    expect(seen.capabilities['deals.update']).toBe(true);
    expect(seen.capabilities['deals.update_value']).toBe(false);

    expect(
      (await member.agent.post(`${BASE}/crm/clients/${c1}/deals`).send({ title: 'Mine', valuePaise: 100 })).status,
    ).toBe(403);
    const mine = await member.agent.post(`${BASE}/crm/clients/${c1}/deals`).send({ title: 'Mine' });
    expect(mine.status).toBe(201);
    expect(data(mine).valuePaise).toBeNull();

    expect((await member.agent.patch(`${BASE}/crm/deals/${d1.id}`).send({ valuePaise: 1 })).status).toBe(403);
    expect((await member.agent.patch(`${BASE}/crm/deals/${d1.id}`).send({ stage: 'proposal' })).status).toBe(200);
    // non-assigned client's deal: 404; no delete permission: 403
    expect((await member.agent.patch(`${BASE}/crm/deals/${d2.id}`).send({ stage: 'won' })).status).toBe(404);
    expect((await member.agent.delete(`${BASE}/crm/deals/${d1.id}`)).status).toBe(403);

    // value untouched
    const after = data(await owner.get(`${BASE}/crm/clients/${c1}/deals`)).find((x: any) => x.id === d1.id);
    expect(after.valuePaise).toBe(500_000);
  });

  // ------------------------------------------------------------ URL-parent binding
  it('child objects must belong to the client in the URL (404 otherwise)', async () => {
    const contact = data(await owner.post(`${BASE}/crm/clients/${c1}/contacts`).send({ name: 'C1 contact' }));
    const note = data(await owner.post(`${BASE}/crm/clients/${c1}/notes`).send({ body: 'C1 note' }));
    const deal = data(await owner.post(`${BASE}/crm/clients/${c1}/deals`).send({ title: 'C1 deal' }));

    expect((await owner.patch(`${BASE}/crm/clients/${c2}/contacts/${contact.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await owner.delete(`${BASE}/crm/clients/${c2}/notes/${note.id}`)).status).toBe(404);
    expect((await owner.patch(`${BASE}/crm/clients/${c2}/deals/${deal.id}`).send({ title: 'x' })).status).toBe(404);
    // matching parent works
    expect((await owner.patch(`${BASE}/crm/clients/${c1}/contacts/${contact.id}`).send({ name: 'ok' })).status).toBe(200);

    // member can't reach a contact of a non-assigned client via the flat route either
    const c2Contact = data(await owner.post(`${BASE}/crm/clients/${c2}/contacts`).send({ name: 'C2 contact' }));
    expect((await member.agent.patch(`${BASE}/crm/contacts/${c2Contact.id}`).send({ name: 'x' })).status).toBe(404);

    // share link revoke bound to the client in the URL
    const tk = data(await owner.post(`${BASE}/clients/${c1}/portal-tokens`).send({}));
    expect((await owner.post(`${BASE}/clients/${c2}/portal-tokens/${tk.id}/revoke`)).status).toBe(404);
  });

  // ------------------------------------------------------------ tenancy
  it('cross-tenant access is 404', async () => {
    const b = (await signupAgency()).agent;
    const deal = data(await owner.post(`${BASE}/crm/clients/${c1}/deals`).send({ title: 'A deal' }));
    const tk = data(await owner.post(`${BASE}/clients/${c1}/portal-tokens`).send({}));
    expect((await b.get(`${BASE}/clients/${c1}`)).status).toBe(404);
    expect((await b.patch(`${BASE}/clients/${c1}`).send({ name: 'x' })).status).toBe(404);
    expect((await b.get(`${BASE}/crm/clients/${c1}/notes`)).status).toBe(404);
    expect((await b.patch(`${BASE}/crm/deals/${deal.id}`).send({ title: 'x' })).status).toBe(404);
    expect((await b.post(`${BASE}/clients/${c1}/portal-tokens/${tk.id}/revoke`)).status).toBe(404);
    expect((await b.get(`${BASE}/clients/${c1}/pinned`)).status).toBe(404);
    expect(data(await b.get(`${BASE}/clients`)).some((c: any) => c.id === c1)).toBe(false);
  });

  // ------------------------------------------------------------ share links
  it('portal tokens: expiry is mandatory (default 30d, max 90), role from portalRole, no hashes', async () => {
    expect((await member.agent.post(`${BASE}/clients/${c1}/portal-tokens`).send({})).status).toBe(403);
    expect((await member.agent.get(`${BASE}/clients/${c1}/portal-tokens`)).status).toBe(403);

    const res = await owner.post(`${BASE}/clients/${c1}/portal-tokens`).send({ label: 'default' });
    expect(res.status).toBe(201);
    const tk = data(res);
    const days = (new Date(tk.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    expect(tk.roleId).toBe(await systemRoleIdFor(owner, 'share_link'));

    expect((await owner.post(`${BASE}/clients/${c1}/portal-tokens`).send({ expiresInDays: 365 })).status).toBeGreaterThanOrEqual(400);
    expect((await owner.post(`${BASE}/clients/${c1}/portal-tokens`).send({ expiresInDays: null })).status).toBeGreaterThanOrEqual(400);
    expect((await owner.post(`${BASE}/clients/${c1}/portal-tokens`).send({ expiresInDays: 0 })).status).toBeGreaterThanOrEqual(400);

    // reviewer brand → review-only link role
    const rev = data(await owner.post(`${BASE}/clients`).send({ name: 'Reviewer brand', portalRole: 'reviewer' }));
    const revTk = data(await owner.post(`${BASE}/clients/${rev.id}/portal-tokens`).send({ expiresInDays: 7 }));
    expect(revTk.roleId).toBe(await systemRoleIdFor(owner, 'share_link_reviewer'));

    // explicit staff role is refused; explicit client role accepted
    const employeeRole = await systemRoleIdFor(owner, 'employee');
    expect((await owner.post(`${BASE}/clients/${c1}/portal-tokens`).send({ roleId: employeeRole })).status).toBe(400);
    const approverRole = await systemRoleIdFor(owner, 'client_approver');
    const withRole = await owner.post(`${BASE}/clients/${c1}/portal-tokens`).send({ roleId: approverRole });
    expect(withRole.status).toBe(201);
    expect(data(withRole).roleId).toBe(approverRole);

    // project access: projects must belong to the client
    expect(
      (
        await owner
          .post(`${BASE}/clients/${c1}/portal-tokens`)
          .send({ projectAccess: 'selected', projectIds: ['prj_not_here'] })
      ).status,
    ).toBe(400);

    const list = await owner.get(`${BASE}/clients/${c1}/portal-tokens`);
    expect(list.status).toBe(200);
    const rows = data(list);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.tokenHash).toBeUndefined();
      expect(r.token).toBeUndefined();
      expect(r.expiresAt).toBeTruthy();
    }
  });

  it('portal tokens: selected projects of the client are stored', async () => {
    const p = await owner.post(`${BASE}/projects`).send({ name: 'Link project', clientId: c1 });
    expect(p.status).toBe(201);
    const projectId = data(p).id;
    const res = await owner
      .post(`${BASE}/clients/${c1}/portal-tokens`)
      .send({ projectAccess: 'selected', projectIds: [projectId] });
    expect(res.status).toBe(201);
    const row = data(await owner.get(`${BASE}/clients/${c1}/portal-tokens`)).find((r: any) => r.id === data(res).id);
    expect(row.projectAccess).toBe('selected');
    expect(row.projectIds).toEqual([projectId]);
  });

  it('revoking a share link kills sessions exchanged from it', async () => {
    const tk = data(await owner.post(`${BASE}/clients/${c1}/portal-tokens`).send({ expiresInDays: 5 }));
    const exchange = await supertest(app).post(`${BASE}/portal/session`).set(bearer(tk.token));
    expect(exchange.status).toBe(200);
    const access = data(exchange).tokens.access as string;
    expect((await supertest(app).get(`${BASE}/auth/me`).set(bearer(access))).status).toBe(200);

    const revoke = await owner.post(`${BASE}/clients/${c1}/portal-tokens/${tk.id}/revoke`);
    expect(revoke.status).toBe(200);

    expect((await supertest(app).get(`${BASE}/auth/me`).set(bearer(access))).status).toBe(401);
    // the link itself is dead too
    expect((await supertest(app).post(`${BASE}/portal/session`).set(bearer(tk.token))).status).toBeGreaterThanOrEqual(400);
  });

  it('send-welcome mints a 30-day link and audits its id', async () => {
    const id = data(await owner.post(`${BASE}/clients`).send({ name: 'Welcome Co', contactEmail: 'w@welcome.test' })).id;
    const res = await owner.post(`${BASE}/clients/${id}/send-welcome`);
    expect(res.status).toBe(200);
    const { tokenId, expiresAt } = data(res);
    expect(tokenId).toMatch(/^ptk_/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const [row] = await db.select().from(schema.portalTokens).where(eq(schema.portalTokens.id, tokenId));
    expect(row!.expiresAt).toBeTruthy();
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audits.some((a) => a.action === 'client.send_welcome' && (a.metadataJson ?? '').includes(tokenId))).toBe(true);
  });

  // ------------------------------------------------------------ portal login
  it('portal-login never overwrites or re-enables an existing account', async () => {
    const emailA = `a.${Date.now()}@brand.test`;
    const emailB = `b.${Date.now()}@brand.test`;
    const id = data(await owner.post(`${BASE}/clients`).send({ name: 'Login brand', contactEmail: emailA })).id;

    const a = data(await owner.post(`${BASE}/clients/${id}/portal-login`).send({}));
    expect(a.created).toBe(true);

    // A different email creates a NEW account; A keeps its email + password.
    const b = await owner.post(`${BASE}/clients/${id}/portal-login`).send({ email: emailB });
    expect(b.status).toBe(201);
    expect(data(b).userId).not.toBe(a.userId);
    const loginA = await supertest(app).post(`${BASE}/auth/login`).send({ email: emailA, password: a.password });
    expect(loginA.status).toBe(200);
    const status = data(await owner.get(`${BASE}/clients/${id}/portal-login`));
    expect(status.accounts.map((x: any) => x.email).sort()).toEqual([emailA, emailB].sort());

    // Existing account: no password returned, nothing changed.
    const again = await owner.post(`${BASE}/clients/${id}/portal-login`).send({ email: emailA });
    expect(again.status).toBe(200);
    expect(data(again).password).toBeNull();

    // Disabled account is not re-enabled.
    await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, a.userId));
    const disabled = await owner.post(`${BASE}/clients/${id}/portal-login`).send({ email: emailA });
    expect(disabled.status).toBe(409);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, a.userId));
    expect(u!.status).toBe('disabled');
    expect(u!.email).toBe(emailA);

    // member without clients.manage_portal
    expect((await member.agent.post(`${BASE}/clients/${c1}/portal-login`).send({})).status).toBe(403);
  });

  // ------------------------------------------------------------ pinned
  it('pinned messages only come from threads the actor participates in', async () => {
    const privateThread = data(
      await owner.post(`${BASE}/messages/threads`).send({ subject: 'Owner only', clientId: c1, participantIds: [] }),
    ).id;
    const sharedThread = data(
      await owner
        .post(`${BASE}/messages/threads`)
        .send({ subject: 'Shared', clientId: c1, participantIds: [member.user.id] }),
    ).id;
    const m1 = data(await owner.post(`${BASE}/messages/threads/${privateThread}/messages`).send({ body: 'secret pin' })).id;
    const m2 = data(await owner.post(`${BASE}/messages/threads/${sharedThread}/messages`).send({ body: 'shared pin' })).id;
    expect((await owner.patch(`${BASE}/messages/threads/${privateThread}/messages/${m1}/pin`).send({ pinned: true })).status).toBe(200);
    expect((await owner.patch(`${BASE}/messages/threads/${sharedThread}/messages/${m2}/pin`).send({ pinned: true })).status).toBe(200);

    const ownerPins = data(await owner.get(`${BASE}/clients/${c1}/pinned`)).map((p: any) => p.body);
    expect(ownerPins).toEqual(expect.arrayContaining(['secret pin', 'shared pin']));

    const memberRes = await member.agent.get(`${BASE}/clients/${c1}/pinned`);
    expect(memberRes.status).toBe(200);
    const memberPins = data(memberRes).map((p: any) => p.body);
    expect(memberPins).toContain('shared pin');
    expect(memberPins).not.toContain('secret pin');

    // AI summary additionally needs ai.use_assistant
    expect((await member.agent.post(`${BASE}/clients/${c1}/pinned/summary`).send({})).status).toBe(403);

    // messages.view is required
    const noMessages = await createMemberSession(owner, { grants: [g('clients.view')] });
    expect((await noMessages.agent.get(`${BASE}/clients/${c1}/pinned`)).status).toBe(403);
  });
});
