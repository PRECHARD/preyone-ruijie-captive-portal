import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encryptPayload,
  decryptResponse,
  initiateEcoCashPayment,
  verifyPaymentStatus,
} from '../src/services/pesepayService';

const TEST_KEY = '0123456789abcdef0123456789abcdef';

describe('encryptPayload and decryptResponse', () => {
  it('round-trips a payload correctly', () => {
    const payload = { foo: 'bar', num: 42 };
    const encrypted = encryptPayload(payload, TEST_KEY);
    expect(encrypted).toBeTruthy();
    expect(typeof encrypted).toBe('string');

    const decrypted = decryptResponse(encrypted, TEST_KEY);
    expect(decrypted).toEqual(payload);
  });

  it('returns null for tampered ciphertext', () => {
    const result = decryptResponse('garbage-invalid-base64', TEST_KEY);
    expect(result).toBeNull();
  });

  it('handles nested objects', () => {
    const payload = { user: { name: 'Alice', tags: [1, 2, 3] } };
    const encrypted = encryptPayload(payload, TEST_KEY);
    const decrypted = decryptResponse(encrypted, TEST_KEY);
    expect(decrypted).toEqual(payload);
  });
});

describe('initiateEcoCashPayment', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PESEPAY_API_KEY;
    delete process.env.PESEPAY_API_ID;
    delete process.env.PESEPAY_MERCHANT_ID;
    delete process.env.PESEPAY_BASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns mock response when Pesepay is not configured', async () => {
    delete process.env.PESEPAY_API_KEY;

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-001',
      description: 'Test package',
      returnUrl: 'http://localhost/callback',
    });

    expect(result.success).toBe(true);
    expect(result.pollUrl).toContain('payments.pesepay.com');
    expect(result.transactionId).toBeTruthy();
  });

  it('formats Zimbabwean phone numbers correctly', async () => {
    process.env.PESEPAY_API_KEY = 'test-key';
    process.env.PESEPAY_API_ID = 'test-id';
    process.env.PESEPAY_MERCHANT_ID = 'test-mid';

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirectUrl: 'https://pay.pesepay.com/poll', reference: 'TXN-1' }),
    });

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '0771327202',
      reference: 'REF-001',
      description: 'Test',
      returnUrl: 'http://localhost/callback',
    });

    const callBody = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(callBody.payment.phone).toBe('263771327202');
    expect(result.success).toBe(true);
  });

  it('returns error when API returns non-ok', async () => {
    process.env.PESEPAY_API_KEY = 'test-key';
    process.env.PESEPAY_API_ID = 'test-id';
    process.env.PESEPAY_MERCHANT_ID = 'test-mid';

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ message: 'Invalid API key' }),
    });

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-002',
      description: 'Test',
      returnUrl: 'http://localhost/callback',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid API key');
  });

  it('returns error when API call throws', async () => {
    process.env.PESEPAY_API_KEY = 'test-key';
    process.env.PESEPAY_API_ID = 'test-id';
    process.env.PESEPAY_MERCHANT_ID = 'test-mid';

    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-003',
      description: 'Test',
      returnUrl: 'http://localhost/callback',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Payment service error');
  });
});

describe('verifyPaymentStatus', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PESEPAY_API_KEY;
    delete process.env.PESEPAY_API_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns unknown when not configured', async () => {
    const result = await verifyPaymentStatus('REF-001');
    expect(result.status).toBe('unknown');
  });

  it('returns status from API when configured', async () => {
    process.env.PESEPAY_API_KEY = 'test-key';
    process.env.PESEPAY_API_ID = 'test-id';

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'completed',
        invoice: { amount: 10, currency: 'USD' },
      }),
    });

    const result = await verifyPaymentStatus('REF-001');
    expect(result.status).toBe('completed');
    expect(result.amount).toBe(10);
  });
});
