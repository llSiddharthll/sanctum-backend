/**
 * HTTP wiring for the MCP server:
 *   /.well-known/oauth-*, /authorize, /token, /register, /revoke  — OAuth (SDK handlers)
 *   POST /mcp                                                       — MCP (Streamable HTTP, stateless)
 *   /api/v1/mcp-connect/*                                           — consent page API (cookie session)
 *
 * The public endpoints use bearer tokens only (no cookies), so they get their
 * own permissive CORS and are mounted before the app's credentialed CORS.
 */
import express, { type Express, type Request, type RequestHandler, Router } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { env, isProd } from '../env.js';
import { db } from '../db/client.js';
import { agencies, users } from '../db/schema.js';
import { actorFromAccessToken, authenticate, getStaffActor } from '../authz/http.js';
import { badRequest } from '../lib/errors.js';
import { ok } from '../lib/http.js';
import { createApiClient } from './api-client.js';
import { SanctumOAuthProvider, issueAuthorizationCode, readAuthRequest, type AuthRequest } from './oauth.js';
import { buildMcpServer, visibleTools } from './server.js';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function requestOrigin(req: Request): string {
  return env.MCP_PUBLIC_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.get('host')}`;
}

/** Where the consent page lives for a given public API origin. */
function appUrlFor(origin: string): string {
  if (env.MCP_APP_URL) return env.MCP_APP_URL.replace(/\/$/, '');
  // Local preview shared through a tunnel: one proxy serves app + API on one origin.
  if (!isProd && !LOCAL_HOST.test(new URL(origin).host)) return origin;
  const origins = env.FRONTEND_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  return (isProd ? origins.find((o) => o.startsWith('https://')) : undefined) ?? origins[0]!;
}

interface OriginHandlers {
  auth: RequestHandler;
  bearer: RequestHandler;
}

const byOrigin = new Map<string, OriginHandlers>();

function handlersFor(req: Request): OriginHandlers | null {
  const origin = requestOrigin(req);
  const hit = byOrigin.get(origin);
  if (hit) return hit;
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(origin);
  } catch {
    return null;
  }
  // OAuth requires https except on localhost.
  if (issuerUrl.protocol !== 'https:' && !LOCAL_HOST.test(issuerUrl.host)) return null;

  const provider = new SanctumOAuthProvider(appUrlFor(origin));
  const resourceServerUrl = new URL('/mcp', issuerUrl);
  // Handlers are built lazily (once per public origin), so the SDK's limiters are
  // created on first request; that's intended — silence the startup-only check.
  const rateLimit = { validate: { creationStack: false } };
  const handlers: OriginHandlers = {
    auth: mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl,
      resourceName: 'Sanctum',
      scopesSupported: ['sanctum'],
      authorizationOptions: { rateLimit },
      tokenOptions: { rateLimit },
      revocationOptions: { rateLimit },
      clientRegistrationOptions: { clientIdGeneration: false, clientSecretExpirySeconds: 0, rateLimit },
    }),
    bearer: requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    }),
  };
  if (byOrigin.size > 20) byOrigin.clear();
  byOrigin.set(origin, handlers);
  return handlers;
}

const AUTH_PATHS = /^\/(\.well-known\/(oauth-authorization-server|oauth-protected-resource)|authorize|token|register|revoke)(\/|$)/;

const mcpHandler: RequestHandler = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' },
      id: null,
    });
    return;
  }
  // `auth` is set by the MCP SDK's requireBearerAuth (OAuth token info), not the legacy session context.
  const { token } = (req as unknown as { auth: { token: string } }).auth;
  const { actor } = await actorFromAccessToken(token);
  if (actor.type !== 'staff') {
    res.status(403).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Team members only.' }, id: null });
    return;
  }
  const server = buildMcpServer({ actor, api: createApiClient(token, req.ip) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
};

/** Public MCP + OAuth endpoints. Call before the app's credentialed CORS middleware. */
export function mountMcp(app: Express): void {
  app.use((req, res, next) => {
    if (!AUTH_PATHS.test(req.path)) return next();
    // Some clients probe the bare protected-resource path; serve the /mcp document there too.
    if (req.path === '/.well-known/oauth-protected-resource') req.url = '/.well-known/oauth-protected-resource/mcp';
    const h = handlersFor(req);
    if (!h) return next();
    h.auth(req, res, next);
  });

  const publicCors = cors({
    origin: true,
    exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
  });
  app.all(
    '/mcp',
    publicCors,
    (req, res, next) => {
      const h = handlersFor(req);
      if (!h) {
        res.status(404).end();
        return;
      }
      h.bearer(req, res, next);
    },
    express.json({ limit: '1mb' }),
    mcpHandler,
  );
}

// ------------------------------------------------------------ consent page API

const requestBody = z.object({ request: z.string().min(1) });

async function loadRequest(raw: unknown): Promise<AuthRequest> {
  const parsed = await readAuthRequest(typeof raw === 'string' ? raw : undefined);
  if (!parsed) {
    throw badRequest('This connection request has expired or is invalid. Start connecting again from your AI app.');
  }
  return parsed;
}

function redirectWith(request: AuthRequest, params: Record<string, string>): string {
  const url = new URL(request.ru);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (request.st) url.searchParams.set('state', request.st);
  return url.href;
}

export const mcpConnectRouter = Router();
mcpConnectRouter.use(authenticate);

/** Details for the consent screen. Session-only (any signed-in team member). */
mcpConnectRouter.get('/request', async (req, res) => {
  const actor = getStaffActor(req);
  const request = await loadRequest(req.query.request);
  const [user] = await db
    .select({ name: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, actor.agencyId))
    .limit(1);
  const tools = visibleTools(actor);
  ok(res, {
    clientName: request.cn,
    clientUri: request.cu ?? null,
    redirectHost: new URL(request.ru).host,
    user: { name: user?.name ?? null, email: user?.email ?? null },
    agency: agency?.name ?? null,
    access: {
      tools: tools.length,
      canChange: tools.filter((t) => t.kind !== 'read').length,
      modules: [...new Set(tools.map((t) => t.name.split('_')[0]!))],
    },
  });
});

/** Approve: issue a one-time code bound to this user and send them back to the AI app. */
mcpConnectRouter.post('/approve', async (req, res) => {
  const actor = getStaffActor(req);
  const { request: raw } = requestBody.parse(req.body);
  const request = await loadRequest(raw);
  const code = await issueAuthorizationCode(request, { userId: actor.userId, agencyId: actor.agencyId });
  ok(res, { redirectTo: redirectWith(request, { code }) });
});

/** Deny: tell the AI app the person declined. */
mcpConnectRouter.post('/deny', async (req, res) => {
  getStaffActor(req);
  const { request: raw } = requestBody.parse(req.body);
  const request = await loadRequest(raw);
  ok(res, { redirectTo: redirectWith(request, { error: 'access_denied' }) });
});
