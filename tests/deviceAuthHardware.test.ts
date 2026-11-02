import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn() },
}));

import { pool } from '../src/db/pool';
import { requireDeviceAuth, deviceTenant, FINGERPRINT_HEADER } from '../src/middleware/deviceAuth';
import { hashFingerprint } from '../src/services/posLease';

const query = pool.query as unknown as ReturnType<typeof vi.fn>;

const FINGERPRINT = 'cpu:ABC|board:ZZ|disk:42';
const TOKEN = 'a'.repeat(64);

function makeReq(overrides: { fingerprint?: string; token?: string } = {}): any {
  const headers: Record<string, string> = {};
  if (overrides.token !== undefined) headers.authorization = `Bearer ${overrides.token}`;
  else headers.authorization = `Bearer ${TOKEN}`;
  if (overrides.fingerprint) headers[FINGERPRINT_HEADER] = overrides.fingerprint;
  return { headers };
}

function makeRes(): any {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function deviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    device_id: 'TILL-1',
    company_id: 'company-1',
    shop_id: 3,
    status: 'active',
    last_seen_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    fingerprint_hash: hashFingerprint(FINGERPRINT),
    lease_expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    lease_days: 7,
    ...overrides,
  };
}

describe('requireDeviceAuth — hardware binding and lease cut-off', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('rejects a request without a bearer token', async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireDeviceAuth({ headers: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unknown or revoked token', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes();
    const next = vi.fn();
    await requireDeviceAuth(makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toContain('Invalid or revoked');
  });

  it('rejects a bound token when no fingerprint is presented', async () => {
    query.mockResolvedValueOnce({ rows: [deviceRow()] });
    const res = makeRes();
    const next = vi.fn();
    await requireDeviceAuth(makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe('DEVICE_FINGERPRINT_MISMATCH');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a bound token replayed on different hardware', async () => {
    query.mockResolvedValueOnce({ rows: [deviceRow()] });
    const res = makeRes();
    const next = vi.fn();
    await requireDeviceAuth(makeReq({ fingerprint: 'stolen laptop' }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe('DEVICE_FINGERPRINT_MISMATCH');
  });

  it('accepts matching hardware and marks the device bound', async () => {
    query
      .mockResolvedValueOnce({ rows: [deviceRow()] })
      .mockResolvedValueOnce({ rows: [] }); // last_seen touch
    const req = makeReq({ fingerprint: FINGERPRINT });
    const res = makeRes();
    const next = vi.fn();
    await requireDeviceAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.device).toMatchObject({ device_id: 'TILL-1', company_id: 'company-1', shop_id: 3, bound: true });
    expect(req.device.leaseRemainingMs).toBeGreaterThan(0);
    expect(deviceTenant(req)).toBe('company-1');
  });

  it('refuses an expired offline lease even with valid hardware', async () => {
    query.mockResolvedValueOnce({
      rows: [deviceRow({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })],
    });
    const res = makeRes();
    const next = vi.fn();
    await requireDeviceAuth(makeReq({ fingerprint: FINGERPRINT }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe('LEASE_EXPIRED');
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a device that has not checked in inside its lease window', async () => {
    query.mockResolvedValueOnce({
      rows: [
        deviceRow({
          last_seen_at: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
          last_seen: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
    });
    const res = makeRes();
    const next = vi.fn();
    await requireDeviceAuth(makeReq({ fingerprint: FINGERPRINT }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe('LEASE_EXPIRED');
  });

  it('lets an unbound device authenticate (pre-enrolment compatibility)', async () => {
    query
      .mockResolvedValueOnce({ rows: [deviceRow({ fingerprint_hash: null, lease_expires_at: null })] })
      .mockResolvedValueOnce({ rows: [] });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    await requireDeviceAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.device.bound).toBe(false);
  });

  it('returns a null tenant for unassigned hardware', async () => {
    query
      .mockResolvedValueOnce({ rows: [deviceRow({ company_id: null })] })
      .mockResolvedValueOnce({ rows: [] });
    const req = makeReq({ fingerprint: FINGERPRINT });
    const res = makeRes();
    const next = vi.fn();
    await requireDeviceAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(deviceTenant(req)).toBeNull();
  });
});
