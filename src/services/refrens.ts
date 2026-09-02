/**
 * Refrens API client.
 *
 * Refrens is a Feathers app. Two things the published docs get wrong and that
 * cost real time to rediscover, so they are written down here:
 *   1. Resources live at the ROOT (`/businesses/:urlKey/invoices`) — there is
 *      no `/api/v1` prefix.
 *   2. Auth is a two-step app-token exchange: we self-sign an ES256 JWT with
 *      the app's EC P-256 private key, then POST it to `/authentication` to
 *      swap it for a short-lived `accessToken` used as the Bearer on calls.
 *
 * Also learned the hard way (see the probes in the integration notes):
 *   - `$limit` is capped at 50 — always paginate with `$skip`.
 *   - The `clients` resource REJECTS app-token auth (401), so the client roster
 *     must be derived from each invoice's embedded `billedTo`.
 *   - Payments are embedded in the invoice, not a separate resource.
 *   - Refrens money is in RUPEES (decimal); Sanctum stores INTEGER PAISE.
 */
import { importPKCS8, SignJWT } from 'jose';
import { env } from '../env.js';

const HOST = 'https://api.refrens.com';
const AUD = 'serana';
const STRATEGY = 'app-iss-app-token';
/** Refrens caps page size at 50 regardless of what you ask for. */
export const REFRENS_PAGE_SIZE = 50;

export interface RefrensPage<T> {
  total: number;
  limit: number;
  skip: number;
  data: T[];
}

/** Only the fields we actually consume — Refrens returns a great deal more. */
export interface RefrensInvoice {
  _id: string;
  invoiceNumber?: string | null;
  invoiceTitle?: string | null;
  billType?: string | null; // INVOICE | CREDITNOTE
  status?: string | null; // UNPAID | PAID | PARTIAL | CANCELED
  invoiceDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  client?: string | null;
  billedTo?: RefrensParty | null;
  items?: RefrensItem[];
  finalTotal?: RefrensTotals | null;
  payments?: RefrensPayment[];
  igst?: boolean;
  terms?: Array<{ label?: string; terms?: string[] }>;
  createdAt?: string;
  updatedAt?: string;
}

export interface RefrensParty {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country?: string | null;
  gstin?: string | null;
  panNumber?: string | null;
  clientId?: string | null;
  gstState?: string | null;
  clientType?: string | null;
}

export interface RefrensItem {
  name?: string | null;
  description?: string | null;
  hsn?: string | null;
  quantity?: number | null;
  rate?: number | null; // rupees
  gstRate?: number | null;
  subTotal?: number | null; // rupees
  total?: number | null; // rupees
  unit?: string | null;
}

export interface RefrensTotals {
  total?: number | null; // rupees
  subTotal?: number | null;
  amount?: number | null;
  igst?: number | null;
  cgst?: number | null;
  sgst?: number | null;
  discount?: number | null;
}

export interface RefrensPayment {
  _id: string;
  amount?: number | null; // rupees
  tds?: number | null; // rupees withheld — still money settled against the bill
  transactionCharge?: number | null;
  paymentDate?: string | null;
  paymentMethod?: string | null;
  isRemoved?: boolean;
  isApproved?: boolean;
  isRefund?: boolean;
}

export class RefrensError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'RefrensError';
  }
}

/** True when all three credentials are present. */
export function refrensConfigured(): boolean {
  return Boolean(
    env.REFRENS_URL_KEY && env.REFRENS_APP_ID && env.REFRENS_PRIVATE_KEY,
  );
}

export function refrensUrlKey(): string {
  if (!env.REFRENS_URL_KEY) throw new RefrensError('Refrens is not configured.', 500);
  return env.REFRENS_URL_KEY;
}

// ---- token cache -----------------------------------------------------------
let cachedToken: { token: string; expiresAt: number } | null = null;

