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

// ---- Brand system (Creative Monk) ------------------------------------------
// Colours are pulled straight from the logo; the primary orange is #EF7E1A.
// Intentional DARK premium theme — designed dark so mobile dark-mode can't
// invert it into a muddy mess, and so the warm orange pops. The hero fades
// into cardBg (#1B1712) for a seamless top.
const BRAND = {
  orange: '#EF7E1A',
  orangeDark: '#D96A0C',
  orangeSoft: '#FBA340',
  heading: '#FCF8F2',
  body: '#C7BFB4',
  muted: '#8B8378',
  line: '#2C2720',
  cardBg: '#1B1712',
  panelBg: '#221D17',
  pageBg: '#0E0C0A',
  chipBg: '#2A1B0E',
  chipLine: '#503417',
  chipText: '#F6A24E',
  logoUrl:
    'https://res.cloudinary.com/dkqo3uz5o/image/upload/w_120,h_120,c_fit,q_auto,f_png/branding/creativemonk-logo.png',
  // Pre-rendered glassmorphism hero (gradient mesh + frosted panel + logo),
  // bottom faded into cardBg. Baked as an image so it renders identically in
  // every client (Gmail strips CSS gradients / inline SVG / backdrop-filter).
  heroUrl:
    'https://res.cloudinary.com/dkqo3uz5o/image/upload/v1784907462/branding/creativemonk-email-hero-dark.png',
  site: 'https://app.thecreativemonk.in',
} as const;

/** Escape a string for safe interpolation into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Premium, email-client-safe HTML wrapper (table layout + inline CSS) around a
 * heading, body and optional CTA. Branded for Creative Monk / Sanctum with the
 * logo header and orange theme. The same signature the app already uses, plus
 * an optional inbox-preview `preheader`.
 */
export function basicHtml(opts: {
  heading: string;
  body: string;
  buttonLabel?: string;
  buttonUrl?: string;
  preheader?: string;
}): string {
  const year = new Date().getUTCFullYear();
  const brandName = env.EMAIL_FROM_NAME || 'Sanctum';
  const preheader = esc(opts.preheader ?? opts.body.replace(/\s+/g, ' ').slice(0, 140));

  // Bulletproof, full-width CTA (with MSO/Outlook VML fallback).
  const button =
    opts.buttonLabel && opts.buttonUrl
      ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" style="padding:2px 0">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${opts.buttonUrl}" style="height:54px;v-text-anchor:middle;width:512px;" arcsize="24%" strokecolor="#D96A0C" fillcolor="#EF7E1A">
              <w:anchorlock/>
              <center style="color:#ffffff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;">${esc(opts.buttonLabel)} &#8594;</center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-- -->
            <a href="${opts.buttonUrl}" style="display:block;width:100%;background:linear-gradient(135deg,${BRAND.orangeSoft} 0%,${BRAND.orange} 52%,${BRAND.orangeDark} 100%);background-color:${BRAND.orange};color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;line-height:54px;height:54px;text-align:center;border-radius:14px;box-shadow:0 10px 26px rgba(239,126,26,0.38);letter-spacing:.3px">${esc(opts.buttonLabel)} &#8594;</a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>`
      : '';

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(brandName)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0;padding:0;background:${BRAND.pageBg};-webkit-font-smoothing:antialiased;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;visibility:hidden">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.pageBg}">
    <tr>
      <td align="center" style="padding:28px 12px 36px">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;box-shadow:0 30px 70px rgba(0,0,0,0.55);border-radius:28px">

          <!-- Glassmorphism hero (pre-rendered, fades into the card) -->
          <tr>
            <td style="font-size:0;line-height:0;background:${BRAND.pageBg}">
              <a href="${BRAND.site}" style="text-decoration:none">
                <img src="${BRAND.heroUrl}" width="600" alt="Creative Monk · Sanctum" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none">
              </a>
            </td>
          </tr>

          <!-- Card body (dark) -->
          <tr>
            <td style="background:${BRAND.cardBg};border:1px solid ${BRAND.line};border-top:0;border-radius:0 0 28px 28px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:14px 32px 32px">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <!-- eyebrow chip -->
                      <tr><td style="padding-bottom:18px">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                          <td style="background:${BRAND.chipBg};border:1px solid ${BRAND.chipLine};border-radius:100px;padding:7px 16px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${BRAND.chipText}">Sanctum</td>
                        </tr></table>
                      </td></tr>
                      <tr><td style="font-size:29px;line-height:1.22;font-weight:800;color:${BRAND.heading};padding-bottom:16px;letter-spacing:-0.6px">${esc(opts.heading)}</td></tr>
                      <tr><td style="font-size:16px;line-height:1.72;color:${BRAND.body};white-space:pre-line">${esc(opts.body)}</td></tr>
                      ${button ? `<tr><td style="padding-top:30px">${button}</td></tr>` : ''}
                    </table>
                  </td>
                </tr>
                <!-- divider + helper note -->
                <tr><td style="padding:0 32px"><div style="height:1px;background:${BRAND.line};line-height:1px;font-size:0">&nbsp;</div></td></tr>
                <tr>
                  <td style="padding:22px 32px 30px">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.panelBg};border:1px solid ${BRAND.line};border-radius:16px">
                      <tr>
                        <td valign="middle" width="40" style="padding:16px 0 16px 18px">
                          <img src="${BRAND.logoUrl}" width="28" height="28" alt="" style="display:block;border:0">
                        </td>
                        <td valign="middle" style="padding:16px 18px 16px 12px;font-size:12.5px;line-height:1.6;color:${BRAND.muted}">
                          Sent by <span style="color:${BRAND.heading};font-weight:700">Creative&nbsp;Monk</span> — an automated message from your Sanctum workspace. If it wasn't expected, you can ignore it.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:22px 8px 4px" align="center">
              <div style="font-size:12px;line-height:1.7;color:${BRAND.muted}">
                <a href="${BRAND.site}" style="color:${BRAND.chipText};text-decoration:none;font-weight:700">app.thecreativemonk.in</a>
                &nbsp;·&nbsp; Studio operations, elevated.
              </div>
              <div style="font-size:11px;color:${BRAND.muted};margin-top:10px">© ${year} Creative Monk. All rights reserved.</div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
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
