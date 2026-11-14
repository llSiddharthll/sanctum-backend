import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import supertest from 'supertest';
import { expect } from 'vitest';
import { app, BASE, data, type Agent } from './helpers';
import { setInternalApiBase } from '../src/mcp/api-client.js';

/** Shared helpers for MCP tests: the OAuth flow and JSON-RPC calls a real AI client makes. */

export const REDIRECT = 'http://localhost:9999/callback';
export const MCP_ACCEPT = 'application/json, text/event-stream';

export const request = () => supertest(app);

export function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function registerClient(name = 'Test AI'): Promise<string> {
  const res = await request()
    .post('/register')
    .send({ redirect_uris: [REDIRECT], client_name: name, token_endpoint_auth_method: 'none' });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

/** Full authorization-code flow for the user behind `userAgent` (cookie session). */
export async function connect(userAgent: Agent, clientId: string) {
  const { verifier, challenge } = pkce();
  const auth = await request().get('/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
  });
  expect(auth.status).toBe(302);
  const consentUrl = new URL(auth.headers.location!);
  expect(consentUrl.pathname).toBe('/connect');
  const sealed = consentUrl.searchParams.get('request')!;

  const details = await userAgent.get(`${BASE}/mcp-connect/request`).query({ request: sealed });
  expect(details.status).toBe(200);
  expect(data(details).clientName).toBe('Test AI');

  const approve = await userAgent.post(`${BASE}/mcp-connect/approve`).send({ request: sealed });
  expect(approve.status).toBe(200);
  const back = new URL(data(approve).redirectTo);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('st-123');
  const code = back.searchParams.get('code')!;

  const token = await request().post('/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
  });
  expect(token.status).toBe(200);
  return { code, verifier, access: token.body.access_token as string, refresh: token.body.refresh_token as string };
}

let rpcId = 0;
export async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  rpcId += 1;
  return request()
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', MCP_ACCEPT)
    .send({ jsonrpc: '2.0', id: rpcId, method, params });
}

export async function toolNames(token: string): Promise<string[]> {
  const res = await rpc(token, 'tools/list');
  expect(res.status).toBe(200);
  return (res.body.result.tools as Array<{ name: string }>).map((t) => t.name);
}

export async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(token, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  return res.body as {
    result?: { isError?: boolean; content: Array<{ text: string }> };
    error?: { message: string };
  };
}

/** Tools call the API over loopback: serve the app on a random port for the test run. */
export function startLoopback(): () => Promise<void> {
  const server = http.createServer(app).listen(0);
  const { port } = server.address() as AddressInfo;
  setInternalApiBase(`http://127.0.0.1:${port}`);
  return async () => {
    setInternalApiBase(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

/** Call a tool and return its parsed JSON result; throws with the tool's message on error. */
export async function useTool<T = any>(token: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const out = await callTool(token, name, args);
  const text = out.result?.content?.[0]?.text ?? out.error?.message ?? '';
  if (out.error || out.result?.isError) throw new Error(`${name} failed: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}
