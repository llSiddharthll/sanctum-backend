import cors from 'cors';
import { env } from '../env.js';

/**
 * Locked CORS: only the configured FRONTEND_ORIGIN (plus localhost in dev)
 * may make credentialed requests. Origin is never '*' (incompatible with
 * credentials: true).
 */
const allowList = new Set(
  [env.FRONTEND_ORIGIN, 'http://localhost:3000'].filter(Boolean),
);

export const corsMw = cors({
  origin(origin, cb) {
    // Same-origin / curl / server-to-server (no Origin header) -> allow.
    if (!origin) return cb(null, true);
    if (allowList.has(origin)) return cb(null, true);
    return cb(new Error('CORS_NOT_ALLOWED'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining'],
  maxAge: 600,
});
