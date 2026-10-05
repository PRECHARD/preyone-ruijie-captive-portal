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

function setDeviceRole(role: string) {
  const perms =
    role === 'SUPER_ADMIN' || role === 'ADMIN'
      ? ['company.admin', 'operations.manage', 'finance.view', 'transit.field_app']
      : ['transit.field_app'];
  (requireTransitDevice as any).mockImplementation((_req: any, _res: any, next: any) => {
    _req.transit = {
      user: { id: 'u1', companyId: 'c1', username: 'user', role, permissions: perms },
      device: { id: 'dev-1', companyId: 'c1', userId: 'u1', deviceUuid: 'd1', status: 'ACTIVE' },
      minAppVersion: '',
    };
    next();
  });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/transit', transitRouter);
  return app;
}

const TRIP_ROW = {
  id: 'trip-1',
  company_id: 'c1',
  user_id: 'u1',
  device_id: 'dev-1',
  trip_no: 'T-101',
  route_code: 'HRE',
  route_from: 'HARARE',
  route_to: 'MUTARE',
  route_name: 'HARARE - MUTARE',
  bus_reg: 'AFB1234',
  driver: 'CHIDAVHARWI',
  driver_phone: '0779112233',
  driver_id: '',
  conductor1: 'CONDUCTOR',
  conductor_phone: '',
  conductor_id: '',
  departure_time: '06:30',
  status: 'SCHEDULED',
  total_seats: 42,
  seats_sold: 3,
  opened_at: '2026-09-16T06:00:00.000Z',
  closed_at: null,
};

const PROMO_ROW = {
  id: 'promo-1',
  company_id: 'c1',
  code: 'SAVE10',
  description: '10% off',
  type: 'PERCENT',
  value: 10,
  minimum_cents: 0,
  max_value_cents: 0,
  active: true,
  usage_count: 0,
  created_by: 'u1',
  created_at: '2026-09-16T06:00:00.000Z',
  updated_at: '2026-09-16T06:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  transitSecurityEvent.mockReset();
  transitAudit.mockReset();
  setDeviceRole('SUPER_ADMIN');

  mockPoolConnect.mockResolvedValue({ query: mockPoolQuery, release: mockClientRelease });

  mockPoolQuery.mockImplementation((sql: string, params: any[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
    if (sql.includes('ORDER BY opened_at DESC')) return Promise.resolve({ rows: [TRIP_ROW] });
    if (sql.includes('INSERT INTO transit_trips')) return Promise.resolve({ rows: [TRIP_ROW] });
    if (sql.includes('UPDATE transit_trips') && sql.includes('RETURNING *')) {
      if (params[0] === 'trip-1') return Promise.resolve({ rows: [{ ...TRIP_ROW, status: sql.includes("'ACTIVE'") ? 'ACTIVE' : 'COMPLETED' }] });
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('FROM transit_trips WHERE id = $1')) {
      // 'trip-1' is the shorthand the trip-endpoint tests use; the sync test
      // uses a real uuid, which is what a real transit_trips.id looks like.
      if (params[0] === 'trip-1') return Promise.resolve({ rows: [TRIP_ROW] });
      if (typeof params[0] === 'string' && params[0].includes('-')) {
        return Promise.resolve({ rows: [{ ...TRIP_ROW, id: params[0] }] });
      }
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('FROM transit_tickets') && sql.includes('ORDER BY seat_number'))
      return Promise.resolve({
        rows: [
          { seat_number: '1', customer_name: 'JANE DOE', customer_mobile: '077111222', total_cents: 200, cash_cents: 200, change_cents: 0, ticket_id: 'tx-a', payment_method: 'cash' },
        ],
      });
    if (sql.includes('FROM transit_promotions')) {
      if (params[0] === 'c1') return Promise.resolve({ rows: [PROMO_ROW, { ...PROMO_ROW, id: 'promo-2', code: 'FLAT5', type: 'FLAT', value: 500, active: false }] });
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('INSERT INTO transit_promotions')) return Promise.resolve({ rows: [PROMO_ROW] });
    if (sql.includes('UPDATE transit_promotions')) {
      if (params[params.length - 2] === 'promo-1' && params[params.length - 1] === 'c1')
        return Promise.resolve({ rows: [{ ...PROMO_ROW, active: params[params.length - 3] === false ? false : true }] });
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('seat_number') && sql.includes('ticket_id <>')) return Promise.resolve({ rows: [] });
    if (sql.includes('INSERT INTO transit_tickets')) return Promise.resolve({ rows: [{ id: 1 }] });
    if (sql.includes('offline_lease_days')) return Promise.resolve({ rows: [{ offline_lease_days: 7, min_app_version: '' }] });
    if (sql.includes('INTERVAL')) return Promise.resolve({ rows: [{ expiry: '2026-09-23T00:00:00.000Z' }] });
    if (sql.includes('UPDATE transit_devices')) return Promise.resolve({ rows: [] });
    if (sql.includes('UPDATE transit_trips') && sql.includes('seats_sold')) return Promise.resolve({ rows: [] });
    if (sql.includes('SELECT id FROM transit_trips WHERE id = $1')) return Promise.resolve({ rows: [TRIP_ROW] });
    throw new Error('Unexpected query: ' + sql);
  });
});

