import { describe, it, expect } from 'vitest';
import { settleDocumentPayment, ledgerPaymentMethod } from '../src/services/documentSettlement';

/**
 * The settlement service is the single place where a confirmed document
 * payment advances the invoice, books revenue and moves stock. These tests
 * drive it with a scripted PG client so the money-safety rules are pinned:
 * idempotency per reference, stock exactly once, and no decrement on a
 * partially paid invoice.
 */

interface FakeDoc {
  id: string;
  doc_number: string;
  company_id: string;
  total: number;
  amount_paid: number;
  status: string;
  currency: string;
  exchange_rate: number;
  stock_applied_at: string | null;
  cashier_id: string | null;
}

interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  stock_qty: number;
  low_stock_threshold: number;
}

function makeClient(opts: {
  doc: FakeDoc;
  items?: Array<{ product_id: string; qty: number }>;
  products?: ProductRow[];
  seedReference?: string;
}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const products = new Map((opts.products ?? []).map((p) => [p.id, { ...p }]));
  const sales = new Set<string>();
  if (opts.seedReference) sales.add(`${opts.doc.id}|${opts.seedReference}`);
  let stockUpdates = 0;

  const query = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });

    if (/FROM pos_documents/.test(sql) && /FOR UPDATE/.test(sql)) {
      return { rows: [opts.doc] };
    }

    if (/FROM pos_document_items/.test(sql)) {
      return { rows: opts.items ?? [] };
    }

    if (/UPDATE pos_products/.test(sql)) {
      stockUpdates += 1;
      const [qty, productId] = params;
      const product = products.get(productId);
      if (!product) return { rows: [] };
      const previous = product.stock_qty;
      product.stock_qty = Math.max(0, previous - Number(qty));
      return {
        rows: [
          {
            id: product.id,
            name: product.name,
            sku: product.sku,
            previous_qty: previous,
            next_qty: product.stock_qty,
            low_stock_threshold: product.low_stock_threshold,
          },
        ],
      };
    }

    if (/UPDATE pos_documents/.test(sql)) {
      const [, nextPaid, nextStatus, stockApplied] = params;
      if (stockApplied) opts.doc.stock_applied_at = new Date().toISOString();
      opts.doc.amount_paid = nextPaid;
      opts.doc.status = nextStatus;
      return { rows: [{ status: nextStatus, amount_paid: nextPaid }] };
    }

    if (/FROM admin_users/.test(sql)) {
      return { rows: [{ full_name: 'Till User' }] };
    }

    if (/INSERT INTO sales/.test(sql)) {
      const key = `${params[7]}|${params[5]}`;
      if (sales.has(key)) return { rows: [] };
      sales.add(key);
      return { rows: [{ id: 'sale-1' }] };
    }

    return { rows: [] };
  };

  return { client: { query } as any, calls, products, stockUpdates: () => stockUpdates };
}

function baseDoc(overrides: Partial<FakeDoc> = {}): FakeDoc {
  return {
    id: 'doc-1',
    doc_number: 'INV-0001',
    company_id: 'company-a',
    total: 50,
    amount_paid: 0,
    status: 'unpaid',
    currency: 'USD',
    exchange_rate: 1,
    stock_applied_at: null,
    cashier_id: 'user-a',
    ...overrides,
  };
}

describe('ledgerPaymentMethod', () => {
  it('normalises the three Pesepay rails for the ledger', () => {
    expect(ledgerPaymentMethod('ecocash')).toBe('EcoCash');
    expect(ledgerPaymentMethod('innbucks')).toBe('InnBucks');
    expect(ledgerPaymentMethod('omari')).toBe('Omari');
    expect(ledgerPaymentMethod('EcoCash (Pesepay)')).toBe('EcoCash');
    expect(ledgerPaymentMethod(null)).toBe('Cash');
  });
});

describe('settleDocumentPayment', () => {
  it('marks the invoice paid, books the sale and decrements stock once', async () => {
    const doc = baseDoc();
    const fake = makeClient({
      doc,
      items: [{ product_id: 'p1', qty: 2 }],
      products: [{ id: 'p1', name: 'Router', sku: 'R-1', stock_qty: 10, low_stock_threshold: 3 }],
    });

    const result = await settleDocumentPayment(fake.client, {
      documentId: doc.id,
      amount: 50,
      paymentMethod: 'ecocash',
      paymentReference: 'PAY-1',
    });

    expect(result.status).toBe('paid');
    expect(result.transitionedToPaid).toBe(true);
    expect(result.saleRecorded).toBe(true);
    expect(result.stockApplied).toBe(true);
    expect(result.stockMovements).toHaveLength(1);
    expect(result.stockMovements[0]).toMatchObject({ previous: 10, next: 8, qty: 2, lowStock: false });
    expect(fake.products.get('p1')?.stock_qty).toBe(8);

    const saleCall = fake.calls.find((c) => /INSERT INTO sales/.test(c.sql));
    expect(saleCall?.params).toContain('EcoCash');
    expect(saleCall?.params).toContain('PAY-1');
  });

  it('is idempotent for the same payment reference and never double-decrements', async () => {
    const doc = baseDoc({ status: 'paid', amount_paid: 50, stock_applied_at: new Date().toISOString() });
    const fake = makeClient({
      doc,
      items: [{ product_id: 'p1', qty: 2 }],
      products: [{ id: 'p1', name: 'Router', sku: null, stock_qty: 8, low_stock_threshold: 3 }],
      seedReference: 'PAY-1',
    });
    const result = await settleDocumentPayment(fake.client, {
      documentId: doc.id,
      amount: 50,
      paymentMethod: 'innbucks',
      paymentReference: 'PAY-1',
    });

    expect(result.saleRecorded).toBe(false);
    expect(result.stockApplied).toBe(false);
    expect(result.stockMovements).toHaveLength(0);
    expect(fake.stockUpdates()).toBe(0);
    expect(fake.products.get('p1')?.stock_qty).toBe(8);
  });

  it('does not touch stock on a partial payment', async () => {
    const doc = baseDoc({ total: 100 });
    const fake = makeClient({
      doc,
      items: [{ product_id: 'p1', qty: 1 }],
      products: [{ id: 'p1', name: 'Router', sku: null, stock_qty: 10, low_stock_threshold: 3 }],
    });

    const result = await settleDocumentPayment(fake.client, {
      documentId: doc.id,
      amount: 40,
      paymentMethod: 'omari',
      paymentReference: 'PAY-2',
    });

    expect(result.status).toBe('partial');
    expect(result.transitionedToPaid).toBe(false);
    expect(result.stockApplied).toBe(false);
    expect(fake.stockUpdates()).toBe(0);
    // Revenue is still recognised for the cash received.
    expect(result.saleRecorded).toBe(true);
    expect(result.amountPaid).toBe(40);
  });

  it('skips stock for a document that was already stocked at checkout', async () => {
    const doc = baseDoc({ status: 'partial', amount_paid: 20, stock_applied_at: new Date().toISOString() });
    const fake = makeClient({
      doc,
      items: [{ product_id: 'p1', qty: 1 }],
      products: [{ id: 'p1', name: 'Router', sku: null, stock_qty: 10, low_stock_threshold: 3 }],
    });

    const result = await settleDocumentPayment(fake.client, {
      documentId: doc.id,
      amount: 80,
      paymentMethod: 'cash',
      paymentReference: 'manual-9',
    });

    expect(result.status).toBe('paid');
    expect(result.stockApplied).toBe(false);
    expect(fake.stockUpdates()).toBe(0);
  });

  it('flags a product that crossed its low-stock threshold', async () => {
    const doc = baseDoc();
    const fake = makeClient({
      doc,
      items: [{ product_id: 'p1', qty: 4 }],
      products: [{ id: 'p1', name: 'Cable', sku: 'CBL', stock_qty: 5, low_stock_threshold: 2 }],
    });

    const result = await settleDocumentPayment(fake.client, {
      documentId: doc.id,
      amount: 50,
      paymentMethod: 'paygo',
      paymentReference: 'PAY-3',
    });

    expect(result.stockMovements[0]).toMatchObject({ previous: 5, next: 1, lowStock: true });
  });

  it('floors stock at zero instead of going negative', async () => {
    const doc = baseDoc();
    const fake = makeClient({
      doc,
      items: [{ product_id: 'p1', qty: 9 }],
      products: [{ id: 'p1', name: 'Cable', sku: null, stock_qty: 3, low_stock_threshold: 2 }],
    });

    const result = await settleDocumentPayment(fake.client, {
      documentId: doc.id,
      amount: 50,
      paymentMethod: 'cash',
      paymentReference: 'PAY-4',
    });

    expect(result.stockMovements[0]).toMatchObject({ previous: 3, next: 0, lowStock: true });
    expect(fake.products.get('p1')?.stock_qty).toBe(0);
  });
});
