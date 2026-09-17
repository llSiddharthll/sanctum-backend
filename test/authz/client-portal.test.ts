import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import { and, eq } from 'drizzle-orm';
import {
  app,
  BASE,
  data,
  db,
  inviteToken,
  schema,
  signupAgency,
  systemRoleIdFor,
  uniqueEmail,
  type Agent,
} from '../helpers';
import { newId } from '../../src/lib/ids.js';
import { clearSessionCache } from '../../src/authz/sessions.js';

/**
 * Client-side actors (client users + share-link sessions) on /client and
 * /portal: permission per endpoint, `client` scope (brand + allowed projects,
 * fail-closed empty selection), state guards, share-link session lifecycle.
 */

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

interface Fixture {
  owner: Agent;
  agencyId: string;
  clientId: string;
  p1: string;
  p2: string;
  otherClientId: string;
  otherProject: string;
}

async function createClient(owner: Agent, name: string): Promise<string> {
  const res = await owner.post(`${BASE}/clients`).send({ name });
  expect(res.status).toBe(201);
  return data(res).id;
}

async function insertProject(agencyId: string, clientId: string, name: string): Promise<string> {
  const id = newId('prj');
  await db.insert(schema.projects).values({ id, agencyId, clientId, name } as never);
  return id;
}

async function insertDoc(f: Fixture, v: { clientId: string | null; projectId: string | null; name: string; clientVisible?: boolean }) {
  const id = newId('doc');
  await db.insert(schema.documents).values({
    id,
    agencyId: f.agencyId,
    name: v.name,
    clientId: v.clientId,
    projectId: v.projectId,
    fileUrl: `https://files.test/${v.name}`,
    clientVisible: v.clientVisible ?? true,
  } as never);
  return id;
}

async function insertFolder(f: Fixture, v: { clientId: string | null; projectId: string | null; name: string }) {
  const id = newId('folder');
  await db.insert(schema.documentFolders).values({
    id,
    agencyId: f.agencyId,
    name: v.name,
    clientId: v.clientId,
    projectId: v.projectId,
    clientVisible: true,
  } as never);
  return id;
}

async function insertInvoice(f: Fixture, clientId: string, projectId: string | null, number: string) {
  const id = newId('inv');
  await db.insert(schema.invoices).values({
    id,
    agencyId: f.agencyId,
    clientId,
    projectId,
    invoiceNumber: number,
    status: 'sent',
    total: 1000,
    subtotal: 1000,
  } as never);
  return id;
}

async function insertProposal(
  f: Fixture,
  clientId: string,
  v: { status?: string; validUntil?: Date | null; title?: string } = {},
) {
  const id = newId('prop');
  await db.insert(schema.proposals).values({
    id,
    agencyId: f.agencyId,
    clientId,
    title: v.title ?? 'Proposal',
    status: v.status ?? 'sent',
    contentJson: JSON.stringify({ deliverables: [{ title: 'Reels', price: 5000 }] }),
    totalPaise: 5000,
    validUntil: v.validUntil ?? null,
    token: 'pzt_public_secret',
  } as never);
  return id;
}

async function insertAgreement(f: Fixture, clientId: string, projectId: string | null, status = 'sent') {
  const id = newId('agr');
  await db.insert(schema.agreements).values({
    id,
    agencyId: f.agencyId,
    clientId,
    projectId,
    title: 'Retainer',
    status,
    termsJson: JSON.stringify({ scope: 'Content', clauses: [] }),
    totalValuePaise: 90000,
    token: 'pzt_public_agreement_secret',
  } as never);
  return id;
}

async function insertPost(f: Fixture, clientId: string, status = 'pending_approval') {
  const id = newId('post');
  await db.insert(schema.contentPosts).values({
    id,
    agencyId: f.agencyId,
    clientId,
    postType: 'post',
    caption: `caption ${id}`,
    status,
  } as never);
  return id;
}

/** Provision a client user via owner POST /team/invite, then accept. */
async function clientUser(
  f: Fixture,
  opts: { projectIds?: string[]; roleKey?: string; clientId?: string } = {},
): Promise<Agent> {
  const email = uniqueEmail('client');
  const roleIds = opts.roleKey ? [await systemRoleIdFor(f.owner, opts.roleKey)] : undefined;
  const invite = await f.owner.post(`${BASE}/team/invite`).send({
    fullName: 'Client Person',
    email,
    kind: 'client',
    clientId: opts.clientId ?? f.clientId,
    ...(opts.projectIds ? { projectIds: opts.projectIds } : {}),
    ...(roleIds ? { roleIds } : {}),
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const agent = supertest.agent(app);
  const accept = await agent
    .post(`${BASE}/auth/accept-invite`)
    .send({ token: inviteToken(invite.body.data.inviteUrl), password: 'Password123!' });
  expect(accept.status, JSON.stringify(accept.body)).toBe(200);
  return agent;
}

/** Mint a share link through the clients router. */
async function shareLink(f: Fixture, roleKey = 'share_link'): Promise<{ id: string; token: string }> {
  const roleId = await systemRoleIdFor(f.owner, roleKey);
  const res = await f.owner.post(`${BASE}/clients/${f.clientId}/portal-tokens`).send({ label: 'link', roleId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: data(res).id, token: data(res).token };
}

const bearer = (token: string) => ({
  get: (path: string) => supertest(app).get(`${BASE}${path}`).set('Authorization', `Bearer ${token}`),
  post: (path: string) => supertest(app).post(`${BASE}${path}`).set('Authorization', `Bearer ${token}`),
});

const ids = (res: { body: { data: Array<{ id: string }> } }) => res.body.data.map((x) => x.id);

describe('client portal authorization (client actors)', () => {
  const f = {} as Fixture;
  let docBrand: string;
  let docP1: string;
  let docP2: string;
  let docP2BrandTagged: string;
  let docHidden: string;
  let folderP2: string;
  let folderBrand: string;
  let invBrand: string;
  let invP1: string;
  let invP2: string;
  let agrP2: string;
  let agrBrand: string;

  beforeAll(async () => {
    const s = await signupAgency();
    f.owner = s.agent;
    f.agencyId = s.agency.id;
    f.clientId = await createClient(f.owner, 'Scope Brand');
    f.otherClientId = await createClient(f.owner, 'Other Brand');
    f.p1 = await insertProject(f.agencyId, f.clientId, 'P1');
    f.p2 = await insertProject(f.agencyId, f.clientId, 'P2');
    f.otherProject = await insertProject(f.agencyId, f.otherClientId, 'Other P');

    docBrand = await insertDoc(f, { clientId: f.clientId, projectId: null, name: 'brand.pdf' });
    docP1 = await insertDoc(f, { clientId: null, projectId: f.p1, name: 'p1.pdf' });
    docP2 = await insertDoc(f, { clientId: null, projectId: f.p2, name: 'p2.pdf' });
    // The old leak: clientId = brand but bound to a project outside the selection.
    docP2BrandTagged = await insertDoc(f, { clientId: f.clientId, projectId: f.p2, name: 'p2-tagged.pdf' });
    docHidden = await insertDoc(f, { clientId: f.clientId, projectId: null, name: 'internal.pdf', clientVisible: false });
    folderP2 = await insertFolder(f, { clientId: f.clientId, projectId: f.p2, name: 'P2 folder' });
    folderBrand = await insertFolder(f, { clientId: f.clientId, projectId: null, name: 'Shared' });

    invBrand = await insertInvoice(f, f.clientId, null, 'INV-BRAND');
    invP1 = await insertInvoice(f, f.clientId, f.p1, 'INV-P1');
    invP2 = await insertInvoice(f, f.clientId, f.p2, 'INV-P2');
    agrP2 = await insertAgreement(f, f.clientId, f.p2);
    agrBrand = await insertAgreement(f, f.clientId, null);
  });

  it('project-selected client sees only its project + brand-level objects', async () => {
    const c = await clientUser(f, { projectIds: [f.p1] });

    const projects = await c.get(`${BASE}/client/projects`);
    expect(projects.status).toBe(200);
    expect(ids(projects)).toEqual([f.p1]);
    expect((await c.get(`${BASE}/client/projects/${f.p2}`)).status).toBe(404);

    const files = await c.get(`${BASE}/client/files`);
    expect(files.status).toBe(200);
    expect(ids(files).sort()).toEqual([docBrand, docP1].sort());
    expect(ids(files)).not.toContain(docP2BrandTagged);
    expect(ids(files)).not.toContain(docHidden);
    expect(files.body.data[0].capabilities).toHaveProperty('documents.upload');

    const folders = await c.get(`${BASE}/client/folders`);
    expect(ids(folders)).toEqual([folderBrand]);

    const invs = await c.get(`${BASE}/client/invoices`);
    expect(invs.status).toBe(200);
    expect(ids(invs).sort()).toEqual([invBrand, invP1].sort());
    expect((await c.get(`${BASE}/client/invoices/${invP2}`)).status).toBe(404);

    const agrs = await c.get(`${BASE}/client/agreements`);
    expect(ids(agrs)).toEqual([agrBrand]);
    expect((await c.get(`${BASE}/client/agreements/${agrP2}`)).status).toBe(404);

    const postId = await insertPost(f, f.clientId);
    const cal = await c.get(`${BASE}/client/calendar`);
    expect(cal.status).toBe(200);
    expect(cal.body.data.posts.map((p: any) => p.id)).toContain(postId); // brand-level post
  });

  it('selected-with-none sees no project-bound objects (fail closed)', async () => {
    const c = await clientUser(f);
    // Force "selected" with zero projects on the created account.
    const me = await c.get(`${BASE}/auth/me`);
    const userId = me.body.data.user.id;
    await db.update(schema.users).set({ clientProjectAccess: 'selected' } as never).where(eq(schema.users.id, userId));

    expect((await c.get(`${BASE}/client/projects`)).body.data).toEqual([]);
    const files = await c.get(`${BASE}/client/files`);
    expect(ids(files)).toEqual([docBrand]);
    const invs = await c.get(`${BASE}/client/invoices`);
    expect(ids(invs)).toEqual([invBrand]);
    expect((await c.get(`${BASE}/client/projects/${f.p1}`)).status).toBe(404);
  });

  it('uploads re-check the folder project scope and bind items to the brand', async () => {
    const c = await clientUser(f, { projectIds: [f.p1] });
    const intoP2 = await c.post(`${BASE}/client/documents`).send({
      name: 'sneaky.pdf',
      folderId: folderP2,
      fileUrl: 'https://files.test/sneaky.pdf',
    });
    expect(intoP2.status).toBe(404);

    const cross = await c.post(`${BASE}/client/folders`).send({ name: 'x', projectId: f.otherProject });
    expect(cross.status).toBe(404);

    const ok1 = await c.post(`${BASE}/client/documents`).send({
      name: 'mine.pdf',
      projectId: f.p1,
      fileUrl: 'https://files.test/mine.pdf',
    });
    expect(ok1.status).toBe(201);
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, ok1.body.data.id));
    expect(row!.clientId).toBe(f.clientId);
    expect(row!.projectId).toBe(f.p1);
    expect(row!.clientVisible).toBe(true);

    const js = await c.post(`${BASE}/client/documents`).send({ name: 'bad', fileUrl: 'javascript:alert(1)' });
    expect(js.status).toBe(422);
  });

  it('team endpoint exposes only name + designation, never user ids or emails', async () => {
    const c = await clientUser(f, { projectIds: [f.p1] });
    const team = await c.get(`${BASE}/client/projects/${f.p1}/team`);
    expect(team.status).toBe(200);
    for (const m of team.body.data) {
      expect(m.id).toMatch(/^tm_/);
      expect(m).not.toHaveProperty('email');
      expect(m).not.toHaveProperty('userId');
    }
  });

  it('reviewer cannot approve posts; approver can (only from pending_approval)', async () => {
    const reviewer = await clientUser(f, { roleKey: 'client_reviewer' });
    const approver = await clientUser(f, { roleKey: 'client_approver' });
    const postId = await insertPost(f, f.clientId);

    const cal = await reviewer.get(`${BASE}/client/calendar`);
    expect(cal.body.data.canApprove).toBe(false);
    const rp = cal.body.data.posts.find((p: any) => p.id === postId);
    expect(rp.capabilities['posts.approve']).toBe(false);
    expect(rp.capabilities['post_comments.create']).toBe(true);

    const denied = await reviewer.post(`${BASE}/client/posts/${postId}/decision`).send({ decision: 'approved' });
    expect(denied.status).toBe(403);
    const comment = await reviewer.post(`${BASE}/client/posts/${postId}/comments`).send({ body: 'Nice' });
    expect(comment.status).toBe(201);

    const good = await approver.post(`${BASE}/client/posts/${postId}/decision`).send({ decision: 'approved' });
    expect(good.status).toBe(200);
    expect(good.body.data.newStatus).toBe('approved');

    const again = await approver
      .post(`${BASE}/client/posts/${postId}/decision`)
      .send({ decision: 'changes_requested' });
    expect(again.status).toBe(409);

    // Mirrored message is system-attributed (no staff author).
    const msgs = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.agencyId, f.agencyId));
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.senderId).toBeNull();
  });

  it('agreement cannot be re-signed (409)', async () => {
    const c = await clientUser(f, { roleKey: 'client_approver' });
    const agr = await insertAgreement(f, f.clientId, null);
    const detail = await c.get(`${BASE}/client/agreements/${agr}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).not.toHaveProperty('token');
    expect(detail.body.data.capabilities['agreements.sign']).toBe(true);

    const sign = { signerName: 'Boss', signerEmail: 'boss@brand.test', signatureDataUrl: SIG };
    expect((await c.post(`${BASE}/client/agreements/${agr}/sign`).send(sign)).status).toBe(200);
    const resign = await c
      .post(`${BASE}/client/agreements/${agr}/sign`)
      .send({ ...sign, signerName: 'Impostor' });
    expect(resign.status).toBe(409);
    const [row] = await db.select().from(schema.agreements).where(eq(schema.agreements.id, agr));
    expect(row!.signerName).toBe('Boss');

    const draft = await insertAgreement(f, f.clientId, null, 'draft');
    expect((await c.post(`${BASE}/client/agreements/${draft}/sign`).send(sign)).status).toBe(404);
  });

  it('proposal cannot be accepted after validUntil or when not sent; token never returned', async () => {
    const c = await clientUser(f, { roleKey: 'client_approver' });
    const expired = await insertProposal(f, f.clientId, { validUntil: new Date(Date.now() - 86_400_000) });
    const accepted = await insertProposal(f, f.clientId, { status: 'accepted' });
    const live = await insertProposal(f, f.clientId, { validUntil: new Date(Date.now() + 86_400_000) });

    expect((await c.post(`${BASE}/client/proposals/${expired}/accept`)).status).toBe(409);
    expect((await c.post(`${BASE}/client/proposals/${accepted}/reject`).send({})).status).toBe(409);

    const list = await c.get(`${BASE}/client/proposals`);
    expect(list.status).toBe(200);
    for (const p of list.body.data) expect(p).not.toHaveProperty('token');
    const lp = list.body.data.find((p: any) => p.id === live);
    expect(lp.capabilities['proposals.respond']).toBe(true);
    expect(lp.totalPaise).toBe(5000);

    expect((await c.post(`${BASE}/client/proposals/${live}/accept`)).status).toBe(200);
    expect((await c.post(`${BASE}/client/proposals/${live}/accept`)).status).toBe(409);
  });

  it('pricing requires *.view_pricing', async () => {
    const roleRes = await f.owner.post(`${BASE}/roles`).send({
      name: `No pricing ${Date.now()}`,
      actorType: 'client',
      grants: [
        { permission: 'proposals.view', scope: 'client' },
        { permission: 'agreements.view', scope: 'client' },
      ],
    });
    expect(roleRes.status, JSON.stringify(roleRes.body)).toBe(201);
    const email = uniqueEmail('client');
    const invite = await f.owner.post(`${BASE}/team/invite`).send({
      fullName: 'No Pricing',
      email,
      kind: 'client',
      clientId: f.clientId,
      roleIds: [roleRes.body.data.id],
    });
    expect(invite.status).toBe(201);
    const c = supertest.agent(app);
    await c
      .post(`${BASE}/auth/accept-invite`)
      .send({ token: inviteToken(invite.body.data.inviteUrl), password: 'Password123!' });
    await insertProposal(f, f.clientId);
    const list = await c.get(`${BASE}/client/proposals`);
    expect(list.status).toBe(200);
    for (const p of list.body.data) {
      expect(p.totalPaise).toBeNull();
      expect(JSON.stringify(p.content)).not.toContain('5000');
    }
    const agrs = await c.get(`${BASE}/client/agreements`);
    for (const a of agrs.body.data) expect(a.totalValuePaise).toBeNull();
    expect((await c.get(`${BASE}/client/invoices`)).status).toBe(403);
  });

  it('staff token → 403 on /client', async () => {
    expect((await f.owner.get(`${BASE}/client/me`)).status).toBe(403);
    expect((await f.owner.get(`${BASE}/client/invoices`)).status).toBe(403);
  });

  it('cross-brand ids → 404', async () => {
    const c = await clientUser(f, { roleKey: 'client_approver' });
    const otherPost = await insertPost(f, f.otherClientId);
    const otherProp = await insertProposal(f, f.otherClientId);
    const otherInv = await insertInvoice(f, f.otherClientId, f.otherProject, 'INV-OTHER');
    const otherAgr = await insertAgreement(f, f.otherClientId, null);
    expect((await c.get(`${BASE}/client/posts/${otherPost}/comments`)).status).toBe(404);
    expect((await c.post(`${BASE}/client/posts/${otherPost}/decision`).send({ decision: 'approved' })).status).toBe(404);
    expect((await c.get(`${BASE}/client/proposals/${otherProp}`)).status).toBe(404);
    expect((await c.post(`${BASE}/client/proposals/${otherProp}/accept`)).status).toBe(404);
    expect((await c.get(`${BASE}/client/invoices/${otherInv}`)).status).toBe(404);
    expect((await c.post(`${BASE}/client/agreements/${otherAgr}/sign`).send({ signerName: 'x', signerEmail: 'x@y.z', signatureDataUrl: SIG })).status).toBe(404);
    expect((await c.get(`${BASE}/client/projects/${f.otherProject}`)).status).toBe(404);
  });

  describe('share links', () => {
    it('link session can view calendar/comments but not invoices/proposals', async () => {
      const link = await shareLink(f, 'share_link');
      const exchange = await bearer(link.token).post('/portal/session');
      expect(exchange.status, JSON.stringify(exchange.body)).toBe(200);
      const { access, refresh } = exchange.body.data.tokens;
      expect(typeof access).toBe('string');
      expect(typeof refresh).toBe('string');
      expect(exchange.body.data.client.name).toBe('Scope Brand');

      const s = bearer(access);
      const me = await s.get('/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.data.authorization.actorType).toBe('portal_link');

      const postId = await insertPost(f, f.clientId);
      const cal = await s.get('/client/calendar');
      expect(cal.status).toBe(200);
      expect(cal.body.data.posts.map((p: any) => p.id)).toContain(postId);
      expect((await s.get(`/client/posts/${postId}/comments`)).status).toBe(200);
      expect((await s.get('/client/invoices')).status).toBe(403);
      expect((await s.get('/client/proposals')).status).toBe(403);
      expect((await s.get('/client/agreements')).status).toBe(403);
      expect((await s.get('/client/files')).status).toBe(403);

      const [audit] = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'portal_link.session.create'));
      expect(audit).toBeTruthy();
      expect(audit!.actorType).toBe('portal_link');
    });

    it('reviewer link gets 403 on decision; approve link can decide (token-only)', async () => {
      const reviewer = await shareLink(f, 'share_link_reviewer');
      const approver = await shareLink(f, 'share_link');
      const postId = await insertPost(f, f.clientId);

      const res = await bearer(reviewer.token).get('/portal/resolve');
      expect(res.status).toBe(200);
      expect(res.body.data.portal.canApprove).toBe(false);

      const denied = await bearer(reviewer.token)
        .post(`/portal/posts/${postId}/decision`)
        .send({ decision: 'approved', actorLabel: 'CEO' });
      expect(denied.status).toBe(403);
      expect(
        (await bearer(reviewer.token).post(`/portal/posts/${postId}/comments`).send({ body: 'hmm' })).status,
      ).toBe(201);

      const ok1 = await bearer(approver.token)
        .post(`/portal/posts/${postId}/decision`)
        .send({ decision: 'approved', actorLabel: 'Jane' });
      expect(ok1.status).toBe(200);
      const [a] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.entityId, postId), eq(schema.auditLog.action, 'post.approved')));
      expect(a!.actorType).toBe('portal_link');
      expect(a!.actorId).toBe(approver.id);
    });

    it('revoking the link ends its sessions: access 401, refresh 401', async () => {
      const link = await shareLink(f, 'share_link');
      const exchange = await bearer(link.token).post('/portal/session');
      expect(exchange.status).toBe(200);
      const { access, refresh } = exchange.body.data.tokens;
      expect((await bearer(access).get('/client/calendar')).status).toBe(200);

      const revoke = await f.owner.post(`${BASE}/clients/${f.clientId}/portal-tokens/${link.id}/revoke`);
      expect(revoke.status).toBe(200);
      clearSessionCache();

      expect((await bearer(access).get('/client/calendar')).status).toBe(401);
      const r = await supertest(app).post(`${BASE}/auth/refresh`).send({ refreshToken: refresh });
      expect(r.status).toBe(401);
      expect((await bearer(link.token).get('/portal/resolve')).status).toBe(410);
    });

    it('an expired link ends its sessions', async () => {
      const link = await shareLink(f, 'share_link');
      const exchange = await bearer(link.token).post('/portal/session');
      const { access, refresh } = exchange.body.data.tokens;
      await db
        .update(schema.portalTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) } as never)
        .where(eq(schema.portalTokens.id, link.id));
      clearSessionCache();
      expect((await bearer(access).get('/client/calendar')).status).toBe(401);
      expect((await supertest(app).post(`${BASE}/auth/refresh`).send({ refreshToken: refresh })).status).toBe(401);
    });
  });
});
