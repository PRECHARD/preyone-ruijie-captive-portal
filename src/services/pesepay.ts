/**
 * Unified Pesepay entry point for the whole ecosystem.
 *
 * `pesepayService.ts` owns the AES-256-CBC envelope, rail codes and the live
 * make-payment/check-payment calls. This module is the single import surface
 * the three settlement surfaces (Starlink Wi-Fi, POS tills, B2B invoices) use,
 * so a rail or currency fix lands in one place instead of three.
 *
 * Settlement itself stays server-side and centralised: every target returns
 * the browser to its own app, but the server-to-server `resultUrl` is always
 * /api/payments/pesepay/callback, which settles the intent by `target_type`.
 */
export * from './pesepayService';

import { normalizeGatewayCurrency } from './pesepayService';
import type { PesepayCurrency } from './pesepayService';

/** The three product surfaces that can raise a Pesepay charge. */
export type PesepayTarget = 'starlink' | 'pos' | 'invoice';

export const PESEPAY_TARGETS: PesepayTarget[] = ['starlink', 'pos', 'invoice'];

export function isPesepayTarget(value: unknown): value is PesepayTarget {
  return typeof value === 'string' && (PESEPAY_TARGETS as string[]).includes(value);
}

function appBase(target: PesepayTarget): string {
  const envKey = `${target.toUpperCase()}_APP_URL`;
  const configured = process.env[envKey];
  if (configured && configured.trim()) return configured.trim().replace(/\/$/, '');
  return `https://${target}.preyone.com`;
}

/**
 * Where the customer's BROWSER lands after Pesepay checkout. Each surface has
 * its own post-payment screen; landing everyone on the WiFi payment-status page
 * (the historical default) left POS and invoice customers on a portal that does
 * not know their document.
 */
export function getPesepayReturnUrlForTarget(target: PesepayTarget, reference?: string): string {
  const suffix = reference ? `?payment=${encodeURIComponent(reference)}` : '';
  switch (target) {
    case 'starlink':
      return `${appBase('starlink')}/starlink/portal${suffix}`;
    case 'pos':
      return `${appBase('pos')}/${suffix}`;
    case 'invoice':
      return `${appBase('invoice')}/${suffix}`;
  }
}

/**
 * The server-to-server callback is deliberately target-independent: it carries
 * the intent reference and settles whichever row that reference points at.
 * Keeping one URL means a single endpoint to watch, sign and rate-limit.
 */
export function getPesepaySettlementUrl(baseUrl?: string): string {
  if (process.env.PESEPAY_RESULT_URL) return process.env.PESEPAY_RESULT_URL;
  const base = (baseUrl || process.env.BASE_URL || 'https://app.preyone.com').replace(/\/$/, '');
  return `${base}/api/payments/pesepay/callback`;
}

/**
 * Normalises a currency for the gateway. Pesepay's local-currency code is
 * "ZiG"; merchants, invoices and POS configs usually say ZWG. USD passes
 * through untouched. Returns null for anything the gateway cannot settle.
 */
export function resolveSettlementCurrency(value: unknown): PesepayCurrency | null {
  return normalizeGatewayCurrency(value);
}

/**
 * Human-readable settlement plan, used by the webhook audit log so an operator
 * can see which table a completed intent mutated.
 */
export function describeSettlement(target: PesepayTarget | string): {
  surface: string;
  table: string;
  effect: string;
} {
  switch (target) {
    case 'starlink':
      return {
        surface: 'Starlink Wi-Fi',
        table: 'starlink_invoices',
        effect: 'Invoice marked PAID, voucher/kit credited to the subscriber wallet.',
      };
    case 'pos':
      return {
        surface: 'POS till',
        table: 'pos_documents',
        effect: 'Document amount_paid credited, status recomputed (paid / partial).',
      };
    case 'invoice':
      return {
        surface: 'Invoicing',
        table: 'pos_documents',
        effect: 'B2B invoice credited; AR aging buckets recomputed on the next read.',
      };
    default:
      return {
        surface: 'Subscription',
        table: 'subscriptions',
        effect: 'Plan period extended and dunning cleared.',
      };
  }
}

/**
 * The 12 international document types the invoicing workspace can raise.
 * `sale` is deliberately absent: it is the POS till receipt and is created by
 * checkout, not by the office workspace (see ALL_DOCUMENT_TYPES).
 */
export const INVOICE_DOCUMENT_TYPES = [
  { type: 'invoice', label: 'Invoice', prefix: 'INV', ar: true, credit: false },
  { type: 'tax_invoice', label: 'Tax Invoice', prefix: 'TIN', ar: true, credit: false },
  { type: 'proforma', label: 'Proforma', prefix: 'PRO', ar: true, credit: false },
  { type: 'quote', label: 'Quote', prefix: 'QUO', ar: false, credit: false },
  { type: 'estimate', label: 'Estimate', prefix: 'EST', ar: false, credit: false },
  { type: 'receipt', label: 'Receipt', prefix: 'RCT', ar: false, credit: false },
  { type: 'sales_receipt', label: 'Sales Receipt', prefix: 'SRC', ar: true, credit: false },
  { type: 'cash_receipt', label: 'Cash Receipt', prefix: 'CRC', ar: false, credit: false },
  { type: 'credit_memo', label: 'Credit Memo', prefix: 'CRM', ar: false, credit: true },
  { type: 'credit_note', label: 'Credit Note', prefix: 'CRN', ar: false, credit: true },
  { type: 'purchase_order', label: 'Purchase Order', prefix: 'PO', ar: false, credit: false },
  { type: 'delivery_note', label: 'Delivery Note', prefix: 'DN', ar: false, credit: false },
] as const;

/** Every persisted doc_type, including the POS-only `sale`. */
export const ALL_DOCUMENT_TYPES = [
  ...INVOICE_DOCUMENT_TYPES.map((t) => t.type),
  'sale',
] as const;

export type InvoiceDocumentType = (typeof INVOICE_DOCUMENT_TYPES)[number]['type'];
export type DocumentType = (typeof ALL_DOCUMENT_TYPES)[number];

