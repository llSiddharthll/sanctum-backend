/**
 * OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, Gemini CLI…).
 *
 *  - Dynamic client registration is stateless: the client_id IS the client's
 *    registration, sealed (encrypted + authenticated) with a server key, so no
 *    new tables or migrations are needed.
 *  - /authorize sends the person to the web app's /connect page, where they
 *    approve while signed in with their own Sanctum account.
 *  - Tokens are ordinary Sanctum sessions (createSession / rotateRefresh): the
 *    access token is the same JWT the web app uses, the session shows up in the
 *    user's session list, can be revoked, and dies when the user is
 *    deactivated. The AI client acts strictly as that user.
 */
import crypto from 'node:crypto';
import type { Response } from 'express';
import { EncryptJWT, jwtDecrypt, decodeJwt } from 'jose';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { env } from '../env.js';
import { actorForUser, actorFromAccessToken } from '../authz/http.js';
import {
  ACCESS_TTL_SECONDS,
  createSession,
  revokeSessionByRefreshToken,
  revokeSessions,
  rotateRefresh,
} from '../authz/sessions.js';

// ------------------------------------------------------------ sealing

const KEY = new Uint8Array(
  crypto.hkdfSync('sha256', env.JWT_ACCESS_SECRET, 'sanctum-mcp-oauth', 'v1', 32),
);

type Kind = 'client' | 'authreq' | 'code';

async function seal(kind: Kind, payload: Record<string, unknown>, ttlSeconds?: number): Promise<string> {
  let jwt = new EncryptJWT({ ...payload, k: kind })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt();
  if (ttlSeconds) jwt = jwt.setExpirationTime(`${ttlSeconds}s`);
  return jwt.encrypt(KEY);
}

async function unseal<T>(kind: Kind, token: string | undefined): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, KEY);
    return payload.k === kind ? (payload as T) : null;
  } catch {
    return null;
  }
}

const hashId = (clientId: string) => crypto.createHash('sha256').update(clientId).digest('base64url');

// ------------------------------------------------------------ pending requests / codes

/** What the /connect page needs, sealed into ?request=. */
export interface AuthRequest {
  cidh: string; // hash of client_id
  cn: string; // client name
  cu?: string; // client uri
  ru: string; // redirect uri (already validated against the registration)
  cc: string; // PKCE code challenge
  st?: string; // state
  rs?: string; // resource
}

interface AuthCode {
  uid: string;
  aid: string;
  cidh: string;
  cn: string;
  ru: string;
  cc: string;
  jti: string;
}

const AUTH_REQUEST_TTL = 15 * 60;
const CODE_TTL = 5 * 60;

export async function readAuthRequest(token: string | undefined): Promise<AuthRequest | null> {
  return unseal<AuthRequest>('authreq', token);
}

/** Called by the consent endpoint once the signed-in user clicks Allow. */
export async function issueAuthorizationCode(
  request: AuthRequest,
  user: { userId: string; agencyId: string },
): Promise<string> {
  const code: AuthCode = {
    uid: user.userId,
    aid: user.agencyId,
    cidh: request.cidh,
    cn: request.cn,
    ru: request.ru,
    cc: request.cc,
    jti: crypto.randomBytes(16).toString('base64url'),
  };
  return seal('code', { ...code }, CODE_TTL);
}

/** Codes are single-use: remember spent ones until they would have expired anyway. */
const spentCodes = new Map<string, number>();
function spend(jti: string): boolean {
  const now = Date.now();
  for (const [k, exp] of spentCodes) if (exp < now) spentCodes.delete(k);
  if (spentCodes.has(jti)) return false;
  spentCodes.set(jti, now + CODE_TTL * 1000);
  return true;
}

function tokens(access: string, refresh: string): OAuthTokens {
  return {
    access_token: access,
    token_type: 'bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh,
  };
}

