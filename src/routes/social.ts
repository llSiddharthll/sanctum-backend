/**
 * A client's connected social accounts (Instagram + Facebook Pages via Meta),
 * the Meta connect flow, and per-post publishing. Mounted at
 * /clients/:clientId/social.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients,
  postPublications,
  socialAccounts,
  socialConnectSessions,
} from '../db/schema.js';
import { ok, param, toIso } from '../lib/http.js';
import { badRequest, invalidState, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { audit } from '../services/audit.js';
import { sealToString, unsealString } from '../services/vault.js';
import {
  MetaApiError,
  authorizeUrl,
  instagramProfile,
  metaConfigured,
  pageProfile,
} from '../services/meta.js';
import {
  isPendingPayload,
  metaRedirectUri,
  signOAuthState,
  type ConnectSessionPayload,
} from '../services/social-oauth.js';
import { publishPost, socialPublishEnabled } from '../services/social-publish.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize, type ObjectFacts } from '../authz/engine.js';
import type { StaffActor } from '../authz/actor.js';
import { clientFacts } from '../authz/policies/clients.js';
import {
  canPublish,
  postApprovalIsValid,
  socialAccountFacts,
  viewOpt,
} from '../authz/policies/posts.js';
import { authorizePost } from './posts.js';

/**
 * Authorizes itself (the clients router no longer gates nested paths):
 * view = social_accounts.view; connect / disconnect / auto-publish =
 * social_accounts.manage; "publish now" = posts.publish on the post.
 */
export const socialRouter = Router({ mergeParams: true });
socialRouter.use(authenticate);

/** URL client in scope for `permission` (404 when the client isn't visible). */
async function authorizeSocialClient(
  actor: StaffActor,
  clientId: string,
  permission: string,
): Promise<ObjectFacts> {
  const facts = await clientFacts(actor, clientId);
  authorize(actor, permission, facts, viewOpt(permission, 'social_accounts.view'));
  return facts!;
}

type Account = typeof socialAccounts.$inferSelect;

export function serializeAccount(a: Account) {
  return {
    id: a.id,
    platform: a.platform,
    externalId: a.externalId,
    pageId: a.pageId,
    username: a.username,
    displayName: a.displayName,
    avatarUrl: a.avatarUrl,
    followersCount: a.followersCount,
    status: a.status,
    lastError: a.lastError,
    autoPublish: a.autoPublish,
    lastSyncedAt: toIso(a.lastSyncedAt),
    createdAt: toIso(a.createdAt),
  };
}

function serializePublication(p: typeof postPublications.$inferSelect, username: string | null) {
  return {
    id: p.id,
    socialAccountId: p.socialAccountId,
    platform: p.platform,
    username,
    status: p.status,
    permalink: p.permalink,
    error: p.error,
    attempts: p.attempts,
    publishedAt: toIso(p.publishedAt),
    updatedAt: toIso(p.updatedAt),
  };
}

async function listAccounts(agencyId: string, clientId: string): Promise<Account[]> {
  return db
    .select()
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.agencyId, agencyId),
        eq(socialAccounts.clientId, clientId),
        ne(socialAccounts.status, 'revoked'),
      ),
    )
    .orderBy(asc(socialAccounts.platform), asc(socialAccounts.createdAt));
}

/** Social account bound to the URL client + agency, authorized for `permission`. */
async function getAccount(
  actor: StaffActor,
  clientId: string,
  accountId: string,
  permission: string,
): Promise<Account> {
  const loaded = await socialAccountFacts(actor, clientId, accountId);
  if (!loaded) throw notFound('Social account not found.');
  authorize(actor, permission, loaded.facts, viewOpt(permission, 'social_accounts.view'));
  return loaded.row;
}

