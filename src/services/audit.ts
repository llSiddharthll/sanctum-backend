import { db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { newId } from '../lib/ids.js';

type ActorType =
  | 'staff'
  | 'client'
  | 'portal_link'
  | 'system'
  | 'integration'
  // legacy values (still written by un-migrated call sites; TODO authz phase 10)
  | 'owner'
  | 'admin'
  | 'member'
  | 'client_token';

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

/**
 * Audit an authorization change with who / what / to whom / before / after
 * (design §38). Actor may be any Actor; entity is the role / user / token.
 */
export async function auditAuthz(input: {
  actor: import('../authz/actor.js').Actor;
  action: string;
  entityType: 'role' | 'user' | 'client_user' | 'portal_token' | 'session';
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string;
}): Promise<void> {
  const { actorAuditId } = await import('../authz/actor.js');
  await audit({
    agencyId: input.actor.agencyId,
    actorType: input.actor.type,
    actorId: actorAuditId(input.actor),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: {
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...('sessionId' in input.actor && input.actor.sessionId
        ? { sessionId: input.actor.sessionId }
        : {}),
    },
    ip: input.ip,
  });
}
