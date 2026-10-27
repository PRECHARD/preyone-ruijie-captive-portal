import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { mockPoolQuery, mockClientQuery, mockClientRelease, mockPoolConnect } = vi.hoisted(() => {
  const mockPoolQuery = vi.fn();
  const mockClientQuery = vi.fn();
  const mockClientRelease = vi.fn();
  const mockPoolConnect = vi.fn();
  return { mockPoolQuery, mockClientQuery, mockClientRelease, mockPoolConnect };
});

// Ruijie Cloud is stubbed for the whole file: every staff sale mints or falls
// back to the pre-minted pool, and neither may touch the network in a unit test.
const ruijieMint = vi.hoisted(() => ({ configured: vi.fn(() => true), mint: vi.fn() }));

vi.mock('../src/services/ruijieMint', () => ({
  isRuijieCloudConfigured: ruijieMint.configured,
  findRuijieProfile: vi.fn(),
  mintRuijieVoucherForTier: ruijieMint.mint,
}));

vi.mock('../src/db/pool', () => ({
  pool: { query: mockPoolQuery, connect: mockPoolConnect },
}));

  vi.mock('../src/middleware/adminAuth', () => ({
    requireAdminAuth: vi.fn(),
    requireAdminAuthAllowLocked: vi.fn(),
    requireRole: () => vi.fn((_req: any, _res: any, next: any) => next()),
  }));

vi.mock('../src/middleware/rbac', () => ({
  PERMISSIONS: {
    SYSTEM_DEVELOPER: 'system.developer',
    COMPANY_ADMIN: 'company.admin',
    OPERATIONS_MANAGE: 'operations.manage',
    FINANCE_VIEW: 'finance.view',
    TRANSIT_FIELD_APP: 'transit.field_app',
    ROUTE_TEMPLATES_MANAGE: 'route.templates.manage',
  },
  requirePermission: () => vi.fn((_req: any, _res: any, next: any) => next()),
  scopeVoucherCondition: vi.fn(() => null),
  scopeUserVoucherCodeCondition: vi.fn(() => null),
  loadPermissions: vi.fn(() => Promise.resolve([])),
  FIELD_STAFF_ROLES: ['CONDUCTOR', 'DRIVER', 'TICKET_SELLER'],
}));

vi.mock('../src/routes/adminAuth', async () => {
  const actual: any = await vi.importActual('../src/routes/adminAuth');
  return { ...actual, recordAuditLog: vi.fn().mockResolvedValue(undefined) };
});

import { requireAdminAuth } from '../src/middleware/adminAuth';
import { adminRouter, __resetStaffMintThrottleForTests } from '../src/routes/admin';
import { RuijieApiError } from '../src/services/ruijieCloud';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

function mockAuth(user: { id: string; role: string; fullName: string }) {
  (requireAdminAuth as any).mockImplementation((_req: any, _res: any, next: any) => {
    _req.adminUser = { id: user.id, email: `${user.role}@test`, role: user.role, fullName: user.fullName };
    next();
  });
}

/** The literal the scope loader runs, so tests can assert the emitted SQL. */
const sqlOf = (call: unknown[]) => String((call as any[])[0]);
const paramsOf = (call: unknown[]) => (call as any[])[1] as unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does NOT drain a mockResolvedValueOnce queue, so a row queued
  // by one test would leak into the next and make it assert against stale data.
  mockPoolQuery.mockReset();
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockPoolConnect.mockReset();
  mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
  ruijieMint.configured.mockReturnValue(true);
  ruijieMint.mint.mockReset();
  __resetStaffMintThrottleForTests();
});

const VOUCHER_ROW = {
  id: 'v-1',
  code: 'ABC123',
  package_tier: 'PreLite',
  expires_at: null,
  is_disabled: false,
  deleted_at: null,
  used_count: 1,
  max_uses: 1,
};

describe('GET /api/admin/vouchers', () => {
  it('returns the paginated envelope the table expects', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ n: 57 }] })          // count
      .mockResolvedValueOnce({ rows: [{ id: 'v-1', status: 'Active' }] }); // page

    const res = await request(createApp()).get('/api/admin/vouchers');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 57, page: 1, pageSize: 25 });
    expect(Array.isArray(res.body.vouchers)).toBe(true);
  });

  it('excludes soft-deleted vouchers', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(createApp()).get('/api/admin/vouchers');

    expect(sqlOf(mockPoolQuery.mock.calls[0])).toContain('v.deleted_at IS NULL');
  });

  it('joins the derived status view rather than reading a stored column', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(createApp()).get('/api/admin/vouchers');

    const dataSql = sqlOf(mockPoolQuery.mock.calls[1]);
    expect(dataSql).toContain('voucher_status vs');
    expect(dataSql).toContain('vs.status');
  });

  it('scopes Staff to only the vouchers they sold', async () => {
    mockAuth({ id: 'staff-9', role: 'Staff', fullName: 'Staff Jane' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(createApp()).get('/api/admin/vouchers');

    const countSql = sqlOf(mockPoolQuery.mock.calls[0]);
    expect(countSql).toContain('v.sold_by = $1');
    expect(paramsOf(mockPoolQuery.mock.calls[0])).toEqual(['staff-9']);
  });

  it('does not scope Manager or CEO', async () => {
    mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager Mike' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(createApp()).get('/api/admin/vouchers');

    expect(sqlOf(mockPoolQuery.mock.calls[0])).not.toContain('v.sold_by');
  });

  it('lowercases the search term and matches on code', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(createApp()).get('/api/admin/vouchers?search=AbC');

    const countSql = sqlOf(mockPoolQuery.mock.calls[0]);
    expect(countSql).toContain('lower(v.code) LIKE');
    expect(paramsOf(mockPoolQuery.mock.calls[0])).toContain('%abc%');
  });

  it('ignores an unrecognised status filter instead of erroring', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).get('/api/admin/vouchers?status=%27%3B+DROP+TABLE+vouchers%3B--');

    expect(res.status).toBe(200);
    expect(sqlOf(mockPoolQuery.mock.calls[0])).not.toContain('vs.status =');
  });

  it('rejects a sort key that is not on the whitelist', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).get('/api/admin/vouchers?sort=deleted_at&dir=asc');

    expect(res.status).toBe(200);
    const dataSql = sqlOf(mockPoolQuery.mock.calls[1]);
    expect(dataSql).toContain('ORDER BY v.created_at ASC');
    expect(dataSql).not.toContain('ORDER BY v.deleted_at');
  });

  it('clamps pageSize and page into safe bounds', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).get('/api/admin/vouchers?pageSize=99999&page=-4');

    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(200);
  });

  it('computes quota bytes on a binary base to match enforcement', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(createApp()).get('/api/admin/vouchers');

    expect(sqlOf(mockPoolQuery.mock.calls[1])).toContain('1073741824');
  });
});

describe('POST /api/admin/vouchers/:id/disable', () => {
  it('disables by default and flips the stored flag', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [VOUCHER_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'ABC123', is_disabled: true }] });

    const res = await request(createApp()).post('/api/admin/vouchers/v-1/disable').send({});

    expect(res.status).toBe(200);
    expect(res.body.is_disabled).toBe(true);
    const updateSql = sqlOf(mockPoolQuery.mock.calls[1]);
    expect(updateSql).toContain('SET is_disabled = $1');
    expect(paramsOf(mockPoolQuery.mock.calls[1])[0]).toBe(true);
  });

  it('re-enables when disabled is explicitly false', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [VOUCHER_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'ABC123', is_disabled: false }] });

    const res = await request(createApp()).post('/api/admin/vouchers/v-1/disable').send({ disabled: false });

    expect(res.body.is_disabled).toBe(false);
    expect(paramsOf(mockPoolQuery.mock.calls[1])[0]).toBe(false);
  });

  it('404s for an unknown voucher', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).post('/api/admin/vouchers/nope/disable').send({});

    expect(res.status).toBe(404);
  });

  it('will not let Staff touch a voucher they did not sell', async () => {
    mockAuth({ id: 'staff-9', role: 'Staff', fullName: 'Staff Jane' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).post('/api/admin/vouchers/v-1/disable').send({});

    expect(res.status).toBe(404);
    expect(sqlOf(mockPoolQuery.mock.calls[0])).toContain('v.sold_by = $2');
  });
});

describe('POST /api/admin/vouchers/:id/extend', () => {
  it('extends the code shelf life from now when expires_at is NULL', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...VOUCHER_ROW, expires_at: null }] });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ id: 'v-1', code: 'ABC123', expires_at: '2026-01-01' }], rowCount: 1 });
    });

    const res = await request(createApp())
      .post('/api/admin/vouchers/v-1/extend')
      .send({ minutes: 1440 });

    expect(res.status).toBe(200);
    const updateSql = String(mockClientQuery.mock.calls.find((c: any) => String(c[0]).includes('COALESCE(expires_at'))?.[0]);
    expect(updateSql).toContain('COALESCE(expires_at, NOW())');
  });

  it('casts the interval parameter to text so integer || text never runs', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [VOUCHER_ROW] });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ id: 'v-1', code: 'ABC123', expires_at: '2026-01-01' }], rowCount: 1 });
    });

    await request(createApp()).post('/api/admin/vouchers/v-1/extend').send({ minutes: 60 });

    const intervalSql = mockClientQuery.mock.calls
      .map((c: any) => String(c[0]))
      .filter((s: string) => s.includes('::interval'));
    expect(intervalSql.length).toBeGreaterThan(0);
    for (const sql of intervalSql) {
      expect(sql).toContain('$1::text');
    }
  });

  it('only touches subscriber sessions when explicitly asked', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [VOUCHER_ROW] });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      if (String(sql).includes('UPDATE users')) return Promise.resolve({ rows: [{ id: 'u-1' }], rowCount: 1 });
      return Promise.resolve({ rows: [{ id: 'v-1', code: 'ABC123', expires_at: '2026-01-01' }], rowCount: 1 });
    });

    const res = await request(createApp())
      .post('/api/admin/vouchers/v-1/extend')
      .send({ minutes: 60, extendSessions: true });

    expect(res.status).toBe(200);
    expect(res.body.sessions_extended).toBe(1);
    const touchedUsers = mockClientQuery.mock.calls.filter((c: any) => String(c[0]).includes('UPDATE users'));
    expect(touchedUsers).toHaveLength(1);
  });

  it('skips the session update entirely when extendSessions is absent', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [VOUCHER_ROW] });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ id: 'v-1', code: 'ABC123', expires_at: '2026-01-01' }], rowCount: 1 });
    });

    const res = await request(createApp()).post('/api/admin/vouchers/v-1/extend').send({ minutes: 60 });

    expect(res.body.sessions_extended).toBe(0);
    expect(mockClientQuery.mock.calls.filter((c: any) => String(c[0]).includes('UPDATE users'))).toHaveLength(0);
  });

  it('rejects a non-positive or non-numeric duration', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [VOUCHER_ROW] });

    for (const body of [{ minutes: 0 }, { minutes: -5 }, { minutes: 'abc' }, {}]) {
      mockPoolQuery.mockClear();
      mockPoolQuery.mockResolvedValueOnce({ rows: [VOUCHER_ROW] });
      const res = await request(createApp()).post('/api/admin/vouchers/v-1/extend').send(body);
      expect(res.status).toBe(422);
    }
  });

  it('caps an absurd duration at one year', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [VOUCHER_ROW] });

    const res = await request(createApp())
      .post('/api/admin/vouchers/v-1/extend')
      .send({ minutes: 99999999 });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('525600');
  });

  it('rolls back when the update throws', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [VOUCHER_ROW] });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (String(sql).includes('UPDATE vouchers')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] });
    });

    const res = await request(createApp()).post('/api/admin/vouchers/v-1/extend').send({ minutes: 60 });

    expect(res.status).toBe(500);
    expect(mockClientQuery.mock.calls.some((c: any) => String(c[0]) === 'ROLLBACK')).toBe(true);
  });
});

describe('POST /api/admin/vouchers/:id/reset-mac', () => {
  it('deactivates active bindings instead of deleting the audit rows', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [VOUCHER_ROW] })
      .mockResolvedValueOnce({ rows: [{ mac_address: 'AABBCCDDEEFF' }, { mac_address: '112233445566' }] });

    const res = await request(createApp()).post('/api/admin/vouchers/v-1/reset-mac');

    expect(res.status).toBe(200);
    expect(res.body.released).toBe(2);
    const sql = sqlOf(mockPoolQuery.mock.calls[1]);
    expect(sql).toContain('SET is_active = FALSE');
    expect(sql).toContain('unbound_at = NOW()');
    expect(sql).not.toContain('DELETE FROM');
  });

  it('is a no-op when nothing is bound', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [VOUCHER_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).post('/api/admin/vouchers/v-1/reset-mac');

    expect(res.body.released).toBe(0);
  });
});

describe('DELETE /api/admin/vouchers/:id', () => {
  it('soft deletes rather than cascading away the redemption trail', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [VOUCHER_ROW] })
      .mockResolvedValueOnce({ rows: [{ code: 'ABC123' }] });

    const res = await request(createApp()).delete('/api/admin/vouchers/v-1');

    expect(res.status).toBe(200);
    const sql = sqlOf(mockPoolQuery.mock.calls[1]);
    expect(sql).toContain('SET deleted_at = NOW()');
    expect(sql).toContain('is_disabled = TRUE');
    expect(sql).not.toMatch(/DELETE\s+FROM\s+vouchers/i);
  });

  it('404s on a second delete because the row is already tombstoned', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).delete('/api/admin/vouchers/v-1');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/vouchers/:id/renew', () => {
  const RENEW_ROW = { ...VOUCHER_ROW, price_amount: '4.99', duration_min: 720, expires_at: null };
  const PACKAGE_ROW = {
    tier_name: 'PreMax',
    duration_min: 1440,
    data_limit_gb: 20,
    is_uncapped: false,
    bandwidth_mbps_up: 10,
    bandwidth_mbps_down: 20,
    max_devices: 5,
  };

  /**
   * Drives the renew transaction: BEGIN → UPDATE vouchers → INSERT sales → COMMIT.
   * `packageRow` also queues the tier lookup that runs before BEGIN: omit it for
   * the plain renewal path, pass null for a package that does not exist.
   */
  function seedTransaction(packageRow?: typeof PACKAGE_ROW | null) {
    mockPoolQuery.mockResolvedValueOnce({ rows: [RENEW_ROW] });
    if (packageRow !== undefined) {
      mockPoolQuery.mockResolvedValueOnce({ rows: packageRow ? [packageRow] : [] });
    }
    mockClientQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s === 'BEGIN' || s === 'COMMIT') return Promise.resolve({ rows: [], rowCount: 0 });
      if (s.includes('INSERT INTO sales')) {
        return Promise.resolve({
          rows: [{ id: 'sale-1', amount: 4.99, currency: 'USD', sale_type: 'renewal', sold_at: '2026-10-14T00:00:00Z' }],
          rowCount: 1,
        });
      }
      if (s.includes('UPDATE vouchers')) {
        return Promise.resolve({
          rows: [{ id: 'v-1', code: 'ABC123', expires_at: '2026-11-14', used_count: 0, max_uses: 1, price_amount: '4.99', duration_min: 720, is_disabled: false }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  }

  const saleInsert = () =>
    mockClientQuery.mock.calls.map(c => String(c[0])).find(s => s.includes('INSERT INTO sales')) ?? '';
  const voucherUpdate = () =>
    mockClientQuery.mock.calls.map(c => String(c[0])).find(s => s.includes('UPDATE vouchers')) ?? '';

  it('re-arms the code AND books the resale so the revenue cannot slip', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    seedTransaction();

    const res = await request(createApp())
      .post('/api/admin/vouchers/v-1/renew')
      .send({ durationMin: 720, priceAmount: 4.99, paymentMethod: 'EcoCash' });

    expect(res.status).toBe(201);
    expect(res.body.renewed).toBe(true);
    expect(res.body.sale.sale_type).toBe('renewal');

    // The resale lands in `sales`, which every revenue report reads from.
    expect(saleInsert()).toContain('INSERT INTO sales');
    expect(saleInsert()).toContain("'renewal'");
    // amount is $5 of the INSERT's parameter list.
    expect(paramsOf(mockClientQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO sales'))!)[4]).toBe(4.99);
  });

  it('clears used_count and expiry so a spent/expired PIN is redeemable again', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    seedTransaction();

    await request(createApp()).post('/api/admin/vouchers/v-1/renew').send({ priceAmount: 4.99 });

    const sql = voucherUpdate();
    expect(sql).toMatch(/used_count\s*=\s*0/);
    expect(sql).toContain('is_disabled    = FALSE');
    // Renewing early must add on top of the current expiry, never clobber it.
    expect(sql).toContain('GREATEST(NOW(), COALESCE(expires_at, NOW()))');
    expect(sql).toContain('$1::text');
    // No durationMin in the body → falls back to the voucher's own duration_min.
    expect(paramsOf(mockClientQuery.mock.calls.find(c => String(c[0]).includes('UPDATE vouchers'))!)[0]).toBe(720);
  });

  it('resets the data quota by default and leaves it alone when told not to', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    seedTransaction();
    await request(createApp()).post('/api/admin/vouchers/v-1/renew').send({ priceAmount: 4.99 });
    const withReset = paramsOf(mockClientQuery.mock.calls.find(c => String(c[0]).includes('UPDATE vouchers'))!);
    expect(withReset[1]).toBe(true);

    vi.clearAllMocks();
    mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    seedTransaction();
    await request(createApp())
      .post('/api/admin/vouchers/v-1/renew')
      .send({ priceAmount: 4.99, resetDataQuota: false });
    const withoutReset = paramsOf(mockClientQuery.mock.calls.find(c => String(c[0]).includes('UPDATE vouchers'))!);
    expect(withoutReset[1]).toBe(false);
  });

  it('refuses a non-positive amount so a renewal can never book nothing', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });

    for (const body of [{ priceAmount: 0 }, { priceAmount: -5 }, { priceAmount: 'abc' }]) {
      mockPoolQuery.mockReset();
      mockPoolQuery.mockResolvedValueOnce({ rows: [RENEW_ROW] });
      const res = await request(createApp()).post('/api/admin/vouchers/v-1/renew').send(body);
      expect(res.status).toBe(422);
      // Rejected before BEGIN, so no voucher was touched and no sale booked.
      expect(mockClientQuery).not.toHaveBeenCalled();
    }
  });

  it('defaults the amount from the voucher so a renewal still books a sale', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    seedTransaction();

    const res = await request(createApp()).post('/api/admin/vouchers/v-1/renew').send({});

    expect(res.status).toBe(201);
    expect(res.body.sale.sale_type).toBe('renewal');
    const insert = mockClientQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO sales'))!;
    expect(paramsOf(insert)[4]).toBe(4.99);
  });

  it('rejects a non-positive or absurd duration', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });

    for (const body of [{ durationMin: 0 }, { durationMin: -5 }, { durationMin: 'abc' }, { durationMin: 9999999 }]) {
      mockPoolQuery.mockReset();
      mockPoolQuery.mockResolvedValueOnce({ rows: [RENEW_ROW] });
      const res = await request(createApp())
        .post('/api/admin/vouchers/v-1/renew')
        .send({ ...body, priceAmount: 4.99 });
      expect(res.status).toBe(422);
      expect(mockClientQuery).not.toHaveBeenCalled();
    }
  });

  it('404s for an unknown voucher and scopes Staff to their own sales', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect((await request(createApp()).post('/api/admin/vouchers/nope/renew').send({ priceAmount: 1 })).status).toBe(404);

    mockAuth({ id: 'staff-9', role: 'Staff', fullName: 'Staff Jane' });
    mockPoolQuery.mockClear();
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp()).post('/api/admin/vouchers/v-1/renew').send({ priceAmount: 1 });
    expect(res.status).toBe(404);
    expect(sqlOf(mockPoolQuery.mock.calls[0])).toContain('v.sold_by = $2');
  });

  it('copies the selected package speed, quota, validity and device cap onto the voucher', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    seedTransaction(PACKAGE_ROW);

    const res = await request(createApp())
      .post('/api/admin/vouchers/v-1/renew')
      .send({ priceAmount: 9.99, packageTier: 'PreMax' });

    expect(res.status).toBe(201);
    expect(res.body.package_swapped).toBe('PreMax');

    // The tier resolves through `packages`, the same lookup creation uses.
    const lookup = mockPoolQuery.mock.calls[1];
    expect(sqlOf(lookup)).toContain('FROM packages WHERE tier_name = $1');
    expect(sqlOf(lookup)).toContain('deleted_at IS NULL');
    expect(paramsOf(lookup)).toEqual(['PreMax']);

    const update = mockClientQuery.mock.calls.find(c => String(c[0]).includes('UPDATE vouchers'))!;
    // RETURNING always echoes these columns, so scope the check to what SET assigns.
    const set = sqlOf(update).slice(sqlOf(update).indexOf('SET'), sqlOf(update).indexOf('WHERE'));
    for (const col of ['package_tier', 'duration_min', 'data_limit_gb', 'is_uncapped',
                       'bandwidth_mbps_up', 'bandwidth_mbps_down', 'max_devices', 'price_amount']) {
      expect(set).toContain(col);
    }

    const p = paramsOf(update);
    // No durationMin in the body → the new tier's validity is what gets granted
    // ($1 for the interval) and what is stored as the voucher's duration_min ($5).
    expect(p[0]).toBe(1440);
    expect(p[2]).toBe('v-1');
    expect(p[3]).toBe('PreMax');
    expect(p[4]).toBe(1440);
    expect(p[5]).toBe(20);
    expect(p[6]).toBe(false);
    expect(p[7]).toBe(10);
    expect(p[8]).toBe(20);
    expect(p[9]).toBe(5);
    expect(p[10]).toBe(9.99);
  });

  it('422s an unknown package before the voucher or the sale is touched', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    seedTransaction(null);

    const res = await request(createApp())
      .post('/api/admin/vouchers/v-1/renew')
      .send({ priceAmount: 4.99, packageTier: 'Nope' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Package not found');
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('leaves every package column alone when no tier is supplied', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    seedTransaction();

    const res = await request(createApp())
      .post('/api/admin/vouchers/v-1/renew')
      .send({ priceAmount: 4.99 });

    expect(res.status).toBe(201);
    expect(res.body.package_swapped).toBeNull();
    const sql = voucherUpdate();
    // RETURNING still echoes the package columns; SET must not assign any of them.
    const set = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'));
    expect(set).not.toContain('package_tier');
    expect(set).not.toContain('bandwidth_mbps_up');
    expect(set).not.toContain('data_limit_gb');
    expect(set).not.toContain('price_amount');
    // Only the voucher load ran — no package lookup at all.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression guard: the prompts these routes came from asked for a stored
 * `status` column and a `/wispr/login` callback. Both would be regressions —
 * see AGENTS.md — so pin the decisions here.
 */
describe('POST /api/admin/vouchers while Ruijie is throttling', () => {
  const PKG_ROW = {
    tier_name: 'PreLite',
    display_name: 'PreLite',
    duration_min: 1440,
    data_limit_gb: 1,
    is_uncapped: false,
    bandwidth_mbps_up: 2,
    bandwidth_mbps_down: 5,
    max_devices: 1,
  };

  const throttle = () =>
    new RuijieApiError(44, 'voucher/create (groupId=9624342) -> HTTP 200: Too many requests.');

  it('sells a pre-minted pool voucher instead of failing the sale', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    ruijieMint.mint.mockRejectedValueOnce(throttle());
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [PKG_ROW] }) // package lookup
      .mockResolvedValueOnce({                              // pool claim
        rows: [{
          code_no: 'pooled123',
          tier_name: 'PreLite',
          user_group_id: 'grp-1',
          profile_uuid: 'prof-1',
          ruijie_expiry: '1798761600000',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'v-9', code: 'pooled123', package_tier: 'PreLite' }] }) // vouchers insert
      .mockResolvedValueOnce({ rows: [] }); // ruijie_vouchers audit insert (conflicts, no-op)

    const res = await request(createApp())
      .post('/api/admin/vouchers')
      .send({ code: 'typed-by-staff', packageTier: 'PreLite' });

    expect(res.status).toBe(201);
    // The customer gets the real Ruijie PIN from stock, never the typed value.
    expect(res.body.code).toBe('pooled123');
    const claim = mockPoolQuery.mock.calls.find(([sql]) => String(sql).includes("source = 'staff'"));
    expect(claim).toBeTruthy();
    expect((claim as any[])[1]).toEqual(['PreLite', 'Staff sale by Boss']);
  });

  it('answers 429 with retryable:true when the pool is empty too', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    ruijieMint.mint.mockRejectedValueOnce(throttle());
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [PKG_ROW] }) // package lookup
      .mockResolvedValueOnce({ rows: [] });       // nothing pre-minted left

    const res = await request(createApp())
      .post('/api/admin/vouchers')
      .send({ code: 'typed', packageTier: 'PreLite' });

    expect(res.status).toBe(429);
    expect(res.body.retryable).toBe(true);
    expect(res.body.error).toMatch(/nothing was sold/i);
  });

  it('reports a real Ruijie failure with its message, not "Internal server error"', async () => {
    mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'Boss' });
    ruijieMint.mint.mockRejectedValueOnce(
      new RuijieApiError('unmapped_tier', "Package tier 'PreLite' has no active Ruijie Cloud profile mapping")
    );
    mockPoolQuery.mockResolvedValueOnce({ rows: [PKG_ROW] });

    const res = await request(createApp())
      .post('/api/admin/vouchers')
      .send({ code: 'typed', packageTier: 'PreLite' });

    expect(res.status).toBe(502);
    expect(res.body.retryable).toBe(false);
    expect(res.body.error).toMatch(/no active Ruijie Cloud profile mapping/);
  });
});

/**
 * Regression guard: the prompts these routes came from asked for a stored
 * `status` column and a `/wispr/login` callback. Both would be regressions —
 * see AGENTS.md — so pin the decisions here.
 */
describe('design invariants', () => {
  const adminSrc = readFileSync(resolve(__dirname, '../src/routes/admin.ts'), 'utf8');

  it('never introduces a /wispr/login callback', () => {
    expect(adminSrc).not.toContain('/wispr/login');
  });

  it('keeps the protected buildRuijieSuccessUrl flow untouched in auth.ts', () => {
    const authSrc = readFileSync(resolve(__dirname, '../src/routes/auth.ts'), 'utf8');
    expect(authSrc).toContain('buildRuijieSuccessUrl');
    // The signup handler must keep reading gateway params from req.query.
    expect(authSrc).toMatch(/req\.query\.client_mac/);
  });
});