import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// payments.ts copies JWT_SECRET into a module-level constant at import time, so
// it must be seeded before the route module loads. PESEPAY_* is read per request
// by isPesepayConfigured(), which /initiate gates on.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.PESEPAY_INTEGRATION_KEY = 'test-integration-key';
  process.env.PESEPAY_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
});

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

// /pesepay/initiate must reject unauthenticated callers, so the auth guard is
// stubbed: the stub still 401s when no Bearer header is present, which keeps the
// "requires authentication" assertions honest.
vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.adminUser = {
      id: 'admin-1',
      email: 'admin@preyone.com',
      role: 'CEO',
      fullName: 'Admin',
      company_id: authState.companyId,
    };
    next();
  },
}));

const authState = vi.hoisted(() => ({ companyId: null as string | null }));

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

    beforeEach(() => {
      // Prod's /initiate drives everything through pool.query (no client
      // transaction), so the once-queue has to start empty for every case.
      (pool.query as any).mockReset();
      process.env.PESEPAY_INTEGRATION_KEY = 'test-integration-key';
      process.env.PESEPAY_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
    });

    const PKG = {
      id: 'pkg-1',
      tier_name: 'PreMAX',
      price_amount: '34.99',
      price_currency: 'USD',
      duration_min: 43200,
      data_limit_gb: 100,
      is_uncapped: false,
      bandwidth_mbps_up: 10,
      bandwidth_mbps_down: 10,
      max_devices: 1,
    };

    it('returns 422 when Pesepay is not configured', async () => {
      delete process.env.PESEPAY_INTEGRATION_KEY;
      delete process.env.PESEPAY_API_KEY;
      delete process.env.PESEPAY_ENCRYPTION_KEY;

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send(validBody);

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/not configured/i);
      // Must not touch the DB before refusing the charge.
      expect(pool.query as any).not.toHaveBeenCalled();
    });

    it('returns 422 for an invalid Zimbabwe phone number', async () => {
      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send({ ...validBody, phone: '12345' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/valid Zimbabwe phone/i);
      expect(pool.query as any).not.toHaveBeenCalled();
    });

    it('returns 422 for an unknown package tier', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send(validBody);

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/Unknown package tier/i);
    });

    it('handles existing user by phone', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [PKG] })                                // 1: package lookup
        .mockResolvedValueOnce({ rows: [{ id: 'existing-user' }] })            // 2: existing user
        .mockResolvedValueOnce({ rows: [{ id: 'pay-1' }] })                    // 3: INSERT payments
        .mockResolvedValueOnce(undefined);                                    // 4: UPDATE pesepay_reference
      (initiateEcoCashPayment as any).mockResolvedValue({
        success: true,
        pollUrl: 'https://pay.pesepay.com/poll',
        transactionId: 'PSE-1',
      });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.pesepayPollUrl).toBe('https://pay.pesepay.com/poll');
      expect(res.body.reference).toMatch(/^PREY-[0-9A-F]{16}$/);
      // The client needs this to poll /status, which refuses unauthenticated reads.
      expect(res.body.statusToken).toBeTruthy();
      expect(res.body.amount).toBe(34.99);
      expect(res.body.phone).toBe('263771327202');
      expect(initiateEcoCashPayment as any).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'USD', phone: '263771327202' })
      );
    });

    it('creates new user when phone not found', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [PKG] })                                // 1: package lookup
        .mockResolvedValueOnce({ rows: [] })                                   // 2: no existing user
        .mockResolvedValueOnce({ rows: [{ id: 'new-user' }] })                 // 3: INSERT users
        .mockResolvedValueOnce({ rows: [{ id: 'pay-2' }] })                    // 4: INSERT payments
        .mockResolvedValueOnce(undefined);                                    // 5: UPDATE pesepay_reference
      (initiateEcoCashPayment as any).mockResolvedValue({
        success: true,
        pollUrl: 'https://pay.pesepay.com/poll',
      });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
    });

    it('handles Pesepay failure gracefully', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [PKG] })                                // 1: package lookup
        .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })                   // 2: existing user
        .mockResolvedValueOnce({ rows: [{ id: 'pay-3' }] })                    // 3: INSERT payments
        .mockResolvedValueOnce(undefined);                                    // 4: UPDATE status=failed
      (initiateEcoCashPayment as any).mockResolvedValue({
        success: false,
        error: 'Insufficient funds',
      });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send(validBody);

      expect(res.status).toBe(502);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toBe('Insufficient funds');
    });
  });

  describe('POST /api/payments/webhook', () => {
    beforeEach(async () => {
      // Both mocks are module-level singletons, so queued once-values would
      // otherwise leak between tests and silently satisfy the wrong query.
      (pool.query as any).mockReset();
      const client = await (pool as any).connect();
      client.query.mockReset();
    });

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
      expect(res.text).toContain('Invalid or undecryptable payload');
      // An undecryptable payload is not from Pesepay: never touch the DB.
      expect(pool.query as any).not.toHaveBeenCalled();
    });

    it('returns 404 when the merchant reference is unknown', async () => {
      (decryptResponse as any).mockReturnValue({
        merchantReference: 'REF-NOPE',
        transactionStatus: 'SUCCESS',
      });
      (pool.query as any).mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp())
        .post('/api/payments/webhook')
        .send({ payload: 'encrypted-string' });

      expect(res.status).toBe(404);
    });

    it('rejects a mismatched callback token without completing the payment', async () => {
      (decryptResponse as any).mockReturnValue({
        merchantReference: 'REF-003',
        transactionStatus: 'SUCCESS',
      });
      (pool.query as any).mockResolvedValueOnce({
        rows: [{ id: 'pay-3', status: 'pending', voucher_code: null, amount: 10, webhook_token: 'a'.repeat(64) }],
      });

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + 'b'.repeat(64))
        .send({ payload: 'encrypted-string' });

      expect(res.status).toBe(404);
    });

    it('processes successful payment webhook', async () => {
      (decryptResponse as any).mockReturnValue({
        merchantReference: 'REF-001',
        transactionStatus: 'SUCCESS',
        amount: 10,
      });

      (pool.query as any).mockResolvedValueOnce({
        rows: [{ id: 'pay-1', status: 'pending', voucher_code: null, amount: 10, webhook_token: null }],
      });

      const client = await (pool as any).connect();
      client.query
        .mockResolvedValueOnce(undefined)                                    // 1: BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'pay-1',
              user_id: 'user-1',
              tier_name: 'PreLITE',
              amount: 10,
              currency: 'USD',
              payment_method: 'EcoCash (Pesepay)',
              status: 'pending',
              duration_min: 1440,
              data_limit_gb: 100,
              is_uncapped: false,
              bandwidth_mbps_up: 10,
              bandwidth_mbps_down: 10,
              max_devices: 1,
            },
          ],
        })                                                                   // 2: SELECT payment FOR UPDATE
        .mockResolvedValueOnce(undefined)                                    // 3: SAVEPOINT mint_voucher
        .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'CT-TESTCODE1' }] }) // 4: INSERT INTO vouchers
        .mockResolvedValueOnce(undefined)                                    // 5: RELEASE SAVEPOINT
        .mockResolvedValueOnce(undefined)                                    // 6: UPDATE payments completed
        .mockResolvedValueOnce(undefined)                                    // 7: INSERT INTO transactions
        .mockResolvedValueOnce(undefined);                                   // 8: COMMIT

      const res = await request(createApp())
        .post('/api/payments/webhook')
        .send({ payload: 'encrypted-string' });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('completed');
      expect(res.body.voucherCode).toBe('CT-TESTCODE1');
    });

    it('marks a gateway failure as failed without minting a voucher', async () => {
      (decryptResponse as any).mockReturnValue({
        merchantReference: 'REF-002',
        transactionStatus: 'FAILED',
      });

      (pool.query as any)
        .mockResolvedValueOnce({
          rows: [{ id: 'pay-2', status: 'pending', voucher_code: null, amount: 20, webhook_token: null }],
        })
        .mockResolvedValueOnce(undefined);                                  // UPDATE status = failed

      const res = await request(createApp())
        .post('/api/payments/webhook')
        .send({ payload: 'encrypted-string' });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('failed');
      expect(res.body.voucherCode).toBeUndefined();
      const updateCall = (pool.query as any).mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes("SET status = 'failed'")
      );
      expect(updateCall).toBeTruthy();
      expect(updateCall![1]).toEqual(['pay-2', 'Payment FAILED', 'pending']);
    });

    it('does not mint again when the payment is already completed', async () => {
      (decryptResponse as any).mockReturnValue({
        merchantReference: 'REF-004',
        transactionStatus: 'SUCCESS',
      });

      (pool.query as any).mockResolvedValueOnce({
        rows: [{ id: 'pay-4', status: 'completed', voucher_code: 'CT-ALREADY1', amount: 10, webhook_token: null }],
      });

      // Clear the bookkeeping call the beforeEach makes to reach the client,
      // then assert no transaction was opened at all.
      const client = await (pool as any).connect();
      client.query.mockClear();

      const res = await request(createApp())
        .post('/api/payments/webhook')
        .send({ payload: 'encrypted-string' });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('completed');
      expect(res.body.voucherCode).toBeUndefined();
      expect(client.query).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/payments/status/:paymentId', () => {
    const statusToken = (paymentId: string) =>
      jwt.sign({ paymentId, type: 'status' }, process.env.JWT_SECRET as string, {
        algorithm: 'HS256',
      });

    beforeEach(() => {
      (pool.query as any).mockReset();
    });

    it('requires authentication so payment IDs cannot be enumerated', async () => {
      const res = await request(createApp()).get('/api/payments/status/pay-1');

      expect(res.status).toBe(401);
      expect(pool.query as any).not.toHaveBeenCalled();
    });

    it('returns 401 for an invalid token', async () => {
      const res = await request(createApp()).get('/api/payments/status/pay-1?token=not-a-jwt');

      expect(res.status).toBe(401);
    });

    it('returns 403 when the token was minted for a different payment', async () => {
      const res = await request(createApp()).get(
        `/api/payments/status/pay-1?token=${encodeURIComponent(statusToken('pay-2'))}`
      );

      expect(res.status).toBe(403);
    });

    it('returns payment status', async () => {
      (pool.query as any).mockResolvedValue({
        rows: [
          {
            id: 'pay-1',
            status: 'completed',
            pesepay_reference: 'REF-1',
            amount: 34.99,
            completed_at: new Date().toISOString(),
            voucher_code: 'CT-ABCD2345',
            tier_name: 'PreMAX',
            error_message: null,
          },
        ],
      });

      const res = await request(createApp()).get(
        `/api/payments/status/pay-1?token=${encodeURIComponent(statusToken('pay-1'))}`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.voucherCode).toBe('CT-ABCD2345');
      expect(res.body.reference).toBe('REF-1');
      expect(res.body.supportRequired).toBe(false);
    });

    it('returns 404 for unknown payment', async () => {
      (pool.query as any).mockResolvedValue({ rows: [] });

      const res = await request(createApp()).get(
        `/api/payments/status/unknown?token=${encodeURIComponent(statusToken('unknown'))}`
      );

      expect(res.status).toBe(404);
    });

    it('reconciles a pending payment against the gateway on poll', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'pay-recon-1',
              status: 'pending',
              pesepay_reference: 'REF-R1',
              amount: 34.99,
              completed_at: null,
              voucher_code: null,
              tier_name: 'PreMAX',
              error_message: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });
      (verifyPaymentStatus as any).mockResolvedValue({ found: true, status: 'PENDING' });

      const res = await request(createApp()).get(
        `/api/payments/status/pay-recon-1?token=${encodeURIComponent(statusToken('pay-recon-1'))}`
      );

      expect(verifyPaymentStatus as any).toHaveBeenCalledWith('REF-R1');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
    });

    it('marks a pending payment failed when the gateway reports failure', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'pay-recon-2',
              status: 'pending',
              pesepay_reference: 'REF-R2',
              amount: 34.99,
              completed_at: null,
              voucher_code: null,
              tier_name: 'PreMAX',
              error_message: null,
            },
          ],
        })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          rows: [
            {
              status: 'failed',
              completed_at: null,
              voucher_code: null,
              error_message: 'Gateway reported FAILED (status check)',
            },
          ],
        });
      (verifyPaymentStatus as any).mockResolvedValue({ found: true, status: 'FAILED' });

      const res = await request(createApp()).get(
        `/api/payments/status/pay-recon-2?token=${encodeURIComponent(statusToken('pay-recon-2'))}`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      const updateCall = (pool.query as any).mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('SET status = $2')
      );
      expect(updateCall).toBeTruthy();
      expect(updateCall![1]).toEqual([
        'pay-recon-2',
        'failed',
        'Gateway reported FAILED (status check)',
      ]);
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
      authState.companyId = null;
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
        .set('Authorization', 'Bearer test-token')
        .send({ ...validBody, amount: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('amount');
    });

    it('rejects an unsupported currency', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .set('Authorization', 'Bearer test-token')
        .send({ ...validBody, currencyCode: 'GBP' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('USD or ZiG');
    });

    it('requires reasonForPayment', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .set('Authorization', 'Bearer test-token')
        .send({ ...validBody, reasonForPayment: '  ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('reasonForPayment');
    });

    it('rejects an unauthenticated caller before touching the gateway', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .send(validBody);

      expect(res.status).toBe(401);
      expect(initiatePesepayPayment as any).not.toHaveBeenCalled();
    });

    it('ignores a body tenant_id that disagrees with the session', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .set('Authorization', 'Bearer test-token')
        .send({ ...validBody, tenant_id: '99999999-9999-4999-8999-999999999999' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/does not match/i);
      expect(initiatePesepayPayment as any).not.toHaveBeenCalled();
    });

    it('derives the tenant from the session company when the body omits it', async () => {
      authState.companyId = TENANT;
      const { tenant_id, ...withoutTenant } = validBody;

      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .set('Authorization', 'Bearer test-token')
        .send(withoutTenant);

      expect(res.status).toBe(200);
      expect(res.body.tenantId).toBe(TENANT);
      const insert = (pool.query as any).mock.calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('INTO pesepay_intents')
      );
      expect(insert).toBeTruthy();
      // The intent must be written against the session's company, not the body.
      expect(insert![1][1]).toBe(TENANT);
    });

    it('rejects an unsupported payment rail', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .set('Authorization', 'Bearer test-token')
        .send({ ...validBody, paymentMethod: 'bitcoin' });

      expect(res.status).toBe(400);
    });

    it('requires a document for invoice payments', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .set('Authorization', 'Bearer test-token')
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
        .set('Authorization', 'Bearer test-token')
        .send(validBody);

      // No portal company can be resolved, so there is no tenant to charge and
      // the request is refused before the gateway is ever called.
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/no company/i);
      expect(initiatePesepayPayment as any).not.toHaveBeenCalled();
    });

    it('rejects an amount larger than the outstanding balance', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .set('Authorization', 'Bearer test-token')
        .send({ ...validBody, amount: 500 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('balance');
      expect(initiatePesepayPayment).not.toHaveBeenCalled();
    });

    it('returns a reference number and redirect URL for an invoice', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .set('Authorization', 'Bearer test-token')
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.referenceNumber).toMatch(/^PREYONE-/);
      expect(res.body.redirectUrl).toContain('pesepay.com');
      // The caller sends "ZWG", but Pesepay's own code is "ZiG". Sending ZWG
      // through untranslated is rejected with "Currency record was not found".
      expect(res.body.currencyCode).toBe('ZiG');
      expect(res.body.paymentMethod).toBe('innbucks');

      const call = (initiatePesepayPayment as any).mock.calls[0][0];
      expect(call.currencyCode).toBe('ZiG');
      expect(call.paymentMethod).toBe('innbucks');
      expect(call.reference).toBe(res.body.referenceNumber);
    });

    it('initiates a subscription payment', async () => {
      const res = await request(createApp())
        .post('/api/payments/pesepay/initiate')
        .set('Authorization', 'Bearer test-token')
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
        .set('Authorization', 'Bearer test-token')
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
        .set('Authorization', 'Bearer test-token')
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

  // ── Public customer status endpoint ──────────────────────────────
  //
  // GET /api/payments/pesepay/status/:intentId is reachable by an
  // unauthenticated customer, so these tests focus on the two things that
  // matter: it cannot be used to enumerate intents, and it never returns one
  // customer's payment details to another.
  describe('GET /api/payments/pesepay/status/:intentId', () => {
    const INTENT = '11111111-1111-4111-8111-111111111111';
    const OTHER_INTENT = '22222222-2222-4222-8222-222222222222';

    const intentRow = {
      id: INTENT,
      reference: 'PREY-ABC123',
      provider_reference: 'PSP-REF-1',
      amount: '25.50',
      currency: 'USD',
      status: 'pending',
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: null,
    };

    function statusToken(intentId: string, type = 'pesepay-status') {
      return jwt.sign({ intentId, type }, 'test-jwt-secret', { algorithm: 'HS256', expiresIn: '2h' });
    }

    beforeEach(() => {
      (pool.query as any).mockImplementation(async (sql: string, params?: any[]) => {
        if (/FROM pesepay_intents/.test(sql)) {
          return params?.[0] === INTENT ? { rows: [intentRow], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      });
    });

    it('returns the public status contract for a correctly signed token', async () => {
      const res = await request(createApp())
        .get(`/api/payments/pesepay/status/${INTENT}`)
        .query({ token: statusToken(INTENT) });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'PENDING',
        referenceNumber: 'PSP-REF-1',
        amount: 25.5,
      });
    });

    it('maps completed to SUCCESS and failed to FAILED', async () => {
      for (const [dbStatus, expected] of [
        ['completed', 'SUCCESS'],
        ['failed', 'FAILED'],
      ] as const) {
        (pool.query as any).mockImplementation(async (sql: string) =>
          /FROM pesepay_intents/.test(sql)
            ? { rows: [{ ...intentRow, status: dbStatus }], rowCount: 1 }
            : { rows: [], rowCount: 1 }
        );
        const res = await request(createApp())
          .get(`/api/payments/pesepay/status/${INTENT}`)
          .query({ token: statusToken(INTENT) });
        expect(res.body.status).toBe(expected);
      }
    });

    it('rejects a request with no token', async () => {
      const res = await request(createApp()).get(`/api/payments/pesepay/status/${INTENT}`);
      expect(res.status).toBe(401);
    });

    it('rejects a forged or tampered token', async () => {
      const res = await request(createApp())
        .get(`/api/payments/pesepay/status/${INTENT}`)
        .query({ token: `${statusToken(INTENT)}tampered` });
      expect(res.status).toBe(401);
    });

    it('refuses a valid token that was issued for a different intent', async () => {
      const res = await request(createApp())
        .get(`/api/payments/pesepay/status/${INTENT}`)
        .query({ token: statusToken(OTHER_INTENT) });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/does not match/i);
    });

    it('does not let a legacy payment status token be replayed here', async () => {
      const legacy = jwt.sign({ paymentId: INTENT, type: 'status' }, 'test-jwt-secret', {
        algorithm: 'HS256',
        expiresIn: '2h',
      });
      const res = await request(createApp())
        .get(`/api/payments/pesepay/status/${INTENT}`)
        .query({ token: legacy });
      expect(res.status).toBe(401);
    });

    it('404s an unknown intent and never touches another tenant row', async () => {
      const res = await request(createApp())
        .get(`/api/payments/pesepay/status/${OTHER_INTENT}`)
        .query({ token: statusToken(OTHER_INTENT) });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Payment not found');
      // The lookup must be by the token-bound id only, with no reference lookup
      // that could match a different customer's payment.
      const call = (pool.query as any).mock.calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('FROM pesepay_intents')
      );
      expect(call![0]).toMatch(/WHERE id = \$1/);
      expect(call![1][0]).toBe(OTHER_INTENT);
    });

    it('never leaks tenant or purpose fields in the public response', async () => {
      const res = await request(createApp())
        .get(`/api/payments/pesepay/status/${INTENT}`)
        .query({ token: statusToken(INTENT) });

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('tenant_id');
      expect(res.body).not.toHaveProperty('purpose');
      expect(res.body).not.toHaveProperty('reason_for_payment');
      expect(res.body).not.toHaveProperty('target_id');
    });
  });
});
