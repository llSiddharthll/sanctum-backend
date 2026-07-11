import cors from 'cors';
import { env, isProd } from '../env.js';
import { isAllowedOrigin } from './origin.js';

/**
 * Locked CORS: only the configured FRONTEND_ORIGIN (plus localhost, and any
 * private-LAN origin in dev so phones/other devices on the same network can
 * use the dev server) may make credentialed requests. Origin is never '*'
 * (incompatible with credentials: true).
 */
const allowList = new Set(
  [...env.FRONTEND_ORIGIN.split(','), 'http://localhost:3000']
    .map((s) => s.trim())
    .filter(Boolean),
);

export const corsMw = cors({
  origin(origin, cb) {
    // Same-origin / curl / server-to-server (no Origin header) -> allow.
    if (!origin) return cb(null, true);
    if (isAllowedOrigin(origin, allowList, !isProd)) return cb(null, true);
    return cb(new Error('CORS_NOT_ALLOWED'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining'],
  maxAge: 600,
});
