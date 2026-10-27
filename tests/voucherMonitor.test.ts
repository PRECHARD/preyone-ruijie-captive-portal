import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  isRuijieCloudConfigured: vi.fn(() => true),
  getAllRuijieVouchers: vi.fn(async (): Promise<any[]> => []),
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async () => ({})),
}));

vi.mock('../src/db/pool', () => ({ pool: { query: mocks.query } }));
vi.mock('../src/services/ruijieCloud', () => ({
  isRuijieCloudConfigured: mocks.isRuijieCloudConfigured,
  getAllRuijieVouchers: mocks.getAllRuijieVouchers,
}));
vi.mock('web-push', () => ({
  __esModule: true,
  default: { setVapidDetails: mocks.setVapidDetails, sendNotification: mocks.sendNotification },
  setVapidDetails: mocks.setVapidDetails,
  sendNotification: mocks.sendNotification,
}));

import {
  chooseAlertTier,
  voucherPct,
  isAlertCandidate,
  buildAlertCopy,
  buildPushPayload,
  configureWebPush,
  __resetVapidForTests,
  runVoucherAlertSweep,
  stopVoucherMonitor,
  ALERT_TIERS,
  normalizeAlertThresholds,
  DEFAULT_ALERT_THRESHOLDS,
} from '../src/services/voucherMonitorService';
import {
  consumptionStatus,
  consumptionTier,
  isDrainedAndExpired,
  sortConsumptionRows,
} from '../src/routes/voucherAnalytics';
import { alertsRouter } from '../src/routes/alerts';

const MB = 1;

function voucher(overrides: Record<string, unknown> = {}) {
  return {
    codeNo: 'N1',
    voucherCode: 'abcdef',
    quotaMb: 1000,
    usedQuotaMb: 100,
    disableStatus: 0,
    packageName: 'preLite_Daily',
    currentClients: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isRuijieCloudConfigured.mockReturnValue(true);
  mocks.getAllRuijieVouchers.mockResolvedValue([]);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.sendNotification.mockResolvedValue({});
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  __resetVapidForTests();
});

afterEach(() => {
  stopVoucherMonitor();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  __resetVapidForTests();
});

describe('chooseAlertTier', () => {
  it('fires nothing below the first threshold', () => {
    expect(chooseAlertTier(0)).toBeNull();
    expect(chooseAlertTier(79.9)).toBeNull();
  });

  it('fires the 80 tier from 80 up to (but not including) 95', () => {
    expect(chooseAlertTier(80)).toBe(80);
    expect(chooseAlertTier(94.99)).toBe(80);
  });

  it('fires the 95 tier from 95 upward — never double-pings 80', () => {
    expect(chooseAlertTier(95)).toBe(95);
    expect(chooseAlertTier(100)).toBe(95);
    expect(ALERT_TIERS).toEqual([80, 95]);
  });

  it('treats non-finite percentages as no alert', () => {
    expect(chooseAlertTier(Number.NaN)).toBeNull();
    expect(chooseAlertTier(Infinity)).toBeNull();
  });
});

describe('voucherPct', () => {
  it('computes capped usage percentage', () => {
    expect(voucherPct({ quotaMb: 1000, usedQuotaMb: 400 })).toBeCloseTo(40);
    expect(voucherPct({ quotaMb: 1000, usedQuotaMb: 5000 })).toBe(100);
  });

  it('returns null for unlimited or invalid inputs', () => {
    expect(voucherPct({ quotaMb: 0, usedQuotaMb: 100 })).toBeNull();
    expect(voucherPct({ quotaMb: 1000 })).toBeNull();
    expect(voucherPct({ quotaMb: 1000, usedQuotaMb: -5 })).toBeNull();
  });
});

describe('isAlertCandidate', () => {
  it('accepts a usable capped voucher with a code', () => {
    expect(isAlertCandidate(voucher() as any)).toBe(true);
  });

  it('rejects unlimited, disabled and codeless vouchers', () => {
    expect(isAlertCandidate(voucher({ quotaMb: 0, usedQuotaMb: 500 }) as any)).toBe(false);
    expect(isAlertCandidate(voucher({ disableStatus: 108 }) as any)).toBe(false);
    expect(isAlertCandidate(voucher({ voucherCode: '' }) as any)).toBe(false);
  });
});

describe('buildAlertCopy / buildPushPayload', () => {
  it('ships the exact 80/95 copy and a /data payload', () => {
    expect(buildAlertCopy(80).title).toContain('DATA THRESHOLD 80%');
    expect(buildAlertCopy(95).title).toContain('RUNNING DRY');
    const payload = buildPushPayload(95, 'ebywa6', 96.2);
    expect(payload).toMatchObject({
      url: '/data',
      tag: 'preyone-alert-95-ebywa6',
      tier: 95,
      pct: 96,
    });
  });
});

describe('configureWebPush', () => {
  it('runs in portal-only mode when VAPID keys are absent', () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    __resetVapidForTests();
    expect(configureWebPush()).toBe(false);
  });

  it('configures VAPID once when keys are present', () => {
    expect(configureWebPush()).toBe(true);
    expect(configureWebPush()).toBe(true);
    expect(mocks.setVapidDetails).toHaveBeenCalledTimes(1);
  });
});

describe('runVoucherAlertSweep', () => {
  function mockClaim(claimed: boolean) {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO voucher_alert_state')) {
        return { rows: claimed ? [{ id: 'claim-1' }] : [] };
      }
      if (sql.includes('SELECT endpoint, p256dh, auth')) return { rows: [] };
      return { rows: [] };
    });
  }

  it('skips unlimited and disabled vouchers entirely', async () => {
    mocks.getAllRuijieVouchers.mockResolvedValue([
      voucher({ quotaMb: 0, usedQuotaMb: 500 }),
      voucher({ disableStatus: 108 }),
    ]);
    const s = await runVoucherAlertSweep();
    expect(s).toMatchObject({ scanned: 2, candidates: 0, claimed: 0 });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('claims and records an event at the 80 tier when no VAPID subs exist', async () => {
    mocks.getAllRuijieVouchers.mockResolvedValue([voucher({ usedQuotaMb: 800 * MB, quotaMb: 1000 * MB })]);
    mockClaim(true);
    const s = await runVoucherAlertSweep();
    expect(s).toMatchObject({ scanned: 1, candidates: 1, claimed: 1, noSubscribers: 1 });

    const claimCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('voucher_alert_state'));
    expect(claimCall?.[1]).toEqual(['abcdef', 80, 800, 1]);

    const eventCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('voucher_alert_events'));
    expect(eventCall?.[1]).toEqual(['abcdef', 80, 800, 1000, 80, 'no_subscribers', expect.any(String)]);
  });

  it('fires only the 95 tier once usage is past 95', async () => {
    mocks.getAllRuijieVouchers.mockResolvedValue([voucher({ usedQuotaMb: 960 })]);
    mockClaim(true);
    const s = await runVoucherAlertSweep();
    expect(s.claimed).toBe(1);
    const claimCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('voucher_alert_state'));
    expect(claimCall?.[1]).toEqual(['abcdef', 95, 960, 1]);
  });

  it('loses the race cleanly when another cluster already claimed', async () => {
    mocks.getAllRuijieVouchers.mockResolvedValue([voucher({ usedQuotaMb: 900 })]);
    mockClaim(false);
    const s = await runVoucherAlertSweep();
    expect(s).toMatchObject({ scanned: 1, candidates: 1, claimed: 0 });
    const eventCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('voucher_alert_events'));
    expect(eventCall).toBeUndefined();
  });

  it('dispatches a real push and records sent status', async () => {
    mocks.getAllRuijieVouchers.mockResolvedValue([voucher({ usedQuotaMb: 900 })]);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO voucher_alert_state')) return { rows: [{ id: 'claim-1' }] };
      if (sql.includes('SELECT endpoint, p256dh, auth')) {
        return { rows: [{ endpoint: 'https://push.example/x', p256dh: 'k'.repeat(40), auth: 'a'.repeat(20) }] };
      }
      return { rows: [] };
    });
    const s = await runVoucherAlertSweep();
    expect(s.sent).toBe(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(mocks.sendNotification.mock.calls[0][1]));
    expect(payload).toMatchObject({ url: '/data', tier: 80 });

    const eventCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('voucher_alert_events'));
    expect(eventCall?.[1]?.[5]).toBe('sent');
  });

  it('returns early without Ruijie keys', async () => {
    mocks.isRuijieCloudConfigured.mockReturnValue(false);
    const s = await runVoucherAlertSweep();
    expect(s.scanned).toBe(0);
    expect(mocks.getAllRuijieVouchers).not.toHaveBeenCalled();
  });
});

describe('consumptionStatus (analytics taxonomy)', () => {
  it('maps pct and disableStatus onto the tab status union', () => {
    expect(consumptionStatus({ quotaMb: 1000, usedQuotaMb: 100 }, 10)).toBe('ok');
    expect(consumptionStatus({ quotaMb: 1000, usedQuotaMb: 0 }, 0)).toBe('idle');
    expect(consumptionStatus({ quotaMb: 1000, usedQuotaMb: 850 }, 85)).toBe('low');
    expect(consumptionStatus({ quotaMb: 1000, usedQuotaMb: 970 }, 97)).toBe('critical');
    expect(consumptionStatus({ quotaMb: 1000, usedQuotaMb: 1000 }, 100)).toBe('exhausted');
    expect(consumptionStatus({ quotaMb: 0, usedQuotaMb: 0 }, null)).toBe('unlimited');
    expect(consumptionStatus({ quotaMb: 1000, usedQuotaMb: 10, disableStatus: 108 }, 1)).toBe('disabled');
  });

  it('marks a past expiryTime as expired even when disableStatus is 0', () => {
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    expect(consumptionStatus({ quotaMb: 1000, usedQuotaMb: 100, expiryTime: now - 1 }, 10, now)).toBe('expired');
    expect(consumptionStatus({ quotaMb: 1000, usedQuotaMb: 100, expiryTime: now + 60_000 }, 10, now)).toBe('ok');
    expect(consumptionStatus({ quotaMb: 1000, usedQuotaMb: 100, expiryTime: now - 1, disableStatus: 108 }, 10, now)).toBe('expired');
  });

  it('honours configured warn/critical thresholds', () => {
    const thresholds = normalizeAlertThresholds({ warn: 70, critical: 90 });
    expect(consumptionStatus({}, 65, Date.now(), thresholds)).toBe('ok');
    expect(consumptionStatus({}, 75, Date.now(), thresholds)).toBe('low');
    expect(consumptionStatus({}, 92, Date.now(), thresholds)).toBe('critical');
    // ...while the default pair still behaves as before.
    expect(consumptionStatus({}, 75, Date.now(), DEFAULT_ALERT_THRESHOLDS)).toBe('ok');
  });
});

describe('normalizeAlertThresholds', () => {
  it('falls back to 80/95 for missing or out-of-range values', () => {
    expect(normalizeAlertThresholds(null)).toEqual({ warn: 80, critical: 95 });
    expect(normalizeAlertThresholds({ warn: 'abc', critical: -1 })).toEqual({ warn: 80, critical: 95 });
    expect(normalizeAlertThresholds({ warn: 0, critical: 101 })).toEqual({ warn: 80, critical: 95 });
  });

  it('keeps critical at least 5 points above warn', () => {
    expect(normalizeAlertThresholds({ warn: 80, critical: 80 })).toEqual({ warn: 80, critical: 85 });
    expect(normalizeAlertThresholds({ warn: 98, critical: 50 })).toEqual({ warn: 98, critical: 100 });
  });

  it('maps configured percentages onto the persisted 80/95 tier slots', () => {
    const t = { warn: 70, critical: 90 };
    expect(chooseAlertTier(69, t)).toBeNull();
    expect(chooseAlertTier(70, t)).toBe(80);
    expect(chooseAlertTier(89.9, t)).toBe(80);
    expect(chooseAlertTier(90, t)).toBe(95);
  });
});

describe('isDrainedAndExpired', () => {
  const now = Date.UTC(2026, 9, 25, 12, 0, 0);
  it('only true for fully consumed AND past-expiry rows', () => {
    expect(isDrainedAndExpired({ pct: 100, expiryTime: now - 1 }, now)).toBe(true);
    expect(isDrainedAndExpired({ pct: 100, expiryTime: now + 60_000 }, now)).toBe(false);
    expect(isDrainedAndExpired({ pct: 60, expiryTime: now - 1 }, now)).toBe(false);
    expect(isDrainedAndExpired({ pct: null, expiryTime: now - 1 }, now)).toBe(false);
    expect(isDrainedAndExpired({ pct: 100, expiryTime: null }, now)).toBe(false);
  });
});

describe('sortConsumptionRows (four-tier hierarchy)', () => {
  const r = (code: string, status: string, pct: number | null, onlineNow = false) => ({
    code,
    status: status as never,
    pct,
    onlineNow,
  });

  it('ranks critical/low above drained, ok and unlimited', () => {
    expect(consumptionTier('critical')).toBe(0);
    expect(consumptionTier('low')).toBe(0);
    expect(consumptionTier('exhausted')).toBe(1);
    expect(consumptionTier('ok')).toBe(2);
    expect(consumptionTier('idle')).toBe(2);
    expect(consumptionTier('unlimited')).toBe(3);
    expect(consumptionTier('disabled')).toBe(4);
    expect(consumptionTier('expired')).toBe(5);
  });

  it('puts quota-critical vouchers on top even when they are offline', () => {
    const sorted = sortConsumptionRows([
      r('offCrit', 'critical', 99),
      r('offLow', 'low', 85),
      r('onIdle', 'idle', 0, true),
      r('onUnl', 'unlimited', null, true),
      r('offOk', 'ok', 40),
    ]);
    expect(sorted.map((x) => x.code)).toEqual([
      'offCrit', 'offLow', 'onIdle', 'offOk', 'onUnl',
    ]);
  });

  it('orders critical/low → drained → ok/idle → unlimited, online first inside a tier', () => {
    const sorted = sortConsumptionRows([
      r('offCrit', 'critical', 99),
      r('onOk', 'ok', 30, true),
      r('onUnl', 'unlimited', null, true),
      r('onLow', 'low', 85, true),
      r('onCrit', 'critical', 97, true),
      r('onIdle', 'idle', 0, true),
      r('onExh', 'exhausted', 100, true),
    ]);
    expect(sorted.map((x) => x.code)).toEqual([
      'onCrit', 'onLow', 'offCrit', 'onExh', 'onOk', 'onIdle', 'onUnl',
    ]);
  });

  it('keeps disabled/expired codes out of the live tiers', () => {
    const sorted = sortConsumptionRows([
      r('onDead', 'disabled', 50, true),
      r('onExp', 'expired', 100, true),
      r('onOk', 'ok', 30, true),
      r('offOk', 'ok', 20),
    ]);
    expect(sorted.map((x) => x.code)).toEqual(['onOk', 'offOk', 'onDead', 'onExp']);
  });

  it('orders critical → low → drained → ok → idle → unlimited → disabled → expired (expired last)', () => {
    const sorted = sortConsumptionRows([
      r('exp1', 'expired', 100),
      r('dis1', 'disabled', 12),
      r('unl1', 'unlimited', null),
      r('idle1', 'idle', 0),
      r('ok1', 'ok', 40),
      r('exh1', 'exhausted', 100),
      r('low1', 'low', 85),
      r('crit1', 'critical', 97),
    ]);
    expect(sorted.map((x) => x.status)).toEqual([
      'critical', 'low', 'exhausted', 'ok', 'idle', 'unlimited', 'disabled', 'expired',
    ]);
  });

  it('sinks every disabled code to the bottom even when its pct is high', () => {
    const sorted = sortConsumptionRows([
      r('dead99', 'disabled', 99),
      r('live50', 'ok', 50),
    ]);
    expect(sorted.map((x) => x.code)).toEqual(['live50', 'dead99']);
  });

  it('breaks ties inside a status by pct desc, then PIN ascending', () => {
    const sorted = sortConsumptionRows([
      r('lowB', 'low', 81),
      r('lowA', 'low', 81),
      r('critMid', 'critical', 96),
      r('critTop', 'critical', 99),
    ]);
    expect(sorted.map((x) => x.code)).toEqual(['critTop', 'critMid', 'lowA', 'lowB']);
  });

  it('does not mutate its input', () => {
    const input = [r('b', 'ok', 10), r('a', 'critical', 96)];
    const snapshot = [...input];
    sortConsumptionRows(input);
    expect(input).toEqual(snapshot);
  });
});

describe('GET/POST /api/alerts routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', alertsRouter);

  it('serves a null public key in portal-only mode', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const res = await request(app).get('/api/alerts/public-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: null });
  });

  it('serves the VAPID public key when configured', async () => {
    const res = await request(app).get('/api/alerts/public-key');
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe('test-public-key');
  });

  it('rejects subscribe with a bad voucher or insecure endpoint', async () => {
    const badVoucher = await request(app).post('/api/alerts/subscribe').send({
      voucher: 'x',
      subscription: { endpoint: 'https://fcm.example/p', keys: { p256dh: 'k'.repeat(40), auth: 'a'.repeat(20) } },
    });
    expect(badVoucher.status).toBe(400);
    expect(badVoucher.body.error).toBe('invalid_voucher');

    const badEndpoint = await request(app).post('/api/alerts/subscribe').send({
      voucher: 'abcdef',
      subscription: { endpoint: 'http://insecure.example/p', keys: { p256dh: 'k'.repeat(40), auth: 'a'.repeat(20) } },
    });
    expect(badEndpoint.status).toBe(400);
    expect(badEndpoint.body.error).toBe('invalid_endpoint');
  });

  it('upserts a valid subscription keyed by endpoint', async () => {
    const res = await request(app).post('/api/alerts/subscribe').send({
      voucher: 'ABCDEF',
      subscription: {
        endpoint: 'https://fcm.example/p/1',
        keys: { p256dh: 'k'.repeat(40), auth: 'a'.repeat(20) },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO push_subscriptions');
    expect(params?.[0]).toBe('abcdef');
  });

  it('requires a voucher on /pending and serves unacked events with copy', async () => {
    const missing = await request(app).get('/api/alerts/pending');
    expect(missing.status).toBe(400);

    mocks.query.mockResolvedValue({
      rows: [{
        id: 'evt-1', tier: 95, pct: 96, used_mb: 960, total_mb: 1000, created_at: new Date(),
      }],
    });
    const res = await request(app).get('/api/alerts/pending?voucher=ebywa6');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0]).toMatchObject({ id: 'evt-1', tier: 95 });
    expect(res.body.alerts[0].title).toContain('RUNNING DRY');
  });

  it('acks only within the voucher scope', async () => {
    const missing = await request(app).post('/api/alerts/ack').send({ voucher: 'abcdef' });
    expect(missing.status).toBe(400);

    const res = await request(app).post('/api/alerts/ack').send({ id: 'evt-1', voucher: 'otherpin' });
    expect(res.status).toBe(200);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain('acknowledged_at');
    expect(params).toEqual(['evt-1', 'otherpin']);
  });
});
