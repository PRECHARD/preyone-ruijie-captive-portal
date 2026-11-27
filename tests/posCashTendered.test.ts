import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-jwt-secret';
});

const clientState = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
  },
}));

vi.mock('../src/db/accounting', () => ({
  syncSaleToLedgerAndStock: vi.fn(async () => {}),
  markStockApplied: vi.fn(async () => {}),
}));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const session = vi.hoisted(() => ({
  company: {
    id: 'company-1',
    name: 'FLONIEL BABYWARE',
    modules: ['pos', 'invoice'],
    plan_type: 'growth_20',
    plan_name: 'PrePro',
    plan_tier: 'PrePro',
    subscription_status: 'active',
    subscription_expires_at: null,
  },
}));

vi.mock('../src/middleware/company', () => ({
  requireCompany: (req: { company?: unknown }, _res: unknown, next: () => void) => {
    req.company = session.company;
    next();
  },
  moduleAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { pool } from '../src/db/pool';
import { posRouter } from '../src/routes/pos';
import { cashChange, cashQuickAmounts } from '../pos/src/utils/cashAmounts';
import { cashQuickAmounts as invoiceQuickAmounts } from '../invoice/src/cashAmounts';

function app() {
  const server = express();
  server.use(express.json());
  server.use((req: any, _res, next) => {
    req.adminUser = { id: 'admin-1', email: 'cashier@test', role: 'Cashier', fullName: 'Prechard' };
    next();
  });
  server.use('/api/pos', posRouter);
  return server;
}

const saleBody = (cashTendered?: number) => ({
  docType: 'sale',
  items: [{ description: 'Rombas - PINK ROMBAS', price: 10, qty: 1 }],
  payments: [{ amount: 10, method: 'cash', ...(cashTendered === undefined ? {} : { cashTendered }) }],
});

beforeEach(() => {
  clientState.query.mockReset();
  clientState.query.mockImplementation(async (sql: string) => {
    if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
    if (/pos_shifts/.test(sql) && /SELECT/.test(sql)) return { rows: [{ id: 'shift-1' }] };
    if (/nextval/.test(sql)) return { rows: [{ v: 119 }] };
    if (/INSERT INTO pos_documents/.test(sql)) {
      return { rows: [{ id: 'doc-1', doc_number: 'RCP-0119', doc_type: 'sale', total: 10 }] };
    }
    if (/UPDATE pos_documents/.test(sql) && /verify_code/.test(sql)) {
      return {
        rows: [{
          id: 'doc-1',
          doc_number: 'RCP-0119',
          doc_type: 'sale',
          total: 10,
          verify_code: 'PVN-4H7X-XN6G-VEME-T11B-EDKC',
        }],
      };
    }
    if (/INSERT INTO pos_document_payments/.test(sql)) {
      return { rows: [{ id: 1, cash_tendered: '20.00', change_amount: '10.00' }] };
    }
    return { rows: [] };
  });
  (pool.connect as any).mockResolvedValue({ query: clientState.query, release: clientState.release });
  (pool.query as any).mockResolvedValue({ rows: [] });
});

describe('cash tender persistence', () => {
  it('stores and returns the real cash handed over and calculated change', async () => {
    const res = await request(app()).post('/api/pos/checkout').send(saleBody(20));

    expect(res.status).toBe(201);
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0]).toMatchObject({
      amount: 10,
      method: 'cash',
      cashTendered: 20,
      change: 10,
    });

    const insert = clientState.query.mock.calls.find(
      ([sql]: [string]) =>
        String(sql).includes('INSERT INTO pos_document_payments') &&
        String(sql).includes('cash_tendered')
    );
    expect(insert).toBeTruthy();
    expect(insert![1]).toEqual(['doc-1', 10, 'cash', null, 'admin-1', 'shift-1', 20, 10]);
  });

  it('never records negative change when the tender is below the amount', async () => {
    const res = await request(app()).post('/api/pos/checkout').send(saleBody(8));

    expect(res.status).toBe(201);
    expect(res.body.payments[0]).toMatchObject({ cashTendered: 10, change: 0 });
  });

  it('keeps legacy cash payments working without tender fields', async () => {
    const res = await request(app()).post('/api/pos/checkout').send(saleBody());

    expect(res.status).toBe(201);
    expect(res.body.payments[0]).toMatchObject({ cashTendered: null, change: null });
    const insert = clientState.query.mock.calls.find(([sql]: [string]) =>
      String(sql).includes('INSERT INTO pos_document_payments')
    );
    expect(String(insert![0])).not.toContain('cash_tendered');
  });

  it('persists cash tender on installment payments too', async () => {
    clientState.query.mockImplementation(async (sql: string) => {
      if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
      if (/SELECT \* FROM pos_documents WHERE id = .* FOR UPDATE/.test(sql)) {
        return {
          rows: [{
            id: 'doc-1', doc_number: 'INV-0119', doc_type: 'sale', total: 10,
            status: 'unpaid', tax_pct: 0, currency: 'USD', shift_id: null,
          }],
        };
      }
      if (/pos_shifts/.test(sql) && /SELECT/.test(sql)) return { rows: [{ id: 'shift-1' }] };
      if (/INSERT INTO pos_document_payments/.test(sql)) {
        return { rows: [{ id: 2, cash_tendered: '20.00', change_amount: '10.00' }] };
      }
      if (/SELECT COALESCE\(SUM\(amount\)/.test(sql)) return { rows: [{ paid: 10 }] };
      if (/UPDATE pos_documents/.test(sql)) {
        return {
          rows: [{
            id: 'doc-1', doc_number: 'INV-0119', doc_type: 'sale', total: 10,
            amount_paid: 10, status: 'paid',
          }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app())
      .post('/api/pos/documents/doc-1/payments')
      .send({ amount: 10, method: 'cash', cashTendered: 20 });

    expect(res.status).toBe(200);
    expect(res.body.balanceDue).toBe(0);
    const insert = clientState.query.mock.calls.find(
      ([sql]: [string]) => String(sql).includes('INSERT INTO pos_document_payments')
    );
    expect(insert![1]).toEqual(['doc-1', 10, 'cash', null, 'admin-1', 'shift-1', 20, 10]);
  });

  it('adds the audit columns through an idempotent migration', () => {
    const sql = fs.readFileSync('db/migrations/v8_pos_cash_tender.sql', 'utf8');
    const migrate = fs.readFileSync('src/db/migrate.ts', 'utf8');
    expect(sql).toContain('cash_tendered NUMERIC(12,2)');
    expect(sql).toContain('change_amount NUMERIC(12,2)');
    expect(migrate).toContain('v8_pos_cash_tender.sql');
  });
});

describe('single-row USD quick amounts', () => {
  it('starts with the exact balance and de-duplicates round bills', () => {
    expect(cashQuickAmounts(10)).toEqual([10, 20, 50, 100]);
    expect(cashQuickAmounts(30)).toEqual([30, 50, 100]);
    expect(cashQuickAmounts(12.34)).toEqual([12.34, 20, 50, 100]);
    expect(cashQuickAmounts(7.25)).toEqual([7.25, 10, 20, 50, 100]);
    expect(cashQuickAmounts(100)).toEqual([100]);
    expect(invoiceQuickAmounts(10)).toEqual(cashQuickAmounts(10));
  });

  it('calculates change to cents and never returns a negative', () => {
    expect(cashChange(20, 10)).toBe(10);
    expect(cashChange(9.999, 10)).toBe(0);
  });

  it('keeps every quick button in one nowrap row on both apps', () => {
    const posCss = fs.readFileSync('pos/src/styles.css', 'utf8');
    const posResponsive = fs.readFileSync('pos/src/responsive.css', 'utf8');
    const invoiceCss = fs.readFileSync('invoice/src/upgradeCheckout.css', 'utf8');

    expect(posCss).toMatch(/\.quick-amts \{[^}]*flex-wrap:\s*nowrap[^}]*width:\s*100%/s);
    expect(posCss).toContain('white-space: nowrap');
    expect(posCss).toContain('font-variant-numeric: tabular-nums');
    expect(posResponsive).not.toContain('grid-template-columns: repeat(2, 1fr)');

    expect(invoiceCss).toMatch(/\.cash-quick-row \{[^}]*flex-wrap:\s*nowrap[^}]*width:\s*100%/s);
    expect(invoiceCss).toContain('white-space: nowrap');
    expect(invoiceCss).toContain('font-variant-numeric: tabular-nums');
  });

  it('submits the cash fields from both payment UIs', () => {
    const till = fs.readFileSync('pos/src/components/CheckoutModal.tsx', 'utf8');
    const modal = fs.readFileSync('pos/src/components/PaymentModal.tsx', 'utf8');
    const drawer = fs.readFileSync('invoice/src/App.tsx', 'utf8');

    expect(till).toContain('cashTendered: handed, change: cashChange(handed, applied)');
    expect(modal).toContain('cashTendered: tendered, change');
    expect(drawer).toContain('cashTendered: cashTenderedNow, change: cashDueChange');
  });
});
