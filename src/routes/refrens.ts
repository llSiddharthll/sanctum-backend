/**
 * Refrens sync control surface: status, "Sync now", and a manual push.
 * Owner-only, like the rest of invoicing.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { invoices } from '../db/schema.js';
import { ok, param } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireModuleRW } from '../middleware/permissions.js';
import { getAuth } from '../middleware/tenant.js';
import { audit } from '../services/audit.js';
import { refrensConfigured } from '../services/refrens.js';
import { pullInvoices, pushInvoice, syncStatus } from '../services/refrens-sync.js';

export const refrensRouter = Router();
refrensRouter.use(requireAuth);
refrensRouter.use(requireModuleRW('finance'));
refrensRouter.use(requireRole('owner'));

// ---- STATUS ----
refrensRouter.get('/status', async (req, res) => {
  const ctx = getAuth(req);
  ok(res, await syncStatus(ctx.agencyId));
});

// ---- SYNC NOW (pull) ----
const syncSchema = z.object({
  max: z.number().int().min(1).max(5000).optional(),
});

refrensRouter.post('/sync', async (req, res) => {
  const ctx = getAuth(req);
  if (!refrensConfigured()) {
    throw badRequest('Refrens is not configured on the server.');
  }
  const body = syncSchema.parse(req.body ?? {});
  const result = await pullInvoices(ctx.agencyId, { max: body.max });

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'refrens.sync',
    entityType: 'agency',
    entityId: ctx.agencyId,
    metadata: {
      scanned: result.scanned,
      created: result.created,
      updated: result.updated,
    },
    ip: req.ip,
  });

  ok(res, result);
});

// ---- PUSH ONE INVOICE ----
refrensRouter.post('/invoices/:id/push', async (req, res) => {
  const ctx = getAuth(req);
  const invoiceId = param(req, 'id');
  if (!refrensConfigured()) {
    throw badRequest('Refrens is not configured on the server.');
  }

  const [inv] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.agencyId, ctx.agencyId), eq(invoices.id, invoiceId)))
    .limit(1);
  if (!inv) throw notFound('Invoice not found.');

  const result = await pushInvoice(ctx.agencyId, invoiceId);
  if (!result.ok) throw badRequest(result.error ?? 'Could not push to Refrens.');

  await audit({
    agencyId: ctx.agencyId,
    actorType: ctx.role,
    actorId: ctx.userId,
    action: 'refrens.push',
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: { refrensId: result.refrensId },
    ip: req.ip,
  });

  ok(res, result);
});