describe('Trip module endpoints', () => {
  it('GET /api/transit/trips/active lists scheduling/open trips for any device role', async () => {
    setDeviceRole('CONDUCTOR');
    const res = await request(createApp()).get('/api/transit/trips/active');
    expect(res.status).toBe(200);
    expect(res.body.trips).toHaveLength(1);
    expect(res.body.trips[0].tripNo).toBe('T-101');
    expect(res.body.trips[0].totalSeats).toBe(42);
    expect(res.body.trips[0].seatsSold).toBe(3);
  });

  it('POST /api/transit/trips creates a SCHEDULED trip for an admin', async () => {
    const res = await request(createApp()).post('/api/transit/trips').send({
      tripNo: 'T-102',
      routeFrom: 'HARARE',
      routeTo: 'MUTARE',
      routeCode: 'HRE',
      totalSeats: 42,
    });
    expect(res.status).toBe(201);
    expect(res.body.trip.tripNo).toBe('T-101');
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'TRIP_CREATED' }));
  });

  it('POST /api/transit/trips rejects field staff with 403', async () => {
    setDeviceRole('CONDUCTOR');
    const res = await request(createApp()).post('/api/transit/trips').send({
      tripNo: 'T-102',
      routeFrom: 'HARARE',
      routeTo: 'MUTARE',
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/transit/trips requires routeFrom/routeTo', async () => {
    const res = await request(createApp()).post('/api/transit/trips').send({ tripNo: 'T-102' });
    expect(res.status).toBe(422);
  });

  it('POST /api/transit/trips auto-generates route_code from origin/destination when omitted', async () => {
    const res = await request(createApp()).post('/api/transit/trips').send({
      tripNo: 'T-202',
      routeFrom: 'HARARE',
      routeTo: 'BULAWAYO',
      totalSeats: 44,
    });
    expect(res.status).toBe(201);
    const insertCall = mockPoolQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('INSERT INTO transit_trips')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain('HRE-BYO');
  });

  it('uses the explicitly-supplied route_code instead of auto-generating one', async () => {
    const res = await request(createApp()).post('/api/transit/trips').send({
      tripNo: 'T-203',
      routeFrom: 'HARARE',
      routeTo: 'MUTARE',
      routeCode: 'X99-A5',
      totalSeats: 44,
    });
    expect(res.status).toBe(201);
    const insertCall = mockPoolQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('INSERT INTO transit_trips')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain('X99-A5');
    expect(insertCall[1]).not.toContain('HRE-MUT');
  });

  it('POST /api/transit/trips/:id/start opens the trip for a conductor', async () => {
    setDeviceRole('CONDUCTOR');
    const res = await request(createApp()).post('/api/transit/trips/trip-1/start');
    expect(res.status).toBe(200);
    expect(res.body.trip.status).toBe('ACTIVE');
  });

  it('POST /api/transit/trips/:id/complete returns 404 for an unknown trip', async () => {
    const res = await request(createApp()).post('/api/transit/trips/nope/complete');
    expect(res.status).toBe(404);
  });

  it('GET /api/transit/trips/:id/manifest returns trip + reconciled seats', async () => {
    const res = await request(createApp()).get('/api/transit/trips/trip-1/manifest');
    expect(res.status).toBe(200);
    expect(res.body.trip.tripNo).toBe('T-101');
    expect(res.body.count).toBe(1);
    expect(res.body.tickets[0].seatNumber).toBe('1');
    expect(res.body.tickets[0].paymentMethod).toBe('cash');
  });
});

