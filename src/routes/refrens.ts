/**
 * Refrens sync control surface: status, "Sync now", and a manual push.
 *
 * The Refrens credentials are server-wide and belong to ONE tenant
 * (`REFRENS_AGENCY_ID`). Sync and push are refused for every other agency,
 * whatever the caller's permissions.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ok, param } from '../lib/http.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { refrensConfigured } from '../services/refrens.js';
import {
  REFRENS_NOT_BOUND,
  pullInvoices,
  pushInvoice,
  refrensBoundTo,
  syncStatus,
} from '../services/refrens-sync.js';
import { authenticate, getStaffActor, requires } from '../authz/http.js';
import { authorize } from '../authz/engine.js';
import { actorAuditId, type Actor } from '../authz/actor.js';
import { loadInvoice } from '../authz/policies/business.js';

export const refrensRouter = Router();
refrensRouter.use(authenticate);

function assertBound(actor: Actor): void {
  if (!refrensBoundTo(actor.agencyId)) throw forbidden(REFRENS_NOT_BOUND);
  if (!refrensConfigured()) throw badRequest('Refrens is not configured on the server.');
}

// ---- STATUS ----
refrensRouter.get('/status', requires('invoices.view'), async (req, res) => {
  const actor = getStaffActor(req);
  ok(res, await syncStatus(actor.agencyId));
});

// ---- SYNC NOW (pull) ----
const syncSchema = z.object({
  max: z.number().int().min(1).max(5000).optional(),
});

// Pulling creates/updates invoices (and their clients) → sync + create.
refrensRouter.post('/sync', requires('invoices.sync', 'invoices.create'), async (req, res) => {
  const actor = getStaffActor(req);
  assertBound(actor);
  const body = syncSchema.parse(req.body ?? {});
  const result = await pullInvoices(actor.agencyId, { max: body.max });

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: 'refrens.sync',
    entityType: 'agency',
    entityId: actor.agencyId,
    metadata: {
      scanned: result.scanned,
      created: result.created,
      updated: result.updated,
      clientsCreated: result.clientsCreated,
      paymentsAdded: result.paymentsAdded,
    },
    ip: req.ip,
  });

  ok(res, result);
});

// ---- PUSH ONE INVOICE ----
refrensRouter.post('/invoices/:id/push', requires('invoices.sync'), async (req, res) => {
  const actor = getStaffActor(req);
  const loaded = await loadInvoice(actor, param(req, 'id'));
  if (!loaded) throw notFound('Invoice not found.');
  authorize(actor, 'invoices.sync', loaded.facts, { view: 'invoices.view' });
  assertBound(actor);

  const result = await pushInvoice(actor.agencyId, loaded.row.id);
  if (!result.ok) throw new AppError('BAD_REQUEST', result.error ?? 'Could not push to Refrens.');

  await audit({
    agencyId: actor.agencyId,
    actorType: actor.type,
    actorId: actorAuditId(actor),
    action: 'refrens.push',
    entityType: 'invoice',
    entityId: loaded.row.id,
    metadata: { refrensId: result.refrensId },
    ip: req.ip,
  });

  ok(res, result);
});
