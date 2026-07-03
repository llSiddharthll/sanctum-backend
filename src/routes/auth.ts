import { Router } from 'express';
import { z } from 'zod';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  customRoles,
  invites,
  passwordResets,
  plans,
  subscriptions,
  users,
} from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { createPasswordReset } from '../services/password-reset.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/jwt.js';
import { setAuthCookies, clearAuthCookies } from '../lib/cookies.js';
import { ok, created } from '../lib/http.js';
import { newId, hashToken } from '../lib/ids.js';
import {
  invalidCredentials,
  unauthenticated,
  notFound,
  gone,
  badRequest,
  conflict,
} from '../lib/errors.js';
import { requireAuth, REFRESH_COOKIE } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rate-limit.js';
import { getAuth } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import { resolvePermissions } from '../lib/permissions.js';

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
): Promise<{ access: string; refresh: string }> {
  const access = await signAccessToken({
    userId: user.id,
    agencyId: user.agencyId,
    role: user.role,
  });
  const refresh = await signRefreshToken({
    userId: user.id,
    agencyId: user.agencyId,
  });
  // Cookies stay for desktop browsers; the tokens are ALSO returned in the body
  // so the SPA can store + send them as `Authorization: Bearer` — the cross-site
  // cookie (Vercel ↔ Render) is blocked by iOS/iPadOS WebKit, which was bouncing
  // iPad/iPhone users back to login. Bearer auth works on every device.
  setAuthCookies(res, { access, refresh });
  return { access, refresh };
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

  // Email is the global login identifier (login resolves lower(email) with no
  // agency scope), so it must be globally unique. Reject a duplicate signup
  // before creating the agency to avoid an ambiguous login + orphaned agency.
  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existingUser.length) {
    throw conflict('An account with this email already exists. Try signing in.');
  }

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

  const tokens = await issueSession(res, {
    id: userId,
    agencyId,
    role: 'owner',
  });
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
    tokens,
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

  const tokens = await issueSession(res, {
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
    tokens,
  });
});

/**
 * Resolve a pending, unexpired invite by its raw token, or throw. Lazily marks
 * an over-due invite 'expired'. Shared by GET /invite (preview) and
 * POST /accept-invite (consume).
 */
async function findPendingInvite(rawToken: string) {
  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!invite) throw notFound('This invite link is invalid.');
  if (invite.status === 'accepted') {
    throw gone('This invite has already been used. Try signing in instead.');
  }
  if (invite.status === 'revoked') throw gone('This invite was revoked.');
  if (invite.expiresAt.getTime() <= Date.now()) {
    if (invite.status !== 'expired') {
      await db
        .update(invites)
        .set({ status: 'expired' })
        .where(eq(invites.id, invite.id));
    }
    throw gone('This invite has expired. Ask your admin to re-invite you.');
  }
  return invite;
}

/** The teammate account created at invite time (active, random password). */
async function inviteMember(invite: typeof invites.$inferSelect) {
  const [member] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.agencyId, invite.agencyId),
        sql`lower(${users.email}) = ${invite.email.toLowerCase()}`,
      ),
    )
    .limit(1);
  return member;
}

// GET /auth/invite?token=... — preview an invite (does NOT consume it) so the
// accept page can greet the user with their email + agency.
authRouter.get('/invite', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) throw badRequest('Missing invite token.');
  const invite = await findPendingInvite(token);
  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, invite.agencyId))
    .limit(1);
  const member = await inviteMember(invite);
  ok(res, {
    email: invite.email,
    role: invite.role,
    agencyName: agency?.name ?? 'your team',
    fullName: member?.fullName ?? null,
  });
});

// POST /auth/accept-invite — set a password on the invited account, mark the
// invite accepted, and log the member straight in (sets session cookies).
const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
  fullName: z.string().trim().min(1).max(120).optional(),
});

authRouter.post('/accept-invite', authLimiter, async (req, res) => {
  const body = acceptInviteSchema.parse(req.body);
  const invite = await findPendingInvite(body.token);

  const member = await inviteMember(invite);
  if (!member) throw notFound('This invite is no longer valid.');
  if (member.status !== 'active') throw gone('This account is not active.');

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(body.password),
      ...(body.fullName ? { fullName: body.fullName } : {}),
    })
    .where(eq(users.id, member.id));

  await db
    .update(invites)
    .set({ status: 'accepted', acceptedAt: new Date() })
    .where(eq(invites.id, invite.id));

  const tokens = await issueSession(res, {
    id: member.id,
    agencyId: member.agencyId,
    role: member.role,
  });
  await audit({
    agencyId: member.agencyId,
    actorType: member.role,
    actorId: member.id,
    action: 'team.invite.accept',
    entityType: 'user',
    entityId: member.id,
    ip: req.ip,
  });

  ok(res, {
    user: {
      id: member.id,
      email: member.email,
      fullName: body.fullName ?? member.fullName,
      role: member.role,
    },
    agencyId: member.agencyId,
    tokens,
  });
});

// ---- Password reset (forgot password) ----------------------------------

// POST /auth/forgot-password — email a reset link. Always 200 (never reveals
// whether an account exists, to avoid email enumeration).
const forgotSchema = z.object({ email: z.string().email() });

authRouter.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = forgotSchema.parse(req.body);
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1);

  if (user && user.status === 'active') {
    await createPasswordReset(user);
    await audit({
      agencyId: user.agencyId,
      actorType: user.role,
      actorId: user.id,
      action: 'auth.password_reset.request',
      entityType: 'user',
      entityId: user.id,
      ip: req.ip,
    });
  }
  ok(res, { ok: true });
});

/** Resolve a non-expired, unused reset token or throw. */
async function findValidReset(rawToken: string) {
  const [row] = await db
    .select()
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.tokenHash, hashToken(rawToken)),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) throw gone('This reset link is invalid or has expired.');
  return row;
}

// GET /auth/reset-password?token= — validate the link + return the account email.
authRouter.get('/reset-password', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) throw badRequest('Missing reset token.');
  const reset = await findValidReset(token);
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, reset.userId))
    .limit(1);
  if (!user) throw gone('This reset link is invalid or has expired.');
  ok(res, { email: user.email });
});

// POST /auth/reset-password { token, password } — set a new password, consume
// the token (and any other outstanding ones), and sign the user in.
const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});

authRouter.post('/reset-password', authLimiter, async (req, res) => {
  const body = resetSchema.parse(req.body);
  const reset = await findValidReset(body.token);
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, reset.userId))
    .limit(1);
  if (!user || user.status !== 'active') {
    throw gone('This account is not active.');
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(body.password) })
    .where(eq(users.id, user.id));

  // Burn every outstanding reset token for this user (single-use + cleanup).
  await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResets.userId, user.id),
        isNull(passwordResets.usedAt),
      ),
    );

  const tokens = await issueSession(res, {
    id: user.id,
    agencyId: user.agencyId,
    role: user.role,
  });
  await audit({
    agencyId: user.agencyId,
    actorType: user.role,
    actorId: user.id,
    action: 'auth.password_reset',
    entityType: 'user',
    entityId: user.id,
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
    tokens,
  });
});

// POST /auth/change-password { currentPassword, newPassword } — authenticated.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const ctx = getAuth(req);
  const body = changePasswordSchema.parse(req.body);
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);
  if (!user) throw notFound('User not found.');

  const valid = await verifyPassword(user.passwordHash, body.currentPassword);
  if (!valid) throw badRequest('Your current password is incorrect.');

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(body.newPassword) })
    .where(eq(users.id, user.id));
  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'auth.password_change',
    entityType: 'user',
    entityId: ctx.userId,
    ip: req.ip,
  });
  ok(res, { ok: true });
});

// POST /auth/refresh — rotate tokens from the refresh cookie.
authRouter.post('/refresh', authLimiter, async (req, res) => {
  // Prefer the cookie (desktop); fall back to a body field or Bearer header so
  // the SPA can refresh on devices where the cross-site cookie is blocked (iOS).
  const header = req.headers.authorization;
  const bearer =
    header && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined;
  const bodyToken =
    req.body && typeof req.body.refreshToken === 'string'
      ? (req.body.refreshToken as string)
      : undefined;
  const token =
    (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? bodyToken ?? bearer;
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

  const tokens = await issueSession(res, {
    id: user.id,
    agencyId: user.agencyId,
    role: user.role,
  });
  ok(res, { refreshed: true, tokens });
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

  // Resolve the user's custom role (if any) for its name + permission preset.
  let customRole = null;
  if (user.customRoleId) {
    const [cr] = await db
      .select()
      .from(customRoles)
      .where(
        and(
          eq(customRoles.id, user.customRoleId),
          eq(customRoles.agencyId, ctx.agencyId),
        ),
      )
      .limit(1);
    customRole = cr ?? null;
  }
  const builtinLabel =
    user.role === 'owner' ? 'Owner' : user.role === 'admin' ? 'Admin' : 'Member';

  ok(res, {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      customRoleId: user.customRoleId,
      roleName: customRole?.name ?? builtinLabel,
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
    // Effective module permissions for sidebar/route gating on the client
    // (user override > custom role > agency role default > built-in default).
    permissions: resolvePermissions(
      user.role,
      user.permissionsJson,
      agency?.rolePermissionsJson ?? null,
      customRole?.permissionsJson ?? null,
    ),
  });
});
