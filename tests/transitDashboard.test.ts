import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/db/pool', () => ({ pool: { query: vi.fn() } }));

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

vi.mock('../src/middleware/rbac', () => ({
  PERMISSIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  requirePermission: () => vi.fn((_req: any, _res: any, next: any) => next()),
  requireTransitPermission: () => vi.fn((_req: any, _res: any, next: any) => next()),
  loadPermissions: vi.fn(async () => []),
  scopeVoucherCondition: () => null,
  scopeUserVoucherCodeCondition: () => null,
  FIELD_STAFF_ROLES: [],
}));

import { pool } from '../src/db/pool';
import { transitWebRouter } from '../src/routes/transitWeb';

const COMPANY = 'b599bd87-154f-4991-8a56-295060fed310';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.adminUser = {
      id: 'u1', email: 'a@b.c', role: 'CEO', fullName: 'A',
      companyId: COMPANY,
      permissions: ['company.admin', 'operations.manage', 'finance.view'],
    };
    next();
  });
  app.use('/api/v1/transit', transitWebRouter);
  return app;
}

describe('GET /api/v1/transit/dashboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes every aggregate to the admin company and returns sector shape', async () => {
    const seenParams: unknown[][] = [];
    (pool.query as any).mockImplementation(async (_sql: string, params: unknown[]) => {
      seenParams.push(params ?? []);
      return { rows: [] };
    });

    const res = await request(createApp()).get('/api/v1/transit/dashboard');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      company: null,
      fleet: { vehicles: 0, deviceOnline: 0, deviceTotal: 0, openShifts: 0, totalShifts: 0, activeTemplates: 0, transitUsers: 0, drivers: 0, conductors: 0 },
      status: { scheduled: 0, open: 0, active: 0, completed: 0, cancelled: 0, closed: 0 },
      today: { tickets: 0, gross: 0, cash: 0 },
      period: { week: { tickets: 0, gross: 0 }, month: { tickets: 0, gross: 0 } },
      routes: [],
      recentTrips: [],
    });

    // Every parameterised query must carry the admin's company id first.
    const scoped = seenParams.filter((p) => p.length > 0);
    expect(scoped.length).toBeGreaterThan(0);
    for (const p of scoped) expect(p[0]).toBe(COMPANY);
  });

  it('maps raw trip statuses into friendly buckets', async () => {
    let statusIdx = -1;
    (pool.query as any).mockImplementation(async (sql: string) => {
      statusIdx += 1;
      if (/FROM transit_trips t/.test(sql)) {
        return { rows: [
          { status: 'SCHEDULED', count: 2 }, { status: 'OPEN', count: 3 }, { status: 'CANCELLED', count: 1 },
        ] };
      }
      return { rows: [] };
    });

    const res = await request(createApp()).get('/api/v1/transit/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({ scheduled: 2, open: 3, cancelled: 1, completed: 0 });
  });
});