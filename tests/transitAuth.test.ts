import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { compareVersions, requireTransitDevice, requireTransitSession, getTransitJwtSecret } from '../src/middleware/transitAuth';
import { buildCanonicalTicketPayload, verifyDeviceSignature } from '../src/routes/transit';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../src/middleware/rbac', () => ({
  loadPermissions: vi.fn(() => Promise.resolve([])),
  FIELD_STAFF_ROLES: ['CONDUCTOR', 'DRIVER', 'TICKET_SELLER'],
  PERMISSIONS: { SYSTEM_DEVELOPER: 'system.developer', COMPANY_ADMIN: 'company.admin', OPERATIONS_MANAGE: 'operations.manage', FINANCE_VIEW: 'finance.view', TRANSIT_FIELD_APP: 'transit.field_app' },
  requirePermission: () => vi.fn((_req: any, _res: any, next: any) => next()),
  requireTransitPermission: () => vi.fn((_req: any, _res: any, next: any) => next()),
  scopeVoucherCondition: vi.fn(() => null),
  scopeUserVoucherCodeCondition: vi.fn(() => null),
}));

import { pool } from '../src/db/pool';

const makeReq = (token?: string, headers: Record<string, string> = {}): any => ({
  headers: {
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...headers,
  },
});

const makeRes = () => {
  const obj: any = {};
  obj.status = vi.fn().mockReturnValue(obj);
  obj.json = vi.fn().mockReturnValue(obj);
  return obj;
};

const SECRET = getTransitJwtSecret();

function deviceToken(overrides: any = {}) {
  return jwt.sign(
    {
      type: 'device',
      sub: 'u1',
      companyId: 'c1',
      deviceId: 'dev-1',
      deviceUuid: 'd1',
      username: 'admin',
      fullName: 'Admin',
      role: 'SUPER_ADMIN',
      ...overrides,
    },
    SECRET,
    { expiresIn: '1h' }
  );
}

describe('requireTransitDevice middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects requests without a Bearer token', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    await requireTransitDevice(req, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a non-device token', async () => {
    const token = jwt.sign({ type: 'session', sub: 'u1', companyId: 'c1', role: 'MANAGER', username: 'a' }, SECRET, { expiresIn: '1h' });
    const req = makeReq(token);
    const res = makeRes();
    const next = vi.fn();
    await requireTransitDevice(req, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a revoked/disabled device with the spec message', async () => {
    (pool.query as any).mockResolvedValue({
      rows: [{ id: 'dev-1', company_id: 'c1', user_id: 'u1', device_uuid: 'd1', device_status: 'REVOKED', app_version: '2.0.0', min_app_version: '', user_status: 'ACTIVE', company_status: 'ACTIVE', company_min_version: '' }],
    });
    const req = makeReq(deviceToken());
    const res = makeRes();
    const next = vi.fn();
    await requireTransitDevice(req, res as any, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DEVICE_DISABLED', error: 'This device has been disabled. Please contact your administrator.' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects devices below the required app version with 426', async () => {
    (pool.query as any).mockResolvedValue({
      rows: [{ id: 'dev-1', company_id: 'c1', user_id: 'u1', device_uuid: 'd1', device_status: 'ACTIVE', app_version: '1.5.0', min_app_version: '', user_status: 'ACTIVE', company_status: 'ACTIVE', company_min_version: '2.0.0' }],
    });
    const req = makeReq(deviceToken(), { 'x-app-version': '1.5.0' });
    const res = makeRes();
    const next = vi.fn();
    await requireTransitDevice(req, res as any, next);
    expect(res.status).toHaveBeenCalledWith(426);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'APP_UPDATE_REQUIRED', minAppVersion: '2.0.0' }));
  });

  it('allows an active device above the minimum version', async () => {
    (pool.query as any).mockResolvedValue({
      rows: [{ id: 'dev-1', company_id: 'c1', user_id: 'u1', device_uuid: 'd1', device_status: 'ACTIVE', app_version: '1.5.0', min_app_version: '', user_status: 'ACTIVE', user_role: 'SUPER_ADMIN', user_username: 'admin', user_full_name: 'Admin', company_status: 'ACTIVE', company_min_version: '2.0.0' }],
    });
    const req = makeReq(deviceToken(), { 'x-app-version': '2.1.0' });
    const res = makeRes();
    const next = vi.fn();
    await requireTransitDevice(req, res as any, next);
    expect(next).toHaveBeenCalled();
    expect(req.transit?.device.deviceUuid).toBe('d1');
  });

  it('uses the live DB role, not stale token claims', async () => {
    // Token claims say SUPER_ADMIN, but the DB now says OPERATOR — the DB must win.
    (pool.query as any).mockResolvedValue({
      rows: [{ id: 'dev-1', company_id: 'c1', user_id: 'u1', device_uuid: 'd1', device_status: 'ACTIVE', app_version: '2.0.0', min_app_version: '', user_status: 'ACTIVE', user_role: 'OPERATOR', user_username: 'operator1', user_full_name: 'Op One', company_status: 'ACTIVE', company_min_version: '' }],
    });
    const req = makeReq(deviceToken(), { 'x-app-version': '2.0.0' });
    const res = makeRes();
    const next = vi.fn();
    await requireTransitDevice(req, res as any, next);
    expect(next).toHaveBeenCalled();
    expect(req.transit?.user.role).toBe('OPERATOR');
    expect(req.transit?.user.username).toBe('operator1');
    expect(req.transit?.user.fullName).toBe('Op One');
  });
});

describe('requireTransitSession middleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a session for a disabled user', async () => {
    const token = jwt.sign({ type: 'session', sub: 'u1', companyId: 'c1', role: 'MANAGER', username: 'a' }, SECRET, { expiresIn: '1h' });
    (pool.query as any).mockResolvedValue({
      rows: [{ id: 'u1', company_id: 'c1', username: 'a', full_name: 'A', role: 'MANAGER', user_status: 'DISABLED', company_status: 'ACTIVE', min_app_version: '' }],
    });
    const req = makeReq(token);
    const res = makeRes();
    const next = vi.fn();
    await requireTransitSession(req, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('allows an active user and attaches the session', async () => {
    const token = jwt.sign({ type: 'session', sub: 'u1', companyId: 'c1', role: 'MANAGER', username: 'a' }, SECRET, { expiresIn: '1h' });
    (pool.query as any).mockResolvedValue({
      rows: [{ id: 'u1', company_id: 'c1', username: 'a', full_name: 'A', role: 'MANAGER', user_status: 'ACTIVE', company_status: 'ACTIVE', min_app_version: '' }],
    });
    const req = makeReq(token);
    const res = makeRes();
    const next = vi.fn();
    await requireTransitSession(req, res as any, next);
    expect(next).toHaveBeenCalled();
    expect(req.transitSession?.session.sub).toBe('u1');
  });
});

describe('signed ticket payload', () => {
  it('canonical payload verifies across a generated Ed25519 key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const jwk: any = publicKey.export({ format: 'jwk' });
    const pubB64u = jwk.x.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

    const t = {
      txId: 'tx-abc',
      clientReceiptNo: 'AGJ0001',
      tripNo: 'T-101',
      routeCode: 'HRE',
      routeName: '',
      driver: 'CHIDAVHARWI',
      driverPhone: '0779112233',
      conductor1: '',
      conductor2: '',
      conductorPhone: '',
      seatNumber: '12A',
      customerName: 'EDWARD CHIKOMBA',
      customerMobile: '0772223344',
      itemsJson: JSON.stringify([{ name: 'Adult', qty: 2, price: 2.0 }]),
      totalCents: 400,
      cashCents: 500,
      changeCents: 100,
      saleTime: '2026-09-15 15:45:26',
    };
    const payloadStr = buildCanonicalTicketPayload(t);
    const sig = crypto.sign(null, Buffer.from(payloadStr, 'utf8'), privateKey);
    expect(verifyDeviceSignature(pubB64u, sig.toString('base64'), payloadStr)).toBe(true);
    expect(verifyDeviceSignature(pubB64u, sig.toString('base64'), payloadStr + 'x')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('compares semver-style app versions', () => {
    expect(compareVersions('2.1.0', '2.0.0')).toBe(true);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(true);
    expect(compareVersions('1.9.9', '2.0.0')).toBe(false);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(true);
  });
});