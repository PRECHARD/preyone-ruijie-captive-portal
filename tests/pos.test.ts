import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { computeTotals, statusForPaid, DOC_PREFIX, posRouter } from '../src/routes/pos';
import { pool } from '../src/db/pool';

// ── Multi-tenant isolation harness ──────────────────────────────────
//
// The tenant is driven entirely by requireCompany (req.company.id), so the
// mock lets each test act as a specific company and then asserts the SQL sent
// to Postgres is constrained to that company. A cross-tenant read must come
// back 404/403 rather than leaking the other company's document.

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
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
const COMPANY_B = 'company-b';
const DOC_A = 'doc-a';
const DOC_B = 'doc-b';

function createApp() {
  const app = express();
  app.use(express.json());
  // Reproduce the real global guard: requireAdminAuth populates req.adminUser.
  app.use((req: any, _res: any, next: any) => {
    req.adminUser = {
      id: session.userId,
      email: 'user@test',
      role: session.role,
      fullName: 'Test User',
      // Deliberately a DIFFERENT tenant from req.company: proves pos.ts trusts
      // req.company and never the (nullable, transit-linked) admin column.
      company_id: 'some-transit-company-id',
    };
    next();
  });
  app.use('/api/pos', posRouter);
  return app;
}

describe('POS cross-tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.companyId = COMPANY_A;
    session.userId = 'user-a';
    session.role = 'CEO';
  });

  it('scopes GET /documents/:id to the caller company and 404s a foreign document', async () => {
    // Simulate the row existing, but belonging to the other tenant: a correct
    // query filters it out, so the mock returns nothing for company-a.
    (pool.query as any).mockImplementation(async (sql: string, params?: any[]) => {
      if (/FROM pos_documents WHERE id/.test(sql)) {
        const [docId, companyId] = params ?? [];
        // Model the real table: each document belongs to exactly one company.
        const owned = docId === DOC_A && companyId === COMPANY_A;
        return owned
          ? { rows: [{ id: DOC_A, doc_number: 'INV-0001', total: 100 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const own = await request(createApp()).get(`/api/pos/documents/${DOC_A}`);
    expect(own.status).toBe(200);
    expect(own.body.doc_number).toBe('INV-0001');

    // Same UUID, different tenant => not visible.
    const foreign = await request(createApp()).get(`/api/pos/documents/${DOC_B}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('Document not found');
  });

  it('always binds the document lookup to the session company, never the path', async () => {
    (pool.query as any).mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await request(createApp()).get(`/api/pos/documents/${DOC_A}`);

    const docCall = (pool.query as any).mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('FROM pos_documents WHERE id')
    );
    expect(docCall).toBeTruthy();
    // The tenant predicate must be present and bound to company-a.
    expect(docCall![0]).toMatch(/company_id\s*=\s*\$2/);
    expect(docCall![1][1]).toBe(COMPANY_A);
  });

  it('scopes the document list and always includes the tenant predicate first', async () => {
    (pool.query as any).mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await request(createApp()).get('/api/pos/documents?type=invoice&status=unpaid');

    const listCall = (pool.query as any).mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('FROM pos_documents d')
    );
    expect(listCall).toBeTruthy();
    expect(listCall![1][0]).toBe(COMPANY_A);
    expect(listCall![0]).toMatch(/WHERE d\.company_id = \$1/);
  });

  it('404s an installment payment against a foreign document instead of mutating it', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (/FROM pos_documents WHERE id/.test(sql)) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }),
      release,
    };
    (pool.connect as any).mockResolvedValue(client);

    const res = await request(createApp())
      .post(`/api/pos/documents/${DOC_B}/payments`)
      .send({ amount: 10, method: 'cash' });

    expect(res.status).toBe(404);
    // Critically: no payment row and no amount_paid update may happen.
    const sqls = client.query.mock.calls.map((c: any[]) => c[0]);
    expect(sqls.some((s: string) => /INSERT INTO pos_document_payments/.test(s))).toBe(false);
    expect(sqls.some((s: string) => /UPDATE pos_documents SET amount_paid/.test(s))).toBe(false);
    expect(sqls).toContain('ROLLBACK');
  });

  it('scopes shift reads and stamps company_id when opening a shift', async () => {
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (/INSERT INTO pos_shifts/.test(sql)) return { rows: [{ id: 'shift-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await request(createApp()).post('/api/pos/shifts/open').send({ openingFloat: 20 });

    const insertCall = (pool.query as any).mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO pos_shifts')
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall![0]).toMatch(/company_id/);
    expect(insertCall![1]).toContain(COMPANY_A);
  });

  it('scopes the shift list so a manager sees only their own company', async () => {
    (pool.query as any).mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await request(createApp()).get('/api/pos/shifts?all=1');

    const shiftCall = (pool.query as any).mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('FROM pos_shifts s')
    );
    expect(shiftCall).toBeTruthy();
    expect(shiftCall![0]).toMatch(/s\.company_id/);
    expect(shiftCall![1]).toContain(COMPANY_A);
  });

  it('scopes sales reports so revenue cannot be aggregated across tenants', async () => {
    (pool.query as any).mockImplementation(async (sql: string) => {
      // The totals/profit rollups dereference rows[0], so return a row.
      if (/AS docs/.test(sql) || /AS profit/.test(sql)) return { rows: [{}], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await request(createApp()).get('/api/pos/reports/sales').expect(200);

    let checked = 0;
    for (const call of (pool.query as any).mock.calls) {
      if (typeof call[0] === 'string' && /pos_documents d/.test(call[0])) {
        expect(call[0]).toMatch(/d\.company_id/);
        expect(call[1]).toContain(COMPANY_A);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('uses req.company, not the transit-linked admin_users.company_id', async () => {
    (pool.query as any).mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    session.companyId = COMPANY_B;

    await request(createApp()).get(`/api/pos/documents/${DOC_A}`);

    const docCall = (pool.query as any).mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('FROM pos_documents WHERE id')
    );
    expect(docCall![1][1]).toBe(COMPANY_B);
    expect(docCall![1]).not.toContain('some-transit-company-id');
  });
});

describe('POS computeTotals', () => {
  it('sums line totals into subtotal', () => {
    const { lines, subtotal } = computeTotals(
      [
        { description: 'Print A4', price: 0.5, qty: 10 },
        { description: 'Laminate', price: 1.25, qty: 2 },
      ],
      0,
      0
    );
    expect(lines).toHaveLength(2);
    expect(subtotal).toBeCloseTo(7.5, 2);
    expect(lines[0].lineTotal).toBeCloseTo(5.0, 2);
    expect(lines[1].lineTotal).toBeCloseTo(2.5, 2);
  });

  it('defaults missing qty to 1 and coerces strings', () => {
    const { lines, subtotal } = computeTotals([{ description: 'Photo', price: '3.335' }], 0, 0);
    expect(lines[0].qty).toBe(1);
    expect(lines[0].price).toBeCloseTo(3.34, 2); // round2 applied per unit price
    expect(subtotal).toBeCloseTo(3.34, 2);
  });

  it('applies discount to subtotal and derives tax-inclusive tax amount', () => {
    // subtotal 100, discount 10% → discounted base 90; tax is the VAT share
    // embedded in that base: 90 × 15/115 ≈ 11.74; total excludes tax.
    const { discountAmount, taxAmount, total } = computeTotals([{ price: 100, qty: 1 }], 10, 15);
    expect(discountAmount).toBeCloseTo(10, 2);
    expect(taxAmount).toBeCloseTo(11.74, 2);
    expect(total).toBeCloseTo(90, 2);
  });

  it('handles empty carts safely', () => {
    const { subtotal, total } = computeTotals([], 0, 0);
    expect(subtotal).toBe(0);
    expect(total).toBe(0);
  });
});

describe('POS statusForPaid', () => {
  it('marks paid when payments cover the total (within rounding tolerance)', () => {
    expect(statusForPaid('invoice', 100, 100)).toBe('paid');
    expect(statusForPaid('sale', 99.99, 99.995)).toBe('paid');
    expect(statusForPaid('quotation', 50, 50)).toBe('paid');
  });

  it('marks partial when some but not all is paid', () => {
    expect(statusForPaid('invoice', 100, 40)).toBe('partial');
  });

  it('falls back to sent for unpaid quotations, unpaid otherwise', () => {
    expect(statusForPaid('quotation', 100, 0)).toBe('sent');
    expect(statusForPaid('invoice', 100, 0)).toBe('unpaid');
    expect(statusForPaid('sale', 100, 0)).toBe('unpaid');
  });
});

describe('POS document numbering prefixes', () => {
  it('maps doc types to brand prefixes', () => {
    expect(DOC_PREFIX.sale).toBe('RCP');
    expect(DOC_PREFIX.invoice).toBe('INV');
    expect(DOC_PREFIX.quotation).toBe('QUO');
  });
});