async function listPublications(agencyId: string, postId: string) {
  const rows = await db
    .select({ pub: postPublications, username: socialAccounts.username, name: socialAccounts.displayName })
    .from(postPublications)
    .leftJoin(socialAccounts, eq(socialAccounts.id, postPublications.socialAccountId))
    .where(and(eq(postPublications.agencyId, agencyId), eq(postPublications.postId, postId)))
    .orderBy(desc(postPublications.updatedAt));
  return rows.map((r) => serializePublication(r.pub, r.username ?? r.name));
}

function safeObj(json: string | null): Record<string, string> {
  try {
    const v = json ? JSON.parse(json) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// ---- GET / — connected accounts + whether Meta is configured ----
socialRouter.get('/', requires('social_accounts.view'), async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  await authorizeSocialClient(ctx, clientId, 'social_accounts.view');
  const rows = await listAccounts(ctx.agencyId, clientId);
  ok(res, {
    configured: metaConfigured(),
    publishingEnabled: socialPublishEnabled(),
    accounts: rows.map(serializeAccount),
  });
});

// ---- POST /meta/connect — start Facebook Login ----
socialRouter.post('/meta/connect', requires('social_accounts.manage'), async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  await authorizeSocialClient(ctx, clientId, 'social_accounts.manage');
  if (!metaConfigured()) {
    throw badRequest(
      'Meta is not configured on the server yet — set META_APP_ID and META_APP_SECRET.',
    );
  }
  const state = await signOAuthState({ agencyId: ctx.agencyId, clientId, userId: ctx.userId });
  ok(res, { authorizeUrl: authorizeUrl(state, metaRedirectUri(req)) });
});

/** A completed connect session of THIS user for THIS client (never another user's). */
async function loadSession(ctx: StaffActor, clientId: string, sessionId: string) {
  const [row] = await db
    .select()
    .from(socialConnectSessions)
    .where(
      and(
        eq(socialConnectSessions.id, sessionId),
        eq(socialConnectSessions.agencyId, ctx.agencyId),
        eq(socialConnectSessions.clientId, clientId),
        eq(socialConnectSessions.userId, ctx.userId),
      ),
    )
    .limit(1);
  if (!row || row.expiresAt.getTime() < Date.now()) {
    throw notFound('This Meta connection expired — click Connect again.');
  }
  const payload = JSON.parse(unsealString(row.payloadEnc)) as unknown;
  // A reserved login that never completed is not a selectable session.
  if (isPendingPayload(payload)) {
    throw notFound('This Meta connection expired — click Connect again.');
  }
  return { row, payload: payload as ConnectSessionPayload };
}

// ---- GET /meta/sessions/:sessionId — Pages offered by the login (no tokens) ----
socialRouter.get('/meta/sessions/:sessionId', requires('social_accounts.manage'), async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  await authorizeSocialClient(ctx, clientId, 'social_accounts.manage');
  const { payload } = await loadSession(ctx, clientId, param(req, 'sessionId'));
  const connected = new Set((await listAccounts(ctx.agencyId, clientId)).map((a) => a.externalId));
  ok(res, {
    pages: payload.pages.map((p) => ({
      id: p.id,
      name: p.name,
      pictureUrl: p.pictureUrl,
      connected: connected.has(p.id),
      instagram: p.instagram
        ? { ...p.instagram, connected: connected.has(p.instagram.id) }
        : null,
    })),
  });
});

async function upsertAccount(
  ctx: StaffActor,
  clientId: string,
  v: {
    platform: 'instagram' | 'facebook';
    externalId: string;
    pageId: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    followers: number | null;
    token: string;
    metaUserId: string;
  },
) {
  const fields = {
    pageId: v.pageId,
    username: v.username,
    displayName: v.displayName,
    avatarUrl: v.avatarUrl,
    followersCount: v.followers,
    accessTokenEnc: sealToString(v.token),
    metaUserId: v.metaUserId,
    status: 'active' as const,
    lastError: null,
    connectedBy: ctx.userId,
    lastSyncedAt: new Date(),
    updatedAt: new Date(),
  };
  const [existing] = await db
    .select({ id: socialAccounts.id })
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.agencyId, ctx.agencyId),
        eq(socialAccounts.clientId, clientId),
        eq(socialAccounts.platform, v.platform),
        eq(socialAccounts.externalId, v.externalId),
      ),
    )
    .limit(1);
  if (existing) {
    await db.update(socialAccounts).set(fields).where(eq(socialAccounts.id, existing.id));
  } else {
    await db.insert(socialAccounts).values({
      id: newId('soc'),
      agencyId: ctx.agencyId,
      clientId,
      platform: v.platform,
      externalId: v.externalId,
      ...fields,
    });
  }
}

