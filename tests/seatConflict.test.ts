import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { buildCanonicalTicketPayload, verifyDeviceSignature } from '../src/routes/transit';

const { mockPoolQuery, mockClientRelease, mockPoolConnect, transitAudit, transitSecurityEvent } = vi.hoisted(() => {
  const mockPoolQuery = vi.fn();
  const mockClientRelease = vi.fn();
  const mockPoolConnect = vi.fn().mockResolvedValue({
    query: mockPoolQuery,
    release: mockClientRelease,
  });
  return { mockPoolQuery, mockClientRelease, mockPoolConnect, transitAudit: vi.fn(), transitSecurityEvent: vi.fn() };
});

vi.mock('../src/db/pool', () => ({
  pool: { query: mockPoolQuery, connect: mockPoolConnect },
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

import { requireTransitDevice } from '../src/middleware/transitAuth';
import { transitRouter } from '../src/routes/transit';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transit', transitRouter);
  return app;
}

function mockDeviceAuth() {
  (requireTransitDevice as any).mockImplementation((_req: any, _res: any, next: any) => {
    _req.transit = {
      user: { id: 'u1', companyId: 'c1', username: 'admin', fullName: 'Admin', role: 'SUPER_ADMIN', permissions: ['company.admin'] },
      device: { id: 'dev-1', companyId: 'c1', userId: 'u1', deviceUuid: 'd1', status: 'ACTIVE' },
      minAppVersion: '',
    };
    next();
  });
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubB64u = (() => {
  const jwk: any = publicKey.export({ format: 'jwk' });
  return jwk.x.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
})();

function signedTicket(overrides: any = {}) {
  const t = {
    txId: 'tx-1',
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
    items: [{ name: 'Adult', qty: 1, price: 2 }],
    totalCents: 200,
    cashCents: 200,
    changeCents: 0,
    saleTime: '2026-09-16 09:00:00',
    ...overrides,
  };
  const payloadStr = buildCanonicalTicketPayload({
    txId: t.txId,
    clientReceiptNo: t.clientReceiptNo,
    tripNo: t.tripNo,
    routeCode: t.routeCode,
    routeName: t.routeName,
    driver: t.driver,
    driverPhone: t.driverPhone,
    conductor1: t.conductor1,
    conductor2: t.conductor2,
    conductorPhone: t.conductorPhone,
    seatNumber: t.seatNumber,
    customerName: t.customerName,
    customerMobile: t.customerMobile,
    itemsJson: JSON.stringify(t.items),
    totalCents: t.totalCents,
    cashCents: t.cashCents,
    changeCents: t.changeCents,
    saleTime: t.saleTime,
  });
  const sig = crypto.sign(null, Buffer.from(payloadStr, 'utf8'), privateKey);
  return { ...t, signature: sig.toString('base64') };
}

function mockQueries(insert: () => Promise<any> | any) {
  mockPoolQuery.mockImplementation((sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
    if (sql.includes('device_key')) return Promise.resolve({ rows: [{ device_key: pubB64u }] });
    if (sql.includes('WHERE tx_id =')) return Promise.resolve({ rows: [] });
    if (sql.includes('INSERT INTO transit_tickets')) return insert();
    if (sql.includes('INTERVAL')) return Promise.resolve({ rows: [{ expiry: '2026-09-23T00:00:00.000Z' }] });
    if (sql.includes('offline_lease_days')) return Promise.resolve({ rows: [{ offline_lease_days: 7, min_app_version: '' }] });
    if (sql.includes('UPDATE transit_devices')) return Promise.resolve({ rows: [] });
    if (sql.includes('seat_number')) return Promise.resolve({ rows: [] });
    throw new Error('Unexpected query: ' + sql);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  transitSecurityEvent.mockReset();
  transitAudit.mockReset();
  mockPoolConnect.mockResolvedValue({ query: mockPoolQuery, release: mockClientRelease });
  mockDeviceAuth();
  mockQueries(() => ({ rows: [{ id: 1 }] }));
});

describe('POST /api/v1/transit/sync — seat lock (financial integrity)', () => {
  it('marks a second device booking the same seat as SEAT_CONFLICT via the DB unique index (23505)', async () => {
    // Two devices booked the same seat on the same trip: the DB partial unique
    // index idx_transit_tickets_seat_lock (company_id, trip_no, seat_number)
    // WHERE status != 'CANCELLED' fires and must become a SEAT_CONFLICT, never a 500.
    mockQueries(() => {
      throw { code: '23505', constraint: 'idx_transit_tickets_seat_lock' };
    });

    const res = await request(createApp())
      .post('/api/v1/transit/sync')
      .send({ tickets: [signedTicket({ txId: 'tx-2' })] });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(0);
    expect(res.body.duplicates).toBe(0);
    expect(res.body.conflicts).toBe(1);
    expect(res.body.device.status).toBe('ACTIVE');
    expect(transitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'SEAT_CONFLICT' })
    );
  });

  it('syncs a unique seat on a unique trip without conflicts', async () => {
    const res = await request(createApp())
      .post('/api/v1/transit/sync')
      .send({ tickets: [signedTicket()] });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);
    expect(res.body.conflicts).toBe(0);
    expect(res.body.rejected).toEqual([]);
    expect(transitSecurityEvent).not.toHaveBeenCalled();
  });

  it('flags a duplicated seat within the same upload batch as a conflict without rejecting the sale', async () => {
    const res = await request(createApp())
      .post('/api/v1/transit/sync')
      .send({
        tickets: [
          signedTicket({ txId: 'tx-a' }),
          signedTicket({ txId: 'tx-b', seatNumber: '12A' }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(2);
    expect(res.body.conflicts).toBe(1);
  });
});