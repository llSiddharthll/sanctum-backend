/**
 * Public Meta endpoints (no session): the Facebook Login redirect target, and
 * the deauthorize / data-deletion callbacks Meta's App Review requires.
 * Mounted at /oauth.
 */
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { socialAccounts, socialConnectSessions } from '../db/schema.js';
import { getFrontendOrigin } from '../lib/frontend-url.js';
import { newId } from '../lib/ids.js';
import { sealToString } from '../services/vault.js';
import {
  exchangeCode,
  fetchMetaUser,
  listPages,
  parseSignedRequest,
} from '../services/meta.js';
import {
  apiOrigin,
  consumeOAuthState,
  metaRedirectUri,
  verifyOAuthState,
  type ConnectSessionPayload,
} from '../services/social-oauth.js';
import { actorForUser } from '../authz/http.js';
import { check } from '../authz/engine.js';
import { clientFacts } from '../authz/policies/clients.js';

export const oauthRouter = Router();
// Meta posts the platform callbacks form-encoded.
oauthRouter.use(express.urlencoded({ extended: false }));

/** Back to the client's Social tab in the web app. */
function backToApp(clientId: string, params: Record<string, string>): string {
  const q = new URLSearchParams({ tab: 'social', ...params });
  return `${getFrontendOrigin()}/clients/${encodeURIComponent(clientId)}?${q}`;
}

/**
 * The user who started the login must still be active staff holding
 * social_accounts.manage on the client (grants may have changed since).
 */
async function initiatorMayConnect(agencyId: string, userId: string, clientId: string): Promise<boolean> {
  try {
    const actor = await actorForUser(userId, agencyId);
    if (actor.type !== 'staff') return false;
    return check(actor, 'social_accounts.manage', await clientFacts(actor, clientId));
  } catch {
    return false;
  }
}

// ---- GET /meta/callback — Facebook Login redirect ----
// Public (no session): authorized by the signed, single-use `state` bound to the
// initiating user + client (see services/social-oauth.ts).
oauthRouter.get('/meta/callback', async (req, res) => {
  const state = await verifyOAuthState(String(req.query.state ?? ''));
  // Consume first: a state works once, whatever the outcome.
  if (!state || !(await consumeOAuthState(state))) {
    res
      .status(400)
      .type('text/plain')
      .send('This Meta login link is invalid or expired. Close this tab and click Connect again.');
    return;
  }
  if (!(await initiatorMayConnect(state.agencyId, state.userId, state.clientId))) {
    res
      .status(403)
      .type('text/plain')
      .send("You no longer have permission to connect this client's social accounts.");
    return;
  }
  if (req.query.error || !req.query.code) {
    const why = String(
      req.query.error_description ?? req.query.error_reason ?? 'Meta login was cancelled.',
    );
    res.redirect(302, backToApp(state.clientId, { meta_error: why.slice(0, 200) }));
    return;
  }

  try {
    const userToken = await exchangeCode(String(req.query.code), metaRedirectUri(req));
    const me = await fetchMetaUser(userToken);
    const pages = await listPages(userToken);
    if (!pages.length) {
      res.redirect(
        302,
        backToApp(state.clientId, {
          meta_error:
            "No Facebook Pages were shared. Connect again and select the client's Page (and its linked Instagram account).",
        }),
      );
      return;
    }
    const payload: ConnectSessionPayload = { metaUserId: me.id, pages };
    const id = newId('scs');
    await db.insert(socialConnectSessions).values({
      id,
      agencyId: state.agencyId,
      clientId: state.clientId,
      userId: state.userId,
      payloadEnc: sealToString(JSON.stringify(payload)),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    // Opportunistic cleanup of abandoned connections.
    await db.delete(socialConnectSessions).where(lt(socialConnectSessions.expiresAt, new Date()));
    res.redirect(302, backToApp(state.clientId, { meta_session: id }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Meta login failed.';
    console.error('[social] meta callback failed:', msg);
    res.redirect(302, backToApp(state.clientId, { meta_error: msg.slice(0, 200) }));
  }
});

function signedUserId(req: express.Request): string | null {
  const data = parseSignedRequest(String(req.body?.signed_request ?? ''));
  return data?.user_id ? String(data.user_id) : null;
}

// ---- POST /meta/deauthorize — the user removed the app on Facebook ----
oauthRouter.post('/meta/deauthorize', async (req, res) => {
  const userId = signedUserId(req);
  if (!userId) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid signed_request.' } });
    return;
  }
  await db
    .update(socialAccounts)
    .set({
      status: 'revoked',
      accessTokenEnc: '',
      autoPublish: false,
      lastError: 'Access was removed on Facebook.',
      updatedAt: new Date(),
    })
    .where(eq(socialAccounts.metaUserId, userId));
  res.json({ ok: true });
});

// ---- POST /meta/data-deletion — the user asked Meta to delete their data ----
oauthRouter.post('/meta/data-deletion', async (req, res) => {
  const userId = signedUserId(req);
  if (!userId) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid signed_request.' } });
    return;
  }
  await db.delete(socialAccounts).where(eq(socialAccounts.metaUserId, userId));
  const code = crypto.randomBytes(8).toString('hex');
  res.json({
    url: `${apiOrigin(req)}/api/v1/oauth/meta/deletion-status?code=${code}`,
    confirmation_code: code,
  });
});

oauthRouter.get('/meta/deletion-status', (req, res) => {
  res.json({
    confirmationCode: String(req.query.code ?? ''),
    status: 'completed',
    message: 'All Instagram / Facebook account data Sanctum held for this login has been deleted.',
  });
});
