import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, clientContacts, clientNotes, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { ok } from '../lib/http.js';
import { notifyMany, agencyApprovers } from '../services/notifications.js';

/**
 * Public lead intake — used by the Creative Monk marketing website to push a
 * contact-form submission straight into the Sanctum CRM. Machine-to-machine, so
 * it's guarded by a shared secret header (`X-Intake-Key` === LEAD_INTAKE_SECRET)
 * rather than a user JWT. Target agency comes from INTAKE_AGENCY_ID.
 */
export const intakeRouter = Router();

const leadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().trim().max(60).optional().or(z.literal('')),
  company: z.string().trim().max(200).optional().or(z.literal('')),
  budget: z.string().trim().max(120).optional().or(z.literal('')),
  service: z.string().trim().max(200).optional().or(z.literal('')),
  message: z.string().trim().max(5000).optional().or(z.literal('')),
  source: z.string().trim().max(120).optional().or(z.literal('')),
});

intakeRouter.post('/lead', async (req, res) => {
  const secret = process.env.LEAD_INTAKE_SECRET;
  if (!secret || req.header('x-intake-key') !== secret) {
    return res.status(401).json({ error: { message: 'Unauthorized' } });
  }
  const agencyId = process.env.INTAKE_AGENCY_ID;
  if (!agencyId) {
    return res.status(500).json({ error: { message: 'INTAKE_AGENCY_ID not configured' } });
  }
  const body = leadSchema.parse(req.body);

  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.agencyId, agencyId), eq(users.role, 'owner')))
    .limit(1);
  const ownerId = owner?.id ?? null;

  const clientId = newId('cli');
  const clientName = (body.company && body.company.trim()) || body.name;
  const summary = [
    body.source ? `Source: ${body.source}` : null,
    body.service ? `Interested in: ${body.service}` : null,
    body.budget ? `Budget: ${body.budget}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // 1) The client (source = inbound).
  await db.insert(clients).values({
    id: clientId,
    agencyId,
    name: clientName,
    contactEmail: body.email || null,
    phone: body.phone || null,
    clientSource: 'inbound',
    ownerId,
    internalNotes: `Website lead — ${body.name}${summary ? ' · ' + summary : ''}`,
  });

  // 2) Primary contact = the person who filled the form.
  try {
    await db.insert(clientContacts).values({
      id: newId('cnt'),
      agencyId,
      clientId,
      name: body.name,
      email: body.email || null,
      phone: body.phone || null,
      isPrimary: true,
    });
  } catch {}

  // 3) CRM note with the enquiry.
  try {
    const noteBody =
      [body.message, summary].filter(Boolean).join('\n\n') || 'New website enquiry.';
    await db.insert(clientNotes).values({
      id: newId('nte'),
      agencyId,
      clientId,
      authorId: ownerId,
      type: 'note',
      body: noteBody,
    });
  } catch {}

  // 4) Notify owners/admins (in-app + push).
  try {
    const recipients = await agencyApprovers(agencyId);
    await notifyMany(recipients, {
      agencyId,
      type: 'lead.created',
      title: 'New website lead',
      body: `${body.name}${body.company ? ' · ' + body.company : ''}${
        body.service ? ' — ' + body.service : ''
      }`,
      entityType: 'client',
      entityId: clientId,
      link: `/clients/${clientId}`,
    });
  } catch {}

  return ok(res, { clientId });
});
