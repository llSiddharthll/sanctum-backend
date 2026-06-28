import { describe, it, expect, beforeAll } from 'vitest';
import {
  BASE,
  signupAgency,
  createMemberSession,
  data,
  type Agent,
} from './helpers';

/**
 * Platform workflows: Media signing, client-scoped AI content generation,
 * the agency-level AI assistant, and Analytics.
 *
 * Test-env facts these tests rely on:
 *  - GEMINI_API_KEY is empty -> all AI endpoints take the deterministic LOCAL
 *    FALLBACK path (source: 'fallback'); they return 200/201 with content, never
 *    501. We assert shape/source, never exact generated text.
 *  - Cloudinary creds are dummy -> /media/sign signs locally and never calls
 *    Cloudinary, so only the response shape is asserted (no real upload).
 *  - The signup flow attaches the lowest-sortOrder plan ('studio',
 *    maxAiGenerations = 5) as a trialing subscription, so the monthly AI quota
 *    is 5 succeeded runs per period.
 *  - requireClientAccess() throws 404 (not 403) for a non-existent OR
 *    cross-tenant client, so media-sign denials surface as 404.
 *  - Zod validation failures serialize as HTTP 422 / code VALIDATION_ERROR.
 */

/** Create a client for `agent` and return its id. */
async function createClient(agent: Agent, name = 'Aurora Cafe'): Promise<string> {
  const res = await agent.post(`${BASE}/clients`).send({ name });
  expect(res.status).toBe(201);
  return data(res).id;
}

const THIS_MONTH = (() => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
})();

describe('platform: media signing', () => {
  let owner: Agent;
  let clientId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = await createClient(owner, 'Media Co');
  });

  it('signs a Cloudinary upload for an accessible client (200, full payload)', async () => {
    const res = await owner.post(`${BASE}/media/sign`).send({ clientId });
    expect(res.status).toBe(200);
    const d = data(res);

    // Cloudinary credentials / signing fields.
    expect(typeof d.cloudName).toBe('string');
    expect(typeof d.apiKey).toBe('string');
    expect(typeof d.timestamp).toBe('number');
    expect(typeof d.signature).toBe('string');
    expect(d.signature.length).toBeGreaterThan(0);

    // Tenant-scoped folder + server-assigned publicId.
    expect(typeof d.folder).toBe('string');
    expect(d.folder).toContain(clientId);
    expect(d.folder).toMatch(/^agency\/.+\/client\/.+\/post\/_staging$/);
    expect(typeof d.publicId).toBe('string');

    // Upload target + defaults.
    expect(d.resourceType).toBe('image'); // schema default
    expect(d.uploadUrl).toContain(`/${d.cloudName}/image/upload`);
    expect(Array.isArray(d.allowedFormats)).toBe(true);
    expect(typeof d.maxBytes).toBe('number');
    expect(typeof d.expiresAt).toBe('string');
  });

  it('honours resourceType=video in the signed payload', async () => {
    const res = await owner
      .post(`${BASE}/media/sign`)
      .send({ clientId, resourceType: 'video' });
    expect(res.status).toBe(200);
    const d = data(res);
    expect(d.resourceType).toBe('video');
    expect(d.uploadUrl).toContain('/video/upload');
  });

  it('rejects a bad resourceType (422 validation error)', async () => {
    const res = await owner
      .post(`${BASE}/media/sign`)
      .send({ clientId, resourceType: 'audio' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('cannot sign for a non-existent client (404)', async () => {
    const res = await owner
      .post(`${BASE}/media/sign`)
      .send({ clientId: 'cli_does_not_exist' });
    expect([403, 404]).toContain(res.status);
  });

  it("cannot sign for another tenant's client (tenant isolation)", async () => {
    const other = (await signupAgency()).agent;
    const otherClientId = await createClient(other, 'Secret Co');

    const res = await owner
      .post(`${BASE}/media/sign`)
      .send({ clientId: otherClientId });
    expect([403, 404]).toContain(res.status);
  });

  it('denies a clients:none member the sign endpoint (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { clients: 'none' },
    });
    const res = await agent.post(`${BASE}/media/sign`).send({ clientId });
    expect(res.status).toBe(403);
  });
});

