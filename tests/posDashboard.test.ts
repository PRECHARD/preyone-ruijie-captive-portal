import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { posRouter } from '../src/routes/pos';
import { pool } from '../src/db/pool';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

const session = vi.hoisted(() => ({
  companyId: 'company-a',
  userId: 'user-a',
  role: 'CEO',
}));

vi.mock('../src/middleware/company', () => ({
  requireCompany: (req: any, _res: any, next: any) => {
    req.company = { id: session.companyId, name: 'Test Co', modules: ['pos'] };
    next();
  },
}));

const COMPANY_A = 'company-a';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.adminUser = {
      id: session.userId,
      email: 'user@test',
      role: session.role,
      fullName: 'Test User',
      company_id: 'some-transit-company-id',
    };
    next();
  });
  app.use('/api/pos', posRouter);
  return app;
}

describe('GET /api/pos/dashboard (POS sector aggregate)', () => {
  // resetAllMocks (not clearAllMocks) so queued mockResolvedValueOnce values
  // seeded by one test never leak into the next.
  beforeEach(() => vi.resetAllMocks());

  function seedDashboard() {
    // 10 parallel queries in order: till, profit, method, sellers, stock, staff, ledger, overdue, recent, shifts.
    (pool.query as any)
      .mockResolvedValueOnce({ rows: [{ docs: 5, gross: '250.00', collected: '200.00', vat: '30.00' }] })
      .mockResolvedValueOnce({ rows: [{ profit: '90.00' }] })
      .mockResolvedValueOnce({ rows: [{ method: 'cash', count: 3, total: '120.00' }, { method: 'ecocash', count: 2, total: '80.00' }] })
      .mockResolvedValueOnce({ rows: [{ description: 'Prepaid Airtime $5', qty_sold: 12, revenue: '60.00' }] })
      .mockResolvedValueOnce({ rows: [{ id: 's1', name: 'Coke 2L', stock_qty: 2, low_stock_threshold: 10 }] })
      .mockResolvedValueOnce({ rows: [{ cashier: 'Leslie', count: 4, gross: '200.00' }] })
      .mockResolvedValueOnce({ rows: [
        { doc_type: 'invoice', status: 'unpaid', count: 1, amount: '100.00', outstanding: '100.00' },
        { doc_type: 'invoice', status: 'paid', count: 2, amount: '120.00', outstanding: '0.00' },
        { doc_type: 'quotation', status: 'sent', count: 2, amount: '80.00', outstanding: '80.00' },
        { doc_type: 'sale', status: 'paid', count: 30, amount: '900.00', outstanding: '0.00' },
      ] })
      .mockResolvedValueOnce({ rows: [{ count: 1, outstanding: '50.00' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'doc1', doc_number: 'INV-0001', doc_type: 'invoice', status: 'unpaid', total: '100.00', amount_paid: '0.00', issue_date: '2026-10-01', due_date: '2026-10-15', customer_name: 'ACME', cashier_name: 'Leslie' }] })
      .mockResolvedValueOnce({ rows: [{ open: 1, total: 2 }] });
  }

  it('returns till counters, ledger and low-stock in the sector shape', async () => {
    seedDashboard();
    const res = await request(createApp()).get('/api/pos/dashboard');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      till: { docs: 5, gross: '250.00', collected: '200.00', vat: '30.00', profit: '90.00', byMethod: expect.any(Array) },
      bestSellers: [expect.objectContaining({ description: 'Prepaid Airtime $5' })],
      lowStock: [expect.objectContaining({ name: 'Coke 2L' })],
      staff: [expect.objectContaining({ cashier: 'Leslie' })],
      ledger: {
        invoices: { issued: 3, paid: 2, unpaid: 1, partial: 0, overdue: { count: 1, outstanding: '50.00' } },
        quotations: { draft: 0, sent: 2, converted: 0 },
        sales: 30,
        recent: expect.any(Array),
      },
      shifts: { open: 1, total: 2 },
    });
  });

  it('tenant-scopes every document/payment query to req.company.id', async () => {
    seedDashboard();
    await request(createApp()).get('/api/pos/dashboard');
    const calls = (pool.query as any).mock.calls.map((c: any[]) => c[0] as string);
    // Every money/document query must be pinned to the requireCompany tenant.
    const scoped = calls.filter((s: string) => /pos_documents d/.test(s));
    expect(scoped.length).toBeGreaterThan(0);
    // The first filter clause in each is the company predicate (checked by the
    // implementation pushing tenantId first); assert it is referenced in SQL.
    for (const sql of scoped) expect(/WHERE\s+d\.company_id = \$1/.test(sql)).toBe(true);
    // products low-stock mirrors the existing reports behaviour (global POS realm).
    expect(calls.some((s: string) => /pos_products/.test(s))).toBe(true);
  });

  it('rejects converting another tenant\'s quotation (probe returns 404)', async () => {
    (pool.query as any).mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp()).post('/api/pos/documents/doc-x/convert-to-invoice');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Quotation not found');
    // It must never reach nextval when the document does not belong here.
    expect((pool.query as any).mock.calls.length).toBe(1);
  });

  it('converts an owned quotation to an invoice with a fresh INV- number', async () => {
    (pool.query as any)
      .mockResolvedValueOnce({ rows: [{ id: 'q1', doc_type: 'quotation', status: 'sent' }] })
      .mockResolvedValueOnce({ rows: [{ v: 42 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'q1', doc_number: 'INV-0042', doc_type: 'invoice', status: 'unpaid' }] });

    const res = await request(createApp()).post('/api/pos/documents/q1/convert-to-invoice');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ doc_number: 'INV-0042', doc_type: 'invoice', status: 'unpaid' });
    const updateSql = (pool.query as any).mock.calls[2][0] as string;
    expect(updateSql).toContain('doc_type = \'invoice\'');
    expect(updateSql).toContain('WHERE id = $2');
    // Ownership was already proven by the tenant-scoped SELECT (first call).
    expect((pool.query as any).mock.calls[0][0] as string).toContain('company_id = $2');
  });
});