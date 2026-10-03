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

vi.mock('../src/services/pesepayService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/pesepayService')>();
  return {
    ...actual,
    initiateEcoCashPayment: vi.fn(),
    initiatePesepayPayment: vi.fn(),
    decryptResponse: vi.fn(),
    verifyPaymentStatus: vi.fn(),
  };
});

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
  initiatePesepayPayment,
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
        .mockResolvedValueOnce(undefined)                                                                         // 1: BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'pay-1', user_id: 'user-1', phone_number: '123', amount: 10, package_id: 'pkg-1', status: 'pending', ruijie_auth_url: null }] })  // 2: SELECT payment
        .mockResolvedValueOnce(undefined)                                                                         // 3: UPDATE payment status
        .mockResolvedValueOnce({ rows: [{ mac_address: 'AA:BB:CC:DD:EE:FF' }] })                                  // 4: SELECT user
        .mockResolvedValueOnce({ rows: [{ tier_name: 'PreLITE', data_limit_gb: 100, is_uncapped: false, bandwidth_mbps_up: 10, bandwidth_mbps_down: 10, duration_min: 1440 }] })  // 5: SELECT package
        .mockResolvedValueOnce(undefined)                                                                         // 6: INSERT INTO transactions
        .mockResolvedValueOnce({ rows: [] })                                                                      // 7: SELECT CEO
        .mockResolvedValueOnce({ rows: [{ id: 'v-1' }] })                                                        // 8: INSERT INTO vouchers
        .mockResolvedValueOnce(undefined)                                                                         // 9: UPDATE users (session_token + session_expires_at + voucher_code)
        .mockResolvedValueOnce(undefined)                                                                         //10: INSERT INTO wispr_profiles
        .mockResolvedValueOnce(undefined);                                                                        //11: COMMIT

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

  const TENANT = '11111111-1111-4111-8111-111111111111';
  const DOC = '22222222-2222-4222-8222-222222222222';
  const SHIFT = '33333333-3333-4333-8333-333333333333';
  const INTEGRATION_KEY = 'test-integration-key';

  describe('POST /api/payments/pesepay/initiate', () => {
    const validBody = {
      amount: 25.5,
      currencyCode: 'ZWG',
      reasonForPayment: 'Invoice INV-001 settlement',
      tenant_id: TENANT,
      paymentMethod: 'innbucks',
      targetType: 'invoice',
      targetId: DOC,
      phone: '+263771327202',
      fullName: 'John Doe',
    };

    beforeEach(() => {
      (pool.query as any).mockImplementation(async (sql: string) => {
        if (/FROM companies/.test(sql)) return { rows: [{ id: TENANT }], rowCount: 1 };
        if (/FROM pos_documents/.test(sql)) {
          return { rows: [{ id: DOC, total: 100, amount_paid: 0, shift_id: SHIFT }], rowCount: 1 };
        }
        if (/FROM subscriptions/.test(sql)) return { rows: [{ id: 'sub-1' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      });
      (initiatePesepayPayment as any).mockResolvedValue({
        success: true,
        referenceNumber: 'PSE-1',
        redirectUrl: 'https://payments.pesepay.com/poll?ref=abc',
        pollUrl: 'https://payments.pesepay.com/poll?ref=abc',
        instructions: 'Approve ZWG 25.5',
      });
    });

    it('rejects a non-positive amount', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send({ ...validBody, amount: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('amount');
    });

    it('rejects an unsupported currency', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send({ ...validBody, currencyCode: 'GBP' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('USD or ZWG');
    });

    it('requires reasonForPayment', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send({ ...validBody, reasonForPayment: '  ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('reasonForPayment');
    });

    it('requires a valid tenant_id', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send({ ...validBody, tenant_id: 'not-a-uuid' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tenant_id');
    });

    it('rejects an unsupported payment rail', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send({ ...validBody, paymentMethod: 'bitcoin' });

      expect(res.status).toBe(400);
    });

    it('requires a document for invoice payments', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send({ ...validBody, targetId: undefined });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('targetId');
    });

    it('returns 404 for an unknown tenant', async () => {
      (pool.query as any).mockImplementation(async (sql: string) => {
        if (/FROM companies/.test(sql)) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      });

      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send(validBody);

      expect(res.status).toBe(404);
    });

    it('rejects an amount larger than the outstanding balance', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send({ ...validBody, amount: 500 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('balance');
      expect(initiatePesepayPayment).not.toHaveBeenCalled();
    });

    it('returns a reference number and redirect URL for an invoice', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.referenceNumber).toMatch(/^PREYONE-/);
      expect(res.body.redirectUrl).toContain('pesepay.com');
      expect(res.body.currencyCode).toBe('ZWG');
      expect(res.body.paymentMethod).toBe('innbucks');

      const call = (initiatePesepayPayment as any).mock.calls[0][0];
      expect(call.currencyCode).toBe('ZWG');
      expect(call.paymentMethod).toBe('innbucks');
      expect(call.reference).toBe(res.body.referenceNumber);
    });

    it('initiates a subscription payment', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send({
          ...validBody,
          targetType: 'subscription',
          targetId: undefined,
          subscriptionModule: 'pos',
          planTier: 'enterprise',
        });

      expect(res.status).toBe(200);
      expect(res.body.targetType).toBe('subscription');
    });

    it('rejects an unknown subscription module', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send({
          ...validBody,
          targetType: 'subscription',
          targetId: undefined,
          subscriptionModule: 'crm',
        });

      expect(res.status).toBe(400);
    });

    it('marks the intent failed when Pesepay rejects initiation', async () => {
      (initiatePesepayPayment as any).mockResolvedValue({ success: false, error: 'Invalid API key' });

      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send(validBody);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid API key');

      const failedUpdate = (pool.query as any).mock.calls.some(
        ([sql]: [string]) => typeof sql === 'string' && sql.includes("status = 'failed'")
      );
      expect(failedUpdate).toBe(true);
    });
  });

  describe('POST /api/payments/pesepay/callback', () => {
    const intent = {
      id: 'intent-1',
      reference: 'PREYONE-ABCD1234-1700000000000',
      tenant_id: TENANT,
      amount: 25.5,
      currency: 'ZWG',
      payment_method: 'innbucks',
      target_type: 'invoice',
      target_id: DOC,
      shift_id: null,
      subscription_module: null,
      plan_tier: null,
      status: 'pending',
    };

    const successBody = {
      referenceNumber: intent.reference,
      transactionStatus: 'SUCCESS',
      amountDetails: { amount: 25.5, currencyCode: 'ZWG' },
    };

    beforeEach(async () => {
      process.env.PESEPAY_INTEGRATION_KEY = INTEGRATION_KEY;
      process.env.PESEPAY_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';

      const client = await (pool as any).connect();
      client.query.mockReset();
      client.query.mockImplementation(async (sql: string) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [], rowCount: 0 };
        if (/FROM pesepay_intents/.test(sql)) return { rows: [intent], rowCount: 1 };
        if (/FROM pos_documents/.test(sql)) {
          return { rows: [{ id: DOC, doc_number: 'INV-001', total: 100, amount_paid: 0, shift_id: SHIFT }], rowCount: 1 };
        }
        if (/UPDATE pos_documents/.test(sql)) return { rows: [{ status: 'paid' }], rowCount: 1 };
        if (/UPDATE subscriptions/.test(sql)) {
          return { rows: [{ id: 'sub-1', plan_tier: 'enterprise', status: 'active' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });
    });

    it('rejects a callback without an authorization header', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/callback')
        .send(successBody);

      expect(res.status).toBe(401);
    });

    it('rejects a callback with the wrong integration key', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/callback')
        .set('authorization', 'wrong-key')
        .send(successBody);

      expect(res.status).toBe(401);
    });

    it('rejects a payload without a reference', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/callback')
        .set('authorization', INTEGRATION_KEY)
        .send({ transactionStatus: 'SUCCESS' });

      expect(res.status).toBe(400);
    });

    it('ignores non-success statuses', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/callback')
        .set('authorization', INTEGRATION_KEY)
        .send({ ...successBody, transactionStatus: 'FAILED' });

      expect(res.status).toBe(200);
      expect(res.body.applied).toBe(false);
      expect(res.body.status).toBe('FAILED');
    });

    it('rejects an amount mismatch', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/callback')
        .set('authorization', INTEGRATION_KEY)
        .send({ ...successBody, amountDetails: { amount: 99 } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('mismatch');
    });

    it('returns 404 for an unknown reference', async () => {
      const client = await (pool as any).connect();
      client.query.mockImplementation(async (sql: string) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [], rowCount: 0 };
        if (/FROM pesepay_intents/.test(sql)) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      });

      const res = await request(createApp())
        .post('/api/payments/pesepay/callback')
        .set('authorization', INTEGRATION_KEY)
        .send(successBody);

      expect(res.status).toBe(404);
    });

    it('applies a successful payment to the invoice', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/callback')
        .set('authorization', INTEGRATION_KEY)
        .send(successBody);

      expect(res.status).toBe(200);
      expect(res.body.applied).toBe(true);
      expect(res.body.documentId).toBe(DOC);
      expect(res.body.documentNumber).toBe('INV-001');
      expect(res.body.status).toBe('paid');

      const client = await (pool as any).connect();
      const inserted = client.query.mock.calls.find(
        ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO pos_document_payments')
      );
      expect(inserted).toBeTruthy();
      expect(inserted[1]).toEqual([DOC, 25.5, 'innbucks', intent.reference, SHIFT]);

      const updated = client.query.mock.calls.find(
        ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE pos_documents')
      );
      expect(updated[1]).toEqual([DOC, 25.5]);
    });

    it('is idempotent for an already completed intent', async () => {
      const client = await (pool as any).connect();
      client.query.mockImplementation(async (sql: string) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [], rowCount: 0 };
        if (/FROM pesepay_intents/.test(sql)) return { rows: [{ ...intent, status: 'completed' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });

      const res = await request(createApp())
        .post('/api/payments/pesepay/callback')
        .set('authorization', INTEGRATION_KEY)
        .send(successBody);

      expect(res.status).toBe(200);
      expect(res.body.applied).toBe(false);
      expect(res.body.message).toContain('Already processed');
    });

    it('activates a subscription on success', async () => {
      const client = await (pool as any).connect();
      client.query.mockImplementation(async (sql: string) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [], rowCount: 0 };
        if (/FROM pesepay_intents/.test(sql)) {
          return {
            rows: [
              {
                ...intent,
                target_type: 'subscription',
                target_id: null,
                subscription_module: 'pos',
                plan_tier: 'enterprise',
              },
            ],
            rowCount: 1,
          };
        }
        if (/UPDATE subscriptions/.test(sql)) {
          return { rows: [{ id: 'sub-1', plan_tier: 'enterprise', status: 'active' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const res = await request(createApp())
        .post('/api/payments/pesepay/callback')
        .set('authorization', INTEGRATION_KEY)
        .send(successBody);

      expect(res.status).toBe(200);
      expect(res.body.targetType).toBe('subscription');
      expect(res.body.module).toBe('pos');
      expect(res.body.planTier).toBe('enterprise');
    });

    it('decrypts an encrypted result payload', async () => {
      (decryptResponse as any).mockReturnValue(successBody);

      const res = await request(createApp())
        .post('/api/payments/pesepay/callback')
        .set('authorization', INTEGRATION_KEY)
        .send({ payload: 'encrypted-blob' });

      expect(res.status).toBe(200);
      expect(res.body.applied).toBe(true);
      expect(decryptResponse).toHaveBeenCalled();
    });
  });
});
