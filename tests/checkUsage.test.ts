import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  listRuijieOnlineUsers: vi.fn(),
  fetchRuijieAccountingRecords: vi.fn(),
  isRuijieCloudConfigured: vi.fn(() => true),
  getAllRuijieVouchers: vi.fn(async (): Promise<any[]> => []),
}));

vi.mock('../src/db/pool', () => ({ pool: { query: mocks.query } }));
vi.mock('../src/services/ruijieService', () => ({
  listRuijieOnlineUsers: mocks.listRuijieOnlineUsers,
  fetchRuijieAccountingRecords: mocks.fetchRuijieAccountingRecords,
}));
vi.mock('../src/services/ruijieCloud', () => ({
  isRuijieCloudConfigured: mocks.isRuijieCloudConfigured,
  getAllRuijieVouchers: mocks.getAllRuijieVouchers,
}));

import { usageRouter, __resetUsageCachesForTests } from '../src/routes/usage';

const app = express();
app.use('/api/check-usage', usageRouter);

const HOUR = 3600 * 1000;
const MB = 1048576;

function localRow(overrides: Record<string, unknown> = {}) {
  return {
    code: 'abc123',
    package_tier: 'PreFam',
    data_consumed_mb: null,
    data_limit_gb: 5,
    is_uncapped: false,
    expires_at: new Date(Date.now() + HOUR),
    activated_at: new Date(Date.now() - HOUR),
    duration_min: 1440,
    used_count: 1,
    max_uses: 3,
    bound_devices: 0,
    ...overrides,
  };
}

function ruijieVoucher(overrides: Record<string, unknown> = {}) {
  return {
    codeNo: 'ABC123',
    voucherCode: 'abc123',
    quotaMb: 5120,
    usedQuotaMb: 500,
    usedTimeMin: 60,
    timePeriodMin: 1440,
    loginTime: Date.now() - HOUR,
    currentClients: 1,
    maxClients: 1,
    packageName: 'preLite_Daily',
    disableStatus: 0,
    expiryTime: Date.now() + 24 * HOUR,
    ...overrides,
  };
}

/**
 * /api/check-usage — the PIN-first bundle balance behind wifi.preyone.com/data.
 *
 * The behaviour under test is the 2026-10-15 change: Ruijie's own
 * per-voucher counters (quota/usedQuota keyed by CODE) are consulted first,
 * which is what lets a customer check their balance with only the voucher PIN
 * while the portal is absent from the auth path and no MAC binding exists
 * locally — plus the Ruijie-only fallback for codes our DB has never seen,
 * gated on real customer activity so unsold stock stays unprobeable.
 */
describe('GET /api/check-usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetUsageCachesForTests();
    mocks.isRuijieCloudConfigured.mockReturnValue(true);
    mocks.getAllRuijieVouchers.mockResolvedValue([]);
    mocks.listRuijieOnlineUsers.mockResolvedValue([]);
    mocks.fetchRuijieAccountingRecords.mockResolvedValue([]);
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it('rejects a request with no credentials at all', async () => {
    const res = await request(app).get('/api/check-usage');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'missing_credentials' });
  });

  it('rejects a malformed MAC before touching anything else', async () => {
    const res = await request(app)
      .get('/api/check-usage')
      .query({ voucher: 'abc123', mac: 'not-a-mac' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_mac' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('answers a PIN-only lookup from Ruijie per-voucher counters and caches the roster', async () => {
    mocks.query.mockResolvedValue({
      rows: [localRow({ package_tier: null })],
    });
    mocks.getAllRuijieVouchers.mockResolvedValue([
      ruijieVoucher({ usedQuotaMb: 1089, usedTimeMin: 60, currentClients: 1 }),
    ]);

    const res = await request(app).get('/api/check-usage').query({ voucher: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.usageSource).toBe('ruijie_voucher');
    expect(res.body.usedMB).toBe(1089);
    expect(res.body.totalMB).toBe(5120);
    expect(res.body.bytesUsed).toBe(1089 * MB);
    expect(res.body.bytesTotal).toBe(5120 * MB);
    expect(res.body.percentUsed).toBe(21.3);
    expect(res.body.remainingMB).toBe(4031);
    expect(res.body.onlineNow).toBe(true);
    // local package_tier is NULL, so Ruijie's own package name fills the gap
    expect(res.body.packageTier).toBe('preLite_Daily');

    // the PWA polls every 15s — the roster must be reused inside the TTL
    const res2 = await request(app).get('/api/check-usage').query({ voucher: 'abc123' });
    expect(res2.status).toBe(200);
    expect(mocks.getAllRuijieVouchers).toHaveBeenCalledTimes(1);
  });

  it('never downgrades a known figure when Ruijie reports zero (sources merge by MAX)', async () => {
    mocks.query.mockResolvedValue({
      rows: [localRow({ data_consumed_mb: '888.8' })],
    });
    mocks.getAllRuijieVouchers.mockResolvedValue([
      ruijieVoucher({ usedQuotaMb: 0 }),
    ]);

    const res = await request(app).get('/api/check-usage').query({ voucher: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.usageSource).toBe('voucher_accounting');
    expect(res.body.usedMB).toBeCloseTo(888.8, 5);
  });

  it('falls back to the reconciled column when the Ruijie roster cannot be fetched', async () => {
    mocks.query.mockResolvedValue({
      rows: [localRow({ data_consumed_mb: '123.4' })],
    });
    mocks.getAllRuijieVouchers.mockRejectedValue(new Error('ruijie down'));

    const res = await request(app).get('/api/check-usage').query({ voucher: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.usageSource).toBe('voucher_accounting');
    expect(res.body.usedMB).toBeCloseTo(123.4, 5);
    // no roster, no voucher counters — the online signal stays unknown
    expect(res.body.onlineNow).toBeNull();
  });

  it('skips Ruijie entirely when the cloud is not configured', async () => {
    mocks.isRuijieCloudConfigured.mockReturnValue(false);
    mocks.query.mockResolvedValue({
      rows: [localRow({ data_consumed_mb: '42' })],
    });

    const res = await request(app).get('/api/check-usage').query({ voucher: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.usageSource).toBe('voucher_accounting');
    expect(mocks.getAllRuijieVouchers).not.toHaveBeenCalled();
  });

  it('lets the live station roster win when its figure is larger (MAC supplied)', async () => {
    mocks.query.mockResolvedValue({
      rows: [localRow({ data_consumed_mb: '100' })],
    });
    mocks.getAllRuijieVouchers.mockResolvedValue([
      ruijieVoucher({ usedQuotaMb: 500 }),
    ]);
    mocks.listRuijieOnlineUsers.mockResolvedValue([
      { mac: 'aabbccddee01', usedMb: 950 },
    ]);

    const res = await request(app)
      .get('/api/check-usage')
      .query({ voucher: 'abc123', mac: 'aa:bb:cc:dd:ee:01' });
    expect(res.status).toBe(200);
    expect(res.body.usageSource).toBe('ruijie_live');
    expect(res.body.usedMB).toBe(950);
    expect(res.body.onlineNow).toBe(true);
  });

  it('reports onlineNow=false for a MAC the roster does not know', async () => {
    mocks.query.mockResolvedValue({ rows: [localRow()] });
    mocks.getAllRuijieVouchers.mockResolvedValue([
      ruijieVoucher({ usedQuotaMb: 10, currentClients: 1 }),
    ]);
    mocks.listRuijieOnlineUsers.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/check-usage')
      .query({ voucher: 'abc123', mac: 'aa:bb:cc:dd:ee:99' });
    expect(res.status).toBe(200);
    expect(res.body.onlineNow).toBe(false);
  });

  it('answers a Ruijie-only code with customer activity straight from Ruijie', async () => {
    mocks.query.mockResolvedValue({ rows: [] }); // unknown to our DB
    mocks.getAllRuijieVouchers.mockResolvedValue([
      ruijieVoucher({
        voucherCode: 'zzz999',
        usedQuotaMb: 640,
        usedTimeMin: 120,
        currentClients: 0,
      }),
    ]);

    const res = await request(app).get('/api/check-usage').query({ voucher: 'zzz999' });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.voucherCode).toBe('zzz999');
    expect(res.body.usageSource).toBe('ruijie_voucher');
    expect(res.body.usedMB).toBe(640);
    expect(res.body.totalMB).toBe(5120);
    expect(res.body.remainingMB).toBe(4480);
    expect(res.body.bytesUsed).toBe(640 * MB);
    expect(res.body.percentUsed).toBe(12.5);
    expect(res.body.onlineNow).toBe(false);
    expect(res.body.packageTier).toBe('preLite_Daily');
    expect(typeof res.body.expiresAt).toBe('string');
    // genuinely unknown locally — reported as unknown, never invented
    expect(res.body.boundDevices).toBeNull();
    expect(res.body.usedCount).toBeNull();
  });

  it('404s a Ruijie-only code with no customer activity (stock stays unprobeable)', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getAllRuijieVouchers.mockResolvedValue([
      ruijieVoucher({ voucherCode: 'cold01', usedQuotaMb: 0, usedTimeMin: 0, currentClients: 0 }),
    ]);

    const res = await request(app).get('/api/check-usage').query({ voucher: 'cold01' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('404s an expired Ruijie-only code even when it has activity', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getAllRuijieVouchers.mockResolvedValue([
      ruijieVoucher({
        voucherCode: 'old001',
        usedQuotaMb: 300,
        usedTimeMin: 90,
        expiryTime: Date.now() - 1000,
      }),
    ]);

    const res = await request(app).get('/api/check-usage').query({ voucher: 'old001' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('404s a disabled Ruijie-only code even when it has activity', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getAllRuijieVouchers.mockResolvedValue([
      ruijieVoucher({
        voucherCode: 'off001',
        usedQuotaMb: 300,
        usedTimeMin: 90,
        disableStatus: 1,
      }),
    ]);

    const res = await request(app).get('/api/check-usage').query({ voucher: 'off001' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('returns the same generic 404 for a code neither side knows', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getAllRuijieVouchers.mockResolvedValue([]);

    const res = await request(app).get('/api/check-usage').query({ voucher: 'ghost99' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('reports unknown usage (not zero) when no source knows anything', async () => {
    mocks.query.mockResolvedValue({ rows: [localRow()] });
    mocks.getAllRuijieVouchers.mockResolvedValue([]);

    const res = await request(app).get('/api/check-usage').query({ voucher: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.usageSource).toBe('none');
    expect(res.body.usedMB).toBeNull();
    expect(res.body.bytesUsed).toBeNull();
  });
});
