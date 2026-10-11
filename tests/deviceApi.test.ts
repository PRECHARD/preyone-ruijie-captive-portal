import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

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
import { pool } from '../src/db/pool';
import { __setRuijieConfiguredProbe } from '../src/services/deviceBinding';

const TOKEN = 'session-token-abc';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

const VOUCHER_ROW = {
  voucher_code: 'PRELINK-ABCD12',
  voucher_id: 'v-1',
  package_tier: 'PreLink',
  max_devices: 2,
  expires_at: null,
};

const DEVICE_ROWS = [
  {
    id: 'd-1',
    voucher_id: 'v-1',
    voucher_code: 'PRELINK-ABCD12',
    user_id: 'u-1',
    mac_address: 'AA:BB:CC:DD:EE:FF',
    label: null,
    is_active: true,
    bound_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'd-2',
    voucher_id: 'v-1',
    voucher_code: 'PRELINK-ABCD12',
    user_id: 'u-1',
    mac_address: '11:22:33:44:55:66',
    label: 'old phone',
    is_active: false,
    bound_at: '2025-12-01T00:00:00.000Z',
    last_seen_at: null,
  },
];

/**
 * Routes by SQL text. GET /devices issues the session->voucher lookup, then the
 * device list, then (via the UPDATE) nothing; DELETE issues the lookup, the
 * deactivate UPDATE, then the device list again.
 */
function stubPool(opts: { voucher?: any[]; devices?: any[]; updateRowCount?: number } = {}) {
  (pool.query as any).mockImplementation(async (sql: string) => {
    const q = String(sql);
    if (q.includes('JOIN vouchers v ON')) {
      return { rows: opts.voucher !== undefined ? opts.voucher : [VOUCHER_ROW] };
    }
    if (q.includes('FROM voucher_devices')) {
      return { rows: opts.devices !== undefined ? opts.devices : DEVICE_ROWS };
    }
    if (q.includes('SET is_active = FALSE')) {
      return { rows: [], rowCount: opts.updateRowCount ?? 1 };
    }
    throw new Error('unstubbed pool.query: ' + q.slice(0, 70));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  __setRuijieConfiguredProbe(null);
});

describe('GET /api/auth/devices', () => {
  it('lists devices with the limit and remaining slots', async () => {
    stubPool();

    const res = await request(createApp()).get(`/api/auth/devices?token=${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.voucherCode).toBe('PRELINK-ABCD12');
    expect(res.body.deviceLimit).toBe(2);
    expect(res.body.devicesActive).toBe(1);
    expect(res.body.slotsRemaining).toBe(1);
    expect(res.body.devices).toHaveLength(2);
    // camelCase for the client, and the inactive device is still listed so the
    // customer can see history.
    expect(res.body.devices[0].macAddress).toBe('AA:BB:CC:DD:EE:FF');
    expect(res.body.devices[0].isActive).toBe(true);
    expect(res.body.devices[1].isActive).toBe(false);
  });

  it('never leaks the raw mac_norm column', async () => {
    stubPool();
    const res = await request(createApp()).get(`/api/auth/devices?token=${TOKEN}`);
    expect(JSON.stringify(res.body)).not.toContain('mac_norm');
  });

  it('requires a token', async () => {
    const res = await request(createApp()).get('/api/auth/devices');
    expect(res.status).toBe(400);
  });

  it('404s when the session has no voucher', async () => {
    stubPool({ voucher: [] });
    const res = await request(createApp()).get(`/api/auth/devices?token=${TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('reports zero slots remaining when the voucher is full', async () => {
    stubPool({
      devices: [
        { ...DEVICE_ROWS[0], is_active: true },
        { ...DEVICE_ROWS[1], is_active: true },
      ],
    });
    const res = await request(createApp()).get(`/api/auth/devices?token=${TOKEN}`);
    expect(res.body.devicesActive).toBe(2);
    expect(res.body.slotsRemaining).toBe(0);
  });
});

describe('DELETE /api/auth/devices', () => {
  it('frees a slot scoped to the caller own voucher', async () => {
    stubPool();

    const res = await request(createApp())
      .delete(`/api/auth/devices?token=${TOKEN}&mac=aa:bb:cc:dd:ee:ff`);

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    expect(res.body.slotsRemaining).toBe(1);
  });

  it('scopes the update to the resolved voucher id', async () => {
    stubPool();
    await request(createApp()).delete(`/api/auth/devices?token=${TOKEN}&mac=AA:BB:CC:DD:EE:FF`);

    const update = (pool.query as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes('SET is_active = FALSE')
    );
    expect(update).toBeDefined();
    // [voucherId, macNorm] — a caller cannot reach another voucher's device.
    expect(update[1]).toEqual(['v-1', 'AABBCCDDEEFF']);
  });

  it('rejects a malformed mac before touching the database', async () => {
    const res = await request(createApp())
      .delete(`/api/auth/devices?token=${TOKEN}&mac=nonsense`);
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('requires a token', async () => {
    const res = await request(createApp()).delete('/api/auth/devices?mac=AA:BB:CC:DD:EE:FF');
    expect(res.status).toBe(400);
  });

  it('404s when the device is not on this voucher', async () => {
    stubPool({ updateRowCount: 0 });
    const res = await request(createApp())
      .delete(`/api/auth/devices?token=${TOKEN}&mac=AA:BB:CC:DD:EE:FF`);
    expect(res.status).toBe(404);
  });

  it('404s when the session has no voucher', async () => {
    stubPool({ voucher: [] });
    const res = await request(createApp())
      .delete(`/api/auth/devices?token=${TOKEN}&mac=AA:BB:CC:DD:EE:FF`);
    expect(res.status).toBe(404);
  });
});