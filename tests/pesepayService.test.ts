import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lenientRequest } from '../src/utils/lenientHttp';
import {
  encryptPayload,
  decryptResponse,
  initiateEcoCashPayment,
  verifyPaymentStatus,
  normalizePesepayCurrency,
  resolveEcoCashMethod,
  normalizePaymentAmount,
} from '../src/services/pesepayService';

vi.mock('../src/utils/lenientHttp');

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

describe('Pesepay currency and method codes', () => {
  // Discovered from the live API:
  //   GET /api/payments-engine/v1/currencies/active
  //   GET /api/payments-engine/v1/payment-methods/for-currency?currencyCode=USD
  it("maps USD to Pesepay's Ecocash USD method, not the legacy 'ECOCASH' name", () => {
    const method = resolveEcoCashMethod('USD');
    expect(method?.code).toBe('PZW211');
    // The legacy SDK name is what produced the misleading "specified amount in
    // the specified currency" error.
    expect(method?.code).not.toBe('ECOCASH');
  });

  it("maps ZiG to Pesepay's Ecocash ZiG method", () => {
    expect(resolveEcoCashMethod('ZiG')?.code).toBe('PZW201');
  });

  // Pesepay's currency code is "ZiG"; sending "ZWG" is rejected with
  // "Currency record was not found for the provided code".
  it("normalises the common 'ZWG' label to Pesepay's 'ZiG' code", () => {
    expect(normalizePesepayCurrency('ZWG')).toBe('ZiG');
    expect(normalizePesepayCurrency('zwg')).toBe('ZiG');
    expect(resolveEcoCashMethod('ZWG')?.code).toBe('PZW201');
  });

  it('normalises case and spacing for USD', () => {
    expect(normalizePesepayCurrency('usd')).toBe('USD');
    expect(normalizePesepayCurrency(' usd ')).toBe('USD');
    expect(normalizePesepayCurrency(undefined)).toBe('USD');
  });

  it('returns undefined for a currency with no EcoCash method', () => {
    expect(resolveEcoCashMethod('EUR')).toBeUndefined();
    expect(resolveEcoCashMethod('ZWL')).toBeUndefined();
  });

  it('exposes the Ecocash USD limits the live API reports', () => {
    const method = resolveEcoCashMethod('USD');
    expect(method?.min).toBe(1);
    expect(method?.max).toBe(500);
  });
});

describe('initiateEcoCashPayment', () => {
  const originalEnv = process.env;
  const mockRequest = vi.mocked(lenientRequest);

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PESEPAY_INTEGRATION_KEY;
    delete process.env.PESEPAY_API_KEY;
    delete process.env.PESEPAY_ENCRYPTION_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it('fails closed when Pesepay is not configured', async () => {
    delete process.env.PESEPAY_INTEGRATION_KEY;
    delete process.env.PESEPAY_API_KEY;

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-001',
      description: 'Test package',
      returnUrl: 'http://localhost/callback',
    });

    // No mock response: a fake pollUrl would ask for real money while no
    // payment could ever arrive, so a missing credential must be a hard error.
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
    expect(result.pollUrl).toBeUndefined();
    expect(result.transactionId).toBeUndefined();
    expect(lenientRequest).not.toHaveBeenCalled();
  });

  it('fails closed when only the encryption key is set', async () => {
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;
    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-002',
      description: 'Test package',
      returnUrl: 'http://localhost/callback',
    });

    expect(result.success).toBe(false);
    expect(lenientRequest).not.toHaveBeenCalled();
  });

  // Pre-flight limits. Sending an out-of-range amount produces Pesepay's
  // misleading "Can not perform transaction of the specified amount in the
  // specified currency", so the check happens before the request is sent.

  // Sub-dollar catalogue prices (0.99 PreLite) are billed as a flat 1.00:
  // EcoCash settles in whole dollars, and the USD method's minimum is 1.00.
  it('treats a 0.99 amount as 1.00 and sends it to Pesepay', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    vi.mocked(lenientRequest).mockResolvedValue({
      status: 200,
      headers: {},
      json: { payload: encryptPayload({ pollUrl: 'https://pay.pesepay.com/poll' }, TEST_KEY) },
      body: '{}',
    });

    const result = await initiateEcoCashPayment({
      amount: 0.99, // PreLite's real price
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-PRELITE',
      description: 'PreLite',
      returnUrl: 'https://wifi.preyone.com/api/payments/return?ref=REF-PRELITE',
    });

    expect(result.success).toBe(true);
    const sent = JSON.parse(mockRequest.mock.calls[0][0].body as string);
    const decoded = decryptResponse(sent.payload, TEST_KEY);
    // The encrypted request must carry 1.00 — not 0.99 — so it passes the 1.00 minimum.
    expect(decoded.amountDetails.amount).toBe(1);
  });

  it('normalises sub-dollar amounts to a whole 1.00 but leaves others untouched', () => {
    expect(normalizePaymentAmount(0.99)).toBe(1);
    expect(normalizePaymentAmount(0.5)).toBe(1);
    expect(normalizePaymentAmount(0)).toBe(0);
    expect(normalizePaymentAmount(1.99)).toBe(1.99);
    expect(normalizePaymentAmount(9.99)).toBe(9.99);
    expect(normalizePaymentAmount(59.99)).toBe(59.99);
  });

  it('rejects an amount above the Ecocash maximum without calling Pesepay', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    const result = await initiateEcoCashPayment({
      amount: 900, // Ecocash USD maximum is 500
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-TOO-HIGH',
      description: 'Test package',
      returnUrl: 'http://localhost/callback',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/maximum/i);
    expect(lenientRequest).not.toHaveBeenCalled();
  });

  it('rejects a currency with no EcoCash method without calling Pesepay', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'EUR',
      phone: '263771327202',
      reference: 'REF-EUR',
      description: 'Test package',
      returnUrl: 'http://localhost/callback',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not available/i);
    expect(lenientRequest).not.toHaveBeenCalled();
  });

  it('sends the PZW211 method code and normalised currency to Pesepay', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.PESEPAY_ECOCASH_METHOD_CODE;

    vi.mocked(lenientRequest).mockResolvedValue({
      status: 200,
      headers: {},
      json: { redirectUrl: 'https://pay.pesepay.com/poll' },
      body: '{}',
    });

    const result = await initiateEcoCashPayment({
      amount: 9.99,
      currency: 'usd',
      phone: '0771327202',
      reference: 'REF-METHOD',
      description: 'PreFlow',
      returnUrl: 'https://wifi.preyone.com/api/payments/return?ref=REF-METHOD',
    });

    expect(result.success).toBe(true);

    // Decrypt what was actually sent and assert the method code.
    const sent = JSON.parse(mockRequest.mock.calls[0][0].body as string);
    const decoded = decryptResponse(sent.payload, TEST_KEY);
    expect(decoded.paymentMethodCode).toBe('PZW211');
    expect(decoded.currencyCode).toBe('USD');
    expect(decoded.customer.phoneNumber).toBe('263771327202');
    expect(decoded.paymentMethodRequiredFields.customerPhoneNumber).toBe('263771327202');
  });

  it('honours a PESEPAY_ECOCASH_METHOD_CODE override', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;
    process.env.PESEPAY_ECOCASH_METHOD_CODE = 'PZW999';

    vi.mocked(lenientRequest).mockResolvedValue({
      status: 200,
      headers: {},
      json: { redirectUrl: 'https://pay.pesepay.com/poll' },
      body: '{}',
    });

    await initiateEcoCashPayment({
      amount: 9.99,
      currency: 'USD',
      phone: '0771327202',
      reference: 'REF-OVERRIDE',
      description: 'PreFlow',
      returnUrl: 'https://wifi.preyone.com/',
    });

    const sent = JSON.parse(mockRequest.mock.calls[0][0].body as string);
    const decoded = decryptResponse(sent.payload, TEST_KEY);
    expect(decoded.paymentMethodCode).toBe('PZW999');
  });

  it('fails closed in production rather than throwing', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PESEPAY_INTEGRATION_KEY;
    delete process.env.PESEPAY_API_KEY;

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-003',
      description: 'Test package',
      returnUrl: 'http://localhost/callback',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  it('formats Zimbabwean phone numbers correctly', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    mockRequest.mockResolvedValue({
      status: 200,
      headers: {},
      json: { redirectUrl: 'https://pay.pesepay.com/poll', reference: 'TXN-1' },
      body: '{}',
    });

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '0771327202',
      reference: 'REF-001',
      description: 'Test',
      returnUrl: 'http://localhost/callback',
    });

    const callBody = JSON.parse(mockRequest.mock.calls[0][0].body as string);
    expect(callBody.payload).toBeTruthy();
    expect(result.success).toBe(true);
  });

  it('returns error when API returns non-ok', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    vi.mocked(lenientRequest).mockResolvedValue({
      status: 400,
      headers: {},
      json: { message: 'Invalid API key' },
      body: '{"message":"Invalid API key"}',
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

  it('returns error when the transport fails, without leaking parser internals', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    vi.mocked(lenientRequest).mockRejectedValue(
      new Error('Unreadable response from api.pesepay.com: Missing expected CR after header value')
    );

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-003',
      description: 'Test',
      returnUrl: 'http://localhost/callback',
    });

    expect(result.success).toBe(false);
    // The customer must see an actionable message...
    expect(result.error).not.toContain('Missing expected CR');
    expect(result.error).toMatch(/could not reach the payment provider/i);
    // ...while the operator keeps the diagnostic.
    expect(result.detail).toContain('Missing expected CR');
  });
});

describe('verifyPaymentStatus', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PESEPAY_INTEGRATION_KEY;
    delete process.env.PESEPAY_API_KEY;
    delete process.env.PESEPAY_ENCRYPTION_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it('returns error when not configured, and never calls the API', async () => {
    const result = await verifyPaymentStatus('REF-001');
    // 'unknown' would be indistinguishable from "payment in flight", so a
    // misconfigured server must not be reported as merely pending.
    expect(result.status).toBe('error');
    expect(lenientRequest).not.toHaveBeenCalled();
  });

  it('returns status from API when configured', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    vi.mocked(lenientRequest).mockResolvedValue({
      status: 200,
      headers: {},
      json: { status: 'completed', amount: 10, currency: 'USD' },
      body: '{}',
    });

    const result = await verifyPaymentStatus('REF-001');
    expect(result.status).toBe('completed');
    expect(result.amount).toBe(10);
    expect(result.found).toBe(true);
  });

  // Pesepay returns HTTP 404 with a JSON body whose own "status" field is the
  // string "404". Reading that as a transaction status would be nonsense.
  it('treats HTTP 404 as an unknown reference, not a status', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    vi.mocked(lenientRequest).mockResolvedValue({
      status: 404,
      headers: {},
      json: { status: '404', message: 'Transaction record was not found' },
      body: '{}',
    });

    const result = await verifyPaymentStatus('REF-MISSING');
    expect(result.status).toBe('not_found');
    expect(result.found).toBe(false);
  });
});
