import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agencies, leads } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { ok } from '../lib/http.js';
import { audit } from '../services/audit.js';
import { notifyPermissionHolders } from '../services/notifications.js';
import { actorAuditId, integrationActor } from '../authz/actor.js';
import { requirePermission } from '../authz/engine.js';

/**
 * Public lead intake — used by the marketing website to push a contact-form
 * submission into the CRM. Machine-to-machine: the `X-Intake-Key` header must
 * match LEAD_INTAKE_SECRET (constant-time). The request then acts as
 * integrationActor('lead-intake', INTAKE_AGENCY_ID, [leads.create]).
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

/** Constant-time comparison of the presented key against the secret. */
export function intakeKeyMatches(presented: string | undefined, secret: string | undefined): boolean {
  if (!secret || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

intakeRouter.post('/lead', async (req, res) => {
  if (!intakeKeyMatches(req.header('x-intake-key'), process.env.LEAD_INTAKE_SECRET)) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } });
  }
  const agencyId = process.env.INTAKE_AGENCY_ID;
  if (!agencyId) {
    return res.status(500).json({ error: { message: 'INTAKE_AGENCY_ID not configured' } });
  }
  const [agency] = await db.select({ id: agencies.id }).from(agencies).where(eq(agencies.id, agencyId)).limit(1);
  if (!agency) {
    return res.status(500).json({ error: { message: 'INTAKE_AGENCY_ID not configured' } });
  }
  const actor = integrationActor('lead-intake', agencyId, [
    { permission: 'leads.create', scope: 'organization' },
  ]);
  requirePermission(actor, 'leads.create');
  const body = leadSchema.parse(req.body);

  // A LEAD (stage = new), unassigned: whoever holds leads.assign routes it.
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
    ownerId: null,
    stage: 'new',
    lastActivityAt: new Date(),
  });

  await audit({
    agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: 'lead.create',
    entityType: 'lead',
    entityId: leadId,
    metadata: { source: body.source || 'website-contact' },
    ip: req.ip,
  });

  // Notify people who can see leads (by capability, never by role).
  try {
    await notifyPermissionHolders(agencyId, 'leads.view', {
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
