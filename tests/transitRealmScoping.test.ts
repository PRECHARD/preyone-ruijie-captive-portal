import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/db/pool', () => ({ pool: { query: vi.fn() } }));

// Both routers call requireAdminAuth themselves, which would reject the request
// before any realm field is read. Replace it with a pass-through that leaves
// req.adminUser exactly as the test set it -- that is the surface under test.
vi.mock('../src/middleware/adminAuth', async () => {
  const actual = await vi.importActual<typeof import('../src/middleware/adminAuth')>(
    '../src/middleware/adminAuth'
  );
  return {
    ...actual,
    requireAdminAuth: (req: any, _res: any, next: any) => next(),
    requireRole: () => (_req: any, _res: any, next: any) => next(),
  };
});

import { pool } from '../src/db/pool';
import { transitWebRouter } from '../src/routes/transitWeb';
import { systemAdminRouter } from '../src/routes/systemAdmin';

/**
 * Regression guard for the drift that let the Transit console ship broken.
 *
 * transitWeb and systemAdmin scope every query through AdminUser.companyId.
 * They were absent from this repo entirely, so nothing exercised the field name
 * they depend on -- and renaming it on AdminUser produced 18 compile errors
 * rather than a test failure only because tsc happened to run.
 *
 * The cases below pin the two behaviours that a wrong field name would break:
 * a company-scoped admin sees only their own company's rows, and a platform
 * (Level 0) admin is never silently scoped to one company.
 */
const COMPANY = 'b599bd87-154f-4991-8a56-295060fed310';
const OTHER = '3b4a6254-24a6-41c6-8b3a-7a18e07ee77c';

function appWith(user: Record<string, unknown>, mount: (b: express.Express) => void) {
  const b = express();
  // The real app parses JSON before the routers; without this req.body is
  // undefined and write handlers throw before reaching the scoping check.
  b.use(express.json());
  b.use((req: any, _res: any, next: any) => {
      req.adminUser = {
        id: 'u1', email: 'a@b.c', role: 'CEO', fullName: 'A',
        permissions: ['system.developer', 'company.admin', 'operations.manage', 'finance.view'],
        ...user,
      };
    next();
  });
  mount(b);
  return b;
}

describe('transitWeb company scoping reads AdminUser.companyId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes a company-scoped admin to their own company', async () => {
    // companyWhere() pushes the tenant as a bound parameter; if it read a field
    // that is always undefined it would silently degrade to "see everything".
    let seenParams: unknown[] = [];
    (pool.query as any).mockImplementation(async (sql: string, params: unknown[]) => {
      seenParams = params ?? [];
      return { rows: [], rowCount: 0 };
    });

    const b = appWith({ companyId: COMPANY }, (x) => x.use('/t', transitWebRouter));
    await request(b).get('/t/fleet').expect(200);

    expect(seenParams).toContain(COMPANY);
    expect(seenParams).not.toContain(OTHER);
  });

  it('treats a platform admin as unscoped rather than defaulting to one company', async () => {
    let seenParams: unknown[] = [];
    (pool.query as any).mockImplementation(async (sql: string, params: unknown[]) => {
      seenParams = params ?? [];
      return { rows: [], rowCount: 0 };
    });

    const b = appWith({ companyId: null }, (x) => x.use('/t', transitWebRouter));
    await request(b).get('/t/fleet').expect(200);

    expect(seenParams).not.toContain(COMPANY);
  });

  it('ignores a foreign companyId in the query and stays pinned to its own company', async () => {
    // Read routes use companyScope(), which for a company admin pins to
    // AdminUser.companyId and disregards any explicit target. Write routes use
    // resolveCompany(), which rejects the mismatch outright. Either way the
    // other tenant's rows are unreachable -- what matters is that the bound
    // parameter is the admin's own company, never the requested one.
    let seenParams: unknown[] = [];
    (pool.query as any).mockImplementation(async (_sql: string, params: unknown[]) => {
      seenParams = params ?? [];
      return { rows: [], rowCount: 0 };
    });

    const b = appWith({ companyId: COMPANY }, (x) => x.use('/t', transitWebRouter));
    await request(b).get(`/t/fleet?companyId=${OTHER}`).expect(200);

    expect(seenParams).toContain(COMPANY);
    expect(seenParams).not.toContain(OTHER);
  });

  it('rejects a company admin whose write targets another company', async () => {
    (pool.query as any).mockResolvedValue({ rows: [], rowCount: 0 });
    const b = appWith({ companyId: COMPANY }, (x) => x.use('/t', transitWebRouter));
    await request(b).post('/t/staff').send({ companyId: OTHER }).expect(403);
  });
});

describe('systemAdmin platform gate reads AdminUser.companyId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('403s a company-scoped admin even when the role grants system.developer', async () => {
    // This is the exact gate that regressed silently: a renamed field makes
    // companyId undefined, the guard passes, and Level 0 platform endpoints
    // (tenants, global revenue, system health) open up to a company admin.
    (pool.query as any).mockResolvedValue({ rows: [], rowCount: 0 });
    const b = appWith({ companyId: COMPANY, permissions: ['system.developer'] }, (x) =>
      x.use('/sa', systemAdminRouter)
    );
    await request(b).get('/sa/companies').expect(403);
  });

  it('allows a platform admin through', async () => {
    (pool.query as any).mockResolvedValue({ rows: [], rowCount: 0 });
    const b = appWith({ companyId: null, permissions: ['system.developer'] }, (x) =>
      x.use('/sa', systemAdminRouter)
    );
    await request(b).get('/sa/companies').expect(200);
  });
});