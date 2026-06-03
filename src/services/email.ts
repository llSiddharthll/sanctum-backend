/**
 * Email service — STUB. Logs the message instead of sending.
 * Swap the body for Resend/Postmark/SES when an EMAIL provider is chosen.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(msg: EmailMessage): Promise<{ ok: boolean }> {
  // eslint-disable-next-line no-console
  console.log(
    `[email:stub] to=${msg.to} subject="${msg.subject}"\n${msg.text}`,
  );
  return { ok: true };
}

export async function sendPortalWelcome(input: {
  to: string;
  clientName: string;
  agencyName: string;
  portalUrl: string;
}): Promise<{ ok: boolean }> {
  return sendEmail({
    to: input.to,
    subject: `${input.agencyName}: your content review portal`,
    text: `Hi,\n\n${input.agencyName} has prepared content for ${input.clientName}. Review and approve it here:\n${input.portalUrl}\n\nNo login required.`,
  });
}
