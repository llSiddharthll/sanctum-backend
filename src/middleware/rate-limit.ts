import crypto from 'node:crypto';
import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

function envelope(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * Skip rate limiting outside production — i.e. under the automated test runner
 * AND in local development. Production (NODE_ENV=production) keeps every limit.
 */
const skipInTest = () => process.env.NODE_ENV !== 'production';

/**
 * Numeric rate-limit configuration — the single source of truth for both the
 * limiters below and any handler that wants to surface the limits (e.g.
 * GET /agency/usage). Each entry is `{ max, windowMs }`.
 *
 * Limits are per PERSON (session / account), not per IP: a whole office shares
 * one public IP, and per-IP limits locked everyone out once a few colleagues
 * had been working ("Too many attempts" on a first login, empty pages). Per-IP
 * ceilings remain only as a generous backstop against floods.
 */
export const rateLimitConfig = {
  /** Per signed-in session (or per IP when anonymous), per minute. */
  global: { max: 600, windowMs: 60 * 1000 },
  /** Per IP backstop for all API traffic, per minute. */
  globalIp: { max: 6000, windowMs: 60 * 1000 },
  /** Failed-or-not login attempts per account + IP (password guessing). */
  auth: { max: 10, windowMs: 15 * 60 * 1000 },
  /** Per IP backstop for login/signup/password flows (credential stuffing). */
  authIp: { max: 300, windowMs: 15 * 60 * 1000 },
  /** Token refreshes per refresh token (needs a valid secret, so no guessing). */
  refresh: { max: 60, windowMs: 15 * 60 * 1000 },
  /** AI generations per person, per hour (cost control). */
  ai: { max: 60, windowMs: 60 * 60 * 1000 },
  portal: { max: 60, windowMs: 60 * 1000 },
} as const;

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('base64url').slice(0, 22);
const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? '0.0.0.0');

/** The access token on a request (Bearer header or session cookie), if any. */
function accessToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return (req.cookies as Record<string, string> | undefined)?.sanctum_at;
}

/** Per-person key: the session's token when signed in, else the IP. */
export function sessionOrIpKey(req: Request): string {
  const token = accessToken(req);
  return token ? `tok:${hash(token)}` : `ip:${ipKey(req)}`;
}

/** Login key: the account being tried + the IP trying it. */
export function accountAndIpKey(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  return `acct:${hash(email)}:${ipKey(req)}`;
}

/** Refresh key: the refresh token presented (body or cookie), else the IP. */
export function refreshTokenKey(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token =
    (typeof body.refreshToken === 'string' && body.refreshToken) ||
    (typeof body.refresh === 'string' && body.refresh) ||
    (req.cookies as Record<string, string> | undefined)?.sanctum_rt ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice('Bearer '.length) : undefined);
  return token ? `rt:${hash(token)}` : `ip:${ipKey(req)}`;
}

/** Per-person AI key (runs after authentication). */
function actorKey(req: Request): string {
  const actor = (req as Request & { actor?: { userId?: string; tokenId?: string } }).actor;
  const id = actor?.userId ?? actor?.tokenId;
  return id ? `actor:${id}` : sessionOrIpKey(req);
}

const common = { standardHeaders: 'draft-7' as const, legacyHeaders: false, skip: skipInTest };

/** Global API limiter, per signed-in session (or per IP when anonymous). */
export const globalLimiter = rateLimit({
  ...common,
  windowMs: rateLimitConfig.global.windowMs,
  limit: rateLimitConfig.global.max,
  keyGenerator: sessionOrIpKey,
  message: envelope('RATE_LIMITED', 'Too many requests.'),
});

/** Generous per-IP backstop for all API traffic. */
export const globalIpLimiter = rateLimit({
  ...common,
  windowMs: rateLimitConfig.globalIp.windowMs,
  limit: rateLimitConfig.globalIp.max,
  message: envelope('RATE_LIMITED', 'Too many requests.'),
});

/** Login attempts per account + IP (password guessing on one account). */
export const loginLimiter = rateLimit({
  ...common,
  windowMs: rateLimitConfig.auth.windowMs,
  limit: rateLimitConfig.auth.max,
  keyGenerator: accountAndIpKey,
  message: envelope('RATE_LIMITED', 'Too many attempts for this account. Wait a few minutes and try again.'),
});

/**
 * Per-IP backstop for login / signup / password and invite flows. Kept as
 * `authLimiter` for existing imports.
 */
export const authLimiter = rateLimit({
  ...common,
  windowMs: rateLimitConfig.authIp.windowMs,
  limit: rateLimitConfig.authIp.max,
  message: envelope('RATE_LIMITED', 'Too many attempts, try again later.'),
});

/** Token refresh, per refresh token (a valid secret is required anyway). */
export const refreshLimiter = rateLimit({
  ...common,
  windowMs: rateLimitConfig.refresh.windowMs,
  limit: rateLimitConfig.refresh.max,
  keyGenerator: refreshTokenKey,
  message: envelope('RATE_LIMITED', 'Too many requests.'),
});

/** AI generation limiter per person (cost control), on top of the per-plan quota. */
export const aiLimiter = rateLimit({
  ...common,
  windowMs: rateLimitConfig.ai.windowMs,
  limit: rateLimitConfig.ai.max,
  keyGenerator: actorKey,
  message: envelope('RATE_LIMITED', 'AI rate limit reached.'),
});

/** Public portal limiter (brute-force resistance on token resolution). */
export const portalLimiter = rateLimit({
  ...common,
  windowMs: rateLimitConfig.portal.windowMs,
  limit: rateLimitConfig.portal.max,
  message: envelope('RATE_LIMITED', 'Too many requests.'),
});
