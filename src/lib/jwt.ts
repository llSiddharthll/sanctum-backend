import { jwtVerify, type JWTPayload } from 'jose';
import { env } from '../env.js';

/**
 * LEGACY token support only. Sessions and access tokens live in
 * src/authz/sessions.ts. What remains here:
 *  - `Role`: the legacy users.role column type (display/compat only),
 *  - verification of pre-session refresh JWTs, exchanged ONCE for a session.
 * TODO(authz phase 10): delete after the legacy refresh window (30 days).
 */
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const refreshKey = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

export type Role = 'owner' | 'admin' | 'member' | 'client';

export interface RefreshClaims extends JWTPayload {
  sub: string;
  agencyId: string;
  type: 'refresh';
}

export async function verifyRefreshToken(token: string): Promise<RefreshClaims> {
  const { payload } = await jwtVerify(token, refreshKey);
  if (payload.type !== 'refresh' || typeof payload.sub !== 'string') {
    throw new Error('Invalid refresh token');
  }
  return payload as RefreshClaims;
}

export const tokenTtl = { refreshSeconds: REFRESH_TTL_SECONDS };
