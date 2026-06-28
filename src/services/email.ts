/**
 * Email service. Sends via SMTP (nodemailer) when EMAIL_USER/EMAIL_PASS are
 * configured; otherwise logs the message (so dev works without creds). Sending
 * is best-effort — failures are logged and never throw into a request.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env, emailEnabled } from '../env.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let transporter: Transporter | null = null;

/** Lazily build the SMTP transporter (Gmail app-password by default). */
function getTransporter(): Transporter | null {
  if (!emailEnabled) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465, // 465 = implicit TLS
    auth: {
      user: env.EMAIL_USER,
      // Gmail shows app passwords with spaces; SMTP wants them stripped.
      pass: (env.EMAIL_PASS ?? '').replace(/\s+/g, ''),
    },
  });
  return transporter;
}

function fromAddress(): string {
  return `"${env.EMAIL_FROM_NAME}" <${env.EMAIL_USER}>`;
}

/** Minimal branded HTML wrapper around a plain-text body + optional button. */
export function basicHtml(opts: {
  heading: string;
  body: string;
  buttonLabel?: string;
  buttonUrl?: string;
}): string {
  const button =
    opts.buttonLabel && opts.buttonUrl
      ? `<p style="margin:24px 0"><a href="${opts.buttonUrl}" style="background:#1f6f54;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${opts.buttonLabel}</a></p>`
      : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f6f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:520px;margin:0 auto;padding:32px 20px">
      <div style="background:#fff;border:1px solid #e6e9e8;border-radius:16px;padding:28px">
        <h1 style="font-size:18px;margin:0 0 12px;color:#16271f">${opts.heading}</h1>
        <div style="font-size:14px;line-height:1.6;color:#3a4541;white-space:pre-line">${opts.body}</div>
        ${button}
      </div>
      <p style="text-align:center;color:#9aa6a1;font-size:12px;margin-top:16px">Sent by ${env.EMAIL_FROM_NAME}</p>
    </div>
  </body></html>`;
}

export async function sendEmail(msg: EmailMessage): Promise<{ ok: boolean }> {
  const tx = getTransporter();
  if (!tx) {
    // eslint-disable-next-line no-console
    console.log(
      `[email:log-only] to=${msg.to} subject="${msg.subject}" (set EMAIL_USER/EMAIL_PASS to actually send)\n${msg.text}`,
    );
    return { ok: true };
  }
  try {
    await tx.sendMail({
      from: fromAddress(),
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[email:error] to=${msg.to} subject="${msg.subject}":`,
      (err as Error)?.message ?? err,
    );
    return { ok: false };
  }
}

/** Verify the SMTP connection (used by the dev test). Returns true if reachable. */
export async function verifyEmail(): Promise<boolean> {
  const tx = getTransporter();
  if (!tx) return false;
  try {
    await tx.verify();
    return true;
  } catch {
    return false;
  }
}

export async function sendPortalWelcome(input: {
  to: string;
  clientName: string;
  agencyName: string;
  portalUrl: string;
}): Promise<{ ok: boolean }> {
  const text = `Hi,\n\n${input.agencyName} has prepared content for ${input.clientName}. Review and approve it here:\n${input.portalUrl}\n\nNo login required.`;
  return sendEmail({
    to: input.to,
    subject: `${input.agencyName}: your content review portal`,
    text,
    html: basicHtml({
      heading: `${input.agencyName} — content for review`,
      body: `${input.agencyName} has prepared content for ${input.clientName}. Review and approve it — no login required.`,
      buttonLabel: 'Open your portal',
      buttonUrl: input.portalUrl,
    }),
  });
}

export async function sendTeamInvite(input: {
  to: string;
  agencyName: string;
  inviterName?: string | null;
  acceptUrl: string;
}): Promise<{ ok: boolean }> {
  const lead = input.inviterName
    ? `${input.inviterName} invited you`
    : 'You have been invited';
  const text = `${lead} to join ${input.agencyName} on Sanctum.\n\nSet your password and sign in:\n${input.acceptUrl}\n\nThis link expires in 7 days.`;
  return sendEmail({
    to: input.to,
    subject: `You're invited to ${input.agencyName} on Sanctum`,
    text,
    html: basicHtml({
      heading: `Join ${input.agencyName} on Sanctum`,
      body: `${lead} to join ${input.agencyName}. Set your password and you'll be signed in. This link expires in 7 days.`,
      buttonLabel: 'Accept invite & set password',
      buttonUrl: input.acceptUrl,
    }),
  });
}

export async function sendPasswordReset(input: {
  to: string;
  resetUrl: string;
  name?: string | null;
  byAdmin?: boolean;
}): Promise<{ ok: boolean }> {
  const who = input.name ? `Hi ${input.name},` : 'Hi,';
  const reason = input.byAdmin
    ? 'An administrator started a password reset for your Sanctum account.'
    : 'We received a request to reset your Sanctum password.';
  const text = `${who}\n\n${reason}\n\nReset your password:\n${input.resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email.`;
  return sendEmail({
    to: input.to,
    subject: 'Reset your Sanctum password',
    text,
    html: basicHtml({
      heading: 'Reset your password',
      body: `${reason} Choose a new password below — this link expires in 1 hour. If you didn't request this, you can safely ignore this email.`,
      buttonLabel: 'Reset password',
      buttonUrl: input.resetUrl,
    }),
  });
}
