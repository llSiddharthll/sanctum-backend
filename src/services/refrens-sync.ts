/**
 * Refrens ⇄ Sanctum invoice sync.
 *
 * Direction 1 (pull): Refrens has no webhooks, so we poll `/invoices` and upsert
 * on `(agency_id, refrens_id)`. Refrens is authoritative for anything it owns —
 * number, status, payments — because it is the accounting system of record.
 *
 * Direction 2 (push): invoices created/edited in Sanctum are POSTed/PATCHed up.
 * We store the returned `_id` in `refrens_id`, which is also what stops an echo
 * loop: the next poll matches that row and UPDATES it instead of re-creating.
 * Pushes only ever originate from the HTTP routes, never from the poller.
 *
 * Clients: the Refrens `clients` resource rejects app-token auth, so the roster
 * is derived from each invoice's embedded `billedTo` and matched into Sanctum
 * by refrensClientId → GSTIN → email → normalised name (creating if needed).
 */
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agencies,
  clients,
  invoiceItems,
  invoicePayments,
  invoices,
} from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { env } from '../env.js';
import {
  REFRENS_PAGE_SIZE,
  type RefrensInvoice,
  type RefrensParty,
  createInvoice,
  getInvoice,
  listInvoices,
  mapPaymentMethod,
  mapStatus,
  paiseToRupees,
  parseDate,
  isSyncableInvoice,
  refrensConfigured,
  rupeesToPaise,
  toRefrensStatus,
  updateInvoice,
} from './refrens.js';

export interface PullResult {
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  clientsCreated: number;
  paymentsAdded: number;
  /** Non-invoice documents (quotations, proformas, POs, credit notes) passed over. */
  ignored: number;
  errors: string[];
}

const norm = (s: string | null | undefined) =>
  (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// ---------------------------------------------------------------- clients ---

/**
 * Find (or create) the Sanctum client for a Refrens `billedTo`, and backfill
 * the Refrens key so subsequent syncs match on the first try.
 */
type ClientRow = typeof clients.$inferSelect;

/** Roster loaded once per sync run — a 400-invoice import must not refetch it 400 times. */
async function loadClientCache(agencyId: string): Promise<ClientRow[]> {
  return db.select().from(clients).where(eq(clients.agencyId, agencyId));
}

async function resolveClient(
  agencyId: string,
  billedTo: RefrensParty | null | undefined,
  counters: { clientsCreated: number },
  rows: ClientRow[],
): Promise<string> {
  const name = (billedTo?.name ?? '').trim() || 'Unknown client (Refrens)';
  const refKey = billedTo?.clientId ?? null;
  const gstin = (billedTo?.gstin ?? '').trim() || null;
  const email = (billedTo?.email ?? '').trim() || null;

  const match =
    (refKey && rows.find((c) => c.refrensClientId === refKey)) ||
    (gstin && rows.find((c) => norm(c.gstNumber) === norm(gstin))) ||
    (email && rows.find((c) => norm(c.contactEmail) === norm(email))) ||
    rows.find((c) => norm(c.name) === norm(name)) ||
    null;

  if (match) {
    // Backfill identity/billing details we now know from Refrens.
    const patch: Record<string, unknown> = {};
    if (refKey && match.refrensClientId !== refKey) patch.refrensClientId = refKey;
    if (gstin && !match.gstNumber) patch.gstNumber = gstin;
    if (email && !match.contactEmail) patch.contactEmail = email;
    if (billedTo?.street && !match.billingAddress) patch.billingAddress = billedTo.street;
    if (billedTo?.state && !match.billingState) patch.billingState = billedTo.state;
    if (billedTo?.city && !match.billingCity) patch.billingCity = billedTo.city;
    if (billedTo?.pincode && !match.billingPincode) patch.billingPincode = billedTo.pincode;
    if (Object.keys(patch).length) {
      patch.updatedAt = new Date();
      await db.update(clients).set(patch).where(eq(clients.id, match.id));
      Object.assign(match, patch); // keep the cache truthful for later invoices
    }
    return match.id;
  }

  const id = newId('cli');
  const row = {
    id,
    agencyId,
    name,
    contactEmail: email,
    gstNumber: gstin,
    billingAddress: billedTo?.street ?? null,
    billingState: billedTo?.state ?? null,
    billingCity: billedTo?.city ?? null,
    billingPincode: billedTo?.pincode ?? null,
    refrensClientId: refKey,
  };
  await db.insert(clients).values(row);
  rows.push(row as ClientRow); // so the next invoice for this brand reuses it
  counters.clientsCreated += 1;
  return id;
}

// ------------------------------------------------------------ invoice no. ---

/**
 * Refrens owns invoice numbers, but `ux_invoices_agency_number` is UNIQUE. If
 * some other Sanctum row already holds this number, disambiguate rather than
 * fail the whole sync.
 */
async function safeInvoiceNumber(
  agencyId: string,
  number: string | null | undefined,
  selfId: string,
): Promise<string | null> {
  if (!number) return null;
  const [clash] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.agencyId, agencyId),
        eq(invoices.invoiceNumber, number),
        ne(invoices.id, selfId),
      ),
    )
    .limit(1);
  return clash ? `${number}-R` : number;
}

