import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/db/pool', () => {
  const mockClientQuery = vi.fn();
  const mockRelease = vi.fn();
  const mockClient = {
    query: mockClientQuery,
    release: mockRelease,
  };
  return {
    pool: {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(mockClient),
    },
  };
});

vi.mock('../src/services/pesepayService', () => ({
  initiateEcoCashPayment: vi.fn(),
  decryptResponse: vi.fn(),
  verifyPaymentStatus: vi.fn(),
}));

vi.mock('../src/services/ruijieService', () => ({
  bypassRuijieFirewall: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/utils/wisprTransformer', () => ({
  transformToWISPrProfile: vi.fn().mockReturnValue({
    macAddress: 'AA:BB:CC:DD:EE:FF',
    bandwidthUpKbps: 5000,
    bandwidthDownKbps: 10000,
    dataQuotaBytes: 10737418240,
    isUncapped: false,
    durationSeconds: 86400,
  }),
}));

import { pool } from '../src/db/pool';
import { paymentsRouter } from '../src/routes/payments';
import {
  initiateEcoCashPayment,
  decryptResponse,
  verifyPaymentStatus,
} from '../src/services/pesepayService';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentsRouter);
  return app;
}

describe('Payments routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/payments/initiate', () => {
    const validBody = {
      tier: 'PreMAX',
      displayName: 'Pro',
      amount: 34.99,
      currency: 'USD',
      billingPeriod: 'monthly',
      dataLimitGb: 100,
      isUncapped: false,
      bandwidthUp: 10,
      bandwidthDown: 10,
      phone: '+263771327202',
      fullName: 'John Doe',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      ipAddress: '10.0.0.5',
    };

    it('returns 400 when required fields are missing', async () => {
      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send({});

      expect(res.status).toBe(400);
    });

    it('handles existing user by phone', async () => {
      const client = await (pool as any).connect();
      client.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 'existing-user' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'pkg-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'pay-1' }] });
      (initiateEcoCashPayment as any).mockResolvedValue({
        success: true,
        pollUrl: 'https://pay.pesepay.com/poll',
      });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pesepayPollUrl).toBeDefined();
    });

    it('creates new user when phone not found', async () => {
      const client = await (pool as any).connect();
      client.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'new-user' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'pkg-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'pay-2' }] });
      (initiateEcoCashPayment as any).mockResolvedValue({
        success: true,
        pollUrl: 'https://pay.pesepay.com/poll',
      });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send(validBody);

      expect(res.status).toBe(200);
    });

    it('returns 400 for invalid package tier', async () => {
      const client = await (pool as any).connect();
      client.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send(validBody);

      expect(res.status).toBe(400);
    });

    it('handles Pesepay failure gracefully', async () => {
      const client = await (pool as any).connect();
      client.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'pkg-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'pay-3' }] });
      (pool.query as any).mockResolvedValueOnce(undefined);
      (initiateEcoCashPayment as any).mockResolvedValue({
        success: false,
        error: 'Insufficient funds',
      });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send(validBody);

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/payments/webhook', () => {
    it('returns 400 when payload is missing', async () => {
      const res = await request(createApp())
        .post('/api/payments/webhook')
        .send({});

      expect(res.status).toBe(400);
      expect(res.text).toContain('Missing payload');
    });

    it('returns 400 when decryption fails', async () => {
      (decryptResponse as any).mockReturnValue(null);

      const res = await request(createApp())
        .post('/api/payments/webhook')
        .send({ payload: 'encrypted-string' });

      expect(res.status).toBe(400);
      expect(res.text).toContain('Invalid payload');
    });

    it('processes successful payment webhook', async () => {
      (decryptResponse as any).mockReturnValue({
        merchantReference: 'REF-001',
        transactionStatus: 'SUCCESS',
      });

      const client = await (pool as any).connect();
      client.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 'pay-1', user_id: 'user-1', phone_number: '123', amount: 10, package_id: 'pkg-1', status: 'pending', ruijie_auth_url: null }] })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ mac_address: 'AA:BB:CC:DD:EE:FF' }] })
        .mockResolvedValueOnce({ rows: [{ tier_name: 'PreLITE', data_limit_gb: 100, is_uncapped: false, bandwidth_mbps_up: 10, bandwidth_mbps_down: 10, duration_min: 1440 }] })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const res = await request(createApp())
        .post('/api/payments/webhook')
        .send({ payload: 'encrypted-string' });

      expect(res.status).toBe(200);
    });

    it('ignores non-success statuses', async () => {
      (decryptResponse as any).mockReturnValue({
        merchantReference: 'REF-002',
        transactionStatus: 'FAILED',
      });

      const client = await (pool as any).connect();
      client.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 'pay-2', user_id: 'user-2', phone_number: '456', amount: 20, package_id: 'pkg-2', status: 'pending', ruijie_auth_url: null }] })
        .mockResolvedValueOnce(undefined);

      const res = await request(createApp())
        .post('/api/payments/webhook')
        .send({ payload: 'encrypted-string' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('Ignored');
    });
  });

  describe('GET /api/payments/status/:paymentId', () => {
    it('returns payment status', { timeout: 10000 }, async () => {
      (pool.query as any).mockResolvedValue({
        rows: [{ id: 'pay-1', status: 'completed', pesepay_reference: 'REF-1', amount: 34.99, completed_at: new Date().toISOString() }],
      });

      const res = await request(createApp()).get('/api/payments/status/pay-1');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
    });

    it('returns 404 for unknown payment', { timeout: 10000 }, async () => {
      (pool.query as any).mockResolvedValue({ rows: [] });

      const res = await request(createApp()).get('/api/payments/status/unknown');

      expect(res.status).toBe(404);
    });
  });
});
