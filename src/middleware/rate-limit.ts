import rateLimit from 'express-rate-limit';

function envelope(code: string, message: string) {
  return { error: { code, message } };
}

/** Skip rate limiting under the automated test runner (NODE_ENV=test). */
const skipInTest = () => process.env.NODE_ENV === 'test';

/**
 * Numeric rate-limit configuration — the single source of truth for both the
 * limiters below and any handler that wants to surface the limits (e.g.
 * GET /agency/usage). Each entry is `{ max, windowMs }`.
 */
export const rateLimitConfig = {
  global: { max: 300, windowMs: 60 * 1000 },
  auth: { max: 20, windowMs: 15 * 60 * 1000 },
  ai: { max: 30, windowMs: 60 * 60 * 1000 },
  portal: { max: 60, windowMs: 60 * 1000 },
} as const;

/** Global API limiter. */
export const globalLimiter = rateLimit({
  windowMs: rateLimitConfig.global.windowMs,
  limit: rateLimitConfig.global.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTest,
  message: envelope('RATE_LIMITED', 'Too many requests.'),
});

/** Strict limiter for auth (login/signup/refresh). */
export const authLimiter = rateLimit({
  windowMs: rateLimitConfig.auth.windowMs,
  limit: rateLimitConfig.auth.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTest,
  message: envelope('RATE_LIMITED', 'Too many attempts, try again later.'),
});

/** AI generation limiter (cost control), on top of the per-plan quota. */
export const aiLimiter = rateLimit({
  windowMs: rateLimitConfig.ai.windowMs,
  limit: rateLimitConfig.ai.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTest,
  message: envelope('RATE_LIMITED', 'AI rate limit reached.'),
});

/** Public portal limiter (brute-force resistance on token resolution). */
export const portalLimiter = rateLimit({
  windowMs: rateLimitConfig.portal.windowMs,
  limit: rateLimitConfig.portal.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTest,
  message: envelope('RATE_LIMITED', 'Too many requests.'),
});