// ------------------------------------------------------------------ pull ----

/** Mirror one Refrens invoice into Sanctum. */
async function upsertInvoice(
  agencyId: string,
  r: RefrensInvoice,
  counters: PullResult,
  clientCache: ClientRow[],
): Promise<void> {
  const clientId = await resolveClient(agencyId, r.billedTo, counters, clientCache);

  const subtotal = rupeesToPaise(r.finalTotal?.subTotal ?? r.finalTotal?.amount);
  const cgst = rupeesToPaise(r.finalTotal?.cgst);
  const sgst = rupeesToPaise(r.finalTotal?.sgst);
  // Refrens reports igst as the FULL tax when interstate, and as cgst+sgst
  // combined when intrastate — so only treat it as IGST when the flag is set.
  const isInterstate = Boolean(r.igst);
  const igst = isInterstate ? rupeesToPaise(r.finalTotal?.igst) : 0;
  const taxTotal = isInterstate ? igst : cgst + sgst;
  const total = rupeesToPaise(r.finalTotal?.total);
  const status = mapStatus(r.status, r.payments, total);

  const [existing] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.agencyId, agencyId), eq(invoices.refrensId, r._id)))
    .limit(1);

  const invoiceId = existing?.id ?? newId('inv');
  const invoiceNumber = await safeInvoiceNumber(agencyId, r.invoiceNumber, invoiceId);
  const terms = r.terms?.flatMap((t) => t.terms ?? []).join('\n') || null;

  const values = {
    agencyId,
    clientId,
    invoiceNumber,
    status,
    issueDate: parseDate(r.invoiceDate),
    dueDate: parseDate(r.dueDate),
    isInterstate,
    currency: r.currency ?? 'INR',
    subtotal,
    taxTotal,
    cgst: isInterstate ? 0 : cgst,
    sgst: isInterstate ? 0 : sgst,
    igst,
    total,
    terms,
    refrensId: r._id,
    externalSource: 'refrens',
    refrensSyncedAt: new Date(),
    refrensSyncError: null,
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(invoices).set(values).where(eq(invoices.id, existing.id));
    counters.updated += 1;
  } else {
    await db.insert(invoices).values({ id: invoiceId, ...values });
    counters.created += 1;
  }

  // Items: Refrens is authoritative, so replace wholesale.
  await db.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
  const items = r.items ?? [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]!;
    const qty = Number(it.quantity) || 1;
    const rate = rupeesToPaise(it.rate);
    await db.insert(invoiceItems).values({
      id: newId('itm'),
      agencyId,
      invoiceId,
      description: [it.name, it.description].filter(Boolean).join(' — ') || 'Item',
      quantity: qty,
      unit: it.unit || 'piece',
      rate,
      gstRate: Number(it.gstRate) || 0,
      amount: rupeesToPaise(it.subTotal ?? (Number(it.rate) || 0) * qty),
      position: i,
    });
  }

  // Payments: additive, deduped on the Refrens payment id.
  for (const p of r.payments ?? []) {
    if (p.isRemoved || p.isRefund) continue;
    const [dupe] = await db
      .select({ id: invoicePayments.id })
      .from(invoicePayments)
      .where(
        and(
          eq(invoicePayments.agencyId, agencyId),
          eq(invoicePayments.refrensPaymentId, p._id),
        ),
      )
      .limit(1);
    if (dupe) continue;
    await db.insert(invoicePayments).values({
      id: newId('pay'),
      agencyId,
      invoiceId,
      amount: rupeesToPaise(p.amount) + rupeesToPaise(p.tds),
      paidAt: parseDate(p.paymentDate),
      method: mapPaymentMethod(p.paymentMethod),
      reference: null,
      notes: p.tds ? `Includes TDS ₹${p.tds}` : null,
      refrensPaymentId: p._id,
    });
    counters.paymentsAdded += 1;
  }
}

/**
 * Poll Refrens and mirror invoices into Sanctum.
 * `max` bounds a single run so the first import can be chunked if needed.
 */
export async function pullInvoices(
  agencyId: string,
  opts: { max?: number } = {},
): Promise<PullResult> {
  const counters: PullResult = {
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    clientsCreated: 0,
    paymentsAdded: 0,
    ignored: 0,
    errors: [],
  };
  if (!refrensConfigured()) {
    counters.errors.push('Refrens is not configured.');
    return counters;
  }

  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const clientCache = await loadClientCache(agencyId);
  let skip = 0;
  let total = Infinity;

  while (skip < total && counters.scanned < max) {
    const page = await listInvoices(skip, REFRENS_PAGE_SIZE);
    total = page.total;
    if (!page.data.length) break;
    for (const r of page.data) {
      if (counters.scanned >= max) break;
      counters.scanned += 1;
      // Quotations / proformas / POs / credit notes are not receivables.
      if (!isSyncableInvoice(r)) {
        counters.ignored += 1;
        continue;
      }
      try {
        await upsertInvoice(agencyId, r, counters, clientCache);
      } catch (e) {
        counters.skipped += 1;
        counters.errors.push(`${r.invoiceNumber ?? r._id}: ${(e as Error).message}`);
      }
    }
    skip += page.data.length;
  }
  return counters;
}

// ------------------------------------------------------------------ push ----

/** Build the Refrens invoice body from a Sanctum invoice + items + client. */
function buildPayload(
  inv: typeof invoices.$inferSelect,
  items: Array<typeof invoiceItems.$inferSelect>,
  client: typeof clients.$inferSelect,
): Record<string, unknown> {
  return {
    billType: 'INVOICE',
    invoiceTitle: 'Invoice',
    currency: inv.currency || 'INR',
    taxType: 'INDIA',
    status: toRefrensStatus(inv.status),
    invoiceDate: (inv.issueDate ?? inv.createdAt ?? new Date()).toISOString(),
    ...(inv.dueDate ? { dueDate: inv.dueDate.toISOString() } : {}),
    igst: Boolean(inv.isInterstate),
    billedTo: {
      name: client.name,
      ...(client.contactEmail ? { email: client.contactEmail } : {}),
      ...(client.phone ? { phone: client.phone } : {}),
      ...(client.gstNumber ? { gstin: client.gstNumber } : {}),
      ...(client.billingAddress ? { street: client.billingAddress } : {}),
      ...(client.billingCity ? { city: client.billingCity } : {}),
      ...(client.billingState ? { state: client.billingState } : {}),
      ...(client.billingPincode ? { pincode: client.billingPincode } : {}),
      country: 'IN',
      ...(client.refrensClientId ? { clientId: client.refrensClientId } : {}),
    },
    items: items.map((it) => ({
      name: it.description,
      quantity: it.quantity,
      rate: paiseToRupees(it.rate),
      gstRate: it.gstRate,
      unit: it.unit,
      subTotal: paiseToRupees(it.amount),
    })),
    ...(inv.terms ? { terms: [{ label: 'Terms and Conditions', terms: [inv.terms] }] } : {}),
  };
}

/**
 * Push one Sanctum invoice to Refrens — creating it if it has no `refrens_id`,
 * otherwise updating the existing Refrens document.
 *
 * Never throws: sync failures are recorded on the row (`refrens_sync_error`) so
 * a Refrens outage can't fail the user's invoice request.
 */
