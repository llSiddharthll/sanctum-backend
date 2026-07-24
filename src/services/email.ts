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
const BRAND = {
  orange: '#EF7E1A',
  orangeDark: '#D96A0C',
  orangeSoft: '#FBA340',
  ink: '#1B1A17',
  body: '#4B4A45',
  muted: '#9A968E',
  line: '#EFE9E1',
  cardBg: '#FFFFFF',
  pageBg: '#F6F2EC', // warm off-white that complements the orange
  logoUrl:
    'https://res.cloudinary.com/dkqo3uz5o/image/upload/w_140,h_140,c_fit,q_auto,f_png/branding/creativemonk-logo.png',
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

  // Bulletproof CTA (with MSO/Outlook VML fallback) — only when a link is given.
  const button =
    opts.buttonLabel && opts.buttonUrl
      ? `
      <tr>
        <td align="left" style="padding:8px 0 4px">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${opts.buttonUrl}" style="height:48px;v-text-anchor:middle;width:300px;" arcsize="18%" strokecolor="#D96A0C" fillcolor="#EF7E1A">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;">${esc(opts.buttonLabel)}</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-- -->
          <a href="${opts.buttonUrl}" style="display:inline-block;background:linear-gradient(135deg,${BRAND.orangeSoft} 0%,${BRAND.orange} 55%,${BRAND.orangeDark} 100%);background-color:${BRAND.orange};color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;line-height:48px;padding:0 34px;border-radius:12px;box-shadow:0 6px 16px rgba(239,126,26,0.32);letter-spacing:.2px">${esc(opts.buttonLabel)}</a>
          <!--<![endif]-->
        </td>
      </tr>`
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
<body style="margin:0;padding:0;background:${BRAND.pageBg};-webkit-font-smoothing:antialiased;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;visibility:hidden">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.pageBg}">
    <tr>
      <td align="center" style="padding:32px 16px">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">

          <!-- Header / brand lockup -->
          <tr>
            <td style="padding:4px 4px 22px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="60" valign="middle" style="padding-right:14px">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr><td align="center" valign="middle" width="56" height="56" style="width:56px;height:56px;background:#ffffff;border:1px solid ${BRAND.line};border-radius:16px;box-shadow:0 4px 12px rgba(27,26,23,0.06)">
                        <img src="${BRAND.logoUrl}" width="38" height="38" alt="Creative Monk" style="display:block;border:0;outline:none;text-decoration:none">
                      </td></tr>
                    </table>
                  </td>
                  <td valign="middle">
                    <div style="font-size:17px;font-weight:800;color:${BRAND.ink};letter-spacing:.2px;line-height:1.1">Creative&nbsp;Monk</div>
                    <div style="font-size:11px;font-weight:700;color:${BRAND.orange};letter-spacing:2px;text-transform:uppercase;margin-top:3px">Sanctum</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:${BRAND.cardBg};border:1px solid ${BRAND.line};border-radius:20px;box-shadow:0 12px 30px rgba(27,26,23,0.07);overflow:hidden">
              <!-- accent bar -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td height="5" style="height:5px;background:linear-gradient(90deg,${BRAND.orangeSoft} 0%,${BRAND.orange} 55%,${BRAND.orangeDark} 100%);font-size:0;line-height:0">&nbsp;</td></tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:34px 40px 38px">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr><td style="font-size:22px;line-height:1.3;font-weight:800;color:${BRAND.ink};padding-bottom:14px">${esc(opts.heading)}</td></tr>
                      <tr><td style="font-size:15px;line-height:1.7;color:${BRAND.body};white-space:pre-line">${esc(opts.body)}</td></tr>
                      ${button ? `<tr><td style="padding-top:26px"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${button}</table></td></tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 8px 8px" align="center">
              <div style="font-size:12px;line-height:1.6;color:${BRAND.muted}">
                Sent by <span style="color:${BRAND.ink};font-weight:600">${esc(brandName)}</span> · powered by Creative&nbsp;Monk<br>
                <a href="${BRAND.site}" style="color:${BRAND.orange};text-decoration:none;font-weight:600">app.thecreativemonk.in</a>
              </div>
              <div style="font-size:11px;color:${BRAND.muted};margin-top:12px">© ${year} Creative Monk. All rights reserved.</div>
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
