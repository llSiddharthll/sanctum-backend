/**
 * Client-facing email notifications for the content review flow. All sends are
 * best-effort (the email service logs instead of throwing when SMTP is off) and
 * resolve the recipient from the primary CRM contact, falling back to the
 * client's legacy contactEmail. Review notifications mint a fresh portal link
 * (tokens are opaque + hashed, so a working link can't be reconstructed).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agencies, clients, clientContacts, portalTokens } from '../db/schema.js';
import { newId, newOpaqueToken } from '../lib/ids.js';
import { env } from '../env.js';
import { sendEmail, bannerHtml, BANNERS } from './email.js';

async function recipientFor(
  agencyId: string,
  clientId: string,
): Promise<string | null> {
  const [contact] = await db
    .select({ email: clientContacts.email })
    .from(clientContacts)
    .where(
      and(
        eq(clientContacts.agencyId, agencyId),
        eq(clientContacts.clientId, clientId),
        eq(clientContacts.isPrimary, true),
      ),
    )
    .limit(1);
  if (contact?.email) return contact.email;
  const [client] = await db
    .select({ email: clients.contactEmail })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  return client?.email ?? null;
}

async function brandName(agencyId: string): Promise<string> {
  const [a] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, agencyId))
    .limit(1);
  return a?.name ?? 'Your agency';
}

async function clientName(clientId: string): Promise<string> {
  const [c] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  return c?.name ?? 'your brand';
}

async function mintPortalUrl(
  agencyId: string,
  clientId: string,
  createdBy: string | null,
): Promise<string> {
  const { raw, hash } = newOpaqueToken();
  await db.insert(portalTokens).values({
    id: newId('ptk'),
    agencyId,
    clientId,
    tokenHash: hash,
    label: 'auto-notify',
    createdBy: createdBy ?? null,
  });
  return `${env.FRONTEND_ORIGIN}/portal/${raw}`;
}

/** "New content ready" / "your requested changes are ready" → emails the client. */
export async function notifyClientReviewReady(opts: {
  agencyId: string;
  clientId: string;
  createdBy: string | null;
  kind: 'new' | 'changes';
}): Promise<void> {
  const to = await recipientFor(opts.agencyId, opts.clientId);
  if (!to) return;
  const [agency, cname, portalUrl] = await Promise.all([
    brandName(opts.agencyId),
    clientName(opts.clientId),
    mintPortalUrl(opts.agencyId, opts.clientId, opts.createdBy),
  ]);
  const heading =
    opts.kind === 'changes'
      ? 'Your requested changes are ready'
      : 'New content is ready to review';
  const body =
    opts.kind === 'changes'
      ? `${agency} has updated the content you asked them to revise. Take a look and approve when you're happy — no login required.`
      : `${agency} has new content ready for ${cname}. Review and approve it — no login required.`;
  await sendEmail({
    to,
    subject: `${agency}: ${opts.kind === 'changes' ? 'updated content to re-review' : 'content ready to review'}`,
    text: `${body}\n\n${portalUrl}`,
    html: bannerHtml({
      imageUrl: opts.kind === 'changes' ? BANNERS.rereview : BANNERS.review,
      linkUrl: portalUrl,
      alt: heading,
      preheader: body,
      fallbackLabel: 'Button not working? Open your review portal here:',
    }),
  });
}

/** Receipt to the client after they approve a post (no link needed). */
export async function notifyClientApproval(opts: {
  agencyId: string;
  clientId: string;
  caption: string | null;
  reviewer: string | null;
}): Promise<void> {
  const to = await recipientFor(opts.agencyId, opts.clientId);
  if (!to) return;
  const agency = await brandName(opts.agencyId);
  const snippet = (opts.caption ?? '').trim().slice(0, 80);
  const who = opts.reviewer?.trim() || 'You';
  const body = `${who} approved a post${snippet ? ` — "${snippet}"` : ''}. ${agency} has been notified and will schedule it.`;
  await sendEmail({
    to,
    subject: `${agency}: approval confirmed`,
    text: body,
    html: bannerHtml({
      imageUrl: BANNERS.approval,
      alt: 'Approval confirmed — Creative Monk',
      preheader: body,
    }),
  });
}
