import crypto from 'node:crypto';
import supertest from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  app,
  BASE,
  createMemberSession,
  data,
  db,
  schema,
  signupAgency,
  type Agent,
} from './helpers';
import { publishPost, runDuePublishing } from '../src/services/social-publish';

type Handler = unknown | ((params: Record<string, string>) => unknown);

/**
 * Stub the Meta Graph API at `fetch`. Keys are "METHOD /path" with the version
 * prefix stripped (e.g. "POST /ig_1/media"); values are a JSON body or a
 * function of the request params. Unstubbed calls fail loudly. Returns the
 * recorded calls.
 */
function stubGraph(routes: Record<string, Handler>) {
  const calls: { key: string; params: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    const params = Object.fromEntries(
      method === 'GET' ? url.searchParams : new URLSearchParams(init.body as URLSearchParams),
    );
    const key = `${method} ${path}`;
    calls.push({ key, params });
    if (!(key in routes)) {
      return new Response(JSON.stringify({ error: { message: `unstubbed ${key}`, code: 100 } }), {
        status: 400,
      });
    }
    const h = routes[key];
    const body = typeof h === 'function' ? (h as (p: Record<string, string>) => unknown)(params) : h;
    return new Response(JSON.stringify(body), { status: (body as any)?.error ? 400 : 200 });
  });
  return calls;
}

