/**
 * Finance domain helpers. MONEY IS STORED AS INTEGER PAISE everywhere
 * (₹1 = 100 paise) to avoid floating-point rounding errors. Quantities and
 * GST percentages are the only non-integer values; every monetary result is
 * rounded to whole paise.
 */

/** A single line item, as needed for tax computation. */
export interface TaxLineInput {
  quantity: number;
  rate: number; // paise per unit
  gstRate: number; // percentage, e.g. 18
}

/** Per-line computed amounts (paise). */
export interface ComputedLine {
  amount: number; // round(quantity * rate)
  lineTax: number; // round(amount * gstRate / 100)
}

/** Invoice-level rolled-up totals (all paise). */
export interface ComputedTotals {
  lines: ComputedLine[];
  subtotal: number;
  taxTotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

/**
 * Compute line amounts + invoice totals + GST split.
 *
 * For each line: amount = round(quantity * rate); lineTax = round(amount * gstRate/100).
 * subtotal = Σ amount; taxTotal = Σ lineTax.
 * Interstate → igst = taxTotal (cgst = sgst = 0).
 * Intrastate → sgst = round(taxTotal/2); cgst = taxTotal - sgst (keeps the sum exact).
 * total = subtotal + taxTotal.
 */
export function computeInvoiceTotals(
  items: TaxLineInput[],
  isInterstate: boolean,
): ComputedTotals {
  const lines: ComputedLine[] = items.map((it) => {
    const amount = Math.round(it.quantity * it.rate);
    const lineTax = Math.round((amount * it.gstRate) / 100);
    return { amount, lineTax };
  });

  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const taxTotal = lines.reduce((sum, l) => sum + l.lineTax, 0);

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (isInterstate) {
    igst = taxTotal;
  } else {
    sgst = Math.round(taxTotal / 2);
    cgst = taxTotal - sgst;
  }

  const total = subtotal + taxTotal;
  return { lines, subtotal, taxTotal, cgst, sgst, igst, total };
}

/** Base invoice status as persisted in the DB. */
export type InvoiceBaseStatus =
  | 'draft'
  | 'sent'
  | 'partially_paid'
  | 'paid'
  | 'cancelled';

/**
 * Derived status shown to clients: a 'sent'/'partially_paid' invoice that is
 * past its due date with money still owed reads as 'overdue' (never stored).
 */
export function deriveStatus(
  base: InvoiceBaseStatus,
  dueDate: Date | null,
  amountDue: number,
  nowMs = Date.now(),
): InvoiceBaseStatus | 'overdue' {
  if (
    (base === 'sent' || base === 'partially_paid') &&
    dueDate != null &&
    dueDate.getTime() < nowMs &&
    amountDue > 0
  ) {
    return 'overdue';
  }
  return base;
}

/**
 * Next base status after a payment is recorded (or removed). Mirrors the spec:
 *  - fully paid (amountPaid >= total) → 'paid'
 *  - partly paid from a draft/sent/partially_paid/paid state → 'partially_paid'
 *  - nothing paid → revert to 'sent' if it had been issued, else 'draft'
 * 'cancelled' is sticky and never auto-changed.
 */
export function statusAfterPayment(
  base: InvoiceBaseStatus,
  amountPaid: number,
  total: number,
  wasIssued: boolean,
): InvoiceBaseStatus {
  if (base === 'cancelled') return 'cancelled';
  if (total > 0 && amountPaid >= total) return 'paid';
  if (amountPaid > 0) return 'partially_paid';
  // No payments left: fall back to the pre-payment lifecycle state.
  return wasIssued ? 'sent' : 'draft';
}
