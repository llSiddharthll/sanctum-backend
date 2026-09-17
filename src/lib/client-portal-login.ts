import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { assignRoles, systemRoleId } from '../authz/roles-store.js';
import { clients, users } from '../db/schema.js';
import { hashPassword } from './password.js';
import { newId } from './ids.js';
import { badRequest, conflict } from './errors.js';
import { sendEmail, basicHtml } from '../services/email.js';

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
import { createPasswordReset } from '../services/password-reset.js';
import { getFrontendOrigin } from './frontend-url.js';

/**
 * Client-portal login provisioning — shared by clients.ts (/portal-login*) and
 * the document-mode send flows (proposals / agreements / invoices).
 *
 * Credential-integrity rules (authz audit 06 §2.5):
 *  - Accounts are identified by EMAIL within the brand. We never pick "the
 *    oldest client user" and never rewrite another account's email.
 *  - An existing account is never given a staff-chosen/generated password and
 *    is never re-enabled. At most, the account holder gets a reset link at
 *    their own address.
 *  - Only a brand-new account gets a generated password, returned exactly once.
 */

// Easy-to-type password: 8 lowercase-unambiguous chars (no i/l/o/0/1), grouped
// 4-4 (e.g. "kmrp-2t9x").
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generatePortalPassword(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += PW_ALPHABET[bytes[i]! % PW_ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out;
}

function isSyntheticPortalEmail(email: string): boolean {
  return email.toLowerCase().endsWith('@portal.sanctum');
}

/** All real (non share-link) client login accounts of a brand, oldest first. */
export async function listClientLogins(agencyId: string, clientId: string) {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.agencyId, agencyId),
        eq(users.clientId, clientId),
        eq(users.kind, 'client'),
      ),
    )
    .orderBy(asc(users.createdAt));
  return rows.filter((u) => !isSyntheticPortalEmail(u.email));
}

/** The brand's first real portal-login account (status display only), if any. */
export async function findClientLogin(agencyId: string, clientId: string) {
  const all = await listClientLogins(agencyId, clientId);
  return all.find((u) => u.status === 'active') ?? all[0] ?? null;
}

/** The brand's client account with exactly this email, if any. */
export async function findClientLoginByEmail(agencyId: string, clientId: string, email: string) {
  const [u] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.agencyId, agencyId),
        eq(users.clientId, clientId),
        eq(users.kind, 'client'),
        sql`lower(${users.email}) = ${email.toLowerCase().trim()}`,
      ),
    )
    .limit(1);
  return u ?? null;
}

export interface PortalLoginResult {
  userId: string;
  email: string;
  /** Plaintext password — ONLY for a brand-new account; undefined otherwise. */
  password?: string;
  created: boolean;
  /** Existing account: status as found (never changed here). */
  status: 'active' | 'disabled';
  /** Existing active account: a reset link was emailed to the account's own address. */
  resetSent: boolean;
}

/**
 * Ensure a portal login exists for `email` on this brand.
 *  - No client account with that email for the brand → create one (kind
 *    'client', role by brand portalRole, all projects) with a generated
 *    password returned once.
 *  - One exists → nothing about the account changes. When `sendResetIfExists`
 *    and the account is active, a password-reset link is emailed to the
 *    account's own address.
 * An email used by any other account (staff, another brand, another agency)
 * is rejected with 409.
 */
export async function mintClientPortalLogin(params: {
  agencyId: string;
  clientId: string;
  clientName: string;
  clientContactEmail?: string | null;
  email?: string;
  /** Ignored (kept for call-site compatibility): staff never choose client passwords. */
  password?: string;
  sendResetIfExists?: boolean;
  req?: Request;
}): Promise<PortalLoginResult> {
  const email = (params.email?.trim() || params.clientContactEmail || '').toLowerCase().trim();
  if (!email) {
    throw badRequest(
      'No email for this client — add a contact email or enter one to use as the login.',
    );
  }
  if (isSyntheticPortalEmail(email)) throw badRequest('That email cannot be used as a login.');

  const existing = await findClientLoginByEmail(params.agencyId, params.clientId, email);
  if (existing) {
    let resetSent = false;
    if (params.sendResetIfExists && existing.status === 'active') {
      await createPasswordReset(
        { id: existing.id, agencyId: existing.agencyId, email: existing.email, fullName: existing.fullName },
        { byAdmin: true, req: params.req },
      );
      resetSent = true;
    }
    return {
      userId: existing.id,
      email: existing.email,
      created: false,
      status: existing.status,
      resetSent,
    };
  }

  // Login resolves email globally, so the address must not belong to any other account.
  const [clash] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (clash) {
    throw conflict('That email is already used by another account. Use a different email.');
  }

  const password = generatePortalPassword();
  const passwordHash = await hashPassword(password);
  const userId = newId('usr');
  const [brand] = await db
    .select({ portalRole: clients.portalRole })
    .from(clients)
    .where(and(eq(clients.id, params.clientId), eq(clients.agencyId, params.agencyId)))
    .limit(1);
  const roleId = await systemRoleId(
    params.agencyId,
    brand?.portalRole === 'reviewer' ? 'client_reviewer' : 'client_approver',
  );
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      agencyId: params.agencyId,
      clientId: params.clientId,
      email,
      passwordHash,
      fullName: `${params.clientName} (portal)`,
      role: 'client',
      kind: 'client',
      clientProjectAccess: 'all',
      status: 'active',
    });
    if (roleId) await assignRoles(tx, { agencyId: params.agencyId, userId, roleIds: [roleId] });
  });
  return { userId, email, password, created: true, status: 'active', resetSent: false };
}

/** Email the client their branded portal sign-in (link + email, and a password only for a new account). */
export async function sendClientPortalLoginEmail(params: {
  req: Request;
  agencyName: string;
  clientName: string;
  to: string;
  email: string;
  password?: string;
  note?: string;
}): Promise<void> {
  const loginUrl = `${getFrontendOrigin(params.req)}/login`;
  const note = params.note?.trim();
  const intro = note
    ? escapeHtml(note)
    : `${escapeHtml(params.agencyName)} has set up your private client portal — follow your projects, view the content calendar, review proposals & agreements, see invoices, and download shared files, all in one place.`;
  const creds = params.password
    ? `Sign in with these details:<br><br><strong>Email:</strong> ${escapeHtml(params.email)}<br><strong>Password:</strong> ${escapeHtml(params.password)}<br><br>Keep these private — you can change your password after signing in.`
    : `Sign in with your email (<strong>${escapeHtml(params.email)}</strong>) and your existing password. Forgot it? Use "Forgot password" on the sign-in page.`;

  await sendEmail({
    to: params.to,
    subject: note
      ? `${params.agencyName}: a new document is ready in your portal`
      : `Your ${params.agencyName} client portal login`,
    html: basicHtml({
      heading: note ? 'A new document is ready' : 'Your secure portal login',
      bodyHtml: `Hi ${escapeHtml(params.clientName)}, ${intro}<br><br>${creds}`,
      buttonLabel: 'Sign in to your portal',
      buttonUrl: loginUrl,
      preheader: note ?? `Your ${params.agencyName} portal login details inside.`,
    }),
    text: `${note ? note + '\n\n' : ''}${params.agencyName} client portal.\nSign in: ${loginUrl}\nEmail: ${params.email}${params.password ? '\nPassword: ' + params.password : '\nUse your existing password.'}\n\nKeep these private.`,
  });
}