/** A Meta `signed_request` (deauthorize / data-deletion callbacks). */
function signedRequest(payload: object, secret = 'test-meta-secret'): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${sig}.${body}`;
}

const PAGES = {
  data: [
    {
      id: 'page_1',
      name: 'Social Co Page',
      access_token: 'PAGE-TOKEN-SECRET',
      picture: { data: { url: 'https://cdn.test/page.png' } },
      instagram_business_account: {
        id: 'ig_1',
        username: 'socialco',
        name: 'Social Co',
        profile_picture_url: 'https://cdn.test/ig.png',
        followers_count: 1200,
      },
    },
    { id: 'page_2', name: 'Unrelated Page', access_token: 'OTHER-PAGE-TOKEN' },
  ],
};

describe('social: Meta connect + publishing', () => {
  let owner: Agent;
  let agencyId: string;
  let clientId: string;

  beforeAll(async () => {
    const s = await signupAgency();
    owner = s.agent;
    agencyId = s.agency.id;
    clientId = data(await owner.post(`${BASE}/clients`).send({ name: 'Social Co' })).id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const social = (path = '') => `${BASE}/clients/${clientId}/social${path}`;

  /** Storage key + Cloudinary URL for a post asset (must live under this agency/client). */
  const assetFor = (postId: string, name: string) => {
    const key = `agency/${agencyId}/client/${clientId}/post/${postId}/${name}`;
    return { key, url: `https://res.cloudinary.com/test-cloud/image/upload/v1/${key}` };
  };

  /** Stand-in for the client approving in the portal (a `post.approved` decision). */
  async function clientApproves(postId: string) {
    await db
      .update(schema.contentPosts)
      .set({ status: 'approved' })
      .where(and(eq(schema.contentPosts.id, postId), eq(schema.contentPosts.agencyId, agencyId)));
    await db.insert(schema.auditLog).values({
      id: `aud_test_${crypto.randomBytes(6).toString('hex')}`,
      agencyId,
      actorType: 'client',
      action: 'post.approved',
      entityType: 'post',
      entityId: postId,
    });
  }

  /** Draft → media → sent for approval → client-approved → scheduled. */
  async function makePost(
    over: Record<string, unknown>,
    media: { name: string; type: 'image' | 'video' }[],
  ): Promise<{ id: string; urls: string[] }> {
    const post = data(
      await owner.post(`${BASE}/clients/${clientId}/posts`).send({
        postType: 'post',
        platforms: ['instagram', 'facebook'],
        caption: 'Hello world',
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        ...over,
      }),
    );
    const urls: string[] = [];
    for (const [i, m] of media.entries()) {
      const a = assetFor(post.id, m.name);
      const r = await owner.post(`${BASE}/media/posts/${post.id}`).send({
        clientId,
        cloudinaryPublicId: a.key,
        secureUrl: a.url,
        resourceType: m.type,
        position: i,
      });
      expect(r.status).toBe(201);
      urls.push(a.url);
    }
    const transition = (to: string) =>
      owner.post(`${BASE}/clients/${clientId}/posts/${post.id}/transition`).send({ to });
    expect((await transition('pending_approval')).status).toBe(200);
    await clientApproves(post.id);
    expect((await transition('scheduled')).status).toBe(200);
    return { id: post.id, urls };
  }

  const postStatus = async (postId: string) =>
    data(await owner.get(`${BASE}/clients/${clientId}/posts/${postId}`)).status;

  it('reports Meta as configured with no accounts yet', async () => {
    const s = data(await owner.get(social()));
    expect(s.configured).toBe(true);
    expect(s.accounts).toEqual([]);
  });

  it('connects a Page + its Instagram account without exposing tokens', async () => {
    const start = data(await owner.post(social('/meta/connect')).send({}));
    const auth = new URL(start.authorizeUrl);
    expect(auth.searchParams.get('client_id')).toBe('test-meta-app');
    expect(auth.searchParams.get('scope')).toContain('instagram_content_publish');
    const state = auth.searchParams.get('state')!;
    // A second login that is never completed (a reserved, pending session).
    const unused = new URL(data(await owner.post(social('/meta/connect')).send({})).authorizeUrl);

    stubGraph({
      'GET /oauth/access_token': (p) => ({
        access_token: p.grant_type === 'fb_exchange_token' ? 'LONG-USER-TOKEN' : 'SHORT-USER-TOKEN',
      }),
      'GET /me': { id: 'fb_user_1', name: 'Staff Member' },
      'GET /me/accounts': PAGES,
    });
    const cb = await supertest(app)
      .get(`${BASE}/oauth/meta/callback`)
      .query({ code: 'the-code', state });
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.location);
    expect(back.pathname).toBe(`/clients/${clientId}`);
    const sessionId = back.searchParams.get('meta_session')!;
    expect(sessionId).toBeTruthy();

    // The OAuth state is single-use: a replay is rejected.
    const replay = await supertest(app)
      .get(`${BASE}/oauth/meta/callback`)
      .query({ code: 'the-code', state });
    expect(replay.status).toBe(400);
    // A reserved-but-never-completed login is not a selectable session.
    const reservedId = JSON.parse(
      Buffer.from(unused.searchParams.get('state')!.split('.')[1]!, 'base64url').toString(),
    ).s as string;
    expect((await owner.get(social(`/meta/sessions/${reservedId}`))).status).toBe(404);

    const offered = await owner.get(social(`/meta/sessions/${sessionId}`));
    expect(offered.status).toBe(200);
    expect(JSON.stringify(offered.body)).not.toContain('PAGE-TOKEN-SECRET');
    expect(data(offered).pages.map((p: any) => p.id)).toEqual(['page_1', 'page_2']);

    const linked = data(
      await owner.post(social(`/meta/sessions/${sessionId}/select`)).send({ pageIds: ['page_1'] }),
    );
    expect(linked.map((a: any) => a.platform).sort()).toEqual(['facebook', 'instagram']);
    const ig = linked.find((a: any) => a.platform === 'instagram');
    expect(ig.username).toBe('socialco');
    expect(ig.followersCount).toBe(1200);
    expect(JSON.stringify(linked)).not.toContain('TOKEN');

    // The session is single-use…
    expect((await owner.get(social(`/meta/sessions/${sessionId}`))).status).toBe(404);
    // …and the real handle is mirrored onto the client for previews.
    const client = data(await owner.get(`${BASE}/clients/${clientId}`));
    expect(JSON.stringify(client)).toContain('socialco');
  });

  it('rejects a tampered login state', async () => {
    const r = await supertest(app)
      .get(`${BASE}/oauth/meta/callback`)
      .query({ code: 'x', state: 'not-a-real-state' });
    expect(r.status).toBe(400);
  });

  it("binds a connect session to the user who started it", async () => {
    const teammate = await createMemberSession(owner, {
      grants: [
        { permission: 'social_accounts.view', scope: 'organization' },
        { permission: 'social_accounts.manage', scope: 'organization' },
      ],
    });
    const start = data(await owner.post(social('/meta/connect')).send({}));
    const state = new URL(start.authorizeUrl).searchParams.get('state')!;
    stubGraph({
      'GET /oauth/access_token': { access_token: 'USER-TOKEN' },
      'GET /me': { id: 'fb_user_1', name: 'Staff Member' },
      'GET /me/accounts': PAGES,
    });
    const cb = await supertest(app).get(`${BASE}/oauth/meta/callback`).query({ code: 'c', state });
    const sessionId = new URL(cb.headers.location).searchParams.get('meta_session')!;
    expect((await teammate.agent.get(social(`/meta/sessions/${sessionId}`))).status).toBe(404);
    expect(
      (await teammate.agent.post(social(`/meta/sessions/${sessionId}/select`)).send({ pageIds: ['page_1'] }))
        .status,
    ).toBe(404);
    expect((await owner.get(social(`/meta/sessions/${sessionId}`))).status).toBe(200);
  });

  it('publishes an image post to Instagram and the Page — once', async () => {
    const { id: postId, urls } = await makePost({}, [{ name: 'a.jpg', type: 'image' }]);
    const calls = stubGraph({
      'POST /ig_1/media': { id: 'container_1' },
      'POST /ig_1/media_publish': { id: 'ig_media_1' },
      'GET /ig_media_1': { permalink: 'https://www.instagram.com/p/abc/' },
      'POST /page_1/photos': { id: 'photo_1', post_id: 'page_1_77' },
    });
    const r = data(await owner.post(social(`/posts/${postId}/publish`)).send({}));
    expect(r.results).toHaveLength(2);
    expect(r.results.every((x: any) => x.status === 'published')).toBe(true);

    const igCall = calls.find((c) => c.key === 'POST /ig_1/media')!;
    expect(igCall.params.image_url).toBe(urls[0]);
    expect(igCall.params.caption).toBe('Hello world');
    expect(igCall.params.access_token).toBe('PAGE-TOKEN-SECRET');

    expect(await postStatus(postId)).toBe('posted');
    const pubs = data(await owner.get(social(`/posts/${postId}/publications`)));
    expect(pubs.find((p: any) => p.platform === 'instagram').permalink).toBe(
      'https://www.instagram.com/p/abc/',
    );

    // Publishing again never re-posts.
    const before = calls.length;
    await owner.post(social(`/posts/${postId}/publish`)).send({});
    expect(calls.length).toBe(before);
  });

  it('waits for an Instagram reel to process, then publishes it on a later run', async () => {
    const { id: postId, urls } = await makePost({ postType: 'reel', platforms: ['instagram'] }, [
      { name: 'r.mp4', type: 'video' },
    ]);
    let calls = stubGraph({
      'POST /ig_1/media': { id: 'container_2' },
      'GET /container_2': { status_code: 'IN_PROGRESS' },
    });
    const first = await publishPost(agencyId, postId, { manual: true, maxWaitMs: 0 });
    expect(first.map((x) => x.status)).toEqual(['processing']);
    const create = calls.find((c) => c.key === 'POST /ig_1/media')!;
    expect(create.params.media_type).toBe('REELS');
    expect(create.params.video_url).toBe(urls[0]);

    calls = stubGraph({
      'GET /container_2': { status_code: 'FINISHED' },
      'POST /ig_1/media_publish': { id: 'ig_media_2' },
      'GET /ig_media_2': { permalink: 'https://www.instagram.com/reel/xyz/' },
    });
    const second = await publishPost(agencyId, postId, { manual: true, maxWaitMs: 0 });
    expect(second.map((x) => x.status)).toEqual(['published']);
    // The processed container is reused, not uploaded again.
    expect(calls.some((c) => c.key === 'POST /ig_1/media')).toBe(false);
    expect(await postStatus(postId)).toBe('posted');
  });

  it('auto-publishes posts that came due, but leaves ones outside the 24h window', async () => {
    const { id: due } = await makePost({ platforms: ['facebook'] }, [{ name: 'b.jpg', type: 'image' }]);
    const { id: stale } = await makePost(
      {
        platforms: ['facebook'],
        scheduledAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      },
      [{ name: 'c.jpg', type: 'image' }],
    );
    stubGraph({ 'POST /page_1/photos': { id: 'photo_2', post_id: 'page_1_78' } });
    const tally = await runDuePublishing(new Date(), { maxWaitMs: 0 });
    expect(tally.published).toBeGreaterThanOrEqual(1);
    expect(await postStatus(due)).toBe('posted');
    expect(await postStatus(stale)).toBe('scheduled');
    // The job acts (and is audited) as a system actor.
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, due), eq(schema.auditLog.action, 'social.auto_publish')));
    expect(rows[0]?.actorType).toBe('system');
  });

  it('never publishes a scheduled post that was never approved, or whose approval an edit voided', async () => {
    // Legacy: scheduled without any client approval.
    const legacy = data(
      await owner.post(`${BASE}/clients/${clientId}/posts`).send({
        postType: 'post',
        platforms: ['facebook'],
        caption: 'Never approved',
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).id as string;
    await db.update(schema.contentPosts).set({ status: 'scheduled' }).where(eq(schema.contentPosts.id, legacy));

    const { id: edited } = await makePost({ platforms: ['facebook'] }, [{ name: 'v.jpg', type: 'image' }]);
    const edit = await owner
      .patch(`${BASE}/clients/${clientId}/posts/${edited}`)
      .send({ caption: 'Changed after approval' });
    expect(edit.status).toBe(200);
    expect(data(edit).status).toBe('draft');
    expect(data(edit).approvalReset).toBe(true);
    // Even if forced back to scheduled, the approval is no longer valid.
    await db.update(schema.contentPosts).set({ status: 'scheduled' }).where(eq(schema.contentPosts.id, edited));

    const calls = stubGraph({});
    await runDuePublishing(new Date(), { maxWaitMs: 0 });
    expect(calls).toHaveLength(0);
    expect((await owner.post(social(`/posts/${legacy}/publish`)).send({})).status).toBe(409);
    expect((await owner.post(social(`/posts/${edited}/publish`)).send({})).status).toBe(409);
  });

  it('skips an account whose auto-publish is off', async () => {
    const fb = data(await owner.get(social())).accounts.find((a: any) => a.platform === 'facebook');
    const off = data(await owner.patch(social(`/${fb.id}`)).send({ autoPublish: false }));
    expect(off.autoPublish).toBe(false);

    const { id: postId } = await makePost({ platforms: ['facebook'] }, [{ name: 'd.jpg', type: 'image' }]);
    const calls = stubGraph({});
    await runDuePublishing(new Date(), { maxWaitMs: 0 });
    expect(calls).toHaveLength(0);
    expect(await postStatus(postId)).toBe('scheduled');

    await owner.patch(social(`/${fb.id}`)).send({ autoPublish: true });
  });

  it('marks the account expired when Meta rejects its token', async () => {
    const { id: postId } = await makePost({ platforms: ['instagram'] }, [{ name: 'e.jpg', type: 'image' }]);
    stubGraph({
      'POST /ig_1/media': {
        error: { message: 'Error validating access token: session has expired', code: 190 },
      },
    });
    const r = data(await owner.post(social(`/posts/${postId}/publish`)).send({}));
    expect(r.results[0].status).toBe('failed');
    expect(r.results[0].error).toContain('access token');
    const ig = data(await owner.get(social())).accounts.find((a: any) => a.platform === 'instagram');
    expect(ig.status).toBe('expired');
    expect(await postStatus(postId)).toBe('scheduled');
  });

  it('requires social_accounts.manage to change accounts and posts.publish to publish', async () => {
    const viewer = await createMemberSession(owner, {
      grants: [
        { permission: 'social_accounts.view', scope: 'organization' },
        { permission: 'posts.view', scope: 'organization' },
      ],
    });
    expect((await viewer.agent.get(social())).status).toBe(200);
    expect((await viewer.agent.post(social('/meta/connect')).send({})).status).toBe(403);
    const fb = data(await owner.get(social())).accounts.find((a: any) => a.platform === 'facebook');
    expect((await viewer.agent.patch(social(`/${fb.id}`)).send({ autoPublish: false })).status).toBe(403);
    expect((await viewer.agent.delete(social(`/${fb.id}`))).status).toBe(403);
    const { id: postId } = await makePost({ platforms: ['facebook'] }, [{ name: 'w.jpg', type: 'image' }]);
    expect((await viewer.agent.post(social(`/posts/${postId}/publish`)).send({})).status).toBe(403);
  });

  it('honours Meta deauthorize + data-deletion callbacks and rejects forged ones', async () => {
    const forged = await supertest(app)
      .post(`${BASE}/oauth/meta/deauthorize`)
      .type('form')
      .send({ signed_request: signedRequest({ user_id: 'fb_user_1' }, 'wrong-secret') });
    expect(forged.status).toBe(400);
    expect(data(await owner.get(social())).accounts).toHaveLength(2);

    const deauth = await supertest(app)
      .post(`${BASE}/oauth/meta/deauthorize`)
      .type('form')
      .send({ signed_request: signedRequest({ user_id: 'fb_user_1', algorithm: 'HMAC-SHA256' }) });
    expect(deauth.status).toBe(200);
    expect(data(await owner.get(social())).accounts).toEqual([]);

    const del = await supertest(app)
      .post(`${BASE}/oauth/meta/data-deletion`)
      .type('form')
      .send({ signed_request: signedRequest({ user_id: 'fb_user_1' }) });
    expect(del.status).toBe(200);
    expect(del.body.confirmation_code).toBeTruthy();
    expect(del.body.url).toContain('/oauth/meta/deletion-status?code=');
  });

  it('keeps social accounts tenant-scoped', async () => {
    const other = (await signupAgency()).agent;
    expect((await other.get(social())).status).toBe(404);
    expect((await other.post(social('/meta/connect')).send({})).status).toBe(404);
  });
});
