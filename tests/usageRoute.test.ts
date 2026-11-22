import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../src/db/pool', () => ({
  pool: { query: mockQuery },
}));

// Keep the route on its local-DB path so the tests never reach Ruijie.
vi.mock('../src/services/ruijieCloud', () => ({
  isRuijieCloudConfigured: () => false,
}));
vi.mock('../src/services/ruijieService', () => ({
  fetchRuijieAccountingRecords: vi.fn(async () => []),
}));
vi.mock('../src/services/ruijieSessionCache', () => ({
  getRuijieSessionSnapshot: vi.fn(async () => ({ users: [] })),
}));
vi.mock('../src/services/ruijieRoster', () => ({
  getRuijieRoster: vi.fn(async () => ({ vouchers: [], fetchedAt: null, stale: false })),
}));

import { usageRouter, __resetUsageCachesForTests } from '../src/routes/usage';

function createApp() {
  const app = express();
  app.use('/api/check-usage', usageRouter);
  return app;
}

const soldRow = {
  code: 'k47nfu',
  package_tier: 'PreLite',
  data_consumed_mb: null,
  data_limit_gb: '5.00',
  is_uncapped: false,
  expires_at: null,
  activated_at: null,
  duration_min: 1440,
  used_count: 0,
  max_uses: 1,
  bound_devices: 0,
};

describe('GET /api/check-usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetUsageCachesForTests();
  });

  it('shows a sold voucher that has not been activated yet', async () => {
    mockQuery.mockResolvedValue({ rows: [soldRow] });

    const res = await request(createApp()).get('/api/check-usage?voucher=k47nfu');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      active: true,
      voucherCode: 'k47nfu',
      packageTier: 'PreLite',
      totalMB: 5120,
    });
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('treats a sold/unactivated voucher as customer-visible in SQL', async () => {
    mockQuery.mockResolvedValue({ rows: [soldRow] });

    await request(createApp()).get('/api/check-usage?voucher=k47nfu');

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('v.used_count > 0');
    expect(sql).toContain('v.sold_by IS NOT NULL');
    expect(sql).toContain('EXISTS (SELECT 1 FROM sales s WHERE s.voucher_code = v.code)');
  });

  it('ignores a malformed MAC instead of rejecting a valid PIN', async () => {
    mockQuery.mockResolvedValue({ rows: [soldRow] });

    const res = await request(createApp()).get('/api/check-usage?voucher=k47nfu&mac=H');

    expect(res.status).toBe(200);
    expect(res.body.voucherCode).toBe('k47nfu');
  });

  it('still requires a PIN or session token', async () => {
    const res = await request(createApp()).get('/api/check-usage?mac=H');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_credentials');
  });

  it('keeps unknown/unsold codes at a uniform 404', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await request(createApp()).get('/api/check-usage?voucher=zzzzzz');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('reports an uncapped plan as unlimited with no invented total', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        ...soldRow,
        code: 'x3n6zr',
        package_tier: 'PreCore',
        data_consumed_mb: '19108.00',
        data_limit_gb: null,
        is_uncapped: true,
      }],
    });

    const res = await request(createApp()).get('/api/check-usage?voucher=x3n6zr');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isUncapped: true,
      unlimited: true,
      totalMB: null,
      bytesTotal: null,
      remainingMB: null,
      percentUsed: null,
      dataLimitGb: null,
    });
    // Usage itself is still reported — only the balance is unlimited.
    expect(res.body.bytesUsed).toBe(19108 * 1048576);
  });
});

describe('GET /api/check-usage/history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetUsageCachesForTests();
  });

  it('requires the voucher PIN', async () => {
    const res = await request(createApp()).get('/api/check-usage/history');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_credentials');
  });

  it('returns the PIN owner’s sessions and alerts with masked devices', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM voucher_redemptions')) {
        return Promise.resolve({
          rows: [{ created_at: '2026-11-20T10:00:00.000Z', mac_address: 'AABBCCDDEEFF' }],
        });
      }
      if (String(sql).includes('FROM voucher_alert_events')) {
        return Promise.resolve({
          rows: [{ tier: 95, pct: 95, used_mb: 950, total_mb: 1000, created_at: '2026-11-20T11:00:00.000Z' }],
        });
      }
      return Promise.resolve({
        rows: [{
          id: '11111111-1111-1111-1111-111111111111',
          code: 'k47nfu',
          package_tier: 'PreFlow',
          is_uncapped: false,
          activated_at: '2026-11-20T09:00:00.000Z',
          expires_at: null,
          data_limit_gb: '40.00',
        }],
      });
    });

    const res = await request(createApp()).get('/api/check-usage/history?voucher=k47nfu');

    expect(res.status).toBe(200);
    expect(res.body.voucher).toMatchObject({ code: 'k47nfu', unlimited: false, dataLimitGb: '40.00' });
    expect(res.body.sessions).toEqual([
      { at: '2026-11-20T10:00:00.000Z', device: '•••• EEFF' },
    ]);
    expect(res.body.alerts[0]).toMatchObject({ tier: 95, usedMB: 950, totalMB: 1000 });
    // Never leak the full MAC, an IP or a name.
    expect(JSON.stringify(res.body)).not.toContain('AABBCCDDEEFF');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('never reveals why a PIN is not entitled to records', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await request(createApp()).get('/api/check-usage/history?voucher=zzzzzz');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('nulls the limit for an uncapped voucher', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM voucher_redemptions') || String(sql).includes('FROM voucher_alert_events')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({
        rows: [{
          id: '22222222-2222-2222-2222-222222222222',
          code: 'x3n6zr',
          package_tier: 'PreCore',
          is_uncapped: true,
          activated_at: '2026-11-20T09:00:00.000Z',
          expires_at: null,
          data_limit_gb: null,
        }],
      });
    });

    const res = await request(createApp()).get('/api/check-usage/history?voucher=x3n6zr');
    expect(res.status).toBe(200);
    expect(res.body.voucher).toMatchObject({ isUncapped: true, unlimited: true, dataLimitGb: null });
  });
});
