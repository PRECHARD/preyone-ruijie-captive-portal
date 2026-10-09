import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/db/pool', () => ({ pool: { query: vi.fn() } }));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: vi.fn((_req: any, _res: any, next: any) => {
    (_req as any).adminUser = { id: 'test', email: 'test@test', role: 'CEO', fullName: 'Test' };
    next();
  }),
  requireRole: () => vi.fn((_req: any, _res: any, next: any) => next()),
}));

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
import { adminRouter } from '../src/routes/admin';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

describe('GET /api/admin/dashboard/wifi (UltraNet sector aggregate)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns AP/gateway/client/voucher/connection state in the sector shape', async () => {
    const calls: { sql: string }[] = [];
    (pool.query as any).mockImplementation(async (sql: string) => {
      calls.push({ sql });
      return { rows: [] };
    });

    const res = await request(createApp()).get('/api/admin/dashboard/wifi');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      aps: { total: 0, online: 0, offline: 0, clients: 0, gateways: { total: 0, online: 0, byModel: [] } },
      apsList: [],
      clients: [],
      vouchers: {
        activeSessions: 0, activeVouchers: 0, redeemedToday: 0, createdToday: 0,
        pendingApprovals: 0, connectionsToday: 0, signupsToday: 0, authSuccessRate: 0,
      },
      connectionLog: [],
      voucherUsage: [],
    });
    expect(calls).toHaveLength(6);
  });

  it('reads only wifi-sector tables (no transit/POS references) and surfaces user_agent', async () => {
    (pool.query as any).mockResolvedValue({ rows: [] });

    await request(createApp()).get('/api/admin/dashboard/wifi');

    const allSql = (vi.mocked(pool.query).mock.calls.map((c) => c[0]) as string[]).join('\n');
    expect(allSql).toContain('ap_devices');
    expect(allSql).toContain('gateway_heartbeats');
    expect(allSql).toContain('wispr_profiles');
    expect(allSql).toContain('voucher_redemptions');
    expect(allSql).toContain('access_log');
    expect(allSql).toContain('user_agent');
    expect(allSql).toContain('voucher_approvals');
    expect(allSql).toMatch(/voucher_redemptions vr/);
    expect(allSql).toMatch(/LEFT JOIN vouchers v ON v.id = vr.voucher_id/);
    expect(allSql).not.toMatch(/transit_|pos_/);
  });

  it('computes a redemption success rate from the daily counters', async () => {
    const apRows = [{ id: 'a1', name: 'RP1', model: 'EG105G-P', status: 'online', clients_count: 3 }];
    let i = 0;
    (pool.query as any).mockImplementation(async () => {
      i += 1;
      if (i === 1) return { rows: apRows };
      if (i === 2) return { rows: [{ dev_model: 'EG105G-P', online: 1, total: 2 }] };
      if (i === 3) return { rows: [{ user_agent: 'Mozilla/5.0 (iPhone)' }] };
      if (i === 4) return { rows: [{ active_sessions: 50, active_vouchers: 40, redeemed_today: 40, created_today: 10, pending_approvals: 2, connections_today: 80, signups_today: 12 }] };
      return { rows: [] };
    });

    const res = await request(createApp()).get('/api/admin/dashboard/wifi');

    expect(res.status).toBe(200);
    expect(res.body.vouchers.authSuccessRate).toBe(50);
    expect(res.body.aps.total).toBe(1);
    expect(res.body.aps.clients).toBe(3);
  });
});