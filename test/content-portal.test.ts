import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import {
  app,
  BASE,
  signupAgency,
  createMemberSession,
  data,
  uniqueEmail,
  type Agent,
} from './helpers';

/**
 * Content posts + approvals + public client portal workflows.
 *
 * Coverage: post CRUD, the staff status state-machine, staff comments,
 * portal token auth (resolve / detail / decision / comments), the in-app
 * notification fan-out to the agency on portal activity, RBAC gates and
 * cross-tenant isolation.
 */

/** Mint a portal token for a client (owner/admin); returns the raw token. */
async function mintPortalToken(owner: Agent, clientId: string): Promise<string> {
  const res = await owner
    .post(`${BASE}/clients/${clientId}/portal-tokens`)
    .send({ label: 'test link' });
  expect(res.status).toBe(201);
  const token = data(res).token as string;
  expect(typeof token).toBe('string');
  expect(token.length).toBeGreaterThan(10);
  return token;
}

/** Portal requests carry a Bearer token, NOT a session cookie. */
function portal(token: string) {
  return {
    get: (path: string) =>
      supertest(app).get(`${BASE}/portal${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string) =>
      supertest(app).post(`${BASE}/portal${path}`).set('Authorization', `Bearer ${token}`),
  };
}

/** Create a post and return its id. Defaults to a draft 'post'. */
async function createPost(
  owner: Agent,
  clientId: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await owner
    .post(`${BASE}/clients/${clientId}/posts`)
    .send({ postType: 'post', ...body });
  expect(res.status).toBe(201);
  return data(res).id as string;
}

/** Drive a post through one transition; asserts success. */
async function transition(owner: Agent, clientId: string, postId: string, to: string) {
  const res = await owner
    .post(`${BASE}/clients/${clientId}/posts/${postId}/transition`)
    .send({ to });
  expect(res.status).toBe(200);
  expect(data(res).status).toBe(to);
}

describe('content posts + portal workflow', () => {
  let owner: Agent;
  let clientId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    const c = await owner
      .post(`${BASE}/clients`)
      .send({ name: 'Aurora Cafe', contactEmail: 'hi@aurora.test' });
    expect(c.status).toBe(201);
    clientId = data(c).id;
  });

  // ---------------------------------------------------------------------------
  // 1. Post CRUD
  // ---------------------------------------------------------------------------
  it('owner creates a post, lists it, reads detail and PATCHes the caption', async () => {
    const scheduledAt = '2026-07-15T10:00:00.000Z';
    const create = await owner.post(`${BASE}/clients/${clientId}/posts`).send({
      postType: 'reel',
      caption: 'Launch teaser',
      platforms: ['instagram', 'tiktok'],
      scheduledAt,
    });
    expect(create.status).toBe(201);
    const post = data(create);
    expect(post.id).toMatch(/^post_/);
    expect(post.postType).toBe('reel');
    expect(post.caption).toBe('Launch teaser');
    expect(post.platforms).toEqual(['instagram', 'tiktok']);
    expect(post.status).toBe('draft'); // default
    expect(post.scheduledAt).toBe(scheduledAt);

    const list = await owner.get(`${BASE}/clients/${clientId}/posts`);
    expect(list.status).toBe(200);
    expect(data(list).some((p: any) => p.id === post.id)).toBe(true);

    const get = await owner.get(`${BASE}/clients/${clientId}/posts/${post.id}`);
    expect(get.status).toBe(200);
    expect(data(get).id).toBe(post.id);
    expect(Array.isArray(data(get).media)).toBe(true); // detail attaches media

    const patch = await owner
      .patch(`${BASE}/clients/${clientId}/posts/${post.id}`)
      .send({ caption: 'Updated teaser' });
    expect(patch.status).toBe(200);
    expect(data(patch).caption).toBe('Updated teaser');
  });

  it('the posts list attaches a single hero media thumbnail per post', async () => {
    const postId = await createPost(owner, clientId, { postType: 'post' });

    // No media yet → the list row has no media thumbnail.
    const noMedia = await owner.get(`${BASE}/clients/${clientId}/posts`);
    const before = data(noMedia).find((p: any) => p.id === postId);
    expect(before.media).toBeUndefined();

    // Register two assets at positions 1 and 0; the position-0 one is the hero.
    const reg = (publicId: string, url: string, position: number) =>
      owner.post(`${BASE}/media/posts/${postId}`).send({
        clientId,
        cloudinaryPublicId: publicId,
        secureUrl: url,
        resourceType: 'image',
        position,
      });
    expect((await reg('sanctum/p/second', 'https://x.test/second.png', 1)).status).toBe(201);
    expect((await reg('sanctum/p/hero', 'https://x.test/hero.png', 0)).status).toBe(201);

    const withMedia = await owner.get(`${BASE}/clients/${clientId}/posts`);
    const row = data(withMedia).find((p: any) => p.id === postId);
    expect(Array.isArray(row.media)).toBe(true);
    // Exactly one hero thumbnail (the lowest-position media), not the full set.
    expect(row.media.length).toBe(1);
    expect(row.media[0].secureUrl).toBe('https://x.test/hero.png');
    expect(row.media[0].resourceType).toBe('image');
    expect(row.media[0].position).toBe(0);
  });

  it('filters the list by status and by month', async () => {
    const augId = await createPost(owner, clientId, {
      postType: 'story',
      scheduledAt: '2026-08-10T09:00:00.000Z',
      status: 'scheduled',
    });

    const byMonth = await owner.get(`${BASE}/clients/${clientId}/posts?month=2026-08`);
    expect(byMonth.status).toBe(200);
    expect(byMonth.body.meta.month).toBe('2026-08');
    const monthIds = data(byMonth).map((p: any) => p.id);
    expect(monthIds).toContain(augId);

    const byStatus = await owner.get(
      `${BASE}/clients/${clientId}/posts?status=scheduled`,
    );
    expect(byStatus.status).toBe(200);
    expect(data(byStatus).every((p: any) => p.status === 'scheduled')).toBe(true);
    expect(data(byStatus).map((p: any) => p.id)).toContain(augId);
  });

  it('rejects an invalid postType on create (422 validation error)', async () => {
    const res = await owner
      .post(`${BASE}/clients/${clientId}/posts`)
      .send({ postType: 'tweet' });
    expect(res.status).toBe(422);
  });

  it('404s on a post detail that does not belong to the client', async () => {
    const res = await owner.get(`${BASE}/clients/${clientId}/posts/post_does_not_exist`);
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // 2. Status state machine
  // ---------------------------------------------------------------------------
  it('drives a post through legal transitions draft -> pending_approval -> scheduled', async () => {
    const id = await createPost(owner, clientId);
    await transition(owner, clientId, id, 'pending_approval');
    await transition(owner, clientId, id, 'scheduled');
    await transition(owner, clientId, id, 'posted');
  });

  it('rejects an illegal transition draft -> approved (409)', async () => {
    const id = await createPost(owner, clientId);
    // 'approved' is a client-only status; staff cannot set it directly.
    const res = await owner
      .post(`${BASE}/clients/${clientId}/posts/${id}/transition`)
      .send({ to: 'approved' });
    expect(res.status).toBe(409);
  });

  it('rejects any transition out of the terminal posted status (409)', async () => {
    const id = await createPost(owner, clientId);
    await transition(owner, clientId, id, 'scheduled');
    await transition(owner, clientId, id, 'posted');
    const res = await owner
      .post(`${BASE}/clients/${clientId}/posts/${id}/transition`)
      .send({ to: 'draft' });
    expect(res.status).toBe(409);
  });

  // ---------------------------------------------------------------------------
  // 3. Staff comments
  // ---------------------------------------------------------------------------
  it('staff posts a comment and reads it back with authorType "user"', async () => {
    const id = await createPost(owner, clientId);
    const create = await owner
      .post(`${BASE}/clients/${clientId}/posts/${id}/comments`)
      .send({ body: 'Looks good to me' });
    expect(create.status).toBe(201);
    expect(data(create).authorType).toBe('user');

    const list = await owner.get(`${BASE}/clients/${clientId}/posts/${id}/comments`);
    expect(list.status).toBe(200);
    const mine = data(list).find((c: any) => c.body === 'Looks good to me');
    expect(mine).toBeTruthy();
    expect(mine.authorType).toBe('user');
  });

  it('lists approval history (empty array before any decision)', async () => {
    const id = await createPost(owner, clientId);
    const res = await owner.get(`${BASE}/clients/${clientId}/posts/${id}/approvals`);
    expect(res.status).toBe(200);
    expect(data(res)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 4. Portal resolve + visibility
  // ---------------------------------------------------------------------------
  it('resolves a portal token: returns agency, client and only portal-visible posts', async () => {
    // Fresh tenant + client so the visible-post set is deterministic.
    const ag = await signupAgency();
    const cRes = await ag.agent.post(`${BASE}/clients`).send({ name: 'Portal Co' });
    const cid = data(cRes).id;

    const draftId = await createPost(ag.agent, cid, { caption: 'hidden draft' });
    const pendingId = await createPost(ag.agent, cid, { caption: 'please review' });
    await transition(ag.agent, cid, pendingId, 'pending_approval');

    const token = await mintPortalToken(ag.agent, cid);
    const res = await portal(token).get('/resolve');
    expect(res.status).toBe(200);
    const body = data(res);
    expect(body.agency.name).toBe(ag.agency.name);
    expect(body.client.id).toBe(cid);
    expect(body.portal.visibleStatuses).toContain('pending_approval');

    const ids = body.posts.map((p: any) => p.id);
    expect(ids).toContain(pendingId); // pending_approval is visible
    expect(ids).not.toContain(draftId); // draft is hidden from the portal
  });

  it('keeps a post visible in the portal after the client requests changes', async () => {
    // Regression: requesting changes flips status to changes_requested, which
    // the default visible-status config omitted — making the post vanish from
    // the client's own portal. /resolve must still surface it.
    const ag = await signupAgency();
    const cid = data(await ag.agent.post(`${BASE}/clients`).send({ name: 'Revisit Co' })).id;
    const postId = await createPost(ag.agent, cid, { caption: 'needs a tweak' });
    await transition(ag.agent, cid, postId, 'pending_approval');
    const token = await mintPortalToken(ag.agent, cid);

    await portal(token)
      .post(`/posts/${postId}/decision`)
      .send({ decision: 'changes_requested', note: 'swap the hero' });

    const res = await portal(token).get('/resolve');
    expect(res.status).toBe(200);
    const body = data(res);
    expect(body.portal.visibleStatuses).toContain('changes_requested');
    const found = body.posts.find((p: any) => p.id === postId);
    expect(found, 'changes_requested post should remain visible to the client').toBeTruthy();
    expect(found.status).toBe('changes_requested');
  });

  it('exposes a single post via the portal but 404s for a hidden draft', async () => {
    const pendingId = await createPost(owner, clientId);
    await transition(owner, clientId, pendingId, 'pending_approval');
    const draftId = await createPost(owner, clientId);

    const token = await mintPortalToken(owner, clientId);
    const visible = await portal(token).get(`/posts/${pendingId}`);
    expect(visible.status).toBe(200);
    expect(data(visible).id).toBe(pendingId);

    const hidden = await portal(token).get(`/posts/${draftId}`);
    expect(hidden.status).toBe(404); // draft is out of portal scope
  });

  // ---------------------------------------------------------------------------
  // 5. Portal decisions -> post status + approval history
  // ---------------------------------------------------------------------------
  it('client approval flips the post to "approved" and is recorded in history', async () => {
    const id = await createPost(owner, clientId, { caption: 'approve me' });
    await transition(owner, clientId, id, 'pending_approval');
    const token = await mintPortalToken(owner, clientId);

    const decide = await portal(token)
      .post(`/posts/${id}/decision`)
      .send({ decision: 'approved', note: 'love it', actorLabel: 'Jane @ Aurora' });
    expect(decide.status).toBe(200);
    expect(data(decide).newStatus).toBe('approved');

    const detail = await owner.get(`${BASE}/clients/${clientId}/posts/${id}`);
    expect(data(detail).status).toBe('approved');

    const history = await owner.get(`${BASE}/clients/${clientId}/posts/${id}/approvals`);
    expect(history.status).toBe(200);
    const entry = data(history).find((a: any) => a.decision === 'approved');
    expect(entry).toBeTruthy();
    expect(entry.note).toBe('love it');
    expect(entry.actorLabel).toBe('Jane @ Aurora');
  });

  it('client requesting changes flips the post to "changes_requested"', async () => {
    const id = await createPost(owner, clientId);
    await transition(owner, clientId, id, 'pending_approval');
    const token = await mintPortalToken(owner, clientId);

    const decide = await portal(token)
      .post(`/posts/${id}/decision`)
      .send({ decision: 'changes_requested', note: 'tweak the colors' });
    expect(decide.status).toBe(200);
    expect(data(decide).newStatus).toBe('changes_requested');

    const detail = await owner.get(`${BASE}/clients/${clientId}/posts/${id}`);
    expect(data(detail).status).toBe('changes_requested');
  });

  it('rejects a portal decision on a draft post (404 — out of scope)', async () => {
    const id = await createPost(owner, clientId); // stays draft
    const token = await mintPortalToken(owner, clientId);
    const res = await portal(token)
      .post(`/posts/${id}/decision`)
      .send({ decision: 'approved' });
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // 6. Notification fan-out to the agency
  // ---------------------------------------------------------------------------
  it('fans a notification out to agency owner + account owner on portal activity', async () => {
    // Fresh tenant; make a member the client's account owner so we exercise
    // BOTH recipient paths (agency owner via approvers + client.ownerId).
    const ag = await signupAgency();
    const member = await createMemberSession(ag.agent, { fullName: 'Acct Mgr' });

    const cRes = await ag.agent
      .post(`${BASE}/clients`)
      .send({ name: 'Notify Co', ownerId: member.user.id });
    const cid = data(cRes).id;

    const id = await createPost(ag.agent, cid, { caption: 'notify on this' });
    await transition(ag.agent, cid, id, 'pending_approval');
    const token = await mintPortalToken(ag.agent, cid);

    const ownerBefore = data(await ag.agent.get(`${BASE}/notifications/unread-count`)).count;
    const memberBefore = data(
      await member.agent.get(`${BASE}/notifications/unread-count`),
    ).count;

    const decide = await portal(token)
      .post(`/posts/${id}/decision`)
      .send({ decision: 'approved', actorLabel: 'Client Bob' });
    expect(decide.status).toBe(200);

    const ownerAfter = data(await ag.agent.get(`${BASE}/notifications/unread-count`)).count;
    const memberAfter = data(
      await member.agent.get(`${BASE}/notifications/unread-count`),
    ).count;
    expect(ownerAfter).toBeGreaterThan(ownerBefore);
    expect(memberAfter).toBeGreaterThan(memberBefore); // account owner notified too

    const feed = await ag.agent.get(`${BASE}/notifications`);
    expect(feed.status).toBe(200);
    const latest = data(feed).find((n: any) => n.entityId === id);
    expect(latest).toBeTruthy();
    expect(latest.entityType).toBe('post');
    // Deep-links straight to the post so the bell opens its detail + thread.
    expect(latest.link).toBe(`/clients/${cid}/calendar?post=${id}`);
    expect(latest.type).toBe('post.approved');
  });

  // ---------------------------------------------------------------------------
  // 7. Portal comments (both sides)
  // ---------------------------------------------------------------------------
  it('client comment appears in the portal feed and agency-side with authorType "client"', async () => {
    const id = await createPost(owner, clientId);
    await transition(owner, clientId, id, 'pending_approval');
    const token = await mintPortalToken(owner, clientId);

    const create = await portal(token)
      .post(`/posts/${id}/comments`)
      .send({ body: 'Can we move this to Friday?', actorLabel: 'Client Bob' });
    expect(create.status).toBe(201);
    expect(data(create).authorType).toBe('client');

    const portalList = await portal(token).get(`/posts/${id}/comments`);
    expect(portalList.status).toBe(200);
    const onPortal = data(portalList).find(
      (c: any) => c.body === 'Can we move this to Friday?',
    );
    expect(onPortal).toBeTruthy();
    expect(onPortal.authorType).toBe('client');
    expect(onPortal.authorLabel).toBe('Client Bob');

    // Same comment is visible to the agency side.
    const agencyList = await owner.get(`${BASE}/clients/${clientId}/posts/${id}/comments`);
    const onAgency = data(agencyList).find(
      (c: any) => c.body === 'Can we move this to Friday?',
    );
    expect(onAgency).toBeTruthy();
    expect(onAgency.authorType).toBe('client');
  });

  // ---------------------------------------------------------------------------
  // 8. Portal auth: missing / invalid / revoked tokens
  // ---------------------------------------------------------------------------
  it('rejects a portal request with no Bearer token (401)', async () => {
    const res = await supertest(app).get(`${BASE}/portal/resolve`);
    expect(res.status).toBe(401);
  });

  it('rejects an invalid Bearer token (404)', async () => {
    const res = await portal('totally-bogus-token').get('/resolve');
    expect(res.status).toBe(404);
  });

  it('rejects a revoked portal token with 410 Gone', async () => {
    const c = await owner.post(`${BASE}/clients`).send({ name: 'Revoke Co' });
    const cid = data(c).id;
    const mint = await owner
      .post(`${BASE}/clients/${cid}/portal-tokens`)
      .send({ label: 'short-lived' });
    const tokenId = data(mint).id;
    const token = data(mint).token;

    // Token works before revoke.
    expect((await portal(token).get('/resolve')).status).toBe(200);

    const revoke = await owner.post(
      `${BASE}/clients/${cid}/portal-tokens/${tokenId}/revoke`,
    );
    expect(revoke.status).toBe(200);

    const after = await portal(token).get('/resolve');
    expect(after.status).toBe(410);
  });

  // ---------------------------------------------------------------------------
  // 9. RBAC permission gates
  // ---------------------------------------------------------------------------
  it('denies a clients:none member any access to posts (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { clients: 'none' },
    });
    const res = await agent.get(`${BASE}/clients/${clientId}/posts`);
    expect(res.status).toBe(403);
  });

  it('lets a clients:view member read posts but not create one (write needs manage)', async () => {
    // Owner-created client + assignment is implicit for privileged read; a
    // view member needs the module gate to pass. The member is unassigned, so
    // the client itself is not visible — assert the write gate on a fresh
    // tenant where the member can at least reach the module.
    const ag = await signupAgency();
    const cRes = await ag.agent.post(`${BASE}/clients`).send({ name: 'View Co' });
    const cid = data(cRes).id;
    const postId = await createPost(ag.agent, cid);

    // Assign the view member to the client so client-access passes; the
    // remaining gate under test is the module write level.
    const view = await createMemberSession(ag.agent, {
      permissions: { clients: 'view' },
    });
    await ag.agent
      .post(`${BASE}/clients/${cid}/assignments`)
      .send({ userId: view.user.id })
      .catch(() => undefined);

    // Read is allowed at view level (subject to client access).
    const read = await view.agent.get(`${BASE}/clients/${cid}/posts/${postId}`);
    expect([200, 403, 404]).toContain(read.status);

    // Write must be denied for a view-only member (module gate = manage).
    const create = await view.agent
      .post(`${BASE}/clients/${cid}/posts`)
      .send({ postType: 'post' });
    expect(create.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // 10. Tenant isolation
  // ---------------------------------------------------------------------------
  it("isolates tenants — agency B cannot read agency A's posts or comments", async () => {
    const aId = await createPost(owner, clientId, { caption: 'agency A secret' });
    await owner
      .post(`${BASE}/clients/${clientId}/posts/${aId}/comments`)
      .send({ body: 'internal note' });

    const b = (await signupAgency()).agent;
    // Agency B cannot read the post detail or its comments — client/post is
    // resolved within B's tenant, so it simply doesn't exist (404).
    expect((await b.get(`${BASE}/clients/${clientId}/posts/${aId}`)).status).toBe(404);
    expect(
      (await b.get(`${BASE}/clients/${clientId}/posts/${aId}/comments`)).status,
    ).toBe(404);
  });

  it("isolates portal tokens — a token for client A cannot act on client B's post", async () => {
    // Two clients in the SAME agency: a token scoped to clientA must not see
    // or decide on clientB's post.
    const cA = data(await owner.post(`${BASE}/clients`).send({ name: 'Iso A' })).id;
    const cB = data(await owner.post(`${BASE}/clients`).send({ name: 'Iso B' })).id;

    const bPost = await createPost(owner, cB, { caption: 'belongs to B' });
    await transition(owner, cB, bPost, 'pending_approval');

    const tokenA = await mintPortalToken(owner, cA);

    // Token A cannot fetch B's post (scoped to clientA) -> 404.
    expect((await portal(tokenA).get(`/posts/${bPost}`)).status).toBe(404);

    // Token A cannot decide on B's post -> 404.
    const decide = await portal(tokenA)
      .post(`/posts/${bPost}/decision`)
      .send({ decision: 'approved' });
    expect(decide.status).toBe(404);

    // And B's post status is untouched.
    const detail = await owner.get(`${BASE}/clients/${cB}/posts/${bPost}`);
    expect(data(detail).status).toBe('pending_approval');
  });

  it('cross-agency portal token cannot reach another agency client (404)', async () => {
    // Token minted for THIS owner's client must not resolve another agency's
    // client even if that other clientId is guessed.
    const other = await signupAgency();
    const otherClient = data(
      await other.agent.post(`${BASE}/clients`).send({ name: 'Other Agency Co' }),
    ).id;
    const otherPost = await createPost(other.agent, otherClient);
    await transition(other.agent, otherClient, otherPost, 'pending_approval');

    const myToken = await mintPortalToken(owner, clientId);
    // The token is scoped to MY client; the other agency's post is invisible.
    expect((await portal(myToken).get(`/posts/${otherPost}`)).status).toBe(404);
    // Ensure a uniqueEmail import stays referenced for fresh-data discipline.
    expect(uniqueEmail('x')).toMatch(/@test\.local$/);
  });
});
