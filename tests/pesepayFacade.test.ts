import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_DOCUMENT_TYPES,
  INVOICE_DOCUMENT_TYPES,
  PESEPAY_TARGETS,
  describeSettlement,
  getPesepayReturnUrlForTarget,
  getPesepaySettlementUrl,
  isPesepayTarget,
  resolveSettlementCurrency,
} from '../src/services/pesepay';
import { DOC_PREFIX, statusForPaid } from '../src/routes/pos';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Pesepay return URLs', () => {
  it('sends each surface back to its own app', () => {
    expect(getPesepayReturnUrlForTarget('starlink')).toBe('https://starlink.preyone.com/starlink/portal');
    expect(getPesepayReturnUrlForTarget('pos')).toBe('https://pos.preyone.com/');
    expect(getPesepayReturnUrlForTarget('invoice')).toBe('https://invoice.preyone.com/');
  });

  it('appends the intent reference for the post-payment screen', () => {
    expect(getPesepayReturnUrlForTarget('pos', 'REF 123')).toContain('?payment=REF%20123');
    expect(getPesepayReturnUrlForTarget('invoice', 'abc')).toBe('https://invoice.preyone.com/?payment=abc');
  });

  it('honours per-surface environment overrides', () => {
    vi.stubEnv('POS_APP_URL', 'http://localhost:5174/');
    vi.stubEnv('INVOICE_APP_URL', 'http://localhost:5176/');
    expect(getPesepayReturnUrlForTarget('pos')).toBe('http://localhost:5174/');
    expect(getPesepayReturnUrlForTarget('invoice')).toBe('http://localhost:5176/');
  });

  it('recognises the three settlement targets only', () => {
    expect(PESEPAY_TARGETS).toEqual(['starlink', 'pos', 'invoice']);
    expect(isPesepayTarget('pos')).toBe(true);
    expect(isPesepayTarget('subscription')).toBe(false);
    expect(isPesepayTarget(null)).toBe(false);
  });
});

describe('Pesepay settlement endpoint', () => {
  it('is one central callback regardless of surface', () => {
    vi.stubEnv('BASE_URL', 'https://app.preyone.com');
    expect(getPesepaySettlementUrl()).toBe('https://app.preyone.com/api/payments/pesepay/callback');
  });

  it('accepts an explicit override for split deployments', () => {
    vi.stubEnv('PESEPAY_RESULT_URL', 'https://api.preyone.com/pesepay');
    expect(getPesepaySettlementUrl('https://anything.example')).toBe('https://api.preyone.com/pesepay');
  });

  it('trims a trailing slash on the base URL', () => {
    vi.stubEnv('BASE_URL', 'https://app.preyone.com/');
    expect(getPesepaySettlementUrl()).toBe('https://app.preyone.com/api/payments/pesepay/callback');
  });
});

describe('settlement currency normalisation', () => {
  it('maps ZWG/ZWD/ZiG to the gateway ZiG code', () => {
    expect(resolveSettlementCurrency('ZWG')).toBe('ZiG');
    expect(resolveSettlementCurrency('zwd')).toBe('ZiG');
    expect(resolveSettlementCurrency('ZiG')).toBe('ZiG');
  });

  it('passes USD through and rejects unsupported currencies', () => {
    expect(resolveSettlementCurrency('usd')).toBe('USD');
    expect(resolveSettlementCurrency('ZAR')).toBeNull();
    expect(resolveSettlementCurrency('')).toBeNull();
    expect(resolveSettlementCurrency(undefined)).toBeNull();
  });
});

describe('settlement descriptions', () => {
  it('names the table each target mutates', () => {
    expect(describeSettlement('starlink').table).toBe('starlink_invoices');
    expect(describeSettlement('pos').table).toBe('pos_documents');
    expect(describeSettlement('invoice').table).toBe('pos_documents');
    expect(describeSettlement('subscription').table).toBe('subscriptions');
  });

  it('falls back to the subscription description for unknown targets', () => {
    expect(describeSettlement('mystery').surface).toBe('Subscription');
  });
});

describe('document type catalogue', () => {
  it('exposes exactly 12 office document types', () => {
    expect(INVOICE_DOCUMENT_TYPES).toHaveLength(12);
    expect(new Set(INVOICE_DOCUMENT_TYPES.map((t) => t.type)).size).toBe(12);
  });

  it('omits the POS-only sale type from the office list', () => {
    expect(INVOICE_DOCUMENT_TYPES.some((t) => t.type === 'sale')).toBe(false);
    expect(ALL_DOCUMENT_TYPES).toContain('sale');
    expect(ALL_DOCUMENT_TYPES).toHaveLength(13);
  });

  it('every prefix matches the number generator', () => {
    for (const type of INVOICE_DOCUMENT_TYPES) {
      expect(DOC_PREFIX[type.type], type.type).toBeTruthy();
    }
  });

  it('marks only credit notes/memos as credit documents', () => {
    const credits = INVOICE_DOCUMENT_TYPES.filter((t) => t.credit).map((t) => t.type);
    expect(credits.sort()).toEqual(['credit_memo', 'credit_note']);
  });

  it('marks invoices, tax invoices, proformas and sales receipts as AR', () => {
    const ar = INVOICE_DOCUMENT_TYPES.filter((t) => t.ar).map((t) => t.type);
    expect(ar.sort()).toEqual(['invoice', 'proforma', 'sales_receipt', 'tax_invoice']);
  });

  it('statusForPaid keeps quotes out of the AR flow', () => {
    expect(statusForPaid('quote', 100, 0)).toBe('sent');
    expect(statusForPaid('estimate', 100, 0)).toBe('sent');
    expect(statusForPaid('proforma', 100, 0)).toBe('sent');
    expect(statusForPaid('invoice', 100, 0)).toBe('unpaid');
    expect(statusForPaid('invoice', 100, 50)).toBe('partial');
    expect(statusForPaid('invoice', 100, 100)).toBe('paid');
  });
});
