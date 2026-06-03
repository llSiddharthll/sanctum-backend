import { Router } from 'express';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  plans,
  subscriptions,
  users,
} from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/jwt.js';
import { setAuthCookies, clearAuthCookies } from '../lib/cookies.js';
import { ok, created } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import {
  invalidCredentials,
  unauthenticated,
  notFound,
} from '../lib/errors.js';
import { requireAuth, REFRESH_COOKIE } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rate-limit.js';
import { getAuth } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';

export const authRouter = Router();

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agency'
  );
}

async function issueSession(
  res: import('express').Response,
  user: { id: string; agencyId: string; role: 'owner' | 'admin' | 'member' },
) {
  const access = await signAccessToken({
    userId: user.id,
    agencyId: user.agencyId,
    role: user.role,
  });
  const refresh = await signRefreshToken({
    userId: user.id,
    agencyId: user.agencyId,
  });
  setAuthCookies(res, { access, refresh });
}

// POST /auth/signup — create agency + first owner.
const signupSchema = z.object({
  agencyName: z.string().min(1).max(120),
  fullName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

authRouter.post('/signup', authLimiter, async (req, res) => {
  const body = signupSchema.parse(req.body);
  const email = body.email.toLowerCase();

  const agencyId = newId('agc');
  let slug = slugify(body.agencyName);

  // Ensure slug uniqueness (slug is globally unique).
  const existingSlug = await db
    .select({ id: agencies.id })
    .from(agencies)
    .where(eq(agencies.slug, slug))
    .limit(1);
  if (existingSlug.length) slug = `${slug}-${agencyId.slice(-6)}`;

  await db.insert(agencies).values({
    id: agencyId,
    name: body.agencyName,
    slug,
  });

  // Attach a default subscription if a 'studio' plan exists (best-effort).
  const [defaultPlan] = await db
    .select({ id: plans.id })
    .from(plans)
    .orderBy(plans.sortOrder)
    .limit(1);
  if (defaultPlan) {
    await db.insert(subscriptions).values({
      id: newId('sub'),
      agencyId,
      planId: defaultPlan.id,
      status: 'trialing',
    });
  }

  const userId = newId('usr');
  await db.insert(users).values({
    id: userId,
    agencyId,
    email,
    passwordHash: await hashPassword(body.password),
    fullName: body.fullName,
    role: 'owner',
    status: 'active',
  });

  await issueSession(res, { id: userId, agencyId, role: 'owner' });
  await audit({
    agencyId,
    actorType: 'owner',
    actorId: userId,
    action: 'agency.signup',
    entityType: 'agency',
    entityId: agencyId,
    ip: req.ip,
  });

  created(res, {
    user: { id: userId, email, fullName: body.fullName, role: 'owner' },
    agency: { id: agencyId, name: body.agencyName, slug },
  });
});

// POST /auth/login
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const body = loginSchema.parse(req.body);
  const email = body.email.toLowerCase();

  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  // Generic failure -> no user enumeration.
  if (!user || user.status !== 'active') {
    throw invalidCredentials();
  }
  const valid = await verifyPassword(user.passwordHash, body.password);
  if (!valid) throw invalidCredentials();

  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  await issueSession(res, {
    id: user.id,
    agencyId: user.agencyId,
    role: user.role,
  });
  await audit({
    agencyId: user.agencyId,
    actorType: user.role,
    actorId: user.id,
    action: 'auth.login',
    ip: req.ip,
  });

  ok(res, {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    },
    agencyId: user.agencyId,
  });
});

// POST /auth/refresh — rotate tokens from the refresh cookie.
authRouter.post('/refresh', authLimiter, async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw unauthenticated('No refresh token.');

  let claims;
  try {
    claims = await verifyRefreshToken(token);
  } catch {
    clearAuthCookies(res);
    throw unauthenticated('Invalid refresh token.');
  }

  const [user] = await db
    .select()
    .from(users)
    .where(
      and(eq(users.id, claims.sub), eq(users.agencyId, claims.agencyId)),
    )
    .limit(1);
  if (!user || user.status !== 'active') {
    clearAuthCookies(res);
    throw unauthenticated('Session no longer valid.');
  }

  await issueSession(res, {
    id: user.id,
    agencyId: user.agencyId,
    role: user.role,
  });
  ok(res, { refreshed: true });
});

// POST /auth/logout
authRouter.post('/logout', async (req, res) => {
  clearAuthCookies(res);
  if (req.auth) {
    await audit({
      agencyId: req.auth.agencyId,
      actorType: req.auth.role,
      actorId: req.auth.userId,
      action: 'auth.logout',
      ip: req.ip,
    });
  }
  ok(res, { loggedOut: true });
});

// GET /auth/me
authRouter.get('/me', requireAuth, async (req, res) => {
  const ctx = getAuth(req);
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, ctx.userId), eq(users.agencyId, ctx.agencyId)))
    .limit(1);
  if (!user) throw notFound('User not found.');

  const [agency] = await db
    .select()
    .from(agencies)
    .where(eq(agencies.id, ctx.agencyId))
    .limit(1);

  // Plan summary (best-effort).
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.agencyId, ctx.agencyId))
    .limit(1);
  let plan = null;
  if (sub) {
    const [p] = await db
      .select()
      .from(plans)
      .where(eq(plans.id, sub.planId))
      .limit(1);
    plan = p ?? null;
  }

  ok(res, {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    },
    agency: agency
      ? { id: agency.id, name: agency.name, slug: agency.slug }
      : null,
    plan: plan
      ? {
          id: plan.id,
          name: plan.name,
          maxClients: plan.maxClients,
          maxAiGenerations: plan.maxAiGenerations,
        }
      : null,
  });
});
