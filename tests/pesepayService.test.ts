import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encryptPayload,
  decryptResponse,
  initiateEcoCashPayment,
  initiatePesepayPayment,
  verifyPaymentStatus,
  normalizePesepayCurrency,
  normalizeGatewayCurrency,
  resolveRail,
  listAvailableRails,
  PESEPAY_SUCCESS_STATUSES,
} from '../src/services/pesepayService';

// The service talks to Pesepay over lenientRequest, NOT axios: Pesepay's edge
// returns a malformed Strict-Transport-Security header folded with a bare LF,
// which axios/undici reject with HPE_CR_EXPECTED / "Response does not match
// the HTTP/1.1 protocol". Only curl tolerates it.
//
// The spy is declared via vi.hoisted so it is the SAME instance the module
// under test imports; a spy created inside the factory would be a different one.
const { lenientRequest } = vi.hoisted(() => ({ lenientRequest: vi.fn() }));

vi.mock('../src/utils/lenientHttp', () => ({ lenientRequest }));

const TEST_KEY = '0123456789abcdef0123456789abcdef';
const mockRequest = lenientRequest;

function ok(json: unknown) {
  return { status: 200, headers: {}, json, body: JSON.stringify(json) };
}

/**
 * Decrypt what the service actually put on the wire. `lenientRequest` takes a
 * `body` string, so the JSON envelope must be parsed before the ciphertext is
 * pulled out of it.
 */
function sentPayload(callIndex = 0) {
  const envelope = JSON.parse(mockRequest.mock.calls[callIndex][0].body as string);
  const decrypted = decryptResponse(envelope.payload, TEST_KEY);
  expect(decrypted).toBeTruthy();
  return decrypted;
}

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

describe('currency normalisation', () => {
  it('maps ZWG/ZWD/ZiG to the code Pesepay actually uses', () => {
    expect(normalizeGatewayCurrency('ZWG')).toBe('ZiG');
    expect(normalizeGatewayCurrency('zwg')).toBe('ZiG');
    expect(normalizeGatewayCurrency('ZWD')).toBe('ZiG');
    expect(normalizeGatewayCurrency('ZiG')).toBe('ZiG');
    expect(normalizeGatewayCurrency('USD')).toBe('USD');
  });

  it('rejects currencies the merchant cannot settle', () => {
    expect(normalizeGatewayCurrency('EUR')).toBeNull();
    expect(normalizeGatewayCurrency('')).toBeNull();
  });

  it('applies the same mapping on the legacy portal path', () => {
    expect(normalizePesepayCurrency('ZWG')).toBe('ZiG');
  });
});

describe('rail resolution', () => {
  it('uses real PZW### codes, not friendly names', () => {
    // Friendly names such as "ECOCASH" are rejected by the API with the
    // misleading "Can not perform transaction of the specified amount in the
    // specified currency".
    expect(resolveRail('ecocash', 'USD')?.code).toBe('PZW211');
    expect(resolveRail('ecocash', 'ZiG')?.code).toBe('PZW201');
    expect(resolveRail('innbucks', 'USD')?.code).toBe('PZW212');
    expect(resolveRail('paygo', 'ZiG')?.code).toBe('PZW210');
    expect(resolveRail('omari', 'USD')?.code).toBe('PZW216');
  });

  it('does not offer a rail in a currency it cannot settle', () => {
    expect(resolveRail('innbucks', 'ZiG')).toBeUndefined();
    expect(resolveRail('paygo', 'USD')).toBeUndefined();
  });

  it('only lists rails the merchant actually has enabled', () => {
    expect(listAvailableRails('USD').map((r) => r.rail)).toEqual([
      'ecocash',
      'innbucks',
      'omari',
    ]);
    expect(listAvailableRails('ZiG').map((r) => r.rail)).toEqual(['ecocash', 'paygo']);
  });

  it('advertises the provider limits', () => {
    expect(resolveRail('ecocash', 'USD')?.min).toBe(1);
    expect(resolveRail('ecocash', 'USD')?.max).toBe(500);
    expect(resolveRail('ecocash', 'ZiG')?.min).toBe(2);
  });
});

