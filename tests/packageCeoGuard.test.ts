import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const actor = vi.hoisted(() => ({ role: 'Staff' }));

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: vi.fn((req: any, _res: any, next: any) => {
    req.adminUser = { id: 'u-1', email: 'actor@test', role: actor.role, fullName: 'Actor One' };
    next();
  }),
  requireAdminAuthAllowLocked: vi.fn((req: any, _res: any, next: any) => {
    req.adminUser = { id: 'u-1', email: 'actor@test', role: actor.role, fullName: 'Actor One' };
    next();
  }),
  requireRole: () => vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../src/middleware/rbac', () => ({
  PERMISSIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  requirePermission: () => vi.fn((_req: any, _res: any, next: any) => next()),
  requireTransitPermission: () => vi.fn((_req: any, _res: any, next: any) => next()),
  loadPermissions: vi.fn(async () => ['COMPANY_ADMIN']),
  scopeVoucherCondition: () => null,
  scopeUserVoucherCodeCondition: () => null,
  FIELD_STAFF_ROLES: [],
}));

import { pool } from '../src/db/pool';
import { adminRouter } from '../src/routes/admin';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

/**
 * CEO-only promo minting (prePromo_Monthly). The UI hides the tier from
 * Staff/Manager, and the API must refuse a hand-crafted request with 403 before
 * clock-in checks, Ruijie minting or pool claims happen.
 */
describe('CEO-only promo tiers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actor.role = 'Staff';
  });

  it('refuses a Staff single-promo mint with 403 and touches nothing', async () => {
    const res = await request(createApp())
      .post('/api/admin/vouchers')
      .send({ code: 'promo001', packageTier: 'prePromo_Monthly' });

    expect(res.status).toBe(403);
    expect(res.body.ceoOnly).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses a Staff bulk promo mint with 403', async () => {
    const res = await request(createApp())
      .post('/api/admin/vouchers/bulk')
      .send({ count: 1, packageTier: 'prePromo_Monthly' });

    expect(res.status).toBe(403);
    expect(res.body.ceoOnly).toBe(true);
  });

  it('refuses a Staff approval request for the promo tier with 403', async () => {
    const res = await request(createApp())
      .post('/api/admin/vouchers/request-approval')
      .send({ requestType: 'single', packageTier: 'prePromo_Monthly' });

    expect(res.status).toBe(403);
    expect(res.body.ceoOnly).toBe(true);
  });

  it('lets the CEO mint the promo tier', async () => {
    actor.role = 'CEO';
    (pool.query as any)
      .mockResolvedValueOnce({
        rows: [{
          tier_name: 'prePromo_Monthly',
          display_name: 'Promo Monthly',
          duration_min: 43200,
          data_limit_gb: null,
          is_uncapped: true,
          bandwidth_mbps_up: 5,
          bandwidth_mbps_down: 5,
          max_devices: 2,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'v-1', code: 'promo001', package_tier: 'prePromo_Monthly' }],
      });

    const res = await request(createApp())
      .post('/api/admin/vouchers')
      .send({ code: 'promo001', packageTier: 'prePromo_Monthly' });

    expect(res.status).toBe(201);
    expect(res.body.package_tier).toBe('prePromo_Monthly');
  });

  it('flags the promo tier in GET /packages for the mint UI', async () => {
    (pool.query as any).mockResolvedValueOnce({
      rows: [
        { tier_name: 'preMicro_Daily', display_name: 'Micro Pass' },
        { tier_name: 'prePromo_Monthly', display_name: 'Promo Monthly' },
      ],
    });

    const res = await request(createApp()).get('/api/admin/packages');

    expect(res.status).toBe(200);
    expect(res.body.map((p: any) => [p.tier_name, p.ceo_exclusive])).toEqual([
      ['preMicro_Daily', false],
      ['prePromo_Monthly', true],
    ]);
  });
});
