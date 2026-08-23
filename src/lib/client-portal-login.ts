import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from './password.js';
import { newId } from './ids.js';
import { badRequest, conflict } from './errors.js';
import { sendEmail, basicHtml } from '../services/email.js';
import { getFrontendOrigin } from './frontend-url.js';

/**
 * Shared "secure client-portal login" primitives — the plumbing behind
 * clients.ts's own /portal-login + /portal-login-email routes, factored out
 * so proposals/agreements/invoices can mint-and-email the same real
 * email+password login when a record is document-mode (an uploaded file with
 * no in-app view worth linking to).
 */

// Easy-to-type password: 8 lowercase-unambiguous chars (no i/l/o/0/1), grouped
// 4-4 (e.g. "kmrp-2t9x"). All lowercase + digits so there's no case-switching
// on a phone keyboard.
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generatePortalPassword(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += PW_ALPHABET[bytes[i] % PW_ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out;
}

/** The brand's canonical portal-login account (role:'client'), if any. */
export async function findClientLogin(agencyId: string, clientId: string) {
  const [u] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.agencyId, agencyId),
        eq(users.clientId, clientId),
        eq(users.role, 'client'),
      ),
    )
    .orderBy(asc(users.createdAt))
    .limit(1);
  return u ?? null;
}

/**
 * Create or reset the brand's secure portal login and return the plaintext
 * password (never persisted — this is the only place it's visible).
 */
export async function mintClientPortalLogin(params: {
  agencyId: string;
  clientId: string;
  clientName: string;
  clientContactEmail?: string | null;
  email?: string;
  password?: string;
}): Promise<{ email: string; password: string; created: boolean }> {
  const existing = await findClientLogin(params.agencyId, params.clientId);
  const email = (
    params.email?.trim() ||
    existing?.email ||
    params.clientContactEmail ||
    ''
  )
    .toLowerCase()
    .trim();
  if (!email) {
    throw badRequest(
      'No email for this client — add a contact email or enter one to use as the login.',
    );
  }

  const [clash] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.agencyId, params.agencyId),
        sql`lower(${users.email}) = ${email}`,
      ),
    )
    .limit(1);
  if (clash && clash.id !== existing?.id) {
    throw conflict(
      'That email is already used by another account in your workspace. Use a different email.',
    );
  }

  const password = params.password?.trim() || generatePortalPassword();
  const passwordHash = await hashPassword(password);

  if (existing) {
    await db
      .update(users)
      .set({ email, passwordHash, status: 'active' })
      .where(eq(users.id, existing.id));
    return { email, password, created: false };
  }

  await db.insert(users).values({
    id: newId('usr'),
    agencyId: params.agencyId,
    clientId: params.clientId,
    email,
    passwordHash,
    fullName: `${params.clientName} (portal)`,
    role: 'client',
    status: 'active',
    // Clients have no module permissions; scope = all brand projects.
    permissionsJson: null,
  });
  return { email, password, created: true };
}

/** Email the client their branded secure-login credentials (link + email + password). */
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
    ? note
    : `${params.agencyName} has set up your private client portal — follow your projects, view the content calendar, review proposals & agreements, see invoices, and download shared files, all in one place.`;
  const creds = params.password
    ? `Sign in with these details:<br><br><strong>Email:</strong> ${params.email}<br><strong>Password:</strong> ${params.password}<br><br>Keep these private — you can change your password after signing in.`
    : `Sign in with your email (<strong>${params.email}</strong>) and your existing password. Forgot it? Ask ${params.agencyName} to reset it for you.`;

  await sendEmail({
    to: params.to,
    subject: note
      ? `${params.agencyName}: a new document is ready in your portal`
      : `Your ${params.agencyName} client portal login`,
    html: basicHtml({
      heading: note ? 'A new document is ready' : 'Your secure portal login',
      bodyHtml: `Hi ${params.clientName}, ${intro}<br><br>${creds}`,
      buttonLabel: 'Sign in to your portal',
      buttonUrl: loginUrl,
      preheader: note ?? `Your ${params.agencyName} portal login details inside.`,
    }),
    text: `${note ? note + '\n\n' : ''}${params.agencyName} client portal.\nSign in: ${loginUrl}\nEmail: ${params.email}${params.password ? '\nPassword: ' + params.password : '\nUse your existing password.'}\n\nKeep these private.`,
  });
}
