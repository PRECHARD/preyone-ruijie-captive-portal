import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Local captive-portal redemption.
 *
 * The PWA used to redeem a PIN through `/api/auth/signup`, which carries a
 * 10-requests-per-15-minutes limiter **per IP**. Every guest on a hotspot shares
 * one NAT IP, so the eleventh paying customer of the day was told "Too many
 * requests" — the "voucher rejected" bug. `/api/portal/redeem` resolves the PIN
 * against the local `vouchers` table only:
 *
 *   - no account (name/email/password optional),
 *   - no per-IP redemption limit (only failed attempts count),
 *   - no outbound HTTP at all, so Ruijie's `code 44` quota can never reject a
 *     voucher that is sitting in our own database.
 *
 * These tests drive the real router against a stubbed pg client.
 */

const { queryMock, releaseMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(async () => ({ query: queryMock, release: releaseMock })),
  },
}));

import { pool } from '../src/db/pool';
import { portalRouter, PORTAL_REDEEM_RATE_LIMIT_OPTIONS } from '../src/routes/portal';
import {
  classifyLocalVoucher,
  normalizeVoucherCode,
  buildVoucherActivation,
  type LocalVoucherRow,
} from '../src/models/voucher';

const VOUCHER_ROW: LocalVoucherRow = {
  id: 'v-1',
  // Ruijie mints lowercase codes; the gateway must receive this exact casing.
  code: 'e7wj7w',
  duration_min: 1440,
  max_uses: 1,
  used_count: 0,
  expires_at: null,
  data_limit_gb: '5.00',
  is_uncapped: false,
  bandwidth_mbps_up: 5,
  bandwidth_mbps_down: 10,
  package_tier: 'PreLite',
  is_disabled: false,
  deleted_at: null,
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/portal', portalRouter);
  return a;
}

interface StubOptions {
  /** `null` = no row for the PIN. */
  voucher?: LocalVoucherRow | null;
}

const executed: string[] = [];

function stubDb(options: StubOptions = {}) {
  const row = options.voucher === undefined ? VOUCHER_ROW : options.voucher;
  queryMock.mockImplementation(async (sql: string) => {
    const q = String(sql);
    executed.push(q);

    if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK') return { rows: [], rowCount: 0 };

    if (q.includes('FROM vouchers') && q.includes('FOR UPDATE')) {
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (q.includes('UPDATE vouchers') && q.includes('used_count')) {
      return { rows: [{ used_count: 1 }], rowCount: 1 };
    }
    if (q.includes('INSERT INTO users')) return { rows: [{ id: 'u-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  executed.length = 0;
  stubDb();
});

describe('POST /api/portal/redeem — local validation', () => {
  it('activates a valid local voucher and returns the gateway hand-off', async () => {
    const res = await request(app())
      .post('/api/portal/redeem?client_mac=AA:BB:CC:DD:EE:FF&login_url=http://192.168.1.216:2060/ext_login&url=http://example.com/news')
      .send({ voucherCode: 'e7wj7w' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      source: 'local',
      voucherCode: 'e7wj7w',
      durationMin: 1440,
      isUncapped: false,
      dataLimitGb: 5,
      bandwidthMbpsUp: 5,
      bandwidthMbpsDown: 10,
      macAddress: 'AA:BB:CC:DD:EE:FF',
    });
    expect(typeof res.body.sessionToken).toBe('string');
    expect(typeof res.body.redirectUrl).toBe('string');

    // Straight to the gateway's ext_login, carrying the ORIGINAL destination.
    expect(res.body.redirectUrl).toContain('192.168.1.216:2060/ext_login');
    expect(res.body.redirectUrl).toContain('client_mac=AA%3ABB%3ACC%3ADD%3AEE%3AFF');
    expect(res.body.redirectUrl).toContain('url=http%3A%2F%2Fexample.com%2Fnews');
    expect(res.body.redirectUrl).toContain('next_url=http%3A%2F%2Fexample.com%2Fnews');
  });

  it('accepts a code with stray whitespace and either casing', async () => {
    const res = await request(app())
      .post('/api/portal/redeem')
      .send({ voucherCode: '  E7WJ 7W ' });

    expect(res.status).toBe(200);
    // The stored, vendor-issued casing is what the gateway receives.
    expect(res.body.voucherCode).toBe('e7wj7w');
  });

  it('rejects an unknown PIN without leaking whether the code ever existed', async () => {
    stubDb({ voucher: null });
    const res = await request(app()).post('/api/portal/redeem').send({ voucherCode: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid Voucher code.', reason: 'invalid' });
    expect(executed).toContain('ROLLBACK');
    expect(executed.some((q) => q.includes('UPDATE vouchers'))).toBe(false);
  });

  it('rejects an exhausted voucher before incrementing used_count', async () => {
    stubDb({ voucher: { ...VOUCHER_ROW, used_count: 1, max_uses: 1 } });
    const res = await request(app()).post('/api/portal/redeem').send({ voucherCode: 'e7wj7w' });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('exhausted');
    expect(executed.some((q) => q.includes('UPDATE vouchers'))).toBe(false);
  });

  it('rejects an expired voucher', async () => {
    stubDb({ voucher: { ...VOUCHER_ROW, expires_at: '2020-01-01T00:00:00.000Z' } });
    const res = await request(app()).post('/api/portal/redeem').send({ voucherCode: 'e7wj7w' });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('expired');
  });

  it('rejects a disabled or soft-deleted voucher', async () => {
    stubDb({ voucher: { ...VOUCHER_ROW, is_disabled: true } });
    const disabled = await request(app()).post('/api/portal/redeem').send({ voucherCode: 'e7wj7w' });
    expect(disabled.status).toBe(400);
    expect(disabled.body.reason).toBe('disabled');

    stubDb({ voucher: { ...VOUCHER_ROW, deleted_at: '2026-01-01T00:00:00.000Z' } });
    const deleted = await request(app()).post('/api/portal/redeem').send({ voucherCode: 'e7wj7w' });
    expect(deleted.status).toBe(400);
    expect(deleted.body.reason).toBe('disabled');
  });

  it('requires a code', async () => {
    const res = await request(app()).post('/api/portal/redeem').send({});
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('invalid');
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/portal/redeem — persistence contract', () => {
  it('keeps the partial-index conflict target on the users INSERT (42P10 guard)', async () => {
    await request(app()).post('/api/portal/redeem').send({ voucherCode: 'e7wj7w' });

    const inserts = executed.filter((q) => q.includes('INSERT INTO users'));
    expect(inserts.length).toBeGreaterThan(0);
    for (const sql of inserts) {
      expect(sql).toContain("ON CONFLICT (email) WHERE email IS NOT NULL AND email != '' DO NOTHING");
    }
  });

  it('records the redemption, the WISPr profile and the access log, then commits', async () => {
    await request(app())
      .post('/api/portal/redeem?client_mac=AA:BB:CC:DD:EE:FF')
      .send({ voucherCode: 'e7wj7w' });

    expect(executed.some((q) => q.includes('INSERT INTO voucher_redemptions'))).toBe(true);
    expect(executed.some((q) => q.includes('INSERT INTO wispr_profiles'))).toBe(true);
    expect(executed.some((q) => q.includes('INSERT INTO access_log'))).toBe(true);
    expect(executed[executed.length - 1]).toBe('COMMIT');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('marks the voucher used and records the claiming device', async () => {
    await request(app())
      .post('/api/portal/redeem?client_mac=AA:BB:CC:DD:EE:FF&client_ip=10.1.2.3')
      .send({ voucherCode: 'e7wj7w' });

    const update = executed.find((q) => q.includes('UPDATE vouchers'));
    expect(update).toBeDefined();
    // Consumption + first-use clock + the device that claimed the code.
    expect(update).toMatch(/used_count\s+= used_count \+ 1/);
    expect(update).toMatch(/activated_at = COALESCE\(activated_at, NOW\(\)\)/);
    expect(update).toMatch(/client_mac\s+= COALESCE\(client_mac, \$2\)/);
    expect(update).toMatch(/client_ip\s+= COALESCE\(client_ip, \$3::inet\)/);
    // A stored status column would be a second copy of used_count/max_uses.
    expect(update).not.toContain('status =');
  });

  it('upserts the per-device session ledger inside the transaction', async () => {
    await request(app())
      .post('/api/portal/redeem?client_mac=AA:BB:CC:DD:EE:FF&client_ip=10.1.2.3')
      .send({ voucherCode: 'e7wj7w' });

    const session = executed.find((q) => q.includes('INSERT INTO active_sessions'));
    expect(session).toBeDefined();
    expect(session).toContain('ON CONFLICT (session_token) DO UPDATE');
    expect(session).toContain('client_mac');
    expect(session).toContain('expires_at');
    // The ledger row must land before the COMMIT that publishes the redemption.
    expect(executed.indexOf(session!)).toBeLessThan(executed.indexOf('COMMIT'));
  });

  it('accepts the device identity from the body when the gateway sent none in the URL', async () => {
    const res = await request(app())
      .post('/api/portal/redeem')
      .send({ voucherCode: 'e7wj7w', clientMac: 'aa-bb-cc-dd-ee-ff', clientIp: '10.9.8.7' });

    expect(res.status).toBe(200);
    expect(res.body.macAddress).toBe('aa-bb-cc-dd-ee-ff');
    expect(res.body.ipAddress).toBe('10.9.8.7');
  });

  it('reports "used" and a success.html fallback without changing the gateway redirect', async () => {
    const res = await request(app())
      .post('/api/portal/redeem?client_mac=AA:BB:CC:DD:EE:FF&login_url=http://10.0.0.1:2060/ext_login')
      .send({ voucherCode: 'e7wj7w' });

    expect(res.status).toBe(200);
    // Single-use code, so one redemption exhausts it.
    expect(res.body.voucherStatus).toBe('used');
    expect(res.body.successUrl).toBe('/success.html');
    // Hard invariant: the client is still sent to ext_login, not success.html.
    expect(res.body.redirectUrl).toContain('10.0.0.1:2060/ext_login');
  });

  it('never treats nas_ip as the client address', async () => {
    const res = await request(app())
      .post('/api/portal/redeem?nas_ip=192.168.1.1')
      .send({ voucherCode: 'e7wj7w' });

    expect(res.status).toBe(200);
    // req.ip is the only remaining source (supertest loopback).
    expect(res.body.ipAddress).not.toBe('192.168.1.1');
  });

  it('does not create a WISPr profile when the gateway supplied no MAC', async () => {
    await request(app()).post('/api/portal/redeem').send({ voucherCode: 'e7wj7w' });

    expect(executed.some((q) => q.includes('INSERT INTO wispr_profiles'))).toBe(false);
    expect(executed[executed.length - 1]).toBe('COMMIT');
  });

  it('reads gateway parameters from the query string, never the body', async () => {
    const res = await request(app())
      .post('/api/portal/redeem?client_mac=11:22:33:44:55:66&login_url=http://10.0.0.1:2060/ext_login&ssid=Preyone')
      // A body-only MAC must not win over the query string: the gateway puts
      // these in the URL, and AGENTS.md documents losing them via the body.
      .send({ voucherCode: 'e7wj7w', client_mac: '99:99:99:99:99:99', login_url: 'http://evil.example' });

    expect(res.status).toBe(200);
    expect(res.body.macAddress).toBe('11:22:33:44:55:66');
    expect(res.body.redirectUrl).toContain('10.0.0.1:2060/ext_login');
    expect(res.body.redirectUrl).not.toContain('evil.example');
  });

  it('rolls back and 500s when the database throws mid-transaction', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const q = String(sql);
      executed.push(q);
      if (q === 'BEGIN') return { rows: [], rowCount: 0 };
      if (q.includes('FROM vouchers') && q.includes('FOR UPDATE')) return { rows: [VOUCHER_ROW], rowCount: 1 };
      if (q.includes('UPDATE vouchers')) throw new Error('connection reset');
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app()).post('/api/portal/redeem').send({ voucherCode: 'e7wj7w' });

    expect(res.status).toBe(500);
    // The failure must undo the claimed allocation.
    expect(executed).toContain('ROLLBACK');
  });
});

describe('GET /api/portal/redeem/health', () => {
  it('reports that the local fast path is available without touching the DB', async () => {
    const res = await request(app()).get('/api/portal/redeem/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, localRedemption: true, upstream: 'none' });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('limiter policy', () => {
  it('only counts failed attempts, so a NAT queue of paying customers cannot lock itself out', () => {
    expect(PORTAL_REDEEM_RATE_LIMIT_OPTIONS.skipSuccessfulRequests).toBe(true);
    expect(PORTAL_REDEEM_RATE_LIMIT_OPTIONS.windowMs).toBe(60_000);
    // Far above the old signup 10/15min, and it is failures-only.
    expect(PORTAL_REDEEM_RATE_LIMIT_OPTIONS.max).toBeGreaterThanOrEqual(10);
  });
});

describe('local-only guarantee', () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

  it.each(['src/routes/portal.ts', 'src/models/voucher.ts'])(
    '%s never reaches for a Ruijie client or the network',
    (file) => {
      const source = read(file);
      // No upstream module: a mint/read call here would make redemption depend
      // on the tenant API quota that produces `code 44`.
      expect(source).not.toMatch(/from\s+['"][^'"]*services\/ruijie/);
      expect(source).not.toMatch(/\bfetch\(/);
      expect(source).not.toContain('https://');
      expect(source).not.toContain('http://');
    }
  );

  it('does not touch the signup handler', () => {
    const auth = read('src/routes/auth.ts');
    expect(auth).toContain("authRouter.post('/signup', signupLimiter");
  });

  it('only reaches Ruijie after COMMIT, fire-and-forget, so it can never delay a redemption', () => {
    const source = read('src/routes/portal.ts');
    const commitAt = source.indexOf("await client.query('COMMIT')");
    const hookAt = source.indexOf('authorizeClientAfterRedeem');
    const responseAt = source.indexOf('res.status(200).json');

    expect(commitAt).toBeGreaterThan(-1);
    expect(responseAt).toBeGreaterThan(commitAt);
    // The hook is imported lazily and never awaited on the response path.
    expect(hookAt).toBeGreaterThan(responseAt);
    expect(source).toMatch(/void \(async \(\) => \{/);
    expect(source).toContain("await import('../services/ruijieAuthorize')");
  });
});

describe('pure classification helpers', () => {
  it('normalises case and internal whitespace', () => {
    expect(normalizeVoucherCode('  e7w J7w \n')).toBe('E7WJ7W');
    expect(normalizeVoucherCode(null)).toBe('');
    expect(normalizeVoucherCode(12345)).toBe('');
  });

  it('classifies every rejection reason', () => {
    expect(classifyLocalVoucher(null)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(classifyLocalVoucher({ ...VOUCHER_ROW, used_count: 2, max_uses: 2 })).toMatchObject({
      ok: false,
      reason: 'exhausted',
    });
    expect(classifyLocalVoucher({ ...VOUCHER_ROW, expires_at: '2000-01-01T00:00:00Z' })).toMatchObject({
      ok: false,
      reason: 'expired',
    });
    expect(classifyLocalVoucher({ ...VOUCHER_ROW, is_disabled: true })).toMatchObject({
      ok: false,
      reason: 'disabled',
    });
    expect(classifyLocalVoucher(VOUCHER_ROW)).toMatchObject({ ok: true });
  });

  it('treats a missing data cap as uncapped when the row says so', () => {
    expect(buildVoucherActivation({ ...VOUCHER_ROW, is_uncapped: true, data_limit_gb: null })).toMatchObject({
      isUncapped: true,
      dataLimitGb: null,
    });
    expect(buildVoucherActivation(VOUCHER_ROW)).toMatchObject({ isUncapped: false, dataLimitGb: 5 });
  });
});
