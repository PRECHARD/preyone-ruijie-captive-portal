import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock('../src/services/pesepayService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/pesepayService')>();
  return {
    ...actual,
    initiateEcoCashPayment: vi.fn(),
    isPesepayConfigured: vi.fn(),
    verifyPaymentStatus: vi.fn(),
  };
});

// Ruijie Cloud minting is off by default in tests (isRuijieCloudConfigured()
// returns undefined/false), so every existing test keeps exercising the legacy
// local-mint path. Individual Ruijie tests override these mocks.
vi.mock('../src/services/ruijieMint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ruijieMint')>();
  return {
    ...actual,
    isRuijieCloudConfigured: vi.fn(),
    mintRuijieVoucherForTier: vi.fn(),
  };
});

import { pool } from '../src/db/pool';
import { paymentsRouter } from '../src/routes/payments';
import { maintenanceCheck } from '../src/middleware/maintenanceMode';
import {
  initiateEcoCashPayment,
  isPesepayConfigured,
  verifyPaymentStatus,
  encryptPayload,
} from '../src/services/pesepayService';
import { isRuijieCloudConfigured, mintRuijieVoucherForTier } from '../src/services/ruijieMint';
import { RuijieApiError } from '../src/services/ruijieCloud';

const SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';
const mockInitiate = vi.mocked(initiateEcoCashPayment);
const mockConfigured = vi.mocked(isPesepayConfigured);
const mockVerify = vi.mocked(verifyPaymentStatus);

// Must be exactly 16/24/32 bytes: Pesepay derives the AES IV from the first 16,
// and crypto-js silently produces unusable output for other key lengths.
const ENCRYPTION_KEY = 'testkey0123456789abcdefghijklmno';
process.env.PESEPAY_ENCRYPTION_KEY = ENCRYPTION_KEY;
process.env.PESEPAY_INTEGRATION_KEY = 'test-integration-key';

// Shape of the per-payment callback token: 32 random bytes as hex.
const CB_TOKEN = 'a1b2c3d4'.repeat(8);
const OTHER_TOKEN = 'ffffffff'.repeat(8);

// Pesepay delivers callbacks as an AES-CBC payload; build real ones so the
// webhook's decryption step is genuinely exercised.
function encrypt(obj: Record<string, unknown>): string {
  return encryptPayload(obj, ENCRYPTION_KEY);
}

function callbackBody(obj: Record<string, unknown>) {
  return { payload: encrypt(obj) };
}

const mockPackage = {
  id: 'pkg-1',
  tier_name: 'PreFlow',
  price_amount: '9.99',
  price_currency: 'USD',
  duration_min: 43200,
  data_limit_gb: 40,
  is_uncapped: false,
  bandwidth_mbps_up: 5,
  bandwidth_mbps_down: 5,
  max_devices: 1,
};

const mockUser = { id: 'u-1' };
const mockPayment = { id: 'pay-1' };

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentsRouter);
  return app;
}

