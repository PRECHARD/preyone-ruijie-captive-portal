import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockQuery, mockSendSetup, mockAudit } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSendSetup: vi.fn(async () => true),
  mockAudit: vi.fn(async () => undefined),
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../src/db/pool', () => ({ pool: { query: mockQuery } }));
vi.mock('../src/services/notificationService', () => ({ sendTransitPasswordSetup: mockSendSetup }));
vi.mock('../src/services/transitAudit', () => ({ transitAudit: mockAudit }));
vi.mock('../src/middleware/transitAuth', () => ({
  requireTransitSession: (req: any, _res: unknown, next: () => void) => {
    req.transitSession = {
      session: { sub: 'user-1', companyId: 'company-1', role: 'TICKET_SELLER', username: 'jane' },
    };
    next();
  },
}));

import { transitPortalRouter } from '../src/routes/transitPortal';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/transit/portal', transitPortalRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockSendSetup.mockResolvedValue(true);
  mockAudit.mockResolvedValue(undefined);
});

describe('transit staff portal API', () => {
  it('sends a one-time setup link for a transit staff email', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1', full_name: 'Jane Buses', email: 'jane@example.com',
          company_id: 'company-1', company_name: 'Preyone Transit',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp())
      .post('/api/transit/portal/auth/request-setup')
      .send({ identifier: 'JANE@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If that account is registered');
    const updateSql = String(mockQuery.mock.calls[1][0]);
    expect(updateSql).toContain('password_setup_token');
    expect(mockSendSetup).toHaveBeenCalledWith(
      'jane@example.com',
      expect.any(String),
      'Jane Buses',
      'Preyone Transit'
    );
  });

  it('does not reveal whether an unknown account exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp())
      .post('/api/transit/portal/auth/request-setup')
      .send({ identifier: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If that account is registered');
    expect(mockSendSetup).not.toHaveBeenCalled();
  });

  it('rejects a weak password and accepts a strong one with a valid token', async () => {
    const weak = await request(createApp())
      .post('/api/transit/portal/auth/set-password')
      .send({ token: 'tok-1', password: 'alllowercase' });
    expect(weak.status).toBe(422);

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', company_id: 'company-1', full_name: 'Jane' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const strong = await request(createApp())
      .post('/api/transit/portal/auth/set-password')
      .send({ token: 'tok-1', password: 'Transit2026!' });

    expect(strong.status).toBe(200);
    const updateSql = String(mockQuery.mock.calls[1][0]);
    expect(updateSql).toContain('password_setup_token = NULL');
  });

  it('returns the staff profile and company on /me', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'user-1', username: 'jane', full_name: 'Jane', role: 'TICKET_SELLER',
        phone: '+263771234567', email: 'jane@example.com', status: 'ACTIVE',
        created_at: '2026-01-01T00:00:00Z', company_id: 'company-1',
        company_name: 'Preyone Transit', currency: 'USD', logo_url: '',
        customer_care: '+263771111111', min_app_version: '1.0.0',
      }],
    });

    const res = await request(createApp()).get('/api/transit/portal/me');

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('jane');
    expect(res.body.company.minAppVersion).toBe('1.0.0');
  });

  it('normalizes blank passenger names to N/A in the manifest', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        tx_id: 'tx-1', client_receipt_no: 'R-1', seat_number: 'A1',
        customer_name: '', customer_mobile: '', total_cents: 2500,
        payment_method: 'cash', ticket_type: 'luggage', sale_time: '',
        synced_at: '2026-01-01T00:00:00Z',
      }],
    });

    const res = await request(createApp()).get('/api/transit/portal/manifest/TRIP-1');

    expect(res.status).toBe(200);
    expect(res.body.tickets[0].passenger).toBe('N/A');
    expect(res.body.tickets[0].ticketType).toBe('luggage');
  });

  it('updates a staff email from the profile endpoint', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // uniqueness check
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1', username: 'jane', full_name: 'Jane', role: 'TICKET_SELLER',
          phone: '+263771234567', email: 'new@example.com',
        }],
      });

    const res = await request(createApp())
      .patch('/api/transit/portal/me')
      .send({ email: 'NEW@example.com', phone: '0771234567' });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('new@example.com');
    const sql = String(mockQuery.mock.calls[1][0]);
    expect(sql).toContain('email = $');
    expect(mockQuery.mock.calls[1][1]).toContain('+263771234567');
  });

  it('rejects an email already used in the same company', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-2' }] });

    const res = await request(createApp())
      .patch('/api/transit/portal/me')
      .send({ email: 'taken@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already used');
  });
});