describe('platform: AI content generation', () => {
  let owner: Agent;
  let clientId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = await createClient(owner, 'Brand X');
  });

  it('generates a month of draft posts via the local fallback (201)', async () => {
    const res = await owner
      .post(`${BASE}/clients/${clientId}/ai/generate-month`)
      .send({ month: THIS_MONTH, postsCount: 4, postTypes: ['post', 'reel'] });

    expect(res.status).toBe(201);
    const d = data(res);
    expect(d.source).toBe('fallback'); // no GEMINI key in tests
    expect(d.status).toBe('succeeded');
    expect(d.month).toBe(THIS_MONTH);
    expect(d.postsCreated).toBe(4);
    expect(Array.isArray(d.posts)).toBe(true);
    expect(d.posts).toHaveLength(4);

    const post = d.posts[0];
    expect(post.id).toMatch(/^post_/);
    expect(typeof post.caption).toBe('string');
    expect(post.caption.length).toBeGreaterThan(0);
    expect(['post', 'reel']).toContain(post.postType);
    expect(post.status).toBe('draft');
    expect(post.aiGenerationId).toBe(d.generationId);
    expect(d.usage).toBeDefined();
  });

  it('the created drafts are persisted and visible on the posts endpoint', async () => {
    const list = await owner.get(
      `${BASE}/clients/${clientId}/posts?month=${THIS_MONTH}`,
    );
    expect(list.status).toBe(200);
    expect(data(list).length).toBeGreaterThanOrEqual(4);
    expect(data(list).every((p: any) => p.status === 'draft')).toBe(true);
  });

  it('reflects the succeeded run in GET /agency/usage (ai.used incremented)', async () => {
    const usage = await owner.get(`${BASE}/agency/usage`);
    expect(usage.status).toBe(200);
    const d = data(usage);
    expect(d.ai.limit).toBe(5); // 'studio' plan default
    expect(d.ai.used).toBeGreaterThanOrEqual(1);
  });

  it('lists the generation under GET /clients/:clientId/ai/generations', async () => {
    const res = await owner.get(`${BASE}/clients/${clientId}/ai/generations`);
    expect(res.status).toBe(200);
    const rows = data(res);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((g: any) => g.status === 'succeeded' && g.postsCreated === 4)).toBe(
      true,
    );
  });

  it('rejects a malformed month (422 validation error)', async () => {
    const res = await owner
      .post(`${BASE}/clients/${clientId}/ai/generate-month`)
      .send({ month: 'June-2026' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('denies an ai:none member content generation (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { ai: 'none' },
    });
    const res = await agent
      .post(`${BASE}/clients/${clientId}/ai/generate-month`)
      .send({ month: THIS_MONTH });
    expect(res.status).toBe(403);
  });

  it('enforces the per-plan monthly AI quota (6th run -> 402 QUOTA_EXCEEDED)', async () => {
    // Dedicated tenant so the 5 successful runs do not pollute other suites.
    const fresh = (await signupAgency()).agent;
    const cId = await createClient(fresh, 'Quota Co');

    // 'studio' allows 5 succeeded runs per period; exhaust them.
    for (let i = 0; i < 5; i++) {
      const ok = await fresh
        .post(`${BASE}/clients/${cId}/ai/generate-month`)
        .send({ month: THIS_MONTH, postsCount: 1 });
      expect(ok.status).toBe(201);
    }

    const blocked = await fresh
      .post(`${BASE}/clients/${cId}/ai/generate-month`)
      .send({ month: THIS_MONTH, postsCount: 1 });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');

    const usage = await fresh.get(`${BASE}/agency/usage`);
    expect(data(usage).ai.used).toBe(5);
  });
});

describe('platform: AI assistant', () => {
  let owner: Agent;
  let clientId: string;
  let projectId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = await createClient(owner, 'Assistant Co');
    const proj = await owner
      .post(`${BASE}/projects`)
      .send({ name: 'Launch Campaign', clientId });
    expect(proj.status).toBe(201);
    projectId = data(proj).id;
  });

  it('generates a document via the fallback template (200, markdown body)', async () => {
    const res = await owner.post(`${BASE}/ai/generate-document`).send({
      type: 'brief',
      title: 'Q3 Brief',
      context: 'Plan a product launch for a new espresso blend.',
    });
    expect(res.status).toBe(200);
    const d = data(res);
    expect(d.title).toBe('Q3 Brief');
    expect(typeof d.content).toBe('string');
    expect(d.content).toContain('# Q3 Brief'); // markdown heading from template
    expect(d.content).toContain('Plan a product launch'); // context echoed
  });

  it('rejects an unknown document type (422 validation error)', async () => {
    const res = await owner
      .post(`${BASE}/ai/generate-document`)
      .send({ type: 'novel', context: 'anything' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers a chat turn via the canned fallback reply (200)', async () => {
    const res = await owner.post(`${BASE}/ai/chat`).send({
      messages: [{ role: 'user', content: 'How many clients do we have?' }],
    });
    expect(res.status).toBe(200);
    const d = data(res);
    expect(typeof d.reply).toBe('string');
    expect(d.reply.length).toBeGreaterThan(0);
  });

  it('rejects a chat with an empty messages array (422 validation error)', async () => {
    const res = await owner.post(`${BASE}/ai/chat`).send({ messages: [] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('breaks a project into milestones + tasks and persists them (201)', async () => {
    const res = await owner
      .post(`${BASE}/ai/task-breakdown`)
      .send({ projectId });
    expect(res.status).toBe(201);
    const d = data(res);
    expect(d.projectId).toBe(projectId);
    expect(d.source).toBe('fallback');
    expect(Array.isArray(d.milestones)).toBe(true);
    expect(d.milestones.length).toBeGreaterThan(0);
    const ms = d.milestones[0];
    expect(ms.id).toMatch(/^pms_/);
    expect(Array.isArray(ms.tasks)).toBe(true);
    expect(ms.tasks.length).toBeGreaterThan(0);
    expect(ms.tasks[0].id).toMatch(/^ptk_/);
  });

  it("task-breakdown 404s for another tenant's project (isolation)", async () => {
    const other = (await signupAgency()).agent;
    const res = await other
      .post(`${BASE}/ai/task-breakdown`)
      .send({ projectId });
    expect(res.status).toBe(404);
  });

  it('denies an ai:none member the assistant (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { ai: 'none' },
    });
    const res = await agent
      .post(`${BASE}/ai/chat`)
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(403);
  });

  // ---- Social-content helpers (fallback path) ---------------------------

  it('generates caption variations via the fallback (200)', async () => {
    const res = await owner.post(`${BASE}/ai/captions`).send({
      brief: 'A cozy autumn latte launch',
      platform: 'instagram',
      tone: 'playful',
      clientId,
    });
    expect(res.status).toBe(200);
    const d = data(res);
    expect(d.source).toBe('fallback');
    expect(Array.isArray(d.variations)).toBe(true);
    expect(d.variations.length).toBe(3);
    expect(typeof d.variations[0]).toBe('string');
    expect(d.variations[0].length).toBeGreaterThan(0);
  });

  it('rejects captions with an empty brief (422 validation error)', async () => {
    const res = await owner
      .post(`${BASE}/ai/captions`)
      .send({ brief: '', platform: 'instagram' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('suggests grouped hashtags via the fallback (200)', async () => {
    const res = await owner.post(`${BASE}/ai/hashtags`).send({
      topic: 'sustainable specialty coffee roastery',
      platform: 'instagram',
      clientId,
    });
    expect(res.status).toBe(200);
    const d = data(res);
    expect(d.source).toBe('fallback');
    expect(Array.isArray(d.groups.broad)).toBe(true);
    expect(Array.isArray(d.groups.niche)).toBe(true);
    expect(Array.isArray(d.groups.branded)).toBe(true);
    // Every suggested tag is a normalized #hashtag.
    const all = [
      ...d.groups.broad,
      ...d.groups.niche,
      ...d.groups.branded,
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const tag of all) expect(tag).toMatch(/^#[a-zA-Z0-9]+$/);
  });

  it('brainstorms content ideas via the fallback (200)', async () => {
    const res = await owner.post(`${BASE}/ai/content-ideas`).send({
      niche: 'home barista accessories',
      count: 5,
      platform: 'instagram',
    });
    expect(res.status).toBe(200);
    const d = data(res);
    expect(d.source).toBe('fallback');
    expect(Array.isArray(d.ideas)).toBe(true);
    expect(d.ideas.length).toBe(5);
    expect(typeof d.ideas[0].hook).toBe('string');
    expect(typeof d.ideas[0].format).toBe('string');
    expect(typeof d.ideas[0].rationale).toBe('string');
  });

  it('repurposes content for another platform via the fallback (200)', async () => {
    const res = await owner.post(`${BASE}/ai/repurpose`).send({
      content: 'Our new espresso blend drops Friday — limited batch!',
      target: 'linkedin',
      clientId,
    });
    expect(res.status).toBe(200);
    const d = data(res);
    expect(d.source).toBe('fallback');
    expect(typeof d.content).toBe('string');
    expect(d.content.length).toBeGreaterThan(0);
    expect(d.targetLabel).toContain('LinkedIn');
  });

  it('rejects repurpose with an unknown target (422 validation error)', async () => {
    const res = await owner
      .post(`${BASE}/ai/repurpose`)
      .send({ content: 'anything', target: 'myspace' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('grounds chat in a client without leaking other tenants (200)', async () => {
    const res = await owner.post(`${BASE}/ai/chat`).send({
      messages: [{ role: 'user', content: 'Summarize this client.' }],
      clientId,
    });
    expect(res.status).toBe(200);
    const d = data(res);
    expect(typeof d.reply).toBe('string');
    expect(d.source).toBe('fallback');
  });

  it('denies an ai:none member the social helpers (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { ai: 'none' },
    });
    const res = await agent
      .post(`${BASE}/ai/captions`)
      .send({ brief: 'hi', platform: 'instagram' });
    expect(res.status).toBe(403);
  });
});

describe('platform: analytics', () => {
  let owner: Agent;
  let clientId: string;

  beforeAll(async () => {
    owner = (await signupAgency()).agent;
    clientId = await createClient(owner, 'Analytics Co');
  });

  it('returns agency-wide summary counts for the owner (200)', async () => {
    // Seed one draft and one scheduled post so the breakdown is non-empty.
    await owner
      .post(`${BASE}/clients/${clientId}/posts`)
      .send({ postType: 'post', status: 'draft' });
    await owner
      .post(`${BASE}/clients/${clientId}/posts`)
      .send({ postType: 'reel', status: 'scheduled' });

    const res = await owner.get(`${BASE}/analytics/summary`);
    expect(res.status).toBe(200);
    const d = data(res);
    expect(d.clients).toBeGreaterThanOrEqual(1);
    expect(d.posts).toBeGreaterThanOrEqual(2);
    expect(typeof d.postsByStatus).toBe('object');
    expect(d.postsByStatus.draft).toBeGreaterThanOrEqual(1);
    expect(d.postsByStatus.scheduled).toBeGreaterThanOrEqual(1);
    // postsByStatus values should sum to the posts total.
    const sum = Object.values(d.postsByStatus as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBe(d.posts);
  });

  it('lets a member with the Dashboard module view the summary (200)', async () => {
    // Gated on the Dashboard module (view); a default member has it.
    const { agent } = await createMemberSession(owner, { role: 'member' });
    const res = await agent.get(`${BASE}/analytics/summary`);
    expect(res.status).toBe(200);
  });

  it('denies a dashboard:none member the summary (403)', async () => {
    const { agent } = await createMemberSession(owner, {
      permissions: { dashboard: 'none' },
    });
    const res = await agent.get(`${BASE}/analytics/summary`);
    expect(res.status).toBe(403);
  });

  it('allows an admin member (200)', async () => {
    const { agent } = await createMemberSession(owner, { role: 'admin' });
    const res = await agent.get(`${BASE}/analytics/summary`);
    expect(res.status).toBe(200);
  });

  it("isolates tenants — agency B's summary excludes agency A's data", async () => {
    // Agency A (owner) already has >=1 client and >=2 posts above.
    const b = (await signupAgency()).agent;
    const res = await b.get(`${BASE}/analytics/summary`);
    expect(res.status).toBe(200);
    const d = data(res);
    // A brand-new agency B has no clients and no posts of its own.
    expect(d.clients).toBe(0);
    expect(d.posts).toBe(0);
    expect(d.postsByStatus).toEqual({});
  });
});