describe('initiateEcoCashPayment', () => {
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

  it('fails closed when Pesepay is not configured', async () => {
    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-001',
      description: 'Test package',
      returnUrl: 'http://localhost/callback',
    });

    // Must NOT fabricate a pollUrl: that points the customer at a page that can
    // never complete while their money is genuinely being requested.
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('sends an encrypted payload and returns the poll URL', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    mockRequest.mockResolvedValue(
      ok({ pollUrl: 'https://pay.pesepay.com/poll', referenceNumber: 'TXN-1' })
    );

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '0771327202',
      reference: 'REF-001',
      description: 'Test',
      returnUrl: 'http://localhost/callback',
    });

    // The wire payload must be decryptable and use the real method code.
    const sent = sentPayload();
    expect(sent.paymentMethodCode).toBe('PZW211');
    // Zimbabwean local format must be normalised to the 263 international form.
    expect(sent.customer.phoneNumber).toBe('263771327202');
    expect(sent.paymentMethodRequiredFields.customerPhoneNumber).toBe('263771327202');

    expect(result.success).toBe(true);
    expect(result.pollUrl).toBe('https://pay.pesepay.com/poll');
  });

  it('returns the provider error message', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    mockRequest.mockResolvedValue({
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

  it('never leaks a transport error to the customer', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    mockRequest.mockRejectedValue(new Error('Parse Error: Missing expected CR after header value'));

    const result = await initiateEcoCashPayment({
      amount: 10,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-003',
      description: 'Test',
      returnUrl: 'http://localhost/callback',
    });

    expect(result.success).toBe(false);
    // Raw parser internals must be logged, not shown to the payer.
    expect(result.error).not.toContain('Parse Error');
    expect(result.detail).toContain('Parse Error');
  });

  it('bills a sub-dollar portal amount as a flat 1.00', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    mockRequest.mockResolvedValue(
      ok({ pollUrl: 'https://pay.pesepay.com/poll', referenceNumber: 'TXN-MIN' })
    );

    // The USD EcoCash minimum is 1.00, so a 0.99 catalogue price is rounded UP
    // to 1.00 rather than being rejected by the gateway. The caller stores the
    // same normalised value so the webhook amount check still matches.
    const result = await initiateEcoCashPayment({
      amount: 0.99,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-004',
      description: 'Test',
      returnUrl: 'http://localhost/callback',
    });

    const sent = sentPayload();
    expect(sent.amountDetails.amount).toBe(1);
    expect(result.success).toBe(true);
  });

  it('rejects an amount above the provider maximum before calling out', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    const result = await initiateEcoCashPayment({
      amount: 900,
      currency: 'USD',
      phone: '263771327202',
      reference: 'REF-005',
      description: 'Test',
      returnUrl: 'http://localhost/callback',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('maximum');
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('initiatePesepayPayment', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  const base = {
    amount: 10,
    currencyCode: 'USD',
    paymentMethod: 'ecocash',
    reasonForPayment: 'Invoice INV-1',
    reference: 'PREY-1',
    phone: '0771327202',
  };

  it('sends the correct method code for the currency', async () => {
    mockRequest.mockResolvedValue(
      ok({ referenceNumber: '20261003-1', transactionStatus: 'PROCESSING' })
    );

    const result = await initiatePesepayPayment(base);

    const sent = sentPayload();
    expect(sent.paymentMethodCode).toBe('PZW211');
    expect(sent.currencyCode).toBe('USD');
    expect(sent.paymentMethodRequiredFields.customerPhoneNumber).toBe('263771327202');
    expect(result.success).toBe(true);
    expect(result.referenceNumber).toBe('20261003-1');
  });

  it('uses the ZiG code for local currency', async () => {
    mockRequest.mockResolvedValue(ok({ referenceNumber: 'Z-1', transactionStatus: 'PROCESSING' }));

    const result = await initiatePesepayPayment({ ...base, currencyCode: 'ZWG' });

    const sent = sentPayload();
    expect(sent.currencyCode).toBe('ZiG');
    expect(sent.paymentMethodCode).toBe('PZW201');
    expect(result.success).toBe(true);
  });

  it('sends an empty required-fields object for a rail with no phone prompt', async () => {
    mockRequest.mockResolvedValue(ok({ referenceNumber: 'I-1', transactionStatus: 'PENDING' }));

    const result = await initiatePesepayPayment({
      ...base,
      paymentMethod: 'innbucks',
    });

    const sent = sentPayload();
    expect(sent.paymentMethodCode).toBe('PZW212');
    // The key must be PRESENT but empty: omitting it makes Pesepay 500 with a
    // null message, even though InnBucks requires no extra fields.
    expect(sent.paymentMethodRequiredFields).toEqual({});
    expect(result.success).toBe(true);
  });

  it('rejects a rail the merchant cannot settle in that currency', async () => {
    const result = await initiatePesepayPayment({ ...base, paymentMethod: 'paygo' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('requires a phone number for phone-prompt rails', async () => {
    const result = await initiatePesepayPayment({ ...base, phone: undefined });

    expect(result.success).toBe(false);
    expect(result.error).toContain('mobile number');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects an unknown currency', async () => {
    const result = await initiatePesepayPayment({ ...base, currencyCode: 'EUR' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported currency');
  });

  it('fails closed when unconfigured rather than mocking', async () => {
    delete process.env.PESEPAY_INTEGRATION_KEY;
    delete process.env.PESEPAY_ENCRYPTION_KEY;

    const result = await initiatePesepayPayment(base);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
    expect(result.pollUrl).toBeUndefined();
  });

  it('surfaces the provider error without inventing success', async () => {
    mockRequest.mockResolvedValue({
      status: 400,
      headers: {},
      json: { message: 'Payment could not be processed.' },
      body: '{}',
    });

    const result = await initiatePesepayPayment(base);

    expect(result.success).toBe(false);
    expect(result.referenceNumber).toBeUndefined();
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

  it('reports not configured without throwing', async () => {
    const result = await verifyPaymentStatus('REF-001');
    expect(result.status).toBe('error');
    expect(result.found).toBe(false);
  });

  it('returns status from the API when configured', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    mockRequest.mockResolvedValue(
      ok({ transactionStatus: 'SUCCESS', amountDetails: { amount: 10 }, currencyCode: 'USD' })
    );

    const result = await verifyPaymentStatus('REF-001');
    expect(result.status).toBe('SUCCESS');
    expect(result.amount).toBe(10);
    expect(result.found).toBe(true);
  });

  it('distinguishes an unknown reference from a real failure', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    // Pesepay answers an unknown reference with HTTP 404 and a body whose own
    // "status" field is the string "404". Treating that as a transaction status
    // would mark a brand-new payment as failed.
    mockRequest.mockResolvedValue({
      status: 404,
      headers: {},
      json: { status: '404', message: 'Transaction record was not found' },
      body: '{"status":"404"}',
    });

    const result = await verifyPaymentStatus('REF-MISSING');
    expect(result.status).toBe('not_found');
    expect(result.found).toBe(false);
  });

  it('decrypts an encrypted status payload', async () => {
    process.env.PESEPAY_INTEGRATION_KEY = 'test-key';
    process.env.PESEPAY_ENCRYPTION_KEY = TEST_KEY;

    mockRequest.mockResolvedValue(
      ok({ payload: encryptPayload({ transactionStatus: 'SUCCESS', amountDetails: { amount: 5 } }, TEST_KEY) })
    );

    const result = await verifyPaymentStatus('REF-ENC');
    expect(result.status).toBe('SUCCESS');
    expect(result.amount).toBe(5);
  });
});

describe('status classification', () => {
  it('does not treat an unrecognised status as a success', () => {
    // A new Pesepay status must never mint a voucher by accident.
    expect(PESEPAY_SUCCESS_STATUSES).not.toContain('PROCESSING');
    expect(PESEPAY_SUCCESS_STATUSES).not.toContain('PENDING');
  });
});
