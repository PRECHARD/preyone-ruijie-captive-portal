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

vi.mock('../src/db/pool', () => ({
  pool: { query: mockPoolQuery, connect: mockPoolConnect },
}));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: vi.fn(),
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
import { adminRouter } from '../src/routes/admin';

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