describe('Promotions module endpoints (admin-only mutations)', () => {
  it('GET /api/transit/promotions is viewable by any role', async () => {
    setDeviceRole('DRIVER');
    const res = await request(createApp()).get('/api/transit/promotions');
    expect(res.status).toBe(200);
    expect(res.body.promotions).toHaveLength(2);
    expect(res.body.promotions[0].active).toBe(true);
  });

  it('POST /api/transit/promotions creates for SUPER_ADMIN', async () => {
    const res = await request(createApp()).post('/api/transit/promotions').send({
      code: 'save10',
      description: '10% off',
      type: 'PERCENT',
      value: 10,
    });
    expect(res.status).toBe(201);
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PROMOTION_CREATED' }));
    const insertCall = mockPoolQuery.mock.calls.find((c: any) => String(c[0]).includes('INSERT INTO transit_promotions'));
    expect(insertCall).toBeDefined();
    expect((insertCall[1] as any[])[1]).toBe('SAVE10');
  });

  it('POST /api/transit/promotions is FORBIDDEN for CONDUCTOR', async () => {
    setDeviceRole('CONDUCTOR');
    const res = await request(createApp()).post('/api/transit/promotions').send({
      code: 'SAVE10',
      type: 'PERCENT',
      value: 10,
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/transit/promotions is FORBIDDEN for DRIVER', async () => {
    setDeviceRole('DRIVER');
    const res = await request(createApp()).post('/api/transit/promotions').send({
      code: 'SAVE10',
      type: 'PERCENT',
      value: 10,
    });
    expect(res.status).toBe(403);
  });

  it('PUT /api/transit/promotions/:id deactivates for ADMIN', async () => {
    const res = await request(createApp()).put('/api/transit/promotions/promo-1').send({ active: false });
    expect(res.status).toBe(200);
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PROMOTION_UPDATED' }));
  });

  it('PUT /api/transit/promotions/:id is FORBIDDEN for TICKET_SELLER', async () => {
    setDeviceRole('TICKET_SELLER');
    const res = await request(createApp()).put('/api/transit/promotions/promo-1').send({ active: false });
    expect(res.status).toBe(403);
  });

  it('PUT /api/transit/promotions/:id returns 404 for another company', async () => {
    const res = await request(createApp()).put('/api/transit/promotions/other-company-promo').send({ active: false });
    expect(res.status).toBe(404);
  });

  it('rejects a percent discount above 100 with 422', async () => {
    const res = await request(createApp()).post('/api/transit/promotions').send({
      code: 'TOOMUCH',
      type: 'PERCENT',
      value: 120,
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/transit/tickets/sync stores trip_id and refreshes seats_sold', () => {
  it('persists trip_id and updates transit_trips.seats_sold after a successful sync', async () => {
    // A real transit_trips.id is a uuid. A non-uuid value can never match a
    // row and used to abort the whole batch with "invalid input syntax for
    // type uuid"; see the device-local on-the-go case in transitTicketSync.test.ts.
    const realTripId = '3f9b1c2d-4e5a-4b6c-8d7e-9f0a1b2c3d4e';
    const res = await request(createApp())
      .post('/api/transit/tickets/sync')
      .send({
        tickets: [
          {
            ticket_id: 'tx-1',
            trip_id: realTripId,
            trip_no: 'T-101',
            receipt_no: 'AGJ0001',
            route_from: 'HARARE',
            route_to: 'MUTARE',
            seat_number: '12A',
            customer_name: 'EDWARD CHIKOMBA',
            customer_phone: '0772223344',
            items: [{ name: 'Adult', qty: 1, price: 2 }],
            amount: 200,
            cash_cents: 200,
            change_cents: 0,
            created_at: '2026-09-16 09:00:00',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);

    const insertCall = mockPoolQuery.mock.calls.find((c: any) => String(c[0]).includes('INSERT INTO transit_tickets'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain(realTripId);

    const refreshCall = mockPoolQuery.mock.calls.find((c: any) => String(c[0]).includes('seats_sold'));
    expect(refreshCall).toBeDefined();
    expect(refreshCall[1]).toContain(realTripId);
  });
});