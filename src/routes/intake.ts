import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { ok } from '../lib/http.js';
import { notifyMany, agencyOwners } from '../services/notifications.js';

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

  // Create a LEAD (stage = new) — it enters the pipeline and only becomes a
  // client once someone converts it. Website enquiry text is preserved.
  const leadId = newId('led');
  await db.insert(leads).values({
    id: leadId,
    agencyId,
    name: body.name,
    company: body.company || null,
    email: body.email || null,
    phone: body.phone || null,
    source: body.source || 'website-contact',
    service: body.service || null,
    budget: body.budget || null,
    message: body.message || null,
    ownerId,
    stage: 'new',
    lastActivityAt: new Date(),
  });

  // Leads are owner-only (Business module) — notify OWNERS only (in-app + push).
  try {
    const recipients = await agencyOwners(agencyId);
    await notifyMany(recipients, {
      agencyId,
      type: 'lead.created',
      title: 'New website lead',
      body: `${body.name}${body.company ? ' · ' + body.company : ''}${
        body.service ? ' — ' + body.service : ''
      }`,
      entityType: 'lead',
      entityId: leadId,
      link: `/leads`,
    });
  } catch {}

  return ok(res, { leadId });
});