const selectSchema = z.object({ pageIds: z.array(z.string().min(1)).min(1).max(20) });

// ---- POST /meta/sessions/:sessionId/select — link the chosen Page(s) ----
socialRouter.post('/meta/sessions/:sessionId/select', requires('social_accounts.manage'), async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  await authorizeSocialClient(ctx, clientId, 'social_accounts.manage');
  const [client] = await db
    .select({ handlesJson: clients.handlesJson })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)))
    .limit(1);
  if (!client) throw notFound('Client not found.');
  const body = selectSchema.parse(req.body);
  const { row, payload } = await loadSession(ctx, clientId, param(req, 'sessionId'));

  const chosen = payload.pages.filter((p) => body.pageIds.includes(p.id));
  if (!chosen.length) throw badRequest('Pick at least one Page from this connection.');

  for (const page of chosen) {
    await upsertAccount(ctx, clientId, {
      platform: 'facebook',
      externalId: page.id,
      pageId: page.id,
      username: null,
      displayName: page.name,
      avatarUrl: page.pictureUrl,
      followers: null,
      token: page.accessToken,
      metaUserId: payload.metaUserId,
    });
    // Instagram publishing goes through the Page it's linked to, with the Page token.
    if (page.instagram) {
      await upsertAccount(ctx, clientId, {
        platform: 'instagram',
        externalId: page.instagram.id,
        pageId: page.id,
        username: page.instagram.username,
        displayName: page.instagram.name,
        avatarUrl: page.instagram.avatarUrl,
        followers: page.instagram.followers,
        token: page.accessToken,
        metaUserId: payload.metaUserId,
      });
    }
  }

  // Mirror the real handles onto the client so every preview uses them.
  const handles = safeObj(client.handlesJson);
  const igUser = chosen.find((p) => p.instagram?.username)?.instagram?.username;
  if (igUser) handles.instagram = igUser;
  if (!handles.facebook && chosen[0]) handles.facebook = chosen[0].name;
  await db
    .update(clients)
    .set({ handlesJson: JSON.stringify(handles) })
    .where(and(eq(clients.id, clientId), eq(clients.agencyId, ctx.agencyId)));

  await db.delete(socialConnectSessions).where(eq(socialConnectSessions.id, row.id));
  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.type,
    actorId: ctx.userId,
    action: 'social.connect',
    entityType: 'client',
    entityId: clientId,
    metadata: { pages: chosen.map((p) => p.id) },
    ip: req.ip,
  });
  ok(res, (await listAccounts(ctx.agencyId, clientId)).map(serializeAccount));
});

// ---- PATCH /:accountId — toggle auto-publish ----
const patchSchema = z.object({ autoPublish: z.boolean() });

socialRouter.patch('/:accountId', requires('social_accounts.manage'), async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const acct = await getAccount(ctx, clientId, param(req, 'accountId'), 'social_accounts.manage');
  const body = patchSchema.parse(req.body);
  await db
    .update(socialAccounts)
    .set({ autoPublish: body.autoPublish, updatedAt: new Date() })
    .where(eq(socialAccounts.id, acct.id));
  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.type,
    actorId: ctx.userId,
    action: 'social.update',
    entityType: 'social_account',
    entityId: acct.id,
    metadata: { autoPublish: body.autoPublish },
    ip: req.ip,
  });
  ok(res, serializeAccount(await getAccount(ctx, clientId, acct.id, 'social_accounts.view')));
});

// ---- POST /:accountId/refresh — re-read handle / avatar / followers ----
// Re-reads what Meta already exposes for the account (a sync, not a change of
// access) -> social_accounts.view.
socialRouter.post('/:accountId/refresh', requires('social_accounts.view'), async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const acct = await getAccount(ctx, clientId, param(req, 'accountId'), 'social_accounts.view');
  try {
    const token = unsealString(acct.accessTokenEnc);
    if (acct.platform === 'instagram') {
      const p = await instagramProfile(acct.externalId, token);
      await db
        .update(socialAccounts)
        .set({
          username: p.username,
          displayName: p.name,
          avatarUrl: p.avatarUrl,
          followersCount: p.followers,
          status: 'active',
          lastError: null,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(socialAccounts.id, acct.id));
    } else {
      const p = await pageProfile(acct.externalId, token);
      await db
        .update(socialAccounts)
        .set({
          displayName: p.name,
          avatarUrl: p.pictureUrl,
          followersCount: p.followers,
          status: 'active',
          lastError: null,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(socialAccounts.id, acct.id));
    }
  } catch (e) {
    if (!(e instanceof MetaApiError)) throw e;
    if (!e.isAuthError) throw badRequest(e.message);
    await db
      .update(socialAccounts)
      .set({ status: 'expired', lastError: e.message.slice(0, 500), updatedAt: new Date() })
      .where(eq(socialAccounts.id, acct.id));
  }
  ok(res, serializeAccount(await getAccount(ctx, clientId, acct.id, 'social_accounts.view')));
});

// ---- DELETE /:accountId — disconnect (token wiped; publish history kept) ----
socialRouter.delete('/:accountId', requires('social_accounts.manage'), async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const acct = await getAccount(ctx, clientId, param(req, 'accountId'), 'social_accounts.manage');
  await db
    .update(socialAccounts)
    .set({ status: 'revoked', accessTokenEnc: '', autoPublish: false, updatedAt: new Date() })
    .where(eq(socialAccounts.id, acct.id));
  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.type,
    actorId: ctx.userId,
    action: 'social.disconnect',
    entityType: 'social_account',
    entityId: acct.id,
    ip: req.ip,
  });
  ok(res, { disconnected: true });
});

// ---- GET /posts/:postId/publications — where a post went live (or failed) ----
socialRouter.get('/posts/:postId/publications', requires('posts.view'), async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const { row: post } = await authorizePost(ctx, clientId, param(req, 'postId'), 'posts.view');
  ok(res, await listPublications(ctx.agencyId, post.id));
});

// ---- POST /posts/:postId/publish — "Publish now" ----
// "Publish now" = posts.publish on the post. Only approved/scheduled posts whose
// client approval is still valid (a `posted` post may be retried for accounts
// that failed; publishing is idempotent per account).
socialRouter.post('/posts/:postId/publish', requires('posts.publish'), async (req, res) => {
  const ctx = getStaffActor(req);
  const clientId = param(req, 'clientId');
  const { row: post } = await authorizePost(ctx, clientId, param(req, 'postId'), 'posts.publish');
  if (!metaConfigured()) throw badRequest('Meta is not configured on the server yet.');
  if (!(canPublish(post.status) || post.status === 'posted')) {
    throw invalidState('Only approved or scheduled posts can be published.');
  }
  if (!(await postApprovalIsValid(ctx.agencyId, post))) {
    throw invalidState('This post needs client approval before it can be published.');
  }
  const results = await publishPost(ctx.agencyId, post.id, { manual: true, maxWaitMs: 60_000 });
  if (!results.length) {
    throw badRequest("No connected account matches this post's platforms.");
  }
  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.type,
    actorId: ctx.userId,
    action: 'social.publish',
    entityType: 'post',
    entityId: post.id,
    metadata: { results: results.map((r) => `${r.platform}:${r.status}`) },
    ip: req.ip,
  });
  ok(res, { results, publications: await listPublications(ctx.agencyId, post.id) });
});
