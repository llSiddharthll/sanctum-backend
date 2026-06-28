import { db } from '../db/client.js';
import { passwordResets } from '../db/schema.js';
import { newId, newOpaqueToken } from '../lib/ids.js';
import { env } from '../env.js';
import { sendPasswordReset } from './email.js';

const FRONTEND_ORIGIN = env.FRONTEND_ORIGIN || 'http://localhost:3000';
/** Reset links are short-lived. */
export const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Mint a single-use, short-lived password-reset token for a user, store its
 * hash, and email the reset link (best-effort — logs only when SMTP is off).
 * Shared by self-service `/auth/forgot-password` and the admin-initiated reset.
 * Returns the raw link so an admin can copy it if email isn't configured.
 */
export async function createPasswordReset(
  user: {
    id: string;
    agencyId: string;
    email: string;
    fullName: string | null;
  },
  opts: { byAdmin?: boolean } = {},
): Promise<{ resetUrl: string }> {
  const { raw, hash } = newOpaqueToken();
  await db.insert(passwordResets).values({
    id: newId('pwr'),
    userId: user.id,
    agencyId: user.agencyId,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
  });

  const resetUrl = `${FRONTEND_ORIGIN}/reset-password?token=${raw}`;
  void sendPasswordReset({
    to: user.email,
    resetUrl,
    name: user.fullName,
    byAdmin: opts.byAdmin,
  });
  return { resetUrl };
}
