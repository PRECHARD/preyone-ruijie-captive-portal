/**
 * 3rd-to-3rd trading cycle rules for Preyone enterprise accounting.
 *
 * Preyone buys from suppliers (third party) and sells to customers (third party).
 * P&L and overview endpoints must classify amounts strictly via these helpers —
 * never re-derive VAT or net sales ad-hoc in route handlers.
 */

/** Zimbabwe VAT rate used across POS / Tax Invoice surfaces. */
export const VAT_RATE_PCT = 15.5;

/** Mobile money rails settled through Pesepay. */
export const PESEPAY_RAILS = ['ecocash', 'omari', 'innbucks', 'paygo', 'pesepay'] as const;
export type PesepayRailName = (typeof PESEPAY_RAILS)[number];

/** Cash / card / bank — non-Pesepay collection rails. */
export const CASH_RAILS = ['cash', 'card', 'bank', 'other'] as const;

export type LedgerEntryType =
  | 'pos_sale'
  | 'invoice_payment'
  | 'credit_note'
  | 'expense'
  | 'stock_adjustment'
  | 'pesepay_collection';

export type LedgerRail =
  | 'cash'
  | 'card'
  | 'ecocash'
  | 'innbucks'
  | 'paygo'
  | 'omari'
  | 'bank'
  | 'pesepay'
  | 'other';

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** Extract VAT from a VAT-inclusive total (standard Preyone till pricing). */
export function extractVatInclusive(grossInclusive: number, taxPct = VAT_RATE_PCT): {
  gross: number;
  tax: number;
  net: number;
} {
  const gross = round2(grossInclusive);
  const pct = Number(taxPct) || 0;
  if (pct <= 0 || gross <= 0) {
    return { gross, tax: 0, net: gross };
  }
  const tax = round2((gross * pct) / (100 + pct));
  const net = round2(gross - tax);
  return { gross, tax, net };
}

/** True when the payment method is a Pesepay mobile rail. */
export function isPesepayRail(method: string | null | undefined): boolean {
  const m = String(method || '').toLowerCase().trim();
  return (PESEPAY_RAILS as readonly string[]).includes(m);
}

/** Normalize a raw payment method into a ledger rail bucket. */
export function normalizeRail(method: string | null | undefined): LedgerRail {
  const m = String(method || '').toLowerCase().trim();
  if (m === 'cash') return 'cash';
  if (m === 'card') return 'card';
  if (m === 'bank') return 'bank';
  if (m === 'ecocash') return 'ecocash';
  if (m === 'innbucks') return 'innbucks';
  if (m === 'omari') return 'omari';
  if (m === 'paygo') return 'paygo';
  if (m === 'pesepay') return 'pesepay';
  return 'other';
}

/** Map document + payment context to a ledger entry type. */
export function classifyEntryType(opts: {
  docType?: string | null;
  method?: string | null;
  isCreditNote?: boolean;
  isExpense?: boolean;
}): LedgerEntryType {
  if (opts.isExpense) return 'expense';
  if (opts.isCreditNote) return 'credit_note';
  if (isPesepayRail(opts.method)) return 'pesepay_collection';
  if (String(opts.docType || '').toLowerCase() === 'sale') return 'pos_sale';
  return 'invoice_payment';
}

/**
 * 3rd-to-3rd P&L line construction.
 *
 *   Gross Revenue     = paid sales + paid invoices (VAT-inclusive collections)
 *   − Credit notes
 *   = Adjusted Gross
 *   − VAT (extracted)
 *   = Net Sales
 *   − COGS (inventory cost of goods sold)
 *   = Gross Profit
 *   − Operating expenses
 *   = Operating Profit
 */
export interface CycleAmounts {
  grossRevenue: number;
  creditNotes: number;
  adjustedGross: number;
  taxCollected: number;
  netSales: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  operatingProfit: number;
}

export function buildCyclePnL(input: {
  grossRevenue: number;
  creditNotes?: number;
  taxCollected: number;
  cogs?: number;
  expenses?: number;
}): CycleAmounts {
  const grossRevenue = round2(input.grossRevenue);
  const creditNotes = round2(input.creditNotes || 0);
  const adjustedGross = round2(grossRevenue - creditNotes);
  const taxCollected = round2(input.taxCollected);
  // Prefer reported tax; if missing, extract from adjusted gross at statutory rate.
  const tax = taxCollected > 0 ? taxCollected : extractVatInclusive(adjustedGross).tax;
  const netSales = round2(adjustedGross - tax);
  const cogs = round2(input.cogs || 0);
  const grossProfit = round2(netSales - cogs);
  const expenses = round2(input.expenses || 0);
  const operatingProfit = round2(grossProfit - expenses);
  return {
    grossRevenue,
    creditNotes,
    adjustedGross,
    taxCollected: tax,
    netSales,
    cogs,
    grossProfit,
    expenses,
    operatingProfit,
  };
}

/** Split a collection amount into cash vs Pesepay rail buckets. */
export function splitRailBuckets(
  rows: Array<{ method: string; amount: number }>
): { cashTotal: number; pesepayTotal: number; byRail: Record<string, number> } {
  const byRail: Record<string, number> = {};
  let cashTotal = 0;
  let pesepayTotal = 0;
  for (const row of rows) {
    const rail = normalizeRail(row.method);
    const amt = round2(row.amount);
    byRail[rail] = round2((byRail[rail] || 0) + amt);
    if (isPesepayRail(rail)) pesepayTotal = round2(pesepayTotal + amt);
    else cashTotal = round2(cashTotal + amt);
  }
  return { cashTotal, pesepayTotal, byRail };
}

export { round2 as roundMoney };