/** Keep only the registration fields the server needs, so client ids stay short. */
function slimClient(c: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) {
  return {
    redirect_uris: c.redirect_uris,
    client_name: c.client_name,
    client_uri: c.client_uri,
    token_endpoint_auth_method: c.token_endpoint_auth_method,
    grant_types: c.grant_types,
    response_types: c.response_types,
    scope: c.scope,
    client_secret: c.client_secret,
    client_secret_expires_at: c.client_secret_expires_at,
  };
}

// ------------------------------------------------------------ provider

export class SanctumOAuthProvider implements OAuthServerProvider {
  /** @param appUrl web app origin hosting the /connect consent page */
  constructor(private readonly appUrl: string) {}

  readonly clientsStore: OAuthRegisteredClientsStore = {
    async getClient(clientId: string) {
      const p = await unseal<{ c: Omit<OAuthClientInformationFull, 'client_id'> }>('client', clientId);
      return p ? ({ ...p.c, client_id: clientId } as OAuthClientInformationFull) : undefined;
    },
    async registerClient(client) {
      const issuedAt = Math.floor(Date.now() / 1000);
      const slim = slimClient(client);
      const clientId = await seal('client', { c: { ...slim, client_id_issued_at: issuedAt } });
      return { ...client, client_id: clientId, client_id_issued_at: issuedAt } as OAuthClientInformationFull;
    },
  };

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const request: AuthRequest = {
      cidh: hashId(client.client_id),
      cn: (client.client_name ?? 'An AI assistant').slice(0, 80),
      cu: client.client_uri?.slice(0, 200),
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      rs: params.resource?.href,
    };
    const sealed = await seal('authreq', { ...request }, AUTH_REQUEST_TTL);
    res.redirect(302, `${this.appUrl}/connect?request=${encodeURIComponent(sealed)}`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = await unseal<AuthCode>('code', authorizationCode);
    if (!code || code.cidh !== hashId(client.client_id)) throw new InvalidGrantError('Invalid authorization code.');
    return code.cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = await unseal<AuthCode>('code', authorizationCode);
    if (!code || code.cidh !== hashId(client.client_id)) throw new InvalidGrantError('Invalid authorization code.');
    if (redirectUri && redirectUri !== code.ru) throw new InvalidGrantError('redirect_uri does not match.');
    if (!spend(code.jti)) throw new InvalidGrantError('Authorization code already used.');

    // The person must still be an active team member.
    let actor;
    try {
      actor = await actorForUser(code.uid, code.aid);
    } catch {
      throw new InvalidGrantError('This account is no longer active.');
    }
    if (actor.type !== 'staff') throw new InvalidGrantError('Only team members can connect AI assistants.');

    const session = await createSession({
      actorType: 'staff',
      agencyId: code.aid,
      userId: code.uid,
      userAgent: `AI connector · ${code.cn}`,
    });
    return tokens(session.access, session.refresh);
  }

  async exchangeRefreshToken(_client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    try {
      const r = await rotateRefresh(refreshToken);
      if (r.session.actorType !== 'staff') throw new Error('not staff');
      return tokens(r.access, r.refresh);
    } catch {
      throw new InvalidGrantError('Refresh token is invalid or expired. Please reconnect.');
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let actor;
    try {
      ({ actor } = await actorFromAccessToken(token));
    } catch {
      throw new InvalidTokenError('Invalid or expired access token.');
    }
    if (actor.type !== 'staff') throw new InvalidTokenError('Only team members can use the Sanctum MCP server.');
    const { exp } = decodeJwt(token);
    return {
      token,
      clientId: 'sanctum',
      scopes: ['sanctum'],
      expiresAt: exp,
      extra: { userId: actor.userId, agencyId: actor.agencyId },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const t = request.token;
    if (t.startsWith('rft_')) {
      await revokeSessionByRefreshToken(t, 'oauth_revoke');
      return;
    }
    try {
      await actorFromAccessToken(t);
      const { sid } = decodeJwt(t);
      if (typeof sid === 'string') await revokeSessions([sid], 'oauth_revoke');
    } catch {
      // RFC 7009: invalid tokens are not an error.
    }
  }
}
