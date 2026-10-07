import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: vi.fn((_req: any, _res: any, next: any) => { (_req as any).adminUser = { id: 'test', email: 'test@test', role: 'CEO', fullName: 'Test' }; next(); }),
  requireRole: () => vi.fn((_req: any, _res: any, next: any) => next()),
}));

// Most admin routes are gated by requirePermission(...). Unmocked, the real
// loader queries the stub pool, grants nothing and 403s before the handler
// runs. This suite's actor is a CEO, who holds every permission in production.
vi.mock('../src/middleware/rbac', () => ({
  PERMISSIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  requirePermission: () => vi.fn((_req: any, _res: any, next: any) => next()),
  requireTransitPermission: () => vi.fn((_req: any, _res: any, next: any) => next()),
  loadPermissions: vi.fn(async () => ['COMPANY_ADMIN', 'FINANCE_VIEW']),
  scopeVoucherCondition: () => null,
  scopeUserVoucherCodeCondition: () => null,
  FIELD_STAFF_ROLES: [],
}));

import { pool } from '../src/db/pool';
import { requireAdminAuth } from '../src/middleware/adminAuth';
import { adminRouter } from '../src/routes/admin';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

describe('Admin routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/admin/revenue', () => {
    it('returns revenue stats and transaction breakdown', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [{ total_revenue: 1234.50 }] })
        .mockResolvedValueOnce({ rows: [{ total_pending: 99.99 }] })
        .mockResolvedValueOnce({ rows: [{ total_sales: 500 }] })
        .mockResolvedValueOnce({ rows: [{ total_pending: 0 }] })
        .mockResolvedValueOnce({ rows: [{ total_approved: 200 }] })
        .mockResolvedValueOnce({ rows: [{ package_tier: 'PreMAX', count: 5, total: 500 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'tx-1', package_tier: 'PreMAX', amount: 34.99, currency: 'USD', status: 'completed', user_name: 'Alice' }] });

      const res = await request(createApp()).get('/api/admin/revenue');

      expect(res.status).toBe(200);
      expect(res.body.totalRevenue).toBe(1434.50);
      expect(res.body.salesRevenue).toBe(500);
      expect(res.body.combinedRevenue).toBe(1434.50);
      expect(res.body.handoverApproved).toBe(200);
      expect(res.body.handoverPending).toBe(0);
      expect(res.body.byTier).toHaveLength(1);
      expect(res.body.recentTransactions).toHaveLength(1);
    });
  });

  describe('Staff management endpoints', () => {
    it('GET /api/admin/staff returns staff list', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [{ id: 's1', full_name: 'Jane', role: 'Staff', approved: true }] });

      const res = await request(createApp()).get('/api/admin/staff');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('GET /api/admin/staff-pending returns pending staff', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [{ id: 's2', full_name: 'Bob' }] });

      const res = await request(createApp()).get('/api/admin/staff-pending');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('POST /api/admin/staff-approve/:id approves a staff account', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [{ id: 's1', full_name: 'Jane', approved: true }] });

      const res = await request(createApp()).post('/api/admin/staff-approve/s1');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('approved');
    });
  });

  describe('GET /api/admin/charts', () => {
    it('returns daily signups and session counts', async () => {
      const fakeDailySignups = [
        { day: '2026-05-10', count: 3 },
        { day: '2026-05-11', count: 5 },
      ];
      (pool.query as any)
        .mockResolvedValueOnce({ rows: fakeDailySignups })
        .mockResolvedValueOnce({ rows: [{ count: 12 }] })
        .mockResolvedValueOnce({ rows: [{ count: 4 }] })
        .mockResolvedValueOnce({ rows: [] }) // dailyRevenue
        .mockResolvedValueOnce({ rows: [] }); // dailySales

      const res = await request(createApp()).get('/api/admin/charts');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        dailySignups: fakeDailySignups,
        activeSessions: 12,
        expiredSessions: 4,
        dailyRevenue: [],
        dailySales: [],
      });
    });
  });

  describe('GET /api/admin/users', () => {
    it('returns users list', async () => {
      const fakeUsers = [
        { id: '1', full_name: 'Alice', phone: '123' },
        { id: '2', full_name: 'Bob', phone: '456' },
      ];
      (pool.query as any).mockResolvedValue({ rows: fakeUsers });

      const res = await request(createApp()).get('/api/admin/users');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(fakeUsers);
    });
  });

  describe('GET /api/admin/access-log', () => {
    it('returns access log with user names', async () => {
      const fakeLog = [
        { id: '1', event: 'login', full_name: 'Alice' },
      ];
      (pool.query as any).mockResolvedValue({ rows: fakeLog });

      const res = await request(createApp()).get('/api/admin/access-log');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(fakeLog);
      // The handler passes an explicit params array (populated by the voucher
      // scope), so the assertion has to account for the second argument.
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('LEFT JOIN users'),
        expect.any(Array),
      );
    });
  });

  describe('POST /api/admin/vouchers', () => {
    it('creates a voucher and returns 201', async () => {
      const fakeVoucher = { id: 'v1', code: 'TEST50', duration_min: 50 };
      (pool.query as any).mockResolvedValue({ rows: [fakeVoucher] });

      const res = await request(createApp())
        .post('/api/admin/vouchers')
        .send({ code: 'test50' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ...fakeVoucher, package_tier: null });
      // The insert carries 12 columns: code, duration, max_uses, expires_at,
      // data_limit, is_uncapped, bandwidth up/down, sold_by, price, tier,
      // max_devices. Defaults come from the handler (60 min, uncapped, 2/5 Mbps).
      // sold_by is null for a non-Staff sale with no price: the handler only
      // attributes a seller when the voucher was actually paid for, which is
      // what makes Staff's own-sales scoping sound.
      // The canonical stored PIN is lowercase even when the client sends
      // uppercase. Authentication is case-insensitive, and every output path
      // (preview, JPEG, PDF, print, share, admin lists, copy-PIN) renders the
      // stored code — one case at the source keeps all of them consistent.
      const insertCall = (pool.query as any).mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO vouchers')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1]).toEqual([
        'test50', 60, 1, null, null, true, 2, 5, null, null, null, null,
      ]);
    });

    it('normalises the PIN to lowercase even for mixed/uppercase input', async () => {
      (pool.query as any).mockResolvedValue({ rows: [{ id: 'v9', code: 'ab12cd', duration_min: 60 }] });

      const res = await request(createApp())
        .post('/api/admin/vouchers')
        .send({ code: 'Ab12CD' });

      expect(res.status).toBe(201);
      const insertCall = (pool.query as any).mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO vouchers')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][0]).toBe('ab12cd');
    });

    it('returns 422 when code is missing', async () => {
      const res = await request(createApp())
        .post('/api/admin/vouchers')
        .send({});

      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: 'code is required' });
    });
  });

  describe('GET /api/admin/vouchers', () => {
    it('returns a paginated voucher list', async () => {
      const fakeVouchers = [
        { id: 'v1', code: 'FREE60' },
        { id: 'v2', code: 'PREMIUM' },
      ];
      // First query is the total count (deliberately run without the LATERAL
      // joins), second is the page of rows.
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [{ n: 2 }] })
        .mockResolvedValueOnce({ rows: fakeVouchers });

      const res = await request(createApp()).get('/api/admin/vouchers');

      expect(res.status).toBe(200);
      expect(res.body.vouchers).toEqual(fakeVouchers);
      expect(res.body.total).toBe(2);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(25);
    });

    it('narrows Staff to only the vouchers they sold', async () => {
      (requireAdminAuth as any).mockImplementation((_req: any, _res: any, next: any) => {
        _req.adminUser = { id: 'staff-1', email: 'staff@test', role: 'Staff', fullName: 'Staff' };
        next();
      });
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp()).get('/api/admin/vouchers');

      expect(res.status).toBe(200);
      const dataCall = (pool.query as any).mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('v.sold_by = $1')
      );
      expect(dataCall).toBeDefined();
      expect(dataCall[1][0]).toBe('staff-1');
    });
  });

  describe('GET /api/admin/dashboard/sales', () => {
    it('returns daily/weekly/monthly sales', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [{ amount: 100, count: 2 }] })
        .mockResolvedValueOnce({ rows: [{ amount: 500, count: 10 }] })
        .mockResolvedValueOnce({ rows: [{ amount: 2000, count: 40 }] })
        .mockResolvedValueOnce({ rows: [{ amount: 10000, count: 200 }] })
        .mockResolvedValueOnce({ rows: [{ sold_by_name: 'Alice', count: 5, total: 250 }] })
        .mockResolvedValueOnce({ rows: [{ voucher_code: 'V1', amount: 50, sold_by_name: 'Alice', sold_at: new Date().toISOString() }] });

      const res = await request(createApp()).get('/api/admin/dashboard/sales');

      expect(res.status).toBe(200);
      expect(res.body.daily.amount).toBe(100);
      expect(res.body.weekly.amount).toBe(500);
      expect(res.body.monthly.amount).toBe(2000);
      expect(res.body.total.amount).toBe(10000);
    });
  });

  describe('Staff time tracking', () => {
    it('POST /api/admin/clock-in creates a new log', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [] }) // no existing open log
        .mockResolvedValueOnce({ rows: [{ id: 1, admin_user_id: 'test', clock_in: new Date().toISOString() }] });

      const res = await request(createApp()).post('/api/admin/clock-in');

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(1);
    });

    it('POST /api/admin/clock-in returns 409 if already clocked in', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const res = await request(createApp()).post('/api/admin/clock-in');

      expect(res.status).toBe(409);
    });

    it('POST /api/admin/clock-out completes a log', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 1, clock_in: new Date(Date.now() - 3600000).toISOString() }] })
        .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
        .mockResolvedValueOnce({ rows: [{ id: 1, clock_out: new Date().toISOString(), duration_min: 60 }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp()).post('/api/admin/clock-out');

      expect(res.status).toBe(200);
      expect(res.body.duration_min).toBe(60);
    });

    it('POST /api/admin/clock-out returns 409 if not clocked in', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp()).post('/api/admin/clock-out');

      expect(res.status).toBe(409);
    });
  });

  describe('GET /api/admin/active-sessions', () => {
    it('returns active users with usage data and per-voucher breakdown', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [
          { id: 'u1', full_name: 'Alice', phone: '+263771111111', voucher_code: 'TEST01',
            mac_address: 'aa:bb:cc:dd:ee:ff', ip_address: '192.168.1.10',
            session_expires_at: new Date(Date.now() + 3600000).toISOString(),
            created_at: new Date().toISOString(),
            duration_min: 60, max_uses: 1, used_count: 1, data_limit_gb: 5, is_uncapped: false,
            bandwidth_mbps_up: 2, bandwidth_mbps_down: 5, voucher_price: 1.99,
            data_used_bytes: 1073741824, data_quota_bytes: 5368709120, session_start: new Date().toISOString() },
        ]})
        .mockResolvedValueOnce({ rows: [{ voucher_code: 'TEST01', connected_users: 1 }] })
        .mockResolvedValueOnce({ rows: [{ count: 1 }] })
        .mockResolvedValueOnce({ rows: [{ count: 5 }] });

      const res = await request(createApp()).get('/api/admin/active-sessions');

      expect(res.status).toBe(200);
      expect(res.body.totalActive).toBe(1);
      expect(res.body.totalRedeemed).toBe(5);
      expect(res.body.perVoucher).toHaveLength(1);
      expect(res.body.activeUsers).toHaveLength(1);
      expect(res.body.activeUsers[0].data_used_bytes).toBe(1073741824);
      expect(res.body.activeUsers[0].data_left_bytes).toBeGreaterThan(0);
      expect(res.body.activeUsers[0].usage_percent).toBe('20.0');
    });
  });
});