/** .env keeps the PEM on one line with escaped newlines; restore them. */
function privateKeyPem(): string {
  const raw = env.REFRENS_PRIVATE_KEY ?? '';
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

async function fetchAccessToken(): Promise<string> {
  if (!refrensConfigured()) throw new RefrensError('Refrens is not configured.', 500);
  const appId = env.REFRENS_APP_ID!;
  const key = await importPKCS8(privateKeyPem(), 'ES256');
  const selfJwt = await new SignJWT({ auth: { entity: 'app', strategy: STRATEGY } })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(appId)
    .setSubject(appId)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

  const res = await fetch(`${HOST}/authentication`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${selfJwt}` },
    body: JSON.stringify({ strategy: STRATEGY }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !(body as any)?.accessToken) {
    throw new RefrensError('Refrens authentication failed.', res.status, body);
  }
  return (body as any).accessToken as string;
}

async function accessToken(force = false): Promise<string> {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const token = await fetchAccessToken();
  // Refrens tokens are short-lived; re-mint every ~10 min regardless.
  cachedToken = { token, expiresAt: Date.now() + 10 * 60_000 };
  return token;
}

/** Authenticated request with a single retry after a 401 (expired token). */
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  retry = true,
): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {
    cachedToken = null;
    return call<T>(method, path, body, false);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg = (parsed as any)?.message ?? `Refrens ${method} ${path} failed`;
    throw new RefrensError(msg, res.status, parsed);
  }
  return parsed as T;
}

// ---- invoices --------------------------------------------------------------

/** One page of invoices, newest first. */
export function listInvoices(skip = 0, limit = REFRENS_PAGE_SIZE) {
  const key = refrensUrlKey();
  const qs = `$limit=${limit}&$skip=${skip}&$sort[invoiceDate]=-1`;
  return call<RefrensPage<RefrensInvoice>>('GET', `/businesses/${key}/invoices?${qs}`);
}

export function getInvoice(id: string) {
  return call<RefrensInvoice>('GET', `/businesses/${refrensUrlKey()}/invoices/${id}`);
}

export function createInvoice(payload: Record<string, unknown>) {
  return call<RefrensInvoice>('POST', `/businesses/${refrensUrlKey()}/invoices`, payload);
}

export function updateInvoice(id: string, payload: Record<string, unknown>) {
  return call<RefrensInvoice>(
    'PATCH',
    `/businesses/${refrensUrlKey()}/invoices/${id}`,
    payload,
  );
}

// ---- money + status mapping ------------------------------------------------

/** Refrens rupees (may be fractional) → Sanctum integer paise. */
export function rupeesToPaise(v: number | null | undefined): number {
  return Math.round((Number(v) || 0) * 100);
}

/** Sanctum integer paise → Refrens rupees. */
export function paiseToRupees(v: number | null | undefined): number {
  return Math.round(Number(v) || 0) / 100;
}

/**
 * Money actually settled against a Refrens invoice.
 *
 * TDS is deducted at source by the client but still discharges the receivable,
 * so it counts toward paid — otherwise every TDS invoice looks permanently
 * short-paid. Removed (`isRemoved`) and refund entries are excluded.
 */
export function settledPaise(payments: RefrensPayment[] | undefined): number {
  if (!payments?.length) return 0;
  return payments
    .filter((p) => !p.isRemoved && !p.isRefund)
    .reduce((sum, p) => sum + rupeesToPaise(p.amount) + rupeesToPaise(p.tds), 0);
}

export type SanctumInvoiceStatus =
  | 'draft'
  | 'sent'
  | 'partially_paid'
  | 'paid'
  | 'cancelled';

/** Refrens status → Sanctum status. Refrens has no "draft". */
export function mapStatus(
  refrensStatus: string | null | undefined,
  payments: RefrensPayment[] | undefined,
  totalPaise: number,
): SanctumInvoiceStatus {
  const s = (refrensStatus ?? '').toUpperCase();
  if (s === 'CANCELED' || s === 'CANCELLED') return 'cancelled';
  if (s === 'PAID') return 'paid';
  const paid = settledPaise(payments);
  if (s === 'PARTIAL' || (paid > 0 && paid < totalPaise)) return 'partially_paid';
  if (paid >= totalPaise && totalPaise > 0) return 'paid';
  // An issued-but-unpaid Refrens invoice is "sent" in Sanctum terms — it has
  // definitively left the building, which "draft" would misrepresent.
  return 'sent';
}

/** Sanctum status → the Refrens status vocabulary (for pushes). */
export function toRefrensStatus(status: SanctumInvoiceStatus): string {
  switch (status) {
    case 'paid':
      return 'PAID';
    case 'partially_paid':
      return 'PARTIAL';
    case 'cancelled':
      return 'CANCELED';
    default:
      return 'UNPAID';
  }
}

const METHOD_MAP: Record<string, string> = {
  ACCOUNT_TRANSFER: 'bank_transfer',
  BANK_TRANSFER: 'bank_transfer',
  NEFT: 'bank_transfer',
  IMPS: 'bank_transfer',
  RTGS: 'bank_transfer',
  UPI: 'upi',
  CASH: 'cash',
  CARD: 'card',
  CREDIT_CARD: 'card',
  DEBIT_CARD: 'card',
  CHEQUE: 'cheque',
};

export function mapPaymentMethod(
  m: string | null | undefined,
): 'bank_transfer' | 'upi' | 'cash' | 'card' | 'cheque' | 'other' {
  return (METHOD_MAP[(m ?? '').toUpperCase()] ?? 'other') as
    | 'bank_transfer'
    | 'upi'
    | 'cash'
    | 'card'
    | 'cheque'
    | 'other';
}

/**
 * The `/invoices` collection is really an all-documents collection: alongside
 * INVOICE it returns PROFORMAINV, QUOTATION, PURCHASEORDER and CREDITNOTE.
 * Only a real INVOICE is a receivable — importing the rest would inflate
 * revenue and outstanding. Credit notes are excluded too: they are negative
 * documents and Sanctum has no credit-note concept to net them against.
 */
export function isSyncableInvoice(r: { billType?: string | null }): boolean {
  return (r.billType ?? 'INVOICE').toUpperCase() === 'INVOICE';
}

export function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
