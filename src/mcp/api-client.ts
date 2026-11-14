/**
 * MCP tools never touch the database directly. Every tool calls the regular
 * REST API (/api/v1/...) over loopback with the signed-in user's own access
 * token, so route permissions, scope filtering, field redaction, validation and
 * audit logging apply exactly as they do in the web app. An MCP user can never
 * do more than they could do in the portal.
 */
import { env } from '../env.js';

let internalBase: string | null = null;

/** Override the loopback base URL (tests listen on a random port). */
export function setInternalApiBase(url: string | null): void {
  internalBase = url ? url.replace(/\/$/, '') : null;
}

function base(): string {
  return internalBase ?? `http://127.0.0.1:${env.PORT}`;
}

export class ApiCallError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export type Query = Record<string, string | number | boolean | null | undefined | Array<string | number>>;

export interface ApiClient {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T>;
  delete<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T>;
}

function queryString(query?: Query): string {
  if (!query) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => qs.append(k, String(item)));
    else qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/**
 * @param token     the caller's Sanctum access token (from the MCP bearer header)
 * @param clientIp  the MCP caller's IP, forwarded so per-IP rate limits apply
 *                  to the real caller instead of to loopback
 */
export function createApiClient(token: string, clientIp?: string): ApiClient {
  async function call<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    if (!path.startsWith('/')) path = `/${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'sanctum-mcp',
    };
    if (clientIp) headers['X-Forwarded-For'] = clientIp;
    const init: RequestInit = { method, headers };
    if (body !== undefined && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base()}/api/v1${path}${queryString(query)}`, init);
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiCallError(
        res.status,
        err?.code ?? `HTTP_${res.status}`,
        err?.message ?? (typeof json === 'string' && json ? json.slice(0, 300) : res.statusText),
        err?.details,
      );
    }
    if (json && typeof json === 'object' && 'data' in (json as object)) {
      // Envelope is { data, ...extra } — keep extras (pagination cursors etc.).
      const { data, ...extra } = json as { data: unknown } & Record<string, unknown>;
      return (Object.keys(extra).length ? { items: data, ...extra } : data) as T;
    }
    return json as T;
  }

  return {
    get: (path, query) => call('GET', path, undefined, query),
    post: (path, body, query) => call('POST', path, body ?? {}, query),
    patch: (path, body, query) => call('PATCH', path, body ?? {}, query),
    put: (path, body, query) => call('PUT', path, body ?? {}, query),
    delete: (path, body, query) => call('DELETE', path, body, query),
  };
}