describe('Payments routes', () => {
  beforeEach(() => {
    // reset (not clear): queued mockResolvedValueOnce values must not leak into
    // the next test and shift every DB result by one.
    vi.resetAllMocks();
    mockConfigured.mockReturnValue(true);
  });

  describe('POST /api/payments/initiate', () => {
    it('returns 422 when Pesepay is not configured', async () => {
      mockConfigured.mockReturnValue(false);

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send({ tier: 'PreFlow', phone: '0771300000' });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain('not configured');
    });

    it('returns 422 for an invalid phone number', async () => {
      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send({ tier: 'PreFlow', phone: '123' });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain('valid Zimbabwe phone');
    });

    it('initiates a Pesepay payment and returns the hosted EcoCash page', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [mockPackage] })   // package lookup
        .mockResolvedValueOnce({ rows: [] })              // existing user lookup
        .mockResolvedValueOnce({ rows: [mockUser] })      // create user
        .mockResolvedValueOnce({ rows: [mockPayment] })   // create payment
        .mockResolvedValueOnce({ rows: [] });             // store pesepay reference + poll url

      mockInitiate.mockResolvedValue({
        success: true,
        pollUrl: 'https://pesepay.com/poll/ABC123',
        transactionId: 'PS-REF-1',
      });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send({ tier: 'PreFlow', phone: '0771 327 202' });

      expect(res.status).toBe(200);
      expect(res.body.paymentId).toBe('pay-1');
      expect(res.body.status).toBe('pending');
      expect(res.body.pesepayPollUrl).toBe('https://pesepay.com/poll/ABC123');
      expect(res.body.pesepayReference).toBe('PS-REF-1');
      expect(res.body.reference).toMatch(/^PREY-[0-9A-F]{16}$/);

      expect(mockInitiate).toHaveBeenCalledTimes(1);
      // Phone handed to Pesepay is normalized to E.164 (263…), and the merchant
      // reference we generated is what Pesepay will echo back on the callback.
      expect(mockInitiate).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: '263771327202',
          reference: res.body.reference,
          amount: 9.99,
        })
      );

      // Pesepay's own reference and hosted page URL are persisted for support.
      const updateCall = (pool.query as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes('UPDATE payments')
      );
      expect(updateCall).toBeDefined();
      expect(String(updateCall[0])).toContain('pesepay_poll_url');
      expect(String(updateCall[0])).toContain('pesepay_reference');
      expect(String(updateCall[0])).not.toContain('contipay');
      expect(updateCall[1][1]).toBe('PS-REF-1');
      expect(updateCall[1][2]).toBe('https://pesepay.com/poll/ABC123');
    });

    // The 0.99 PreLite tier is billed at a flat 1.00: EcoCash settles in whole
    // dollars (USD minimum 1.00), so fractions of a dollar can never be charged.
    it('bills a 0.99 package as 1.00 everywhere: DB row, Pesepay request, response', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [{ ...mockPackage, tier_name: 'PreLite', price_amount: '0.99' }] }) // package lookup
        .mockResolvedValueOnce({ rows: [] })                                            // existing user lookup
        .mockResolvedValueOnce({ rows: [mockUser] })                                    // create user
        .mockResolvedValueOnce({ rows: [{ id: 'pay-prelite' }] })                       // create payment
        .mockResolvedValueOnce({ rows: [] });                                           // store pesepay reference + poll url

      mockInitiate.mockResolvedValue({
        success: true,
        pollUrl: 'https://pesepay.com/poll/PREZ',
        transactionId: 'PS-REF-PRELITE',
      });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send({ tier: 'PreLite', phone: '0771 327 202' });

      expect(res.status).toBe(200);
      expect(res.body.amount).toBe(1);
      // The DB row stores 1.00 (not 0.99) so the webhook amount-match check
      // compares against the actual charge, and Pesepay receives 1.00.
      const insertCall = (pool.query as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes('INSERT INTO payments')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][3]).toBe(1);
      expect(mockInitiate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1 })
      );
    });

    it('stamps a unique per-payment callback token and passes it to Pesepay', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [mockPackage] })
        .mockResolvedValueOnce({ rows: [mockUser] })
        .mockResolvedValueOnce({ rows: [mockPayment] })
        .mockResolvedValueOnce({ rows: [] });

      mockInitiate.mockResolvedValue({ success: true, pollUrl: 'https://pesepay.com/poll/ABC123' });

      await request(createApp())
        .post('/api/payments/initiate')
        .send({ tier: 'PreFlow', phone: '0771 327 202' });

      // The token must be persisted on the payment row...
      const insertCall = (pool.query as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes('INSERT INTO payments')
      );
      expect(String(insertCall[0])).toContain('webhook_token');
      expect(String(insertCall[0])).toContain('merchant_reference');
      const token = insertCall[1][8];
      expect(String(token)).toMatch(/^[a-f0-9]{64}$/);

      // ...and handed to Pesepay, which embeds it in resultUrl and echoes it back.
      expect(mockInitiate.mock.calls[0][0].webhookToken).toBe(token);
    });

    it('generates a different callback token for every payment', async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        (pool.query as any)
          .mockResolvedValueOnce({ rows: [mockPackage] })
          .mockResolvedValueOnce({ rows: [mockUser] })
          .mockResolvedValueOnce({ rows: [{ id: `pay-${i}` }] })
          .mockResolvedValueOnce({ rows: [] });

        mockInitiate.mockResolvedValue({ success: true, pollUrl: 'https://pesepay.com/poll/x' });

        await request(createApp())
          .post('/api/payments/initiate')
          .send({ tier: 'PreFlow', phone: '0771 327 202' });

        const insertCall = (pool.query as any).mock.calls.findLast(
          (c: any[]) => String(c[0]).includes('INSERT INTO payments')
        );
        seen.add(String(insertCall[1][8]));
      }
      expect(seen.size).toBe(3);
    });

    it('marks the payment failed and returns 502 when Pesepay declines to start', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [mockPackage] })
        .mockResolvedValueOnce({ rows: [mockUser] })
        .mockResolvedValueOnce({ rows: [mockPayment] })
        .mockResolvedValueOnce({ rows: [] }); // status -> failed update

      mockInitiate.mockResolvedValue({ success: false, error: 'No poll URL received from payment provider' });

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send({ tier: 'PreFlow', phone: '0771300000' });

      expect(res.status).toBe(502);
      expect(res.body.status).toBe('failed');

      const failedUpdate = (pool.query as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes("status = 'failed'")
      );
      expect(failedUpdate).toBeDefined();
    });

    it('returns 502 and records the error when Pesepay throws', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [mockPackage] })
        .mockResolvedValueOnce({ rows: [mockUser] })
        .mockResolvedValueOnce({ rows: [mockPayment] })
        .mockResolvedValueOnce({ rows: [] });

      mockInitiate.mockRejectedValue(new Error('upstream timeout'));

      const res = await request(createApp())
        .post('/api/payments/initiate')
        .send({ tier: 'PreFlow', phone: '0771300000' });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('upstream timeout');

      const failedUpdate = (pool.query as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes("status = 'failed'")
      );
      expect(failedUpdate).toBeDefined();
    });
  });

  describe('POST /api/payments/webhook', () => {
    const paidRow = {
      id: 'pay-1',
      status: 'pending',
      voucher_code: null,
      amount: '9.99',
      currency: 'USD',
      phone_number: '263771327202',
      webhook_token: CB_TOKEN,
      tier_name: 'PreFlow',
      price_amount: '9.99',
      duration_min: 43200,
      data_limit_gb: 40,
      is_uncapped: false,
      bandwidth_mbps_up: 5,
      bandwidth_mbps_down: 5,
      max_devices: 1,
      user_id: 'u-1',
      payment_method: 'EcoCash (Pesepay)',
    };

    const MERCHANT_REF = 'PREY-ABCDEF0123456789';

    it('completes a paid payment: mints a voucher and records the transaction', async () => {
      // completePayment runs inside a connection-level transaction
      // (pool.connect → BEGIN → SELECT…FOR UPDATE → mint → COMMIT).
      const clientQuery = vi.fn();
      (pool.connect as any).mockResolvedValue({ query: clientQuery, release: vi.fn() });

      (pool.query as any).mockResolvedValueOnce({ rows: [paidRow] });   // webhook payment lookup

      clientQuery
        .mockResolvedValueOnce({ rows: [] })                              // BEGIN
        .mockResolvedValueOnce({ rows: [paidRow] })                       // SELECT … FOR UPDATE
        .mockResolvedValueOnce({ rows: [] })                              // SAVEPOINT mint_voucher
        .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'CT-ABC12345' }] }) // INSERT voucher
        .mockResolvedValueOnce({ rows: [] })                              // RELEASE SAVEPOINT mint_voucher
        .mockResolvedValueOnce({ rows: [] })                              // UPDATE payments → completed
        .mockResolvedValueOnce({ rows: [] })                              // INSERT transaction
        .mockResolvedValueOnce({ rows: [] });                             // COMMIT

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS', amount: 9.99 }));

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('completed');
      expect(res.body.voucherCode).toBe('CT-ABC12345');

      // Voucher insert happens inside the transaction (client) and uses a
      // generated CT-###### code plus the package attributes.
      const voucherCall = clientQuery.mock.calls.find(
        (c: any[]) => String(c[0]).includes('INSERT INTO vouchers')
      );
      expect(voucherCall).toBeDefined();
      expect(voucherCall[1][0]).toMatch(/^CT-[A-Z2-9]{8}$/); // $1 = generated code

      // The payment row must be locked FOR UPDATE before minting
      const lockCall = clientQuery.mock.calls.find(
        (c: any[]) => String(c[0]).includes('FOR UPDATE')
      );
      expect(lockCall).toBeDefined();

      // Regression: the voucher INSERT reads these six attributes off `pay`,
      // but they are columns of `packages`, not `payments`. If the locking
      // SELECT does not project them off the join, every one arrives as
      // `undefined` and the mint fails with a NOT NULL violation - which is
      // exactly what shipped: zero payments had ever completed. The mocked
      // `paidRow` above carries these fields, so asserting on the query text is
      // the only way to catch a missing projection.
      const lockSql = String(lockCall[0]);
      for (const col of [
        'duration_min',
        'data_limit_gb',
        'is_uncapped',
        'bandwidth_mbps_up',
        'bandwidth_mbps_down',
        'max_devices',
      ]) {
        expect(lockSql).toContain(`pk.${col}`);
      }
    });

    it('completes on a valid encrypted payload even when no token came back', async () => {
      // Regression guard for the 2026-09-22 incident: requiring an out-of-band
      // credential 401'd 24/24 genuine callbacks, so customers were charged and
      // never got a voucher. Pesepay's payload is AES-encrypted with a
      // pre-shared key, which is itself the authentication, so a callback that
      // decrypts must still complete if Pesepay strips the query string.
      const clientQuery = vi.fn();
      (pool.connect as any).mockResolvedValue({ query: clientQuery, release: vi.fn() });
      (pool.query as any).mockResolvedValueOnce({ rows: [paidRow] });

      clientQuery
        .mockResolvedValueOnce({ rows: [] })                                 // BEGIN
        .mockResolvedValueOnce({ rows: [paidRow] })                          // SELECT … FOR UPDATE
        .mockResolvedValueOnce({ rows: [] })                                 // SAVEPOINT
        .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'CT-ABC12345' }] }) // INSERT voucher
        .mockResolvedValueOnce({ rows: [] })                                 // RELEASE SAVEPOINT
        .mockResolvedValueOnce({ rows: [] })                                 // UPDATE payments
        .mockResolvedValueOnce({ rows: [] })                                 // INSERT transaction
        .mockResolvedValueOnce({ rows: [] });                                // COMMIT

      const res = await request(createApp())
        .post('/api/payments/webhook')
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS', amount: 9.99 }));

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('completed');
      expect(res.body.voucherCode).toBe('CT-ABC12345');
    });

    it('does not double-mint when the payment completed while waiting on the row lock', async () => {
      // Two concurrent completed webhooks: the first mints, the second blocks on
      // FOR UPDATE, re-reads status='completed' and must return the SAME voucher.
      const clientQuery = vi.fn();
      (pool.connect as any).mockResolvedValue({ query: clientQuery, release: vi.fn() });

      (pool.query as any).mockResolvedValueOnce({ rows: [paidRow] });

      clientQuery
        .mockResolvedValueOnce({ rows: [] })                              // BEGIN
        .mockResolvedValueOnce({                                           // SELECT … FOR UPDATE
          rows: [{ ...paidRow, status: 'completed', voucher_code: 'CT-EXISTING' }],
        })
        .mockResolvedValueOnce({ rows: [] });                             // COMMIT

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS' }));

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('completed');
      expect(res.body.voucherCode).toBe('CT-EXISTING');

      // No second voucher, no second transaction, no status flip: single-mint.
      const voucherInserts = clientQuery.mock.calls.filter(
        (c: any[]) => String(c[0]).includes('INSERT INTO vouchers')
      );
      expect(voucherInserts).toHaveLength(0);
    });

    it('acknowledges pending webhooks without completing', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [paidRow] });

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'AWAITING' }));

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('pending');
      expect(res.body.voucherCode).toBeUndefined();
    });

    it('marks a declined payment as failed', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [paidRow] })
        .mockResolvedValueOnce({ rows: [] }); // status -> failed update

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'CANCELLED' }));

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('failed');

      const failedUpdate = (pool.query as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes("status = 'failed'")
      );
      expect(failedUpdate).toBeDefined();
    });

    it('rejects a callback with no payload before touching the database', async () => {
      const res = await request(createApp()).post('/api/payments/webhook').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/payload/i);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('rejects an undecryptable payload without touching the database', async () => {
      // Not produced with our key => cannot be trusted => must not reach a lookup.
      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send({ payload: 'this-is-not-a-valid-ciphertext' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/payload/i);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('rejects a valid payload that carries no merchant reference', async () => {
      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ transactionStatus: 'SUCCESS' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/merchant reference/i);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('rejects a malformed token without hitting the database', async () => {
      const res = await request(createApp())
        .post('/api/payments/webhook?token=not-a-real-token')
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS' }));

      expect(res.status).toBe(401);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown merchant reference', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: 'PREY-0000000000000000', transactionStatus: 'SUCCESS' }));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Unknown payment');
    });

    it('rejects a token that does not belong to the referenced payment', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [paidRow] });

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + OTHER_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS' }));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Unknown payment');
    });

    it('rejects a callback whose amount does not match the payment', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [paidRow] });

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS', amount: 99.99 }));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Amount mismatch');
    });

    it('does not let a failed webhook overwrite a completed payment', async () => {
      (pool.query as any).mockResolvedValueOnce({
        rows: [{ ...paidRow, status: 'completed', voucher_code: 'CT-ABC12345' }],
      });

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'FAILED' }));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.state).toBe('completed');

      const failedUpdate = (pool.query as any).mock.calls.find((c: any[]) =>
        String(c[0]).includes("status = 'failed'")
      );
      expect(failedUpdate).toBeUndefined();
    });
  });

  // When Ruijie Cloud is the mint source and its API fails, the customer has
  // ALREADY been charged by Pesepay but no voucher exists. The transaction must
  // roll back (payment stays pending) AND an operations alert must be raised —
  // otherwise the failure is silent and nobody refunds them.
  describe('Ruijie mint failure alerting', () => {
    const paidRow = {
      id: 'pay-1',
      status: 'pending',
      voucher_code: null,
      amount: '9.99',
      currency: 'USD',
      phone_number: '263771327202',
      pesepay_reference: 'PS-REF-7788',
      webhook_token: CB_TOKEN,
      tier_name: 'PreFlow',
      price_amount: '9.99',
      duration_min: 43200,
      data_limit_gb: 40,
      is_uncapped: false,
      bandwidth_mbps_up: 5,
      bandwidth_mbps_down: 5,
      max_devices: 1,
      user_id: 'u-1',
      payment_method: 'EcoCash (Pesepay)',
    };
    const MERCHANT_REF = 'PREY-ABCDEF0123456789';

    beforeEach(() => {
      vi.mocked(isRuijieCloudConfigured).mockReturnValue(true);
      vi.mocked(mintRuijieVoucherForTier).mockRejectedValue(
        new RuijieApiError('Login failed', 'Ruijie returned code 1 "Login failed"')
      );
    });

    // The alert write and the payments marker write run concurrently
    // (Promise.all), so the stubs must key off SQL text rather than call order.
    function stubPool(alertError?: Error) {
      (pool.query as any).mockImplementation((sql: string) => {
        const q = String(sql);
        if (q.includes('merchant_reference')) return { rows: [paidRow] };
        if (q.includes('SELECT email FROM users')) return { rows: [{ email: 'a@b.co' }] };
        if (q.includes('INSERT INTO alerts')) {
          return alertError ? Promise.reject(alertError) : { rows: [] };
        }
        if (q.includes('SET error_message = $2 WHERE id = $1')) return { rows: [] };
        return Promise.reject(new Error('unstubbed pool.query: ' + q.slice(0, 70)));
      });
    }

    function transactionFailsAtMint() {
      const clientQuery = vi.fn();
      (pool.connect as any).mockResolvedValue({ query: clientQuery, release: vi.fn() });
      clientQuery
        .mockResolvedValueOnce({ rows: [] })      // BEGIN
        .mockResolvedValueOnce({ rows: [paidRow] }) // SELECT … FOR UPDATE
        .mockResolvedValueOnce({ rows: [] })      // ROLLBACK
        .mockResolvedValueOnce({ rows: [] });
      return clientQuery;
    }

    it('rolls back and raises a critical alert carrying the Pesepay reference', async () => {
      const clientQuery = transactionFailsAtMint();
      stubPool();

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS', amount: 9.99 }));

      // No voucher is ever handed back.
      expect(res.body.voucherCode).toBeUndefined();
      expect(res.body.state).not.toBe('completed');

      // The transaction rolled back — nothing was written on the payment.
      const rollback = clientQuery.mock.calls.find((c: any[]) => String(c[0]).trim() === 'ROLLBACK');
      expect(rollback).toBeDefined();

      const alertCall = (pool.query as any).mock.calls.find((c: any[]) =>
        String(c[0]).includes('INSERT INTO alerts')
      );
      expect(alertCall).toBeDefined();
      const [type, severity, , message, targetType, targetId] = alertCall[1];
      expect(type).toBe('ruijie_mint_failure');
      expect(severity).toBe('critical');
      // Enough for support to find and refund the customer.
      expect(message).toContain('PS-REF-7788');
      expect(message).toContain('263771327202');
      expect(message).toContain('a@b.co');
      expect(message).toContain('Login failed');
      expect(targetType).toBe('payment');
      expect(targetId).toBe('pay-1');
    });

    it('flags the payment so the portal can show the support screen', async () => {
      transactionFailsAtMint();
      stubPool();

      await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS', amount: 9.99 }));

      const marker = (pool.query as any).mock.calls.find((c: any[]) =>
        String(c[0]).includes('SET error_message = $2 WHERE id = $1')
      );
      expect(marker).toBeDefined();
      // Guarded on status='pending' so a completed payment is never downgraded.
      expect(String(marker[0])).toContain("status = 'pending'");
      expect(marker[1][0]).toBe('pay-1');
      expect(marker[1][1]).toMatch(/^ruijie_mint_pending: /);
    });

    it('does not let a failing alert insert mask the original error', async () => {
      transactionFailsAtMint();
      stubPool(new Error('alerts table unavailable'));

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS', amount: 9.99 }));

      // The alert failure is swallowed; the route still answers normally and no
      // voucher is issued.
      expect(res.status).toBe(500);
      expect(res.body.voucherCode).toBeUndefined();
    });

    it('still flags the payment when the alert insert fails', async () => {
      transactionFailsAtMint();
      stubPool(new Error('alerts table unavailable'));

      await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS', amount: 9.99 }));

      // The two writes are independent: losing the ops alert must not also cost
      // the customer their support screen.
      const marker = (pool.query as any).mock.calls.find((c: any[]) =>
        String(c[0]).includes('SET error_message = $2 WHERE id = $1')
      );
      expect(marker).toBeDefined();
    });

    it('does not alert for non-Ruijie failures such as a missing payment', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [] }); // no such payment

      const res = await request(createApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: MERCHANT_REF, transactionStatus: 'SUCCESS', amount: 9.99 }));

      expect(res.status).toBe(404);
      const alertCall = (pool.query as any).mock.calls.find((c: any[]) =>
        String(c[0]).includes('INSERT INTO alerts')
      );
      expect(alertCall).toBeUndefined();
    });
  });

  describe('GET /api/payments/return', () => {
    const pendingRow = {
      id: 'pay-1',
      status: 'pending',
      pesepay_reference: 'PS-REF-1',
      amount: '9.99',
    };

    it('redirects the browser back to the portal with a signed status token', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [pendingRow] });
      // Gateway reports it still awaiting: nothing to reconcile.
      mockVerify.mockResolvedValue({ status: 'AWAITING', found: true });

      const res = await request(createApp()).get('/api/payments/return?ref=PREY-ABCDEF0123456789');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('pay=pay-1');
      expect(res.headers.location).toContain('tok=');
    });

    it('flags a missing reference', async () => {
      const res = await request(createApp()).get('/api/payments/return');

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/?payment=invalid');
    });

    it('flags an unknown reference', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp()).get('/api/payments/return?ref=PREY-UNKNOWN');

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/?payment=unknown');
    });

    // Pesepay does NOT retry the result callback. A payment can be settled at the
    // gateway while our webhook never arrives, leaving the customer charged with
    // no voucher. Returning from Pesepay is the reliable moment to reconcile.
    it('mints the voucher when the callback was lost but the gateway says SUCCESS', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [pendingRow] });
      mockVerify.mockResolvedValue({ status: 'SUCCESS', amount: 9.99, found: true });

      const clientQuery = vi.fn();
      (pool.connect as any).mockResolvedValue({ query: clientQuery, release: vi.fn() });

      const paidRow = {
        id: 'pay-1',
        status: 'pending',
        voucher_code: null,
        amount: '9.99',
        currency: 'USD',
        tier_name: 'PreFlow',
        price_amount: '9.99',
        duration_min: 43200,
        data_limit_gb: 40,
        is_uncapped: false,
        bandwidth_mbps_up: 5,
        bandwidth_mbps_down: 5,
        max_devices: 1,
        user_id: 'u-1',
        payment_method: 'EcoCash (Pesepay)',
      };
      clientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [paidRow] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'CT-RECONCILED' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp()).get('/api/payments/return?ref=PREY-ABCDEF0123456789');

      // The customer still lands back on the portal...
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('pay=pay-1');
      // ...and the voucher was minted without any webhook having arrived.
      expect(mockVerify).toHaveBeenCalledWith('PS-REF-1');
      const voucherCall = clientQuery.mock.calls.find(
        (c: any[]) => String(c[0]).includes('INSERT INTO vouchers')
      );
      expect(voucherCall).toBeDefined();
    });

    it('marks a lost-callback payment failed when the gateway says FAILED', async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [pendingRow] })
        .mockResolvedValueOnce({ rows: [] }); // status -> failed
      mockVerify.mockResolvedValue({ status: 'FAILED', found: true });

      const res = await request(createApp()).get('/api/payments/return?ref=PREY-ABCDEF0123456789');

      expect(res.status).toBe(302);
      const failedUpdate = (pool.query as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes("status = $2")
      );
      expect(failedUpdate).toBeDefined();
    });

    it('does not reconcile when the gateway has no record of the reference', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [pendingRow] });
      // found:false is the load-bearing part here: even if the status string
      // looks like a success, a reference Pesepay does not recognise must never
      // mint a voucher.
      mockVerify.mockResolvedValue({ status: 'SUCCESS', found: false });

      const res = await request(createApp()).get('/api/payments/return?ref=PREY-ABCDEF0123456789');

      expect(res.status).toBe(302);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('treats an unknown reference as pending rather than failed', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [pendingRow] });
      mockVerify.mockResolvedValue({ status: 'not_found', found: false });

      const res = await request(createApp()).get('/api/payments/return?ref=PREY-ABCDEF0123456789');

      expect(res.status).toBe(302);
      // No mint and no status change: the transaction may simply not have
      // appeared at the gateway yet.
      expect(pool.connect).not.toHaveBeenCalled();
      const statusUpdate = (pool.query as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes('UPDATE payments')
      );
      expect(statusUpdate).toBeUndefined();
    });

    it('never reconciles an already-completed payment', async () => {
      (pool.query as any).mockResolvedValueOnce({
        rows: [{ ...pendingRow, status: 'completed' }],
      });

      const res = await request(createApp()).get('/api/payments/return?ref=PREY-ABCDEF0123456789');

      expect(res.status).toBe(302);
      // Guards against a second completion minting a duplicate voucher.
      expect(mockVerify).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('does not reconcile when the payment has no Pesepay reference', async () => {
      (pool.query as any).mockResolvedValueOnce({
        rows: [{ ...pendingRow, pesepay_reference: null }],
      });

      const res = await request(createApp()).get('/api/payments/return?ref=PREY-ABCDEF0123456789');

      expect(res.status).toBe(302);
      expect(mockVerify).not.toHaveBeenCalled();
    });

    it('still redirects the customer when reconciliation throws', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [pendingRow] });
      mockVerify.mockResolvedValue({ status: 'error', found: false });

      const res = await request(createApp()).get('/api/payments/return?ref=PREY-ABCDEF0123456789');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('pay=pay-1');
    });
  });

  describe('GET /api/payments/status/:paymentId', () => {
    const statusToken = (paymentId: string) =>
      jwt.sign({ paymentId, type: 'status' }, SECRET, { algorithm: 'HS256', expiresIn: '2h' });

    // A pending row WITH a Pesepay reference triggers reconciliation, which then
    // re-reads the row. Stub both by SQL text so the two reads stay in order.
    function stubPendingStatus(row: Record<string, unknown>) {
      (pool.query as any).mockImplementation((sql: string) => {
        const q = String(sql);
        if (q.includes('FROM payments WHERE id = $1')) return { rows: [row] };
        if (q.includes('JOIN packages')) return { rows: [row] };
        return Promise.reject(new Error('unstubbed pool.query: ' + q.slice(0, 70)));
      });
    }

    it('returns payment status including voucher code and tier', async () => {
      (pool.query as any).mockResolvedValue({
        rows: [{
          id: 'pay-1',
          status: 'completed',
          amount: 34.99,
          completed_at: new Date().toISOString(),
          voucher_code: 'CT-ABC12345',
          tier_name: 'PreFlow',
        }],
      });

      const res = await request(createApp())
        .get('/api/payments/status/pay-1')
        .set('Authorization', `Bearer ${statusToken('pay-1')}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.voucherCode).toBe('CT-ABC12345');
      expect(res.body.tier).toBe('PreFlow');
    });

    it('returns null voucher code while pending', async () => {
      (pool.query as any).mockResolvedValue({
        rows: [{
          id: 'pay-1',
          status: 'pending',
          amount: 34.99,
          completed_at: null,
          voucher_code: null,
          tier_name: 'PreFlow',
        }],
      });

      const res = await request(createApp())
        .get('/api/payments/status/pay-1')
        .set('Authorization', `Bearer ${statusToken('pay-1')}`);

      expect(res.status).toBe(200);
      expect(res.body.voucherCode).toBeNull();
    });

    it('returns 404 for unknown payment', async () => {
      (pool.query as any).mockResolvedValue({ rows: [] });

      const res = await request(createApp())
        .get('/api/payments/status/unknown')
        .set('Authorization', `Bearer ${statusToken('unknown')}`);

      expect(res.status).toBe(404);
    });

    it('returns 401 when no token is provided', async () => {
      const res = await request(createApp()).get('/api/payments/status/pay-1');

      expect(res.status).toBe(401);
    });

    it('returns 403 when the token does not match the payment', async () => {
      const res = await request(createApp())
        .get('/api/payments/status/pay-1')
        .set('Authorization', `Bearer ${statusToken('other-payment')}`);

      expect(res.status).toBe(403);
    });

    // Seamless EcoCash has no hosted page, so the customer never navigates back
    // through /return. /status is the only heartbeat, so a pending payment is
    // reconciled here: the voucher self-mints while the portal polls.
    it('self-mints the voucher when polling and the gateway says SUCCESS', async () => {
      const pendingRow = { id: 'pay-9', status: 'pending', pesepay_reference: 'PS-REF-1', amount: '9.99' };
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [pendingRow] }) // status handler main SELECT
        .mockResolvedValueOnce({ rows: [{ status: 'completed', completed_at: new Date().toISOString(), voucher_code: 'CT-SELFMINT' }] }); // refresh
      mockVerify.mockResolvedValue({ status: 'SUCCESS', amount: 9.99, found: true });

      const clientQuery = vi.fn();
      (pool.connect as any).mockResolvedValue({ query: clientQuery, release: vi.fn() });

      const paidRow = {
        id: 'pay-9',
        status: 'pending',
        voucher_code: null,
        amount: '9.99',
        currency: 'USD',
        tier_name: 'PreFlow',
        price_amount: '9.99',
        duration_min: 43200,
        data_limit_gb: 40,
        is_uncapped: false,
        bandwidth_mbps_up: 5,
        bandwidth_mbps_down: 5,
        max_devices: 1,
        user_id: 'u-1',
        payment_method: 'EcoCash (Pesepay)',
      };
      clientQuery
        .mockResolvedValueOnce({ rows: [] })                                   // BEGIN
        .mockResolvedValueOnce({ rows: [paidRow] })                            // SELECT … FOR UPDATE
        .mockResolvedValueOnce({ rows: [] })                                   // SAVEPOINT
        .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'CT-SELFMINT' }] }) // INSERT vouchers
        .mockResolvedValueOnce({ rows: [] })                                   // RELEASE SAVEPOINT
        .mockResolvedValueOnce({ rows: [] })                                   // UPDATE payments completed
        .mockResolvedValueOnce({ rows: [] })                                   // INSERT transactions
        .mockResolvedValueOnce({ rows: [] });                                  // COMMIT

      const res = await request(createApp())
        .get('/api/payments/status/pay-9')
        .set('Authorization', `Bearer ${statusToken('pay-9')}`);

      expect(res.status).toBe(200);
      expect(mockVerify).toHaveBeenCalledWith('PS-REF-1');
      expect(res.body.status).toBe('completed');
      expect(res.body.voucherCode).toBe('CT-SELFMINT');
      const voucherCall = clientQuery.mock.calls.find(
        (c: any[]) => String(c[0]).includes('INSERT INTO vouchers')
      );
      expect(voucherCall).toBeDefined();
    });

    it('marks the payment failed when polling and the gateway says FAILED', async () => {
      const pendingRow = { id: 'pay-8', status: 'pending', pesepay_reference: 'PS-REF-1', amount: '9.99' };
      (pool.query as any)
        .mockResolvedValueOnce({ rows: [pendingRow] }) // main SELECT
        .mockResolvedValueOnce({ rows: [] })            // UPDATE payments -> failed
        .mockResolvedValueOnce({ rows: [{ status: 'failed', completed_at: null, voucher_code: null }] }); // refresh
      mockVerify.mockResolvedValue({ status: 'FAILED', found: true });

      const res = await request(createApp())
        .get('/api/payments/status/pay-8')
        .set('Authorization', `Bearer ${statusToken('pay-8')}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      const failedUpdate = (pool.query as any).mock.calls.find(
        (c: any[]) => String(c[0]).includes("status = $2")
      );
      expect(failedUpdate).toBeDefined();
    });

    it('does not reconcile a pending payment that has no Pesepay reference', async () => {
      (pool.query as any).mockResolvedValueOnce({
        rows: [{ id: 'pay-7', status: 'pending', amount: 34.99, voucher_code: null, tier_name: 'PreFlow' }],
      });

      const res = await request(createApp())
        .get('/api/payments/status/pay-7')
        .set('Authorization', `Bearer ${statusToken('pay-7')}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(mockVerify).not.toHaveBeenCalled();
    });

    it('reports supportRequired once a Ruijie mint has failed', async () => {
      const row = {
        id: 'pay-6',
        status: 'pending',
        amount: 9.99,
        completed_at: null,
        voucher_code: null,
        pesepay_reference: 'PS-REF-7788',
        error_message: 'ruijie_mint_pending: 1: Ruijie returned code 1 "Login failed"',
        tier_name: 'PreFlow',
      };
      stubPendingStatus(row);
      mockVerify.mockResolvedValue({ status: 'AWAITING', found: true });

      const res = await request(createApp())
        .get('/api/payments/status/pay-6')
        .set('Authorization', `Bearer ${statusToken('pay-6')}`);

      expect(res.status).toBe(200);
      // Still pending, and crucially no voucher is promised.
      expect(res.body.status).toBe('pending');
      expect(res.body.voucherCode).toBeNull();
      expect(res.body.supportRequired).toBe(true);
      // The portal puts this in the WhatsApp message.
      expect(res.body.reference).toBe('PS-REF-7788');
    });

    it('does not report supportRequired for an unrelated error_message', async () => {
      stubPendingStatus({
        id: 'pay-5',
        status: 'pending',
        amount: 9.99,
        completed_at: null,
        voucher_code: null,
        pesepay_reference: 'PS-REF-1',
        error_message: 'some other note',
        tier_name: 'PreFlow',
      });
      mockVerify.mockResolvedValue({ status: 'AWAITING', found: true });

      const res = await request(createApp())
        .get('/api/payments/status/pay-5')
        .set('Authorization', `Bearer ${statusToken('pay-5')}`);

      expect(res.status).toBe(200);
      expect(res.body.supportRequired).toBe(false);
    });
  });

  // Regression: maintenanceCheck is mounted BEFORE the payments router in src/index.ts.
  // If it does not exempt the webhook, Pesepay callbacks for in-flight payments are
  // 503'd, the customer is charged, and no voucher is ever minted.
  describe('maintenance mode', () => {
    function createMaintenanceApp() {
      const app = express();
      app.use(express.json());
      app.use(maintenanceCheck);
      app.use('/api/payments', paymentsRouter);
      return app;
    }

    function maintenanceOn() {
      (pool.query as any).mockImplementation((sql: string) => {
        if (String(sql).includes('maintenance_mode')) {
          return Promise.resolve({ rows: [{ value: 'true' }] });
        }
        if (String(sql).includes('maintenance_message')) {
          return Promise.resolve({ rows: [{ value: 'Down for maintenance' }] });
        }
        return Promise.resolve({ rows: [] });
      });
    }

    it('still accepts the payment webhook while maintenance mode is on', async () => {
      maintenanceOn();
      // A decryptable callback for an unknown reference must reach the handler
      // (404 "Unknown payment" proves the router ran; a 503 would mean Pesepay
      // lost the callback and the customer paid for nothing).
      const res = await request(createMaintenanceApp())
        .post('/api/payments/webhook?token=' + CB_TOKEN)
        .send(callbackBody({ merchantReference: 'PREY-UNKNOWN0000000', transactionStatus: 'SUCCESS' }));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Unknown payment');
    });

    it('still blocks starting a new payment while maintenance mode is on', async () => {
      maintenanceOn();
      const res = await request(createMaintenanceApp()).post('/api/payments/initiate').send({
        tier: 'PreFlow',
        phone: '0771327202',
      });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('maintenance');
    });
  });
});
