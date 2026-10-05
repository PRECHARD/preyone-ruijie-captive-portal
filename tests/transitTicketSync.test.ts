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

describe('POST /api/transit/tickets/sync — offline ticket upsert', () => {
  it('stores route_from/route_to from the app payload', async () => {
    const res = await request(createApp())
      .post('/api/transit/tickets/sync')
      .send({ tickets: [ticket()] });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);
    const insertCall = mockPoolQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('INSERT INTO transit_tickets')
    );
    expect(insertCall).toBeDefined();
    const params: any[] = insertCall[1];
    expect(params).toContain('HARARE');
    expect(params).toContain('MUTARE');
  });

  it('upserts idempotently — re-sending the same ticket_id never duplicates', async () => {
    const app = createApp();
    const first = await request(app)
      .post('/api/transit/tickets/sync')
      .send({ tickets: [ticket()] });
    const second = await request(app)
      .post('/api/transit/tickets/sync')
      .send({ tickets: [ticket()] });

    expect(first.body.synced).toBe(1);
    expect(second.body.synced).toBe(1);
    expect(first.body.duplicates).toBe(0);
    expect(second.body.duplicates).toBe(0);

    const insertCalls = mockPoolQuery.mock.calls.filter((c: any) =>
      String(c[0]).includes('INSERT INTO transit_tickets')
    );
    expect(insertCalls.length).toBe(2);
    for (const c of insertCalls) {
      expect(String(c[0])).toContain('ON CONFLICT (ticket_id) DO UPDATE');
    }
  });

  it('rejects tickets without a ticket_id without touching the DB', async () => {
    const res = await request(createApp())
      .post('/api/transit/tickets/sync')
      .send({ tickets: [{ customer_name: 'NO ID' }] });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(0);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].code).toBe('MISSING_TICKET_ID');
  });

  it('flags a seat already taken on the trip as SEAT_CONFLICT', async () => {
    mockPoolQuery.mockImplementation((sql: string, params: any[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
      if (sql.includes('seat_number') && sql.includes('ticket_id <>'))
        return Promise.resolve({ rows: [{ present: 1 }] });
      if (sql.includes('INSERT INTO transit_tickets')) return Promise.resolve({ rows: [{ id: 1 }] });
      if (sql.includes('offline_lease_days')) return Promise.resolve({ rows: [{ offline_lease_days: 7, min_app_version: '' }] });
      if (sql.includes('INTERVAL')) return Promise.resolve({ rows: [{ expiry: '2026-09-23T00:00:00.000Z' }] });
      if (sql.includes('UPDATE transit_devices')) return Promise.resolve({ rows: [] });
      if (sql.includes('UPDATE transit_trips') && sql.includes('seats_sold')) return Promise.resolve({ rows: [] });
      throw new Error('Unexpected query: ' + sql);
    });

    const res = await request(createApp())
      .post('/api/transit/tickets/sync')
      .send({ tickets: [ticket({ ticket_id: 'tx-9' })] });

    expect(res.status).toBe(200);
    expect(res.body.conflicts).toBe(1);
    expect(transitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'SEAT_CONFLICT' })
    );
  });

  it('stores custom_fare, departure_time and luggage_linked_ticket_id from the app payload', async () => {
    const res = await request(createApp())
      .post('/api/transit/tickets/sync')
      .send({
        tickets: [
          ticket({
            ticket_id: 'tx-lug',
            custom_fare: 250,
            departure_time: '06:30',
            luggage_linked_ticket_id: 'dev-1-luggage-parent-txid',
          }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);
    const insertCall = mockPoolQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('INSERT INTO transit_tickets')
    );
    expect(insertCall).toBeDefined();
    const params: any[] = insertCall[1];
    expect(params).toContain(250);
    expect(params).toContain('06:30');
    expect(params).toContain('dev-1-luggage-parent-txid');
    expect(String(insertCall[0])).toContain('custom_fare');
    expect(String(insertCall[0])).toContain('departure_time');
    expect(String(insertCall[0])).toContain('luggage_linked_ticket_id');
  });

  it('stores a route_code without a route_name when the app sends it natively', async () => {
    const res = await request(createApp())
      .post('/api/transit/tickets/sync')
      .send({
        tickets: [
          ticket({
            ticket_id: 'tx-rt',
            route_from: '',
            route_to: '',
            route_code: 'HRE-BYO',
            route_name: '',
          }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);
    const insertCall = mockPoolQuery.mock.calls.find((c: any) =>
      String(c[0]).includes('INSERT INTO transit_tickets')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain('HRE-BYO');
  });

  describe('duplicate ticket numbers', () => {
    it('reports a repeated number as a duplicate receipt instead of overwriting', async () => {
      // Two handsets minted the same number. The earlier sale must stand: the
      // paper is already in a passenger's hand, so silently replacing the row
      // would erase a real paid ticket from the books.
      mockPoolQuery.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
        if (sql.includes('seat_number') && sql.includes('ticket_id <>')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO transit_tickets')) {
          const err: any = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          err.constraint = 'idx_transit_tickets_receipt_unique';
          return Promise.reject(err);
        }
        if (sql.includes('offline_lease_days')) return Promise.resolve({ rows: [{ offline_lease_days: 7, min_app_version: '' }] });
        if (sql.includes('INTERVAL')) return Promise.resolve({ rows: [{ expiry: '2026-09-23T00:00:00.000Z' }] });
        if (sql.includes('UPDATE transit_devices')) return Promise.resolve({ rows: [] });
        if (sql.includes('UPDATE transit_trips') && sql.includes('seats_sold')) return Promise.resolve({ rows: [] });
        throw new Error('Unexpected query: ' + sql);
      });

      const res = await request(createApp())
        .post('/api/transit/tickets/sync')
        .send({ tickets: [ticket({ ticket_id: 'tx-dup', receipt_no: 'AGJ-A1B-0041' })] });

      // The whole batch must still succeed: one bad number cannot roll back the
      // rest of the conductor's shift.
      expect(res.status).toBe(200);
      expect(res.body.duplicate_receipts).toBe(1);
      expect(res.body.duplicate_receipt_ids).toEqual(['tx-dup']);
      expect(res.body.synced).toBe(0);
      expect(transitSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'DUPLICATE_RECEIPT_NO' })
      );
    });

    it('does not treat a seat-lock violation as a duplicate receipt', async () => {
      // The two constraints are both 23505, so they must be told apart by name.
      // Misreading a seat clash as a number clash would wrongly tell a conductor
      // their ticket number is shared when only the seat was.
      mockPoolQuery.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [] });
        if (sql.includes('seat_number') && sql.includes('ticket_id <>')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO transit_tickets')) {
          const err: any = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          err.constraint = 'idx_transit_tickets_seat_lock';
          return Promise.reject(err);
        }
        if (sql.includes('offline_lease_days')) return Promise.resolve({ rows: [{ offline_lease_days: 7, min_app_version: '' }] });
        if (sql.includes('INTERVAL')) return Promise.resolve({ rows: [{ expiry: '2026-09-23T00:00:00.000Z' }] });
        if (sql.includes('UPDATE transit_devices')) return Promise.resolve({ rows: [] });
        if (sql.includes('UPDATE transit_trips') && sql.includes('seats_sold')) return Promise.resolve({ rows: [] });
        throw new Error('Unexpected query: ' + sql);
      });

      const res = await request(createApp())
        .post('/api/transit/tickets/sync')
        .send({ tickets: [ticket({ ticket_id: 'tx-seat', receipt_no: 'AGJ-A1B-0042' })] });

      expect(res.status).toBe(200);
      expect(res.body.conflicts).toBe(1);
      expect(res.body.duplicate_receipts).toBe(0);
    });

    it('still surfaces an unexpected database error rather than swallowing it', async () => {
      mockPoolQuery.mockImplementation((sql: string) => {
        if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO transit_tickets')) {
          const err: any = new Error('something else broke');
          err.code = '23505';
          err.constraint = 'some_other_index';
          return Promise.reject(err);
        }
        if (sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
        throw new Error('Unexpected query: ' + sql);
      });

      const res = await request(createApp())
        .post('/api/transit/tickets/sync')
        .send({ tickets: [ticket({ ticket_id: 'tx-boom' })] });

      expect(res.status).toBeGreaterThanOrEqual(500);
    });
  });
});