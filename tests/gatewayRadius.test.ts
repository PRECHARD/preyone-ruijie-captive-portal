import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

import { pool } from '../src/db/pool';
import { gatewayRouter } from '../src/routes/gateway';
import { normalizeMac, bindDevice, getDeviceLimit, unbindDevice, __setRuijieConfiguredProbe } from '../src/services/deviceBinding';

const VOUCHER_ID = 'v-1';
const VOUCHER_CODE = 'PRELINK-ABCD12';

function createApp() {
  const app = express();
  app.use(gatewayRouter);
  return app;
}

/**
 * Routes a client-side query stream by SQL text. bindDevice() runs a fixed
 * BEGIN / lock / lookup / count / insert / COMMIT sequence, and the assertions
 * care about which statements ran rather than their order.
 */
function stubBindingClient(opts: {
  existingDevice?: { id: string; is_active: boolean } | null;
  activeCount?: number;
  maxDevices?: number;
  packageTier?: string | null;
  insertShouldFail?: boolean;
}) {
  const clientQuery = vi.fn(async (sql: string, params?: any[]) => {
    const q = String(sql).trim();
    if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK') return { rows: [] };
    if (q.includes('FROM vouchers WHERE id = $1 FOR UPDATE')) {
      return { rows: [{ id: VOUCHER_ID, package_tier: opts.packageTier ?? 'PreLink', max_devices: opts.maxDevices ?? null }] };
    }
    if (q.includes('FROM voucher_devices') && q.includes('mac_norm = $2')) {
      return { rows: opts.existingDevice ? [opts.existingDevice] : [] };
    }
    if (q.includes('count(*)::int AS n FROM voucher_devices')) {
      return { rows: [{ n: opts.activeCount ?? 0 }] };
    }
    if (q.includes('INSERT INTO voucher_devices')) {
      if (opts.insertShouldFail) throw new Error('insert exploded');
      return { rows: [] };
    }
    if (q.startsWith('UPDATE voucher_devices')) return { rows: [], rowCount: 1 };
    throw new Error('unstubbed client query: ' + q.slice(0, 70));
  });
  (pool.connect as any).mockResolvedValue({ query: clientQuery, release: vi.fn() });
  return clientQuery;
}

beforeEach(() => {
  vi.resetAllMocks();
  __setRuijieConfiguredProbe(null);
});

describe('normalizeMac', () => {
  it('accepts every common spelling', () => {
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('AABBCCDDEEFF');
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('AABBCCDDEEFF');
    expect(normalizeMac('AABBCCDDEEFF')).toBe('AABBCCDDEEFF');
    expect(normalizeMac('  aa:bb:cc:dd:ee:ff ')).toBe('AABBCCDDEEFF');
  });

  it('rejects anything that is not a 12-hex MAC', () => {
    expect(normalizeMac('AABBCC')).toBeNull();
    expect(normalizeMac('not-a-mac')).toBeNull();
    expect(normalizeMac('')).toBeNull();
    expect(normalizeMac(null)).toBeNull();
  });
});

describe('getDeviceLimit', () => {
  it('prefers Ruijie user-group no_of_device when Ruijie is configured', async () => {
    __setRuijieConfiguredProbe(() => true);
    (pool.query as any).mockResolvedValueOnce({ rows: [{ no_of_device: 4 }] });

    const limit = await getDeviceLimit('PreMax', 1);
    expect(limit).toBe(4);
  });

  it('falls back to vouchers.max_devices when Ruijie is not configured', async () => {
    expect(await getDeviceLimit('PreLink', 3)).toBe(3);
  });

  it('defaults to 1 rather than being open-ended', async () => {
    expect(await getDeviceLimit('PreLink', null)).toBe(1);
    expect(await getDeviceLimit('PreLink', 0)).toBe(1);
    expect(await getDeviceLimit(null, null)).toBe(1);
  });

  it('survives a Ruijie outage instead of throwing', async () => {
    __setRuijieConfiguredProbe(() => true);
    (pool.query as any).mockRejectedValueOnce(new Error('ruijie down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getDeviceLimit('PreLink', 2)).toBe(2);
    expect(errors).toHaveBeenCalled();
  });
});

describe('bindDevice', () => {
  it('binds a new device when slots remain', async () => {
    const clientQuery = stubBindingClient({ activeCount: 0, maxDevices: 3 });

    const res = await bindDevice({
      voucherId: VOUCHER_ID,
      voucherCode: VOUCHER_CODE,
      tierName: 'PreLink',
      maxDevices: 3,
      mac: 'AA:BB:CC:DD:EE:FF',
    });

    expect(res).toEqual({ ok: true, bound: true, activeDevices: 1, limit: 3 });
    const insert = clientQuery.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO voucher_devices'));
    expect(insert).toBeDefined();
    // MAC is persisted normalized so RADIUS lookups are an index hit.
    expect(insert[1][4]).toBe('AABBCCDDEEFF');
  });

  it('locks the voucher row before counting so concurrent devices cannot overshoot', async () => {
    const clientQuery = stubBindingClient({ activeCount: 0, maxDevices: 2 });
    await bindDevice({ voucherId: VOUCHER_ID, voucherCode: VOUCHER_CODE, tierName: null, maxDevices: 2, mac: 'AA:BB:CC:DD:EE:01' });

    const sqls = clientQuery.mock.calls.map((c: any[]) => String(c[0]).trim());
    const lockAt = sqls.findIndex((s) => s.includes('FOR UPDATE'));
    const countAt = sqls.findIndex((s) => s.includes('count(*)::int AS n'));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(countAt).toBeGreaterThan(lockAt);
  });

  it('reconnects an already-bound device without consuming another slot', async () => {
    const clientQuery = stubBindingClient({
      existingDevice: { id: 'd-1', is_active: true },
      activeCount: 1,
      maxDevices: 1,
    });

    const res = await bindDevice({
      voucherId: VOUCHER_ID, voucherCode: VOUCHER_CODE, tierName: null, maxDevices: 1,
      mac: 'AA:BB:CC:DD:EE:FF',
    });

    // bound=false is the important part: no INSERT, no new slot.
    expect(res).toEqual({ ok: true, bound: false, activeDevices: 1, limit: 1 });
    const insert = clientQuery.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO voucher_devices'));
    expect(insert).toBeUndefined();
    const update = clientQuery.mock.calls.find((c: any[]) => String(c[0]).startsWith('UPDATE voucher_devices'));
    expect(update).toBeDefined();
  });

  it('reactivates a previously unbound device', async () => {
    stubBindingClient({ existingDevice: { id: 'd-1', is_active: false }, activeCount: 0, maxDevices: 1 });
    const res = await bindDevice({
      voucherId: VOUCHER_ID, voucherCode: VOUCHER_CODE, tierName: null, maxDevices: 1, mac: 'AA:BB:CC:DD:EE:FF',
    });
    expect(res.ok).toBe(true);
    expect(res.ok && res.bound).toBe(false);
  });

  it('refuses a new device once the limit is reached', async () => {
    const clientQuery = stubBindingClient({ activeCount: 2, maxDevices: 2 });

    const res = await bindDevice({
      voucherId: VOUCHER_ID, voucherCode: VOUCHER_CODE, tierName: null, maxDevices: 2, mac: 'AA:BB:CC:DD:EE:03',
    });

    expect(res).toEqual({ ok: false, reason: 'device_limit_reached', activeDevices: 2, limit: 2 });
    const insert = clientQuery.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO voucher_devices'));
    expect(insert).toBeUndefined();
    const rollback = clientQuery.mock.calls.find((c: any[]) => String(c[0]).trim() === 'ROLLBACK');
    expect(rollback).toBeDefined();
  });

  it('rejects a malformed MAC without touching the database', async () => {
    const res = await bindDevice({
      voucherId: VOUCHER_ID, voucherCode: VOUCHER_CODE, tierName: null, maxDevices: 1, mac: 'garbage',
    });
    expect(res).toEqual({ ok: false, reason: 'invalid_mac' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows when the insert fails', async () => {
    const clientQuery = stubBindingClient({ activeCount: 0, maxDevices: 3, insertShouldFail: true });

    await expect(
      bindDevice({ voucherId: VOUCHER_ID, voucherCode: VOUCHER_CODE, tierName: null, maxDevices: 3, mac: 'AA:BB:CC:DD:EE:04' })
    ).rejects.toThrow('insert exploded');

    const sqls = clientQuery.mock.calls.map((c: any[]) => String(c[0]).trim());
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });
});

describe('unbindDevice', () => {
  it('deactivates the device row', async () => {
    (pool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await unbindDevice(VOUCHER_ID, 'aa:bb:cc:dd:ee:ff')).toBe(true);
    const call = (pool.query as any).mock.calls[0];
    expect(call[1][1]).toBe('AABBCCDDEEFF');
  });

  it('returns false for a malformed MAC', async () => {
    expect(await unbindDevice(VOUCHER_ID, 'nope')).toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// The RADIUS endpoint is the only thing standing between a device and the
// internet, and it had no test coverage before the voucher-code branch.
describe('GET /api/radius/auth', () => {
  const SESSION_ROW = {
    session_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    session_end: null,
    bandwidth_up_kbps: 2000,
    bandwidth_down_kbps: 5000,
    data_quota_bytes: 1024,
    data_used_bytes: 0,
    is_uncapped: false,
  };

  const VOUCHER_ROW = {
    voucher_id: VOUCHER_ID,
    code: VOUCHER_CODE,
    package_tier: 'PreLink',
    max_devices: 2,
    user_id: 'u-1',
    session_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    bandwidth_up_kbps: 2048,
    bandwidth_down_kbps: 5120,
    data_quota_bytes: 2048,
    data_used_bytes: 0,
    is_uncapped: false,
    session_end: null,
  };

  function stubRadius(macRows: any[], voucherRows: any[] = []) {
    (pool.query as any).mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('FROM vouchers v')) return { rows: voucherRows };
      if (q.includes('FROM users u')) return { rows: macRows };
      throw new Error('unstubbed pool.query: ' + q.slice(0, 70));
    });
  }

  it('still authorizes a device bound at redemption (regression)', async () => {
    stubRadius([SESSION_ROW]);

    const res = await request(createApp())
      .get('/api/radius/auth?mac=AA:BB:CC:DD:EE:FF&username=AA:BB:CC:DD:EE:FF');

    expect(res.status).toBe(200);
    expect(res.body['control:Auth-Type']).toBe('Accept');
    expect(res.body['WISPr-Bandwidth-Max-Down']).toBe(5000);
    expect(res.body['ChilliSpot-Max-Total-Octets']).toBe(1024);
  });

  it('requires mac or username', async () => {
    const res = await request(createApp()).get('/api/radius/auth');
    expect(res.status).toBe(400);
  });

  it('binds and authorizes a new device presenting a code it owns', async () => {
    stubRadius([], [VOUCHER_ROW]);
    stubBindingClient({ activeCount: 0, maxDevices: 2 });

    const res = await request(createApp())
      .get(`/api/radius/auth?mac=AA:BB:CC:DD:EE:07&username=${VOUCHER_CODE}`);

    expect(res.status).toBe(200);
    expect(res.body['control:Auth-Type']).toBe('Accept');
    // Attributes come from the voucher's active session, not the device row.
    expect(res.body['WISPr-Bandwidth-Max-Down']).toBe(5120);
  });

  it('accepts a lowercase/whitespace code from the gateway', async () => {
    stubRadius([], [VOUCHER_ROW]);
    stubBindingClient({ activeCount: 0, maxDevices: 2 });

    const res = await request(createApp())
      .get('/api/radius/auth?mac=AA:BB:CC:DD:EE:08&username=%20prelink-abcd12%20');

    expect(res.status).toBe(200);
    expect(res.body['control:Auth-Type']).toBe('Accept');
  });

  it('refuses a new device once the voucher device limit is reached', async () => {
    stubRadius([], [VOUCHER_ROW]);
    stubBindingClient({ activeCount: 2, maxDevices: 2 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(createApp())
      .get(`/api/radius/auth?mac=AA:BB:CC:DD:EE:09&username=${VOUCHER_CODE}`);

    expect(res.status).toBe(404);
  });

  it('refuses an unknown code without binding anything', async () => {
    stubRadius([], []);

    const res = await request(createApp())
      .get('/api/radius/auth?mac=AA:BB:CC:DD:EE:0A&username=NOSUCHCODE');

    expect(res.status).toBe(404);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('does not bind anything when the gateway sends no MAC', async () => {
    stubRadius([], [VOUCHER_ROW]);

    const res = await request(createApp())
      .get(`/api/radius/auth?username=${VOUCHER_CODE}`);

    expect(res.status).toBe(404);
    expect(pool.connect).not.toHaveBeenCalled();
  });

it('does not attempt to bind a device when the MAC is unusable', async () => {
    // The gateway sometimes sends a placeholder instead of a real MAC. Binding
    // must be skipped rather than writing a junk device row.
    stubRadius([], [VOUCHER_ROW]);

    const res = await request(createApp())
      .get('/api/radius/auth?mac=not-a-mac&username=' + VOUCHER_CODE);

    expect(res.status).toBe(404);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────
  // Data-quota enforcement. The gateway is told the cap via
  // ChilliSpot-Max-Total-Octets, but if it ever ignores that attribute the
  // client browses for free. The portal rejects as well so the cap holds
  // regardless of gateway behaviour.
  describe('data quota enforcement', () => {
    const at = (used: number) => ({ ...SESSION_ROW, data_quota_bytes: 1024, data_used_bytes: used });

    it('rejects a session that has burned through its allowance', async () => {
      stubRadius([at(1024)]);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await request(createApp())
        .get('/api/radius/auth?mac=AA:BB:CC:DD:EE:FF&username=AA:BB:CC:DD:EE:FF');

      // 403 => explicit reject, distinct from the 404 "no such session".
      expect(res.status).toBe(403);
      expect(res.body['control:Auth-Type']).toBe('Reject');
    });

    it('treats exactly reaching the quota as exhausted', async () => {
      stubRadius([at(1024)]);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await request(createApp())
        .get('/api/radius/auth?mac=AA:BB:CC:DD:EE:FF&username=AA:BB:CC:DD:EE:FF');

      expect(res.status).toBe(403);
    });

    it('still authorizes one byte under the quota', async () => {
      stubRadius([at(1023)]);

      const res = await request(createApp())
        .get('/api/radius/auth?mac=AA:BB:CC:DD:EE:FF&username=AA:BB:CC:DD:EE:FF');

      expect(res.status).toBe(200);
      expect(res.body['control:Auth-Type']).toBe('Accept');
    });

    it('never rejects an uncapped session no matter how much it used', async () => {
      stubRadius([{ ...at(999_999_999_999), is_uncapped: true }]);

      const res = await request(createApp())
        .get('/api/radius/auth?mac=AA:BB:CC:DD:EE:FF&username=AA:BB:CC:DD:EE:FF');

      expect(res.status).toBe(200);
      expect(res.body['control:Auth-Type']).toBe('Accept');
      // Uncapped sessions must not advertise a cap to the gateway either.
      expect(res.body['ChilliSpot-Max-Total-Octets']).toBeUndefined();
    });

    it('treats a zero quota as "no cap set", not "zero bytes allowed"', async () => {
      stubRadius([{ ...at(5_000_000), data_quota_bytes: 0 }]);

      const res = await request(createApp())
        .get('/api/radius/auth?mac=AA:BB:CC:DD:EE:FF&username=AA:BB:CC:DD:EE:FF');

      expect(res.status).toBe(200);
    });

it('rejects an over-quota device presenting its voucher code', async () => {
      stubRadius([], [{ ...VOUCHER_ROW, data_used_bytes: 2048 }]);
      stubBindingClient({ activeCount: 0, maxDevices: 2 });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await request(createApp())
        .get(`/api/radius/auth?mac=AA:BB:CC:DD:EE:0B&username=${VOUCHER_CODE}`);

      expect(res.status).toBe(403);
    });
  });
});

describe('GET /api/gateway/quota', () => {
  function stubQuota(rows: any[]) {
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (String(sql).includes('voucher_devices') || String(sql).includes('WITH target AS')) {
        return { rows };
      }
      throw new Error('unstubbed pool.query: ' + String(sql).slice(0, 70));
    });
  }

  const row = (over: Partial<any> = {}) => ({
    data_quota_bytes: 1024,
    data_used_bytes: 0,
    is_uncapped: false,
    package_tier: 'PreLite',
    ...over,
  });

  it('requires a mac', async () => {
    const res = await request(createApp()).get('/api/gateway/quota');
    expect(res.status).toBe(400);
  });

  it('rejects a malformed mac without hitting the database', async () => {
    const res = await request(createApp()).get('/api/gateway/quota?mac=not-a-mac');
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('reports found=false for a MAC with no session', async () => {
    stubQuota([]);

    const res = await request(createApp()).get('/api/gateway/quota?mac=AA:BB:CC:DD:EE:FF');

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.exhausted).toBe(false);
  });

  it('reports exhausted=true once the allowance is used up', async () => {
    stubQuota([row({ data_used_bytes: 1024 })]);

    const res = await request(createApp()).get('/api/gateway/quota?mac=AA:BB:CC:DD:EE:FF');

    expect(res.body.found).toBe(true);
    expect(res.body.exhausted).toBe(true);
    expect(res.body.usedBytes).toBe(1024);
    expect(res.body.quotaBytes).toBe(1024);
  });

  it('reports exhausted=false while there is data left', async () => {
    stubQuota([row({ data_used_bytes: 10 })]);

    const res = await request(createApp()).get('/api/gateway/quota?mac=AA:BB:CC:DD:EE:FF');

    expect(res.body.exhausted).toBe(false);
  });

  it('never marks an uncapped session exhausted', async () => {
    stubQuota([row({ is_uncapped: true, data_quota_bytes: 0, data_used_bytes: 999_999 })]);

    const res = await request(createApp()).get('/api/gateway/quota?mac=AA:BB:CC:DD:EE:FF');

    expect(res.body.uncapped).toBe(true);
    expect(res.body.exhausted).toBe(false);
  });

  it('accepts any common MAC spelling', async () => {
    stubQuota([row()]);

    for (const mac of ['AA:BB:CC:DD:EE:FF', 'aa-bb-cc-dd-ee-ff', 'aabbccddeeff']) {
      const res = await request(createApp()).get('/api/gateway/quota?mac=' + mac);
      expect(res.status).toBe(200);
    }
    const call = (pool.query as any).mock.calls[0];
    expect(call[1][0]).toBe('AABBCCDDEEFF');
  });

  it('does not leak the voucher code to whoever knows the MAC', async () => {
    stubQuota([row({ package_tier: 'PreLite' })]);

    const res = await request(createApp()).get('/api/gateway/quota?mac=AA:BB:CC:DD:EE:FF');

    // A voucher code is a bearer credential for the whole allowance, so it must
    // never be echoed back by an endpoint reachable from the captive network.
    expect(JSON.stringify(res.body)).not.toContain(VOUCHER_CODE);
    expect(res.body.packageTier).toBe('PreLite');
  });

  it('resolves the redeeming device as well as later bound devices', async () => {
    stubQuota([row()]);

    await request(createApp()).get('/api/gateway/quota?mac=AA:BB:CC:DD:EE:FF');

    const sql = String((pool.query as any).mock.calls[0][0]);
    // The device that redeems is recorded on users.mac_address; a
    // voucher_devices row only exists for devices bound later with the same
    // code. Matching only voucher_devices reported found=false for the
    // redeeming device -- i.e. the notice never reached the main customer.
    expect(sql).toContain('UPPER(mac_address)');
    expect(sql).toContain('voucher_devices');
  });

  it('ignores a device whose session has already expired', async () => {
    stubQuota([row()]);

    await request(createApp()).get('/api/gateway/quota?mac=AA:BB:CC:DD:EE:FF');

    const sql = String((pool.query as any).mock.calls[0][0]);
    // An expired session should fall back to the voucher form, not be told its
    // data ran out.
    expect(sql).toContain('session_expires_at > NOW()');
  });
});