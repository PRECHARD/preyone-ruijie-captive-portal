import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const { mockPoolQuery, transitAudit, transitSecurityEvent } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  transitAudit: vi.fn(),
  transitSecurityEvent: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({
  pool: { query: mockPoolQuery },
}));

vi.mock('../src/middleware/transitAuth', () => ({
  requireTransitDevice: vi.fn(),
  requireTransitSession: vi.fn(),
  getTransitJwtSecret: () => 'test-secret',
  compareVersions: () => true,
  requireTransitRoles: (...roles: string[]) => (req: any, res: any, next: any) => {
    if (!req.transit || !roles.includes(req.transit.user?.role)) {
      res.status(403).json({ error: 'You do not have permission to perform this action' });
      return;
    }
    next();
  },
}));

vi.mock('../src/services/transitAudit', () => ({
  transitAudit,
  transitSecurityEvent,
}));

import { transitRouter } from '../src/routes/transit';
import { requireTransitSession, requireTransitDevice } from '../src/middleware/transitAuth';

const TEST_PASSWORD = 'PhoneTest!1';
const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

const USER_ROW = {
  id: 'u1',
  company_id: 'c1',
  username: 'transit_test',
  full_name: 'Transit Test',
  role: 'SUPER_ADMIN',
  phone: '+263771000001',
  password_hash: TEST_HASH,
  user_status: 'ACTIVE',
  company_status: 'ACTIVE',
  company_name: 'Preyone Transit',
};

const COMPANY_ROW = {
  id: 'c1',
  name: 'Preyone Transit',
  slug: 'preyone-transit',
  tagline: '',
  address: '',
  email: '',
  website: '',
  customer_care: '',
  currency: 'USD',
  default_receipt_prefix: 'PT',
  offline_lease_days: 7,
  min_app_version: '',
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transit', transitRouter);
  return app;
}

function mockLoginQueries(overrides: any = {}) {
  mockPoolQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM transit_users')) {
      return Promise.resolve({ rows: [overrides.userRow ?? USER_ROW] });
    }
    if (sql.includes('SELECT * FROM transit_companies')) {
      return Promise.resolve({ rows: [COMPANY_ROW] });
    }
    if (sql.includes('FROM transit_devices')) {
      return Promise.resolve({ rows: overrides.devices ?? [] });
    }
    if (sql.includes('UPDATE transit_devices')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('INTERVAL')) {
      return Promise.resolve({ rows: [{ expiry: '2026-09-23T00:00:00.000Z' }] });
    }
    // Effective permissions (role defaults + per-user + company grants), used
    // to gate the app's UI the same way the API gates its writes.
    if (sql.includes('role_permissions')) {
      return Promise.resolve({ rows: overrides.permissions ?? [] });
    }
    throw new Error('Unexpected query: ' + sql);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  transitAudit.mockReset();
  transitSecurityEvent.mockReset();
  mockLoginQueries();
});

describe('POST /api/v1/transit/auth/login', () => {
  it('logs in a valid username/password and issues a session token', async () => {
    const res = await request(createApp())
      .post('/api/v1/transit/auth/login')
      .send({ username: 'transit_test', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.sessionToken).toBe('string');
    expect(res.body.sessionToken.length).toBeGreaterThan(20);
    expect(res.body.user).toEqual({
      id: 'u1',
      username: 'transit_test',
      fullName: 'Transit Test',
      role: 'SUPER_ADMIN',
      phone: '+263771000001',
      permissions: [],
    });
    expect(res.body.needsDeviceRegistration).toBe(true);
    expect(res.body.device).toBeNull();
  });

  it('returns the effective permission list so the app can gate its UI', async () => {
    mockLoginQueries({
      permissions: [
        { permission_code: 'transit.field_app' },
        { permission_code: 'route.templates.manage' },
      ],
    });

    const res = await request(createApp())
      .post('/api/v1/transit/auth/login')
      .send({ username: 'transit_test', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.permissions).toEqual([
      'transit.field_app',
      'route.templates.manage',
    ]);
  });

  it('passes role, user and company to the permission lookup', async () => {
    mockLoginQueries({ permissions: [] });

    await request(createApp())
      .post('/api/v1/transit/auth/login')
      .send({ username: 'transit_test', password: TEST_PASSWORD });

    // The company id is what lets a company-wide grant reach a field-staff
    // owner, so it must be part of the lookup.
    const permCall = mockPoolQuery.mock.calls.find(
      c => String(c[0]).includes('role_permissions')
    );
    expect(permCall).toBeDefined();
    expect(permCall![1]).toEqual(['SUPER_ADMIN', 'u1', 'c1']);
  });

  it('rejects a wrong password with 401 and logs a failed-login event', async () => {
    const res = await request(createApp())
      .post('/api/v1/transit/auth/login')
      .send({ username: 'transit_test', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(transitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'FAILED_LOGIN' })
    );
  });

  it('issues a device token for a bound, active device that matches the deviceUuid', async () => {
    mockLoginQueries({
      devices: [{ id: 'dev-1', device_uuid: 'uuid-1', status: 'ACTIVE', device_model: 'Android', app_version: '2.1.0' }],
    });

    const res = await request(createApp())
      .post('/api/v1/transit/auth/login')
      .send({ username: 'transit_test', password: TEST_PASSWORD, deviceUuid: 'uuid-1', appVersion: '2.1.0' });

    expect(res.status).toBe(200);
    expect(typeof res.body.deviceToken).toBe('string');
    expect(res.body.deviceToken.length).toBeGreaterThan(20);
    expect(res.body.needsDeviceRegistration).toBe(false);
    expect(res.body.licenseExpiresAt).toBeTruthy();
  });
});

describe('GET /api/v1/transit/staff — roster (registry + login DRIVER/CONDUCTOR)', () => {
  const CONDUCTOR_ROW = {
    id: 'u-con-1',
    role: 'CONDUCTOR',
    full_name: 'Praise Muvirimi',
    phone: '+263772555830',
    license_no: '',
    status: 'ACTIVE',
  };

  function mockStaffQueries(rows: any[] = [CONDUCTOR_ROW]) {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('UNION ALL')) return Promise.resolve({ rows });
      throw new Error('Unexpected query: ' + sql);
    });
  }

  beforeEach(() => {
    (requireTransitDevice as any).mockImplementation((req: any, _res: any, next: any) => {
      req.transit = { user: { id: 'u1', companyId: 'c1', role: 'SUPER_ADMIN' }, device: { id: 'dev-1' } };
      next();
    });
  });

  it('returns login DRIVER/CONDUCTOR accounts with phone + phone_number', async () => {
    mockStaffQueries();
    const res = await request(createApp()).get('/api/v1/transit/staff');

    expect(res.status).toBe(200);
    expect(res.body.staff).toHaveLength(1);
    expect(res.body.staff[0]).toEqual({
      id: 'u-con-1',
      role: 'CONDUCTOR',
      fullName: 'Praise Muvirimi',
      phone: '+263772555830',
      phone_number: '+263772555830',
      licenseNo: '',
      status: 'ACTIVE',
    });
  });

  it('passes the role filter (role=CONDUCTOR) as the second query param', async () => {
    mockStaffQueries([]);
    const res = await request(createApp()).get('/api/v1/transit/staff?role=CONDUCTOR');

    expect(res.status).toBe(200);
    expect(res.body.staff).toEqual([]);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['c1', 'CONDUCTOR']);
  });

  it('rejects an invalid role with 422', async () => {
    mockStaffQueries([]);
    const res = await request(createApp()).get('/api/v1/transit/staff?role=CEO');

    expect(res.status).toBe(422);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/transit/devices/register — hardware blacklist', () => {
  const ED = crypto.generateKeyPairSync('ed25519');
  const PUB_B64U = (ED.publicKey.export({ format: 'jwk' }) as { x: string }).x;

  function mockRegisterQueries(overrides: any = {}) {
    mockPoolQuery.mockImplementation((sql: string, params: any[]) => {
      if (sql.includes('FROM blocked_devices')) {
        return Promise.resolve({ rows: overrides.blocked ? [overrides.blocked] : [] });
      }
      if (sql.includes('SELECT * FROM transit_companies')) {
        return Promise.resolve({ rows: [COMPANY_ROW] });
      }
      if (sql.includes('FROM transit_devices WHERE id = $1')) {
        return Promise.resolve({ rows: [{ id: 'dev-x', company_id: 'c1', user_id: 'u1', device_uuid: 'NEW-UUID' }] });
      }
      if (sql.includes('FROM transit_devices WHERE device_uuid = $1')) {
        return Promise.resolve({ rows: overrides.owned || [] });
      }
      if (sql.includes('UPDATE transit_devices')) {
        return Promise.resolve({ rows: [{ id: overrides.updatedId || 'dev-owned' }] });
      }
      if (sql.includes('FROM transit_devices')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO transit_devices')) {
        return Promise.resolve({ rows: [{ id: 'dev-x' }] });
      }
      if (sql.includes('INTERVAL')) {
        return Promise.resolve({ rows: [{ expiry: '2026-09-23T00:00:00.000Z' }] });
      }
      throw new Error('Unexpected query: ' + sql);
    });
  }

  function mockSession() {
    (requireTransitSession as any).mockImplementation((req: any, _res: any, next: any) => {
      req.transitSession = { session: { sub: 'u1', companyId: 'c1', role: 'SUPER_ADMIN', username: 'transit_test' } };
      next();
    });
  }

  it('rejects registration with 403 DEVICE_BLOCKED when the device is on the blacklist', async () => {
    mockSession();
    mockRegisterQueries({ blocked: { id: 'b1', hardware_id: 'BLOCKED-UUID', hardware_type: 'UUID', reason: 'Stolen device' } });

    const res = await request(createApp())
      .post('/api/v1/transit/devices/register')
      .send({ deviceUuid: 'BLOCKED-UUID', devicePublicKey: PUB_B64U, deviceModel: 'A6 POS', appVersion: '2.6.0' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEVICE_BLOCKED');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['BLOCKED-UUID']);
    expect(transitSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'HARDWARE_BLOCKED' }));
    expect(transitAudit).not.toHaveBeenCalled();
  });

  it('rejects registration with 409 DEVICE_BOUND_OTHER when the terminal belongs to another account', async () => {
    mockSession();
    mockRegisterQueries({ owned: [{ id: 'dev-other', user_id: 'u-other' }] });

    const res = await request(createApp())
      .post('/api/v1/transit/devices/register')
      .send({ deviceUuid: 'OTHER-UUID', devicePublicKey: PUB_B64U, deviceModel: 'A6 POS', appVersion: '2.6.0' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEVICE_BOUND_OTHER');
    expect(res.body.error).toContain('already bound to another account');
    expect(transitSecurityEvent).not.toHaveBeenCalled();
  });

  it('re-registers a released UNBOUND terminal (user_id NULL) to a new account', async () => {
    mockSession();
    mockRegisterQueries({ owned: [{ id: 'dev-released', user_id: null }] });

    const res = await request(createApp())
      .post('/api/v1/transit/devices/register')
      .send({ deviceUuid: 'RELEASED-UUID', devicePublicKey: PUB_B64U, deviceModel: 'A6 POS', appVersion: '2.6.0' });

    expect(res.status).toBe(201);
    expect(res.body.device.status).toBe('ACTIVE');
    const updateCall = mockPoolQuery.mock.calls.find(c => c[0].includes('UPDATE transit_devices'));
    expect(updateCall).toBeTruthy();
    // Rebind to the new staff member: user_id = $6, company_id = $7, WHERE id = $8
    expect(updateCall![1][5]).toBe('u1');
    expect(updateCall![1][6]).toBe('c1');
    expect(updateCall![1][7]).toBe('dev-released');
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'DEVICE_REGISTERED' }));
  });

  it('allows registration once the hardware has been unblocked', async () => {
    mockSession();
    mockRegisterQueries();

    const res = await request(createApp())
      .post('/api/v1/transit/devices/register')
      .send({ deviceUuid: 'NEW-UUID', devicePublicKey: PUB_B64U, deviceModel: 'A6 POS', appVersion: '2.6.0' });

    expect(res.status).toBe(201);
    expect(res.body.device.status).toBe('ACTIVE');
    expect(transitSecurityEvent).not.toHaveBeenCalled();
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'DEVICE_REGISTERED' }));
  });
});