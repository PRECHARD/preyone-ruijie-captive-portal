import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { accountingRouter } from '../src/routes/accounting';
import { pool } from '../src/db/pool';

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: (req: any, _res: any, next: any) => {
    req.adminUser = {
      id: 'u1',
      email: 'ceo@preyone.com',
      role: session.role,
      fullName: 'CEO',
      portalCompanyId: 'company-a',
    };
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) => {
    if (!roles.includes(req.adminUser?.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  },
}));

vi.mock('../src/middleware/company', () => ({
  requireCompany: (req: any, _res: any, next: any) => {
    req.company = { id: 'company-a', name: 'Preyone', modules: ['pos', 'invoice'] };
    next();
  },
}));

const session = vi.hoisted(() => ({ role: 'CEO' }));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounting', accountingRouter);
  return app;
}

describe('GET /api/accounting/*', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.role = 'CEO';
  });

  it('returns overview KPIs for CEO', async () => {
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (/FROM accounting_ledger l/.test(sql) && /AS gross/.test(sql)) {
        return { rows: [{ gross: 115.5, tax: 15.5, net: 100, cogs: 40, credits: 0, expenses: 0 }] };
      }
      if (/AS outstanding/.test(sql)) return { rows: [{ outstanding: 25 }] };
      if (/AS till/.test(sql)) return { rows: [{ till: 50 }] };
      if (/AS revenue/.test(sql)) return { rows: [{ revenue: 200 }] };
      if (/AS valuation/.test(sql)) return { rows: [{ valuation: 500 }] };
      if (/GROUP BY rail/.test(sql)) return { rows: [{ rail: 'cash', amount: 50 }, { rail: 'ecocash', amount: 65.5 }] };
      return { rows: [] };
    });

    const res = await request(createApp()).get('/api/accounting/overview');
    expect(res.status).toBe(200);
    expect(res.body.totalGrossRevenue).toBe(115.5);
    expect(res.body.taxCollected).toBe(15.5);
    expect(res.body.netSales).toBe(100);
    expect(res.body.outstandingAr).toBe(25);
    expect(res.body.pesepayTotal).toBe(65.5);
    expect(res.body.cashTotal).toBe(50);
  });

  it('limits Cashier overview to till-drawer summary', async () => {
    session.role = 'Cashier';
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (/AS gross/.test(sql)) return { rows: [{ gross: 10, tax: 1, net: 9, cogs: 0, credits: 0, expenses: 0 }] };
      if (/AS outstanding/.test(sql)) return { rows: [{ outstanding: 0 }] };
      if (/AS till/.test(sql)) return { rows: [{ till: 10 }] };
      if (/AS revenue/.test(sql)) return { rows: [{ revenue: 10 }] };
      if (/AS valuation/.test(sql)) return { rows: [{ valuation: 0 }] };
      if (/GROUP BY rail/.test(sql)) return { rows: [{ rail: 'cash', amount: 10 }] };
      return { rows: [] };
    });

    const res = await request(createApp()).get('/api/accounting/overview');
    expect(res.status).toBe(200);
    expect(res.body.todayTill).toBe(10);
    expect(res.body.totalGrossRevenue).toBeUndefined();
    expect(res.body.cashTotal).toBe(10);
  });

  it('forbids Cashier from ledger/pnl/tax', async () => {
    session.role = 'Cashier';
    const app = createApp();
    expect((await request(app).get('/api/accounting/ledger')).status).toBe(403);
    expect((await request(app).get('/api/accounting/pnl')).status).toBe(403);
    expect((await request(app).get('/api/accounting/tax-summary')).status).toBe(403);
  });

  it('returns tax summary split for Manager', async () => {
    session.role = 'Manager';
    (pool.query as any).mockResolvedValue({
      rows: [
        { bucket: 'pos', count: 2, gross: 115.5, vat: 15.5, net: 100 },
        { bucket: 'invoice', count: 1, gross: 231, vat: 31, net: 200 },
      ],
    });
    const res = await request(createApp()).get('/api/accounting/tax-summary');
    expect(res.status).toBe(200);
    expect(res.body.posReceipts.vat).toBe(15.5);
    expect(res.body.taxInvoices.vat).toBe(31);
    expect(res.body.totalVatLiability).toBe(46.5);
  });
});
