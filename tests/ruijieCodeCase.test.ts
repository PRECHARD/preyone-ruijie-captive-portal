import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Regression guard for the Ruijie voucher-code casing bug.
 *
 * Ruijie Cloud mints LOWERCASE codes (verified live: 'e7wj7w', '2jbfmf'),
 * while legacy Preyone codes are uppercase. The redemption handler used to
 * look up `WHERE code = $1` with an uppercased parameter, so every Ruijie
 * voucher was unredeemable. It also uppercased the code before handing it to
 * the Ruijie gateway via ext_login, which would have sent a code the vendor
 * never issued.
 *
 * Rule under test: match case-insensitively, then propagate the STORED casing
 * verbatim everywhere downstream.
 */

vi.mock('../src/db/pool', () => {
  const q = vi.fn();
  const r = vi.fn();
  return {
    pool: {
      query: q,
      connect: vi.fn().mockResolvedValue({ query: q, release: r }),
    },
  };
});

vi.mock('../src/services/notificationService', () => ({
  sendPortalAccountCreated: vi.fn().mockResolvedValue(true),
  sendPortalSignupConfirmation: vi.fn().mockResolvedValue(true),
  sendPortalEmailVerification: vi.fn().mockResolvedValue(true),
  sendPortalForgotPassword: vi.fn().mockResolvedValue(true),
}));

import { authRouter } from '../src/routes/auth';
import { gatewayRouter } from '../src/routes/gateway';
import { pool } from '../src/db/pool';
import { sendPortalSignupConfirmation } from '../src/services/notificationService';

/** The code exactly as Ruijie issued it. */
const RUIJIE_CODE = 'e7wj7w';

const VOUCHER_ROW = {
  id: 'v-1',
  code: RUIJIE_CODE,
  duration_min: 60,
  max_uses: 3,
  used_count: 0,
  expires_at: null,
  data_limit_gb: 5,
  is_uncapped: false,
  bandwidth_mbps_up: 4,
  bandwidth_mbps_down: 8,
  package_tier: 'PreLite',
};

function signupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

/** Route by SQL text so assertions can inspect exactly what was executed. */
function stubSignup(rows = [VOUCHER_ROW]) {
  (pool.query as any).mockImplementation(async (sql: string) => {
    const q = String(sql);
    if (q.includes('FROM vouchers') && q.includes('FOR UPDATE')) return { rows };
    if (q.includes('INSERT INTO users')) return { rows: [{ id: 'u-1' }] };
    return { rows: [] };
  });
}

function signupBody(overrides: Record<string, any> = {}) {
  return {
    fullName: 'Jane Chinyama',
    phone: '+263771327202',
    email: 'jane@example.com',
    voucherCode: RUIJIE_CODE,
    acceptedTos: true,
    ...overrides,
  };
}

/** Find the SQL call whose text contains `needle`. */
function callWith(needle: string): any[] | undefined {
  return (pool.query as any).mock.calls.find((c: any[]) => String(c[0]).includes(needle));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('signup matches Ruijie codes case-insensitively', () => {
  it('looks the voucher up with UPPER(code) rather than code', async () => {
    stubSignup();
    await request(signupApp()).post('/api/auth/signup').send(signupBody());

    const lookup = callWith('FOR UPDATE');
    expect(lookup).toBeDefined();
    expect(String(lookup![0])).toContain('UPPER(code) = $1');
    // Parameter is normalised for matching...
    expect(lookup![1]).toEqual([RUIJIE_CODE.toUpperCase()]);
  });

  it('still redeems when the customer types the code in a different case', async () => {
    stubSignup();
    const res = await request(signupApp())
      .post('/api/auth/signup')
      .send(signupBody({ voucherCode: 'E7WJ7W' }));

    expect(res.status).toBe(200);
  });

  it('tolerates surrounding whitespace from a pasted code', async () => {
    stubSignup();
    const res = await request(signupApp())
      .post('/api/auth/signup')
      .send(signupBody({ voucherCode: '  e7wj7w  ' }));

    expect(res.status).toBe(200);
  });
});

describe('signup propagates the vendor-issued casing downstream', () => {
  it('stores the canonical lowercase code on the user row', async () => {
    stubSignup();
    await request(signupApp()).post('/api/auth/signup').send(signupBody());

    const insert = callWith('INSERT INTO users');
    expect(insert).toBeDefined();
    // users.voucher_code must be the canonical 'e7wj7w', never 'E7WJ7W'.
    expect(insert![1]).toContain(RUIJIE_CODE);
    expect(insert![1]).not.toContain(RUIJIE_CODE.toUpperCase());
  });

  it('records the canonical code in voucher_redemptions', async () => {
    stubSignup();
    await request(signupApp()).post('/api/auth/signup').send(signupBody());

    const redemption = callWith('INSERT INTO voucher_redemptions');
    expect(redemption).toBeDefined();
    expect(redemption![1][1]).toBe(RUIJIE_CODE);
  });

  it('emails the customer the code exactly as issued', async () => {
    stubSignup();
    await request(signupApp()).post('/api/auth/signup').send(signupBody());

    expect(sendPortalSignupConfirmation).toHaveBeenCalledWith(
      'jane@example.com',
      'Jane Chinyama',
      RUIJIE_CODE,
    );
  });

  it('returns the canonical code in the JSON response', async () => {
    stubSignup();
    const res = await request(signupApp()).post('/api/auth/signup').send(signupBody());

    expect(res.status).toBe(200);
    expect(res.body.voucherCode).toBe(RUIJIE_CODE);
  });
});

describe('ext_login receives the vendor-issued casing', () => {
  // The gateway supplies these as query params, not in the JSON body.
  const gatewayParams = 'client_mac=AA:BB:CC:DD:EE:FF&login_url=' +
    encodeURIComponent('http://192.168.1.1:2060/portal/login') +
    '&nas_ip=192.168.1.1';

  it('sends the lowercase code to the Ruijie gateway, not the uppercased one', async () => {
    stubSignup();
    const res = await request(signupApp())
      .post(`/api/auth/signup?${gatewayParams}`)
      .send(signupBody());

    expect(res.status).toBe(200);
    const extLogin = new URL(res.body.redirectUrl);
    expect(extLogin.port).toBe('2060');
    // Ruijie's backend issued 'e7wj7w'; sending 'E7WJ7W' may be rejected.
    expect(extLogin.searchParams.get('username')).toBe(RUIJIE_CODE);
    expect(extLogin.searchParams.get('password')).toBe(RUIJIE_CODE);
  });

  it('preserves the original url the client wanted to reach (AGENTS.md gotcha #4)', async () => {
    stubSignup();
    const res = await request(signupApp())
      .post(`/api/auth/signup?${gatewayParams}&url=${encodeURIComponent('http://example.com/news')}`)
      .send(signupBody());

    const extLogin = new URL(res.body.redirectUrl);
    expect(extLogin.searchParams.get('url')).toBe('http://example.com/news');
  });
});

describe('RADIUS voucher branch matches Ruijie codes case-insensitively', () => {
  function radiusApp() {
    const app = express();
    app.use(express.json());
    // The router defines the full '/api/radius/auth' path itself.
    app.use(gatewayRouter);
    return app;
  }

  it('joins and filters case-insensitively', async () => {
    (pool.query as any).mockResolvedValue({ rows: [] });

    await request(radiusApp()).get(
      `/api/radius/auth?mac=AA:BB:CC:DD:EE:FF&username=${RUIJIE_CODE}`,
    );

    // The voucher lookup is not necessarily the first query issued.
    const voucherLookup = (pool.query as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .find((s: string) => s.includes('FROM vouchers v'));

    expect(voucherLookup).toBeDefined();
    expect(voucherLookup).toContain('UPPER(v.code) = $1');
    expect(voucherLookup).toContain('UPPER(u.voucher_code) = UPPER(v.code)');
  });
});