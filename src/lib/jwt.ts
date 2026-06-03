import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../env.js';

const ACCESS_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshKey = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

export type Role = 'owner' | 'admin' | 'member';

export interface AccessClaims extends JWTPayload {
  sub: string; // userId
  agencyId: string;
  role: Role;
  type: 'access';
}

export interface RefreshClaims extends JWTPayload {
  sub: string; // userId
  agencyId: string;
  type: 'refresh';
}

export async function signAccessToken(input: {
  userId: string;
  agencyId: string;
  role: Role;
}): Promise<string> {
  return new SignJWT({
    agencyId: input.agencyId,
    role: input.role,
    type: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(accessKey);
}

export async function signRefreshToken(input: {
  userId: string;
  agencyId: string;
}): Promise<string> {
  return new SignJWT({ agencyId: input.agencyId, type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_TTL_SECONDS}s`)
    .sign(refreshKey);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, accessKey);
  if (payload.type !== 'access' || typeof payload.sub !== 'string') {
    throw new Error('Invalid access token');
  }
  return payload as AccessClaims;
}

export async function verifyRefreshToken(
  token: string,
): Promise<RefreshClaims> {
  const { payload } = await jwtVerify(token, refreshKey);
  if (payload.type !== 'refresh' || typeof payload.sub !== 'string') {
    throw new Error('Invalid refresh token');
  }
  return payload as RefreshClaims;
}

export const tokenTtl = {
  accessSeconds: ACCESS_TTL_SECONDS,
  refreshSeconds: REFRESH_TTL_SECONDS,
};
