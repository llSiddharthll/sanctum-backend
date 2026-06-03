import { db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { newId } from '../lib/ids.js';

type ActorType = 'owner' | 'admin' | 'member' | 'client_token' | 'system';

/** Append a security-relevant event. Best-effort; never throws to the caller. */
export async function audit(input: {
  agencyId: string;
  actorType: ActorType;
  actorId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: newId('aud'),
      agencyId: input.agencyId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      ip: input.ip ?? null,
    });
  } catch {
    // auditing must never break the request path
  }
}
