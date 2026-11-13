import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  TIER_CATALOG,
  invoiceBlock,
  modulesForPlan,
  subscriptionBlock,
} from '../src/plans/entitlements';

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
    name: 'Shop',
    modules: ['pos'] as string[],
    plan_type: 'standard_10',
    plan_name: 'PreTill',
    plan_tier: 'PreTill',
    subscription_status: 'active' as string | null,
    subscription_expires_at: null as string | null,
  },
}));

vi.mock('../src/middleware/company', () => ({
  requireCompany: (req: { company?: unknown }, _res: unknown, next: () => void) => {
    req.company = session.company;
    next();
  },
  moduleAccess: (...modules: string[]) => (req: any, res: any, next: () => void) => {
    const have: string[] = req.company?.modules ?? [];
    if (!have.some((m) => modules.includes(m))) {
      const label = modules.includes('invoice') ? 'Invoice' : 'POS';
      res.status(403).json({ error: `${label} is not on your plan.`, code: 'PLAN_MODULE_DISABLED', module: modules[0] });
      return;
    }
    next();
  },
}));

import { pool } from '../src/db/pool';
import { posRouter } from '../src/routes/pos';

function app() {
  const server = express();
  server.use(express.json());
  server.use((req: any, _res, next) => {
    req.adminUser = { id: 'admin-1', email: 'a@b.c', role: 'CEO', fullName: 'Ada', company_id: null };
    next();
  });
  server.use('/api/pos', posRouter);
  return server;
}

const saleBody = {
  docType: 'sale',
  items: [{ description: 'Bread', price: 1, qty: 1 }],
  payments: [{ amount: 1, method: 'cash' }],
};

function usePlan(id: string) {
  const tier = TIER_CATALOG.find((t) => t.id === id)!;
  session.company = {
    ...session.company,
    plan_type: tier.id,
    plan_name: tier.name,
    plan_tier: tier.name,
    modules: [...tier.modules],
    subscription_status: 'active',
    subscription_expires_at: null,
  };
}

beforeEach(() => {
  usePlan('standard_10');
  clientState.query.mockReset();
  clientState.query.mockImplementation(async (sql: string) => {
    if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
    if (/pos_shifts/.test(sql) && /SELECT/.test(sql)) return { rows: [{ id: 'shift-1' }] };
    if (/nextval/.test(sql)) return { rows: [{ v: 12 }] };
    if (/INSERT INTO pos_documents /.test(sql) || /INSERT INTO pos_documents\n/.test(sql)) {
      return { rows: [{ id: 'doc-1', doc_number: 'RCP-0012', doc_type: 'sale', total: 1 }] };
    }
    if (/INSERT INTO pos_document_payments/.test(sql)) {
      return { rows: [{ id: 1 }] };
    }
    return { rows: [] };
  });
  (pool.connect as any).mockResolvedValue({ query: clientState.query, release: clientState.release });
  (pool.query as any).mockResolvedValue({ rows: [] });
});

describe('plan catalogue', () => {
  it('names the four plans with the Pre prefix and the agreed prices', () => {
    expect(TIER_CATALOG.map((t) => [t.id, t.name, t.price, t.devices])).toEqual([
      ['standard_10', 'PreTill', 10, 1],
      ['pos_invoice_15', 'PreBiz', 15, 3],
      ['growth_20', 'PrePro', 20, 6],
      ['unlimited_30', 'PreUnlimited', 30, 9999],
    ]);
  });

  it('gives PreTill POS only and every higher plan POS and Invoice', () => {
    expect(modulesForPlan('standard_10')).toEqual(['pos']);
    expect(modulesForPlan('pos_invoice_15')).toEqual(['pos', 'invoice']);
    expect(modulesForPlan('invoicing_15')).toEqual(['pos', 'invoice']);
    expect(modulesForPlan('growth_20')).toEqual(['pos', 'invoice']);
    expect(modulesForPlan('unlimited_30')).toEqual(['pos', 'invoice']);
    expect(modulesForPlan('enterprise')).toEqual([]);
  });
});

describe('POS sale and invoice entitlement', () => {
  it('lets a PreTill company record a sale', async () => {
    const res = await request(app()).post('/api/pos/checkout').send(saleBody);
    expect(res.status).toBe(201);
  });

  it('refuses an invoice from a PreTill company', async () => {
    const res = await request(app()).post('/api/pos/checkout').send({ ...saleBody, docType: 'invoice' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_MODULE_DISABLED');
    expect(res.body.error).toMatch(/not on your plan/i);
    expect(clientState.query).not.toHaveBeenCalled();
  });

  it('lets PreBiz and above record both a sale and an invoice', async () => {
    for (const id of ['pos_invoice_15', 'growth_20', 'unlimited_30']) {
      usePlan(id);
      const sale = await request(app()).post('/api/pos/checkout').send(saleBody);
      const invoice = await request(app()).post('/api/pos/checkout').send({ ...saleBody, docType: 'invoice' });
      expect(sale.status, id).toBe(201);
      expect(invoice.status, id).toBe(201);
    }
  });

  it('blocks a new sale when the subscription has expired or is suspended', async () => {
    usePlan('unlimited_30');
    session.company.subscription_expires_at = new Date(Date.now() - 60_000).toISOString();
    const expired = await request(app()).post('/api/pos/checkout').send(saleBody);
    expect(expired.status).toBe(403);
    expect(expired.body.code).toBe('SUBSCRIPTION_EXPIRED');

    session.company.subscription_expires_at = null;
    session.company.subscription_status = 'suspended';
    const suspended = await request(app()).post('/api/pos/checkout').send(saleBody);
    expect(suspended.status).toBe(403);
    expect(suspended.body.code).toBe('SUBSCRIPTION_SUSPENDED');
  });

  it('hides POS data routes when the plan does not include POS', async () => {
    session.company.modules = [];
    const res = await request(app()).get('/api/pos/products');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not on your plan/i);
  });
});

describe('entitlement helpers', () => {
  const preTill = { modules: ['pos'], subscription_status: 'active', subscription_expires_at: null };
  const preBiz = { modules: ['pos', 'invoice'], subscription_status: 'active', subscription_expires_at: null };

  it('matches the HTTP rules', () => {
    expect(invoiceBlock(preTill)?.code).toBe('PLAN_MODULE_DISABLED');
    expect(invoiceBlock(preBiz)).toBeNull();
    expect(subscriptionBlock({ ...preBiz, subscription_status: 'suspended' })?.code).toBe('SUBSCRIPTION_SUSPENDED');
  });
});
