/**
 * Turning a lead into a client. Shared by POST /leads/:id/convert and by
 * converting an accepted proposal into an agreement — an agreement needs a
 * client, and a proposal that sits on a lead has none until the deal is won.
 *
 * Idempotent: a lead that already produced a client returns that client.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clientContacts,
  clientNotes,
  clients,
  leadActivities,
  leads,
} from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { invalidState } from '../lib/errors.js';
import { check } from '../authz/engine.js';
import { requireActiveStaff } from '../authz/tenancy.js';
import type { StaffActor } from '../authz/actor.js';
import type { ObjectFacts } from '../authz/engine.js';

type LeadRow = typeof leads.$inferSelect;

export interface ConvertLeadResult {
  clientId: string;
  /** True when the lead had already been converted before this call. */
  already: boolean;
  /** The client's name, for messages and audit metadata. */
  clientName: string;
}

export async function convertLeadToClient(input: {
  actor: StaffActor;
  lead: LeadRow;
  facts: ObjectFacts;
  name?: string;
  industry?: string;
}): Promise<ConvertLeadResult> {
  const { actor, lead: row, facts } = input;

  if (row.convertedClientId) {
    const [existing] = await db
      .select({ name: clients.name })
      .from(clients)
      .where(and(eq(clients.id, row.convertedClientId), eq(clients.agencyId, actor.agencyId)))
      .limit(1);
    return {
      clientId: row.convertedClientId,
      already: true,
      clientName: existing?.name ?? row.company ?? row.name,
    };
  }
  if (row.stage === 'lost' || row.stage === 'spam') {
    throw invalidState(`A ${row.stage} lead cannot be converted.`);
  }

  const clientId = newId('cli');
  const clientName = input.name?.trim() || row.company || row.name;

  // Keep the lead's owner only when they are still an active teammate.
  let ownerId: string = actor.userId;
  if (row.ownerId) {
    try {
      await requireActiveStaff(actor.agencyId, [row.ownerId]);
      ownerId = row.ownerId;
    } catch {
      ownerId = actor.userId;
    }
  }

  // The budget only travels into client notes when the converter may see it.
  const showValue = check(actor, 'leads.view_value', facts);
  const summary = [
    row.source ? `Source: ${row.source}` : null,
    row.service ? `Interested in: ${row.service}` : null,
    showValue && row.budget ? `Budget: ${row.budget}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  await db.insert(clients).values({
    id: clientId,
    agencyId: actor.agencyId,
    name: clientName,
    contactEmail: row.email || null,
    phone: row.phone || null,
    ...(input.industry ? { industry: input.industry } : {}),
    clientSource: 'inbound',
    ownerId,
    internalNotes: `Converted from lead — ${row.name}${summary ? ' · ' + summary : ''}`,
  });

  // Carry the person over as a primary contact.
  try {
    await db.insert(clientContacts).values({
      id: newId('cnt'),
      agencyId: actor.agencyId,
      clientId,
      name: row.name,
      email: row.email || null,
      phone: row.phone || null,
      isPrimary: true,
    });
  } catch {}

  // Preserve the original enquiry as a client note.
  try {
    const noteBody =
      [row.message, summary].filter(Boolean).join('\n\n') ||
      'Converted from an inbound lead.';
    await db.insert(clientNotes).values({
      id: newId('nte'),
      agencyId: actor.agencyId,
      clientId,
      authorId: actor.userId,
      type: 'note',
      body: noteBody,
    });
  } catch {}

  // Flip the lead to converted, keep it linked (history stays on the lead).
  await db
    .update(leads)
    .set({
      stage: 'converted',
      convertedClientId: clientId,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(leads.id, row.id), eq(leads.agencyId, actor.agencyId)));

  await db.insert(leadActivities).values({
    id: newId('lac'),
    agencyId: actor.agencyId,
    leadId: row.id,
    authorId: actor.userId,
    type: 'stage_change',
    body: `Converted to client "${clientName}"`,
  });

  return { clientId, already: false, clientName };
}
