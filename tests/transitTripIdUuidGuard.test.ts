import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { transitRouter } from '../src/routes/transit';

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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/transit', transitRouter);
  return app;
}

const REAL_TRIP_ID = '3f9b1c2d-4e5a-4b6c-8d7e-9f0a1b2c3d4e';

beforeEach(() => {
  vi.clearAllMocks();
  transitSecurityEvent.mockReset();
  transitAudit.mockReset();
  (requireTransitDevice as any).mockImplementation((_req: any, _res: any, next: any) => {
    _req.transit = {
      user: { id: 'u1', companyId: 'c1', username: 'admin', role: 'ADMIN' },
      device: { id: 'dev-1', companyId: 'c1', userId: 'u1', deviceUuid: 'd1', status: 'ACTIVE' },
      minAppVersion: '',
    };
    next();
  });
  mockPoolConnect.mockResolvedValue({ query: mockPoolQuery, release: mockClientRelease });
  mockPoolQuery.mockImplementation((sql: string, params: any[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
    if (sql.includes('seat_number') && sql.includes('ticket_id <>')) return Promise.resolve({ rows: [] });
    if (sql.includes('INSERT INTO transit_tickets')) return Promise.resolve({ rows: [{ id: 1 }] });
    if (sql.includes('offline_lease_days')) return Promise.resolve({ rows: [{ offline_lease_days: 7, min_app_version: '' }] });
    if (sql.includes('INTERVAL')) return Promise.resolve({ rows: [{ expiry: '2026-09-23T00:00:00.000Z' }] });
    if (sql.includes('UPDATE transit_devices')) return Promise.resolve({ rows: [] });
    if (sql.includes('UPDATE transit_trips') && sql.includes('seats_sold')) return Promise.resolve({ rows: [] });
    throw new Error('Unexpected query: ' + sql);
  });
});

function ticket(overrides: any = {}) {
  return {
    ticket_id: 'tx-1',
    company_id: 'c1',
    receipt_no: 'AGJ0001',
    trip_no: 'T-101',
    route_from: 'HARARE',
    route_to: 'MUTARE',
    route_code: 'HRE',
    seat_number: '12A',
    customer_name: 'EDWARD CHIKOMBA',
    customer_phone: '0772223344',
    driver_name: 'CHIDAVHARWI',
    driver_phone: '0779112233',
    conductor_name: '',
    conductor2: '',
    conductor_phone: '',
    items: [{ name: 'Adult', qty: 1, price: 2 }],
    amount: 200,
    cash_cents: 200,
    change_cents: 0,
    created_at: '2026-09-16 09:00:00',
    ...overrides,
  };
}

describe('POST /api/transit/tickets/sync — trip_id uuid guard', () => {
  it('never queries a uuid column with a device-local on-the-go trip id', async () => {
    // The app mints TRIP-<device>-<epoch> for a conductor-created run. Those
    // runs are device-local by design and can never exist in transit_trips, but
    // transit_trips.id is a uuid column: querying with one raised "invalid
    // input syntax for type uuid" and rolled back the WHOLE batch, so one
    // on-the-go ticket silently blocked every ticket on the device from ever
    // syncing. Such a trip can never exist server-side by definition, so it is
    // treated as unresolvable, exactly like an unknown id.
    const res = await request(createApp())
      .post('/api/transit/tickets/sync')
      .send({
        tickets: [ticket({ ticket_id: 'tx-otg', trip_id: 'TRIP-556E75-1790679222766' })],
      });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);

    // No SELECT against transit_trips may have been issued with that id.
    const tripLookups = mockPoolQuery.mock.calls.filter(
      (c: any) => String(c[0]).includes('FROM transit_trips') && String(c[0]).includes('id = $1')
    );
    expect(tripLookups).toHaveLength(0);

    // The ticket is still stored, just without a server trip link.
    const insertCall = mockPoolQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('INSERT INTO transit_tickets')
    );
    expect(insertCall).toBeDefined();
    const params: any[] = insertCall[1];
    expect(params).toContain(null);
    expect(params).not.toContain('TRIP-556E75-1790679222766');
  });

  it('still resolves a real server trip id and backfills the crew from it', async () => {
    mockPoolQuery.mockImplementation((sql: string, params: any[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      if (sql.includes('FROM transit_trips') && sql.includes('id = $1'))
        return Promise.resolve({
          rows: [{
            id: REAL_TRIP_ID,
            bus_reg: 'AGJ-777',
            driver: 'SERVER DRIVER',
            driver_phone: '0771002003',
            conductor1: 'SERVER CONDUCTOR',
            conductor2: '',
            conductor_phone: '',
            departure_time: '06:30',
          }],
        });
      if (sql.includes('seat_number') && sql.includes('ticket_id <>')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO transit_tickets')) return Promise.resolve({ rows: [{ id: 1 }] });
      if (sql.includes('offline_lease_days')) return Promise.resolve({ rows: [{ offline_lease_days: 7, min_app_version: '' }] });
      if (sql.includes('INTERVAL')) return Promise.resolve({ rows: [{ expiry: '2026-09-23T00:00:00.000Z' }] });
      if (sql.includes('UPDATE transit_devices')) return Promise.resolve({ rows: [] });
      if (sql.includes('UPDATE transit_trips') && sql.includes('seats_sold')) return Promise.resolve({ rows: [] });
      throw new Error('Unexpected query: ' + sql);
    });

    // The payload leaves crew blank on purpose: the trip is the canonical source.
    const res = await request(createApp())
      .post('/api/transit/tickets/sync')
      .send({
        tickets: [
          ticket({
            ticket_id: 'tx-real-trip',
            trip_id: REAL_TRIP_ID,
            driver_name: '',
            driver_phone: '',
            conductor_name: '',
          }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);
    const insertCall = mockPoolQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('INSERT INTO transit_tickets')
    );
    const params: any[] = insertCall[1];
    expect(params).toContain(REAL_TRIP_ID);
    expect(params).toContain('SERVER DRIVER');
    expect(params).toContain('SERVER CONDUCTOR');
    expect(params).toContain('AGJ-777');
  });
});
