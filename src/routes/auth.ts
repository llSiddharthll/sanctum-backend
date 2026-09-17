import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  invites,
  passwordResets,
  plans,
  roles,
  sessions,
  subscriptions,
  userRoles,
  users,
} from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { createPasswordReset } from '../services/password-reset.js';
import { verifyRefreshToken } from '../lib/jwt.js';
import { setAuthCookies, clearAuthCookies } from '../lib/cookies.js';
import { ok, created } from '../lib/http.js';
import { newId, hashToken } from '../lib/ids.js';
import {
  AppError,
  invalidCredentials,
  unauthenticated,
  notFound,
  gone,
  badRequest,
  conflict,
  forbidden,
} from '../lib/errors.js';
import { env } from '../env.js';
import { REFRESH_COOKIE } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rate-limit.js';
import { audit } from '../services/audit.js';
import {
  authenticate,
  getActor,
  getUserActor,
  readAccessToken,
} from '../authz/http.js';
import {
  createSession,
  getSession,
  listUserSessions,
  revokeSessions,
  revokeUserSessions,
  rotateRefresh,
  verifyAnyAccessToken,
  type SessionActorType,
} from '../authz/sessions.js';
import { initAgencyAuthorization } from '../authz/roles-store.js';
import { legacyPermissionMap, legacyPersona } from '../authz/compat.js';
import { CATALOG_VERSION } from '../authz/catalog.js';
import { actorAuditId } from '../authz/actor.js';

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

/**
 * Start a server-side session for a user and hand out tokens. Cookies stay for
 * desktop browsers; tokens are also returned in the body for Bearer clients
 * (iOS WebKit blocks the cross-site cookie).
 */
async function startUserSession(
  req: Request,
  res: Response,
  user: { id: string; agencyId: string; kind: 'staff' | 'client' },
): Promise<{ access: string; refresh: string }> {
  const s = await createSession({
    actorType: user.kind as SessionActorType,
    agencyId: user.agencyId,
    userId: user.id,
    req,
  });
  const tokens = { access: s.access, refresh: s.refresh };
  setAuthCookies(res, tokens, s.expiresAt);
  return tokens;
}

function isSyntheticPortalUser(email: string): boolean {
  return email.toLowerCase().endsWith('@portal.sanctum');
}

// POST /auth/signup — create agency + first owner.
const signupSchema = z.object({
  agencyName: z.string().min(1).max(120),
  fullName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

authRouter.post('/signup', authLimiter, async (req, res) => {
  if (!env.ALLOW_SIGNUP) {
    throw forbidden(
      'Public sign-up is disabled. Ask an admin to invite you to the workspace.',
    );
  }
  const body = signupSchema.parse(req.body);
  const email = body.email.toLowerCase();

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
  const existingSlug = await db
    .select({ id: agencies.id })
    .from(agencies)
    .where(eq(agencies.slug, slug))
    .limit(1);
  if (existingSlug.length) slug = `${slug}-${agencyId.slice(-6)}`;

  await db.insert(agencies).values({ id: agencyId, name: body.agencyName, slug });

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
    kind: 'staff',
    status: 'active',
  });
  await initAgencyAuthorization(agencyId, userId);

  const tokens = await startUserSession(req, res, { id: userId, agencyId, kind: 'staff' });
  await audit({
    agencyId,
    actorType: 'staff',
    actorId: userId,
    action: 'agency.signup',
    entityType: 'agency',
    entityId: agencyId,
    ip: req.ip,
  });

  created(res, {
    user: { id: userId, email, fullName: body.fullName, kind: 'staff', role: 'owner' },
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

  // Email is unique per agency; the same address may exist in two agencies.
  // Resolve by password so an invite from another agency can't hijack or lock
  // out a login. Ambiguity (same password in both) is refused, never guessed.
  const candidates = await db
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, eq(users.status, 'active')))
    .limit(5);
  const matches = [];
  for (const u of candidates) {
    if (isSyntheticPortalUser(u.email)) continue;
    if (await verifyPassword(u.passwordHash, body.password)) matches.push(u);
  }
  if (matches.length === 0) throw invalidCredentials();
  if (matches.length > 1) {
    throw conflict(
      'This email belongs to more than one workspace. Ask your admin to change one of the accounts.',
    );
  }
  const user = matches[0]!;

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  const tokens = await startUserSession(req, res, user);
  await audit({
    agencyId: user.agencyId,
    actorType: user.kind,
    actorId: user.id,
    action: 'auth.login',
    ip: req.ip,
  });

  ok(res, {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      kind: user.kind,
      role: user.role,
    },
    agencyId: user.agencyId,
    tokens,
  });
});

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
      await db.update(invites).set({ status: 'expired' }).where(eq(invites.id, invite.id));
    }
    throw gone('This invite has expired. Ask your admin to re-invite you.');
  }
  return invite;
}

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

// GET /auth/invite?token=... — preview an invite (does NOT consume it).
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
  const roleNames = member
    ? (
        await db
          .select({ name: roles.name })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(eq(userRoles.userId, member.id))
      ).map((r) => r.name)
    : [];
  ok(res, {
    email: invite.email,
    kind: invite.role === 'client' ? 'client' : 'staff',
    roles: roleNames,
    role: invite.role,
    agencyName: agency?.name ?? 'your team',
    fullName: member?.fullName ?? null,
  });
});

// POST /auth/accept-invite — set a password on the invited account and sign in.
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
  // Any session created before the invite was accepted is void.
  await revokeUserSessions(member.id, 'invite_accepted');

  await db
    .update(invites)
    .set({ status: 'accepted', acceptedAt: new Date() })
    .where(eq(invites.id, invite.id));

  const tokens = await startUserSession(req, res, member);
  await audit({
    agencyId: member.agencyId,
    actorType: member.kind,
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
      kind: member.kind,
      role: member.role,
    },
    agencyId: member.agencyId,
    tokens,
  });
});

// ---- Password reset ------------------------------------------------------

const forgotSchema = z.object({ email: z.string().email() });

authRouter.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = forgotSchema.parse(req.body);
  const accounts = await db
    .select()
    .from(users)
    .where(
      and(sql`lower(${users.email}) = ${email.toLowerCase()}`, eq(users.status, 'active')),
    )
    .limit(5);

  for (const user of accounts) {
    if (isSyntheticPortalUser(user.email)) continue;
    await createPasswordReset(user, { req });
    await audit({
      agencyId: user.agencyId,
      actorType: user.kind,
      actorId: user.id,
      action: 'auth.password_reset.request',
      entityType: 'user',
      entityId: user.id,
      ip: req.ip,
    });
  }
  ok(res, { ok: true });
});

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

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});

authRouter.post('/reset-password', authLimiter, async (req, res) => {
  const body = resetSchema.parse(req.body);
  const reset = await findValidReset(body.token);
  const [user] = await db.select().from(users).where(eq(users.id, reset.userId)).limit(1);
  if (!user || user.status !== 'active') throw gone('This account is not active.');

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(body.password) })
    .where(eq(users.id, user.id));
  await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
  // A reset means the old credential may be compromised: end every session.
  await revokeUserSessions(user.id, 'password_reset');

  const tokens = await startUserSession(req, res, user);
  await audit({
    agencyId: user.agencyId,
    actorType: user.kind,
    actorId: user.id,
    action: 'auth.password_reset',
    entityType: 'user',
    entityId: user.id,
    ip: req.ip,
  });

  ok(res, {
    user: { id: user.id, email: user.email, fullName: user.fullName, kind: user.kind, role: user.role },
    agencyId: user.agencyId,
    tokens,
  });
});

// POST /auth/change-password — authenticated; ends every OTHER session.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

authRouter.post('/change-password', authenticate, async (req, res) => {
  const actor = getUserActor(req);
  const body = changePasswordSchema.parse(req.body);
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId)).limit(1);
  if (!user) throw notFound('User not found.');

  const valid = await verifyPassword(user.passwordHash, body.currentPassword);
  if (!valid) throw badRequest('Your current password is incorrect.');

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(body.newPassword) })
    .where(eq(users.id, user.id));
  const ended = await revokeUserSessions(user.id, 'password_change', actor.sessionId);
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actor.userId,
    action: 'auth.password_change',
    entityType: 'user',
    entityId: actor.userId,
    metadata: { otherSessionsEnded: ended },
    ip: req.ip,
  });
  ok(res, { ok: true });
});

function readRefreshToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  const bodyToken =
    req.body && typeof req.body.refreshToken === 'string'
      ? (req.body.refreshToken as string)
      : undefined;
  return bodyToken ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? bearer;
}

// POST /auth/refresh — rotate the refresh token; reuse revokes the session.
authRouter.post('/refresh', authLimiter, async (req, res) => {
  const token = readRefreshToken(req);
  if (!token) throw unauthenticated('No refresh token.');

  try {
    if (token.split('.').length === 3) {
      // Legacy JWT refresh token issued before sessions existed: exchange ONCE
      // for a real session. TODO(authz phase 10): remove after 30 days.
      let claims;
      try {
        claims = await verifyRefreshToken(token);
      } catch {
        throw unauthenticated('Invalid refresh token.');
      }
      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, claims.sub), eq(users.agencyId, claims.agencyId)))
        .limit(1);
      if (!user || user.status !== 'active' || isSyntheticPortalUser(user.email)) {
        throw unauthenticated('Session no longer valid.');
      }
      const tokens = await startUserSession(req, res, user);
      return ok(res, { refreshed: true, tokens });
    }

    const r = await rotateRefresh(token);
    const tokens = { access: r.access, refresh: r.refresh };
    setAuthCookies(res, tokens, r.session.expiresAt);
    ok(res, { refreshed: true, tokens });
  } catch (err) {
    if (err instanceof AppError && err.status === 401) clearAuthCookies(res);
    throw err;
  }
});

// POST /auth/logout — ends the current session (access or refresh token).
authRouter.post('/logout', async (req, res) => {
  clearAuthCookies(res);
  let sessionId: string | null = null;
  const access = readAccessToken(req);
  if (access) {
    try {
      const claims = await verifyAnyAccessToken(access);
      if (claims.v === 2 && typeof claims.sid === 'string') sessionId = claims.sid;
    } catch {
      // expired access token: fall back to the refresh token below
    }
  }
  if (!sessionId) {
    const refresh = readRefreshToken(req);
    if (refresh && refresh.split('.').length !== 3) {
      const [row] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.refreshHash, hashToken(refresh)))
        .limit(1);
      sessionId = row?.id ?? null;
    }
  }
  if (sessionId) {
    const s = await getSession(sessionId);
    await revokeSessions([sessionId], 'logout');
    if (s) {
      await audit({
        agencyId: s.agencyId,
        actorType: s.actorType,
        actorId: s.userId ?? s.portalTokenId ?? undefined,
        action: 'auth.logout',
        metadata: { sessionId },
        ip: req.ip,
      });
    }
  }
  ok(res, { loggedOut: true });
});

// GET /auth/me — identity + the authorization contract (design §I.5).
authRouter.get('/me', authenticate, async (req, res) => {
  const anyActor = getActor(req);
  if (anyActor.type === 'portal_link') {
    // Share-link session: no user record; identity is the link itself.
    const [agency] = await db.select().from(agencies).where(eq(agencies.id, anyActor.agencyId)).limit(1);
    return ok(res, {
      user: null,
      link: { id: anyActor.tokenId, clientId: anyActor.clientId },
      agency: agency
        ? { id: agency.id, name: agency.name, slug: agency.slug, themePreset: agency.themePreset }
        : null,
      plan: null,
      authorization: {
        version: `link.${CATALOG_VERSION}`,
        actorType: anyActor.type,
        roles: [],
        grants: anyActor.grants.toJSON(),
        projectAccess: anyActor.projectAccess,
      },
      persona: 'client',
      permissions: legacyPermissionMap(anyActor),
    });
  }
  const actor = getUserActor(req);
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.agencyId, actor.agencyId)))
    .limit(1);
  if (!user) throw notFound('User not found.');

  const [agency] = await db.select().from(agencies).where(eq(agencies.id, actor.agencyId)).limit(1);
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.agencyId, actor.agencyId))
    .limit(1);
  let plan = null;
  if (sub) {
    const [p] = await db.select().from(plans).where(eq(plans.id, sub.planId)).limit(1);
    plan = p ?? null;
  }

  const roleRows = await db
    .select({ id: roles.id, key: roles.key, name: roles.name, kind: roles.kind })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, user.id), isNull(roles.archivedAt)));

  // ---- Legacy fields (old app builds). TODO(authz phase 10): remove. ----
  const persona = legacyPersona(actor, user.role);
  const legacyRoleName = roleRows[0]?.name ?? 'Employee';

  ok(res, {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      kind: user.kind,
      clientId: user.clientId ?? null,
      // legacy
      role: user.role,
      customRoleId: null,
      roleName: legacyRoleName,
      persona,
    },
    agency: agency
      ? { id: agency.id, name: agency.name, slug: agency.slug, themePreset: agency.themePreset }
      : null,
    plan: plan
      ? {
          id: plan.id,
          name: plan.name,
          maxClients: plan.maxClients,
          maxAiGenerations: plan.maxAiGenerations,
        }
      : null,
    authorization: {
      version: `${actor.authzVersion}.${CATALOG_VERSION}`,
      actorType: actor.type,
      roles: roleRows,
      grants: actor.grants.toJSON(),
      projectAccess: actor.type === 'client' ? actor.projectAccess : null,
    },
    // legacy
    persona,
    permissions: legacyPermissionMap(actor),
  });
});

// GET /auth/sessions — the caller's live sessions.
authRouter.get('/sessions', authenticate, async (req, res) => {
  const actor = getActor(req);
  if (actor.type !== 'staff' && actor.type !== 'client') throw forbidden();
  const rows = await listUserSessions(actor.userId);
  ok(
    res,
    rows.map((r) => ({ ...r, current: r.id === actor.sessionId })),
  );
});

// DELETE /auth/sessions/:id — end one of the caller's own sessions.
authRouter.delete('/sessions/:id', authenticate, async (req, res) => {
  const actor = getUserActor(req);
  const s = await getSession(String(req.params.id));
  if (!s || s.userId !== actor.userId) throw notFound();
  await revokeSessions([s.id], 'user_signout');
  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: 'auth.session.revoke',
    entityType: 'session',
    entityId: s.id,
    ip: req.ip,
  });
  ok(res, { revoked: true });
});