export async function pushInvoice(
  agencyId: string,
  invoiceId: string,
): Promise<{ ok: boolean; refrensId?: string; error?: string }> {
  if (!refrensConfigured()) return { ok: false, error: 'Refrens is not configured.' };
  try {
    const [inv] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.agencyId, agencyId), eq(invoices.id, invoiceId)))
      .limit(1);
    if (!inv) return { ok: false, error: 'Invoice not found.' };

    const [client] = await db
      .select()
      .from(clients)
      .where(eq(clients.id, inv.clientId))
      .limit(1);
    if (!client) return { ok: false, error: 'Client not found.' };

    const items = await db
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, inv.id));
    if (!items.length) return { ok: false, error: 'Invoice has no line items.' };

    const payload = buildPayload(inv, items, client);
    const result = inv.refrensId
      ? await updateInvoice(inv.refrensId, payload)
      : await createInvoice(payload);

    const refrensId = result?._id ?? inv.refrensId ?? null;
    await db
      .update(invoices)
      .set({
        refrensId,
        // Refrens assigns the real, gapless invoice number — adopt it.
        invoiceNumber: result?.invoiceNumber
          ? await safeInvoiceNumber(agencyId, result.invoiceNumber, inv.id)
          : inv.invoiceNumber,
        refrensSyncedAt: new Date(),
        refrensSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, inv.id));

    // Adopt the Refrens client key so the client matches on later pulls.
    const refClientKey = result?.billedTo?.clientId ?? null;
    if (refClientKey && !client.refrensClientId) {
      await db
        .update(clients)
        .set({ refrensClientId: refClientKey, updatedAt: new Date() })
        .where(eq(clients.id, client.id));
    }
    return { ok: true, refrensId: refrensId ?? undefined };
  } catch (e) {
    const error = (e as Error).message;
    await db
      .update(invoices)
      .set({ refrensSyncError: error, updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId))
      .catch(() => {});
    return { ok: false, error };
  }
}

/** Re-pull a single invoice (used right after a push to reconcile totals). */
export async function refreshInvoice(agencyId: string, refrensId: string) {
  const counters: PullResult = {
    scanned: 1,
    created: 0,
    updated: 0,
    skipped: 0,
    clientsCreated: 0,
    paymentsAdded: 0,
    ignored: 0,
    errors: [],
  };
  const r = await getInvoice(refrensId);
  await upsertInvoice(agencyId, r, counters, await loadClientCache(agencyId));
  return counters;
}

// --------------------------------------------------------------- plumbing ---

/**
 * Which agency the poller syncs into. The Refrens credentials belong to ONE
 * business, so: an explicit env pin, else the only agency, else nothing.
 */
export async function syncAgencyId(): Promise<string | null> {
  const rows = await db.select({ id: agencies.id }).from(agencies).limit(2);
  if (rows.length === 1) return rows[0]!.id;
  return null;
}

export function refrensSyncEnabled(): boolean {
  return Boolean(env.REFRENS_SYNC_ENABLED) && refrensConfigured();
}

export function refrensAutoPushEnabled(): boolean {
  return Boolean(env.REFRENS_AUTO_PUSH) && refrensConfigured();
}

/** Sync status for the UI. */
export async function syncStatus(agencyId: string) {
  const [row] = await db
    .select({
      mirrored: sql<number>`count(*)`,
      lastSyncedAt: sql<number | null>`max(${invoices.refrensSyncedAt})`,
    })
    .from(invoices)
    .where(and(eq(invoices.agencyId, agencyId), isNotNull(invoices.refrensId)));
  const [errRow] = await db
    .select({ failed: sql<number>`count(*)` })
    .from(invoices)
    .where(
      and(eq(invoices.agencyId, agencyId), isNotNull(invoices.refrensSyncError)),
    );
  return {
    configured: refrensConfigured(),
    syncEnabled: refrensSyncEnabled(),
    autoPush: refrensAutoPushEnabled(),
    mirrored: Number(row?.mirrored ?? 0),
    failed: Number(errRow?.failed ?? 0),
    lastSyncedAt: row?.lastSyncedAt ? new Date(Number(row.lastSyncedAt) * 1000).toISOString() : null,
  };
}
