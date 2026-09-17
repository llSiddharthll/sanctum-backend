/**
 * Content calendar authorization scenarios: client scope (assigned vs
 * organization), URL-parent binding, tenant isolation, the post state machine,
 * media permissions + storage-key binding, social account management and
 * client-scoped AI generation.
 */
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  BASE,
  createMemberSession,
  data,
  db,
  schema,
  signupAgency,
  type Agent,
} from '../helpers';

type G = { permission: string; scope: 'own' | 'assigned' | 'organization' };
const A = (permission: string): G => ({ permission, scope: 'assigned' });

describe('authz: content calendar', () => {
  let owner: Agent;
  let agencyId: string;
  let c1: string; // assigned to the member
  let c2: string; // not assigned
  let member: Agent;
  let memberId: string;

  const posts = (clientId: string, p = '') => `${BASE}/clients/${clientId}/posts${p}`;

  async function createPost(agent: Agent, clientId: string, over: Record<string, unknown> = {}) {
    const r = await agent.post(posts(clientId)).send({ postType: 'post', caption: 'Hi', ...over });
    expect(r.status).toBe(201);
    return data(r).id as string;
  }

  async function clientApproves(postId: string) {
    await db
      .update(schema.contentPosts)
      .set({ status: 'approved' })
      .where(and(eq(schema.contentPosts.id, postId), eq(schema.contentPosts.agencyId, agencyId)));
    await db.insert(schema.auditLog).values({
      id: `aud_t_${crypto.randomBytes(6).toString('hex')}`,
      agencyId,
      actorType: 'client',
      action: 'post.approved',
      entityType: 'post',
      entityId: postId,
    });
  }

  const asset = (clientId: string, postId: string, name = 'x.jpg', agency = agencyId) => {
    const key = `agency/${agency}/client/${clientId}/post/${postId}/${name}`;
    return { key, url: `https://res.cloudinary.com/test-cloud/image/upload/v1/${key}` };
  };

  beforeAll(async () => {
    const s = await signupAgency();
    owner = s.agent;
    agencyId = s.agency.id;
    c1 = data(await owner.post(`${BASE}/clients`).send({ name: 'Assigned Co' })).id;
    c2 = data(await owner.post(`${BASE}/clients`).send({ name: 'Other Co' })).id;
    const m = await createMemberSession(owner, {
      grants: [
        A('clients.view'),
        A('posts.view'),
        A('posts.create'),
        A('posts.update'),
        A('posts.delete'),
        A('posts.submit_for_approval'),
        A('posts.schedule'),
        A('media.upload'),
        A('post_comments.view'),
        A('post_comments.create'),
        A('ai.generate_content'),
      ],
    });
    member = m.agent;
    memberId = m.user.id;
    // Account owner of c1 ⇒ `assigned`.
    await db.update(schema.clients).set({ ownerId: memberId }).where(eq(schema.clients.id, c1));
  });

  it('assigned scope: list/detail/edit only for assigned clients', async () => {
    const p1 = await createPost(owner, c1);
    const p2 = await createPost(owner, c2);

    const list = await member.get(posts(c1));
    expect(list.status).toBe(200);
    expect(data(list).map((p: any) => p.id)).toContain(p1);
    expect((await member.get(posts(c2))).status).toBe(404);

    expect((await member.get(posts(c1, `/${p1}`))).status).toBe(200);
    expect((await member.get(posts(c2, `/${p2}`))).status).toBe(404);

    expect((await member.patch(posts(c1, `/${p1}`)).send({ caption: 'edit' })).status).toBe(200);
    expect((await member.patch(posts(c2, `/${p2}`)).send({ caption: 'edit' })).status).toBe(404);
    expect((await member.post(posts(c2)).send({ postType: 'post' })).status).toBe(404);
  });

  it('includes per-post capabilities', async () => {
    const p1 = await createPost(member, c1);
    const d = data(await member.get(posts(c1, `/${p1}`)));
    expect(d.capabilities).toMatchObject({
      'posts.update': true,
      'posts.delete': true,
      'posts.submit_for_approval': true,
      'posts.schedule': false, // draft: not approved yet
      'posts.publish': false, // no grant
      'media.upload': true,
      'post_comments.create': true,
    });
  });

  it('binds posts, reservations and media to the URL client (404 on mismatch)', async () => {
    const p2 = await createPost(owner, c2);
    expect((await owner.get(posts(c1, `/${p2}`))).status).toBe(404);
    expect((await owner.patch(posts(c1, `/${p2}`)).send({ caption: 'x' })).status).toBe(404);
    expect((await owner.delete(posts(c1, `/${p2}`))).status).toBe(404);
    expect((await owner.get(posts(c1, `/${p2}/comments`))).status).toBe(404);

    // Unarchive IDOR: an archived post of c2 can't be restored through c1.
    await db
      .update(schema.contentPosts)
      .set({ archivedAt: new Date(), archivedMonth: '2026-01' })
      .where(eq(schema.contentPosts.id, p2));
    expect((await owner.post(posts(c1, `/${p2}/unarchive`)).send({})).status).toBe(404);
    expect((await owner.post(posts(c2, `/${p2}/unarchive`)).send({})).status).toBe(200);

    // Reservation delete IDOR.
    const rsv = data(
      await owner.post(`${BASE}/clients/${c2}/reservations`).send({ date: '2026-10-01' }),
    ).id;
    expect((await owner.delete(`${BASE}/clients/${c1}/reservations/${rsv}`)).status).toBe(404);
    const still = data(await owner.get(`${BASE}/clients/${c2}/reservations`));
    expect(still.map((r: any) => r.id)).toContain(rsv);
    expect((await owner.delete(`${BASE}/clients/${c2}/reservations/${rsv}`)).status).toBe(200);

    // Media: post of c2 registered under clientId c1.
    const a = asset(c1, p2);
    const r = await owner
      .post(`${BASE}/media/posts/${p2}`)
      .send({ clientId: c1, cloudinaryPublicId: a.key, secureUrl: a.url, resourceType: 'image' });
    expect(r.status).toBe(404);
  });

  it('is tenant isolated (404 for another agency)', async () => {
    const p1 = await createPost(owner, c1);
    const other = (await signupAgency()).agent;
    expect((await other.get(posts(c1))).status).toBe(404);
    expect((await other.get(posts(c1, `/${p1}`))).status).toBe(404);
    expect((await other.post(posts(c1, `/${p1}/transition`)).send({ to: 'pending_approval' })).status).toBe(404);
    expect((await other.get(`${BASE}/clients/${c1}/reservations`)).status).toBe(404);
  });

  it('enforces the post state machine', async () => {
    // Can't create directly as scheduled.
    const bad = await owner.post(posts(c1)).send({ postType: 'post', status: 'scheduled' });
    expect(bad.status).toBe(409);

    const id = await createPost(owner, c1);
    const tr = (to: string) => owner.post(posts(c1, `/${id}/transition`)).send({ to });
    // Unapproved posts can't be scheduled or marked posted.
    expect((await tr('scheduled')).status).toBe(409);
    expect((await tr('posted')).status).toBe(409);
    expect((await tr('pending_approval')).status).toBe(200);
    expect((await tr('scheduled')).status).toBe(409);
    // Staff can't approve on the client's behalf.
    expect((await tr('approved')).status).toBe(403);

    await clientApproves(id);
    expect((await tr('scheduled')).status).toBe(200);

    // A status-neutral PATCH (same values) keeps the approval.
    const same = await owner.patch(posts(c1, `/${id}`)).send({ caption: 'Hi' });
    expect(data(same).status).toBe('scheduled');
    expect(data(same).approvalReset).toBe(false);

    // Editing approved content resets it to draft.
    const edit = await owner.patch(posts(c1, `/${id}`)).send({ caption: 'Changed' });
    expect(edit.status).toBe(200);
    expect(data(edit).status).toBe('draft');
    expect(data(edit).approvalReset).toBe(true);
    expect((await tr('scheduled')).status).toBe(409);
  });

  it('schedule / publish need their own permissions', async () => {
    const id = await createPost(owner, c1);
    await clientApproves(id);
    const tr = (agent: Agent, to: string) => agent.post(posts(c1, `/${id}/transition`)).send({ to });
    const noSchedule = await createMemberSession(owner, {
      grants: [A('clients.view'), A('posts.view'), A('posts.update')],
    });
    await db.update(schema.clients).set({ ownerId: noSchedule.user.id }).where(eq(schema.clients.id, c2));
    // Not assigned to c1 → can't even see it.
    expect((await tr(noSchedule.agent, 'scheduled')).status).toBe(404);
    // member: has posts.schedule but not posts.publish.
    expect((await tr(member, 'scheduled')).status).toBe(200);
    expect((await tr(member, 'posted')).status).toBe(403);
    expect((await tr(owner, 'posted')).status).toBe(200);
  });

  it('media: foreign storage keys are rejected; delete needs media.delete', async () => {
    const id = await createPost(owner, c1);
    const reg = (agent: Agent, key: string, url: string) =>
      agent
        .post(`${BASE}/media/posts/${id}`)
        .send({ clientId: c1, cloudinaryPublicId: key, secureUrl: url, resourceType: 'image' });

    const foreignAgency = asset(c1, id, 'x.jpg', 'agy_someone_else');
    expect((await reg(member, foreignAgency.key, foreignAgency.url)).status).toBe(400);
    const otherClient = asset(c2, id);
    expect((await reg(member, otherClient.key, otherClient.url)).status).toBe(400);
    const good = asset(c1, id);
    expect((await reg(member, good.key, 'https://evil.test/' + good.key)).status).toBe(400);
    expect((await reg(member, 'sanctum/' + agencyId + '/documents/doc.pdf', good.url)).status).toBe(400);

    const ok = await reg(member, good.key, good.url);
    expect(ok.status).toBe(201);
    const mediaId = data(ok).id;

    // member has no media.delete.
    expect((await member.delete(`${BASE}/media/${mediaId}`)).status).toBe(403);
    // own-scope delete: the post was created by the owner → not "own".
    const ownOnly = await createMemberSession(owner, {
      grants: [A('clients.view'), A('posts.view'), { permission: 'media.delete', scope: 'own' }],
    });
    await db.insert(schema.clientAssignments).values({
      id: `cas_t_${crypto.randomBytes(6).toString('hex')}`,
      agencyId,
      clientId: c1,
      userId: ownOnly.user.id,
    });
    expect((await ownOnly.agent.delete(`${BASE}/media/${mediaId}`)).status).toBe(403);
    // Another agency can't see it at all.
    const other = (await signupAgency()).agent;
    expect((await other.delete(`${BASE}/media/${mediaId}`)).status).toBe(404);
    expect((await owner.delete(`${BASE}/media/${mediaId}`)).status).toBe(200);
  });

  it('social accounts: view vs manage', async () => {
    const viewer = await createMemberSession(owner, {
      grants: [{ permission: 'social_accounts.view', scope: 'organization' }],
    });
    expect((await viewer.agent.get(`${BASE}/clients/${c1}/social`)).status).toBe(200);
    expect((await viewer.agent.post(`${BASE}/clients/${c1}/social/meta/connect`).send({})).status).toBe(403);
    // member has no social permissions at all.
    expect((await member.get(`${BASE}/clients/${c1}/social`)).status).toBe(403);
    expect((await owner.post(`${BASE}/clients/${c1}/social/meta/connect`).send({})).status).toBe(200);
  });

  it('AI generation requires the client in scope (and posts.create)', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const gen = (agent: Agent, clientId: string) =>
      agent.post(`${BASE}/clients/${clientId}/ai/generate-month`).send({ month, postsCount: 1 });
    expect((await gen(member, c1)).status).toBe(201);
    expect((await gen(member, c2)).status).toBe(404);

    const noAi = await createMemberSession(owner, {
      grants: [A('clients.view'), A('posts.view'), A('posts.create')],
    });
    expect((await gen(noAi.agent, c1)).status).toBe(403);
  });

  it('AI quota counts the current period regardless of the requested month', async () => {
    const sOwner = await signupAgency();
    const cid = data(await sOwner.agent.post(`${BASE}/clients`).send({ name: 'Quota Co' })).id;
    // Studio plan cap = 5 runs per period; ask for five different months.
    for (let i = 1; i <= 5; i++) {
      const r = await sOwner.agent
        .post(`${BASE}/clients/${cid}/ai/generate-month`)
        .send({ month: `2030-0${i}`, postsCount: 1 });
      expect(r.status).toBe(201);
    }
    const r = await sOwner.agent
      .post(`${BASE}/clients/${cid}/ai/generate-month`)
      .send({ month: '2030-09', postsCount: 1 });
    expect(r.status).toBe(402);
  });
});
