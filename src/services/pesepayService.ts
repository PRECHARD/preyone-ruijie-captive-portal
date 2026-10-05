import * as CryptoJS from 'crypto-js';
import { lenientRequest } from '../utils/lenientHttp';

interface PesepayConfig {
  integrationKey: string;
  encryptionKey: string;
  baseUrl: string;
}

interface InitiatePaymentRequest {
  amount: number;
  currency: string;
  phone: string;
  email?: string;
  fullName?: string;
  reference: string;
  description: string;
  returnUrl: string;
  webhookToken?: string;
}

interface PesepayPaymentResponse {
  success: boolean;
  pollUrl?: string;
  error?: string;
  /** Server-side diagnostic detail. Logged, never shown to the customer. */
  detail?: string;
  transactionId?: string;
}

const PESEPAY_V2_URL = 'https://api.pesepay.com/api/payments-engine/v2/payments/make-payment';

// Pesepay reports transactionStatus as a string. Anything unrecognised is
// treated as pending, so a new Pesepay status value can never be mistaken for
// a success and mint a voucher.
export const PESEPAY_SUCCESS_STATUSES = ['SUCCESS', 'COMPLETED', 'PAID', 'APPROVED'];
export const PESEPAY_FAILED_STATUSES = [
  'FAILED',
  'CANCELLED',
  'CANCELED',
  'DECLINED',
  'REJECTED',
  'EXPIRED',
  'ERROR',
  'UNPAID',
];

export function isPesepayConfigured(): boolean {
  return Boolean(
    (process.env.PESEPAY_INTEGRATION_KEY || process.env.PESEPAY_API_KEY) &&
    process.env.PESEPAY_ENCRYPTION_KEY
  );
}

function getPesepayConfig(): PesepayConfig {
  return {
    integrationKey: process.env.PESEPAY_INTEGRATION_KEY || process.env.PESEPAY_API_KEY || '',
    encryptionKey: process.env.PESEPAY_ENCRYPTION_KEY || '',
    baseUrl: process.env.PESEPAY_BASE_URL || PESEPAY_V2_URL,
  };
}

export function encryptPayload(payloadObject: any, encryptionKey: string): string {
  const plainTextJson = JSON.stringify(payloadObject);
  const key = CryptoJS.enc.Utf8.parse(encryptionKey);
  const iv = CryptoJS.enc.Utf8.parse(encryptionKey.substring(0, 16));
  const encrypted = CryptoJS.AES.encrypt(plainTextJson, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  return encrypted.toString();
}

export function decryptResponse(encryptedString: string, encryptionKey: string): any {
  try {
    const key = CryptoJS.enc.Utf8.parse(encryptionKey);
    const iv = CryptoJS.enc.Utf8.parse(encryptionKey.substring(0, 16));
    const decrypted = CryptoJS.AES.decrypt(encryptedString, key, {
      iv,
      mode: CryptoJS.mode.CBC,
      // Callers treat a null/falsey return as "not from Pesepay", so a garbage
      // or wrongly-keyed payload must never escape as a thrown exception.
      padding: CryptoJS.pad.Pkcs7,
    });
    const txt = decrypted.toString(CryptoJS.enc.Utf8);
    if (!txt) return null;
    return JSON.parse(txt);
  } catch (err) {
    console.error('Failed to parse decrypted payload', err);
    return null;
  }
}

function formatPhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('263')) return cleaned;
  if (cleaned.startsWith('0')) return '263' + cleaned.substring(1);
  return '263' + cleaned;
}

/**
 * Pesepay v2 identifies payment methods by `PZW###` codes. The legacy SDKs took
 * friendly names like 'ECOCASH', and sending one to the v2 endpoint fails with
 * the misleading "Can not perform transaction of the specified amount in the
 * specified currency" - which reads like a pricing problem, not a bad method
 * code.
 *
 * Discovered from the live API rather than guessed:
 *   GET /api/payments-engine/v1/currencies/active
 *   GET /api/payments-engine/v1/payment-methods/for-currency?currencyCode=USD
 *
 * For this merchant that reports currencies ZiG and USD (USD is the default),
 * with Ecocash available as:
 *   PZW211  Ecocash USD   min 1.00    max 500
 *   PZW201  Ecocash ZiG   min 2.00    max 8000
 *
 * Note the local currency code is "ZiG", not "ZWG": sending 'ZWG' is rejected
 * outright with "Currency record was not found for the provided code".
 */
export const ECOCASH_METHODS: Record<string, { code: string; min: number; max: number }> = {
  USD: { code: 'PZW211', min: 1, max: 500 },
  ZIG: { code: 'PZW201', min: 2, max: 8000 },
};

/**
 * Normalises a currency to the exact code Pesepay expects. 'ZWG' is the label
 * most people use for Zimbabwe Gold, but Pesepay's code is 'ZiG', so it is
 * mapped rather than passed through.
 */
export function normalizePesepayCurrency(currency: string | undefined): string {
  const raw = String(currency || 'USD').trim();
  const upper = raw.toUpperCase();

  if (upper === 'ZWG' || upper === 'ZWD' || upper === 'ZIG' || upper === 'ZIMBABWE DOLLAR') {
    return 'ZiG';
  }
  if (upper === 'US$' || upper === 'US DOLLAR') return 'USD';
  return upper;
}

/**
 * EcoCash settles in whole dollars (the USD method's minimum is 1.00), so a
 * sub-dollar catalogue price can never be charged as-is. Sub-dollar amounts are
 * therefore billed as a flat 1.00 instead of being rejected by the gateway.
 * Whole-dollar and above amounts pass through untouched (9.99 stays 9.99).
 * The caller stores the SAME normalised value in the payments row so that the
 * webhook's amount-match check compares against the actual charge.
 */
export function normalizePaymentAmount(amount: number): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return n;
  if (n < 1) return 1;
  return Math.round(n * 100) / 100;
}

/** Returns the EcoCash method + limits for a currency, or undefined if unsupported. */
export function resolveEcoCashMethod(
  currency: string | undefined
): { code: string; min: number; max: number } | undefined {
  // The map is keyed uppercase, but Pesepay's own code is mixed case ("ZiG"),
  // so the normalised value is upper-cased for lookup only. Returning the
  // un-normalised code here would silently find nothing.
  const key = normalizePesepayCurrency(currency).toUpperCase();
  return ECOCASH_METHODS[key];
}

/**
 * POST an encrypted payload to Pesepay over the lenient HTTP client.
 *
 * axios cannot be used here: Pesepay's edge returns a malformed
 * `Strict-Transport-Security` header folded with a bare LF, which every strict
 * parser rejects with HPE_CR_EXPECTED. See utils/lenientHttp.ts.
 */
async function postEncryptedPayload(
  requestBody: unknown,
  config: PesepayConfig
): Promise<{ decrypted: any | null; data: any; error?: string }> {
  const encryptedPayload = encryptPayload(requestBody, config.encryptionKey);

  const response = await lenientRequest({
    url: config.baseUrl,
    method: 'POST',
    headers: {
      authorization: config.integrationKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payload: encryptedPayload }),
    timeoutMs: 30000,
  });

  const data = response.json;

  if (response.status >= 400) {
    console.error('Pesepay API error:', response.status, data ?? response.body);
    return {
      decrypted: null,
      data,
      error: data?.message || data?.error || 'Payment initiation failed',
    };
  }

  if (data?.payload) {
    const decrypted = decryptResponse(data.payload, config.encryptionKey);
    if (!decrypted) {
      return { decrypted: null, data, error: 'Failed to decrypt Pesepay response' };
    }
    return { decrypted, data };
  }

  return { decrypted: null, data };
}

function getRequestBody(
  paymentRequest: InitiatePaymentRequest,
  methodCode: string,
  currencyCode: string
) {
  // resultUrl is echoed back by Pesepay on the server-to-server callback, so the
  // per-payment token is appended here: a callback can then only be matched to a
  // payment this server actually created.
  const baseUrl = (process.env.BASE_URL || 'https://wifi.preyone.com').replace(/\/$/, '');
  const resultUrl = paymentRequest.webhookToken
    ? `${baseUrl}/api/payments/webhook?token=${encodeURIComponent(paymentRequest.webhookToken)}`
    : `${baseUrl}/api/payments/webhook`;
  const formattedPhone = formatPhoneNumber(paymentRequest.phone);

  return {
    currencyCode,
    paymentMethodCode: methodCode,
    customer: {
      email: paymentRequest.email || '',
      phoneNumber: formattedPhone,
      name: paymentRequest.fullName || 'GUEST',
    },
    // Required by Pesepay's v2 make-payment for EcoCash. Missing this field (or
    // calling it "phone" instead of "phoneNumber") makes their backend return a
    // bare HTTP 500 with a null message.
    paymentMethodRequiredFields: {
      customerPhoneNumber: formattedPhone,
    },
    amountDetails: {
      amount: paymentRequest.amount,
      currencyCode,
    },
    reasonForPayment: paymentRequest.description,
    returnUrl: paymentRequest.returnUrl,
    resultUrl,
    merchantReference: paymentRequest.reference,
  };
}

export async function initiateEcoCashPayment(
  paymentRequest: InitiatePaymentRequest
): Promise<PesepayPaymentResponse> {
  try {
    const config = getPesepayConfig();
    if (!config.integrationKey || !config.encryptionKey) {
      // Fail closed in EVERY environment. The previous implementation returned a
      // mock response outside production, which handed customers a pollUrl
      // pointing at a fake page: real money would be requested and no payment
      // would ever arrive. A missing credential must be a hard error.
      return { success: false, error: 'Pesepay is not configured on this server.' };
    }

    const currencyCode = normalizePesepayCurrency(paymentRequest.currency);
    const amount = normalizePaymentAmount(paymentRequest.amount);
    const method = resolveEcoCashMethod(currencyCode);

    if (!method) {
      return {
        success: false,
        error: `EcoCash is not available in ${currencyCode}. Please contact support.`,
      };
    }

    // Check the amount against the limits Pesepay advertises for this method.
    // Without this the request is sent anyway and Pesepay answers "Can not
    // perform transaction of the specified amount in the specified currency",
    // which looks like a server misconfiguration and hides the real cause.
    if (amount < method.min) {
      return {
        success: false,
        error: `The minimum EcoCash payment in ${currencyCode} is ${method.min.toFixed(2)}.`,
      };
    }
    if (amount > method.max) {
      return {
        success: false,
        error: `The maximum EcoCash payment in ${currencyCode} is ${method.max.toFixed(2)}.`,
      };
    }

    // An explicit override wins, for the rare case Pesepay rotates a method code
    // and we need to ship a fix without waiting for a deploy.
    const methodCode = (process.env.PESEPAY_ECOCASH_METHOD_CODE || method.code).toUpperCase();

    const requestBody = getRequestBody({ ...paymentRequest, amount }, methodCode, currencyCode);
    const { decrypted, data, error } = await postEncryptedPayload(requestBody, config);

    if (error) {
      return { success: false, error };
    }

    const result = decrypted ?? data;
    if (result?.pollUrl || result?.redirectUrl) {
      return {
        success: true,
        pollUrl: result.pollUrl || result.redirectUrl,
        transactionId: result.referenceNumber || result.reference,
      };
    }

    return { success: false, error: 'No poll URL received from payment provider' };
  } catch (error: unknown) {
    console.error('Pesepay integration error:', error);
    // Never surface a raw transport/parser message to the customer: it leaks
    // internals and tells them nothing actionable. Log the detail, show a
    // retryable message instead.
    const detail = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: 'We could not reach the payment provider. Please check your connection and try again.',
      detail,
    };
  }
}

export async function verifyPaymentStatus(reference: string): Promise<{
  status: string;
  amount?: number;
  currency?: string;
  // false means "Pesepay has no record of this reference" (HTTP 404), which is
  // distinct from a real transaction that is still AWAITING. Callers must not
  // treat a not-found as a failure - a payment can take a moment to appear.
  found: boolean;
}> {
  try {
    const config = getPesepayConfig();
    if (!config.integrationKey || !config.encryptionKey) {
      return { status: 'error', found: false };
    }

    const baseCheckUrl =
      process.env.PESEPAY_CHECK_URL ||
      'https://api.pesepay.com/api/payments-engine/v1/payments/check-payment';
    const checkUrl = `${baseCheckUrl}?referenceNumber=${encodeURIComponent(reference)}`;

    const response = await lenientRequest({
      url: checkUrl,
      method: 'GET',
      headers: { authorization: config.integrationKey },
      timeoutMs: 15000,
    });

    const data = response.json || {};

    // Pesepay answers an unknown reference with HTTP 404 and a JSON body whose
    // own "status" field is the string "404". Without this branch that string
    // would be read as a transaction status.
    if (response.status === 404) {
      return { status: 'not_found', found: false };
    }
    if (response.status >= 400) {
      console.error(`check-payment returned HTTP ${response.status}`, data);
      return { status: 'error', found: false };
    }

    if (data.payload) {
      const decrypted = decryptResponse(data.payload, config.encryptionKey);
      if (decrypted) {
        return {
          status: decrypted.transactionStatus || decrypted.status || 'unknown',
          amount: decrypted.amountDetails?.amount || decrypted.amount,
          currency: decrypted.currencyCode,
          found: true,
        };
      }
    }

    return {
      status: data.transactionStatus || data.status || 'unknown',
      amount: data.amount || data.amountDetails?.amount,
      currency: data.currency || data.currencyCode,
      found: true,
    };
  } catch (error: unknown) {
    console.error('Payment verification error:', error);
    return { status: 'error', found: false };
  }
}

// ---------------------------------------------------------------------------
// Multi-rail gateway (POS / invoices / subscriptions)
//
// Method codes were read from the LIVE merchant API, not guessed:
//   GET /api/payments-engine/v1/currencies/active
//   GET /api/payments-engine/v1/payment-methods/for-currency?currencyCode=<CUR>
//
// Verified 2026-10-03 against this merchant with real initiations:
//   Ecocash USD PZW211 -> PROCESSING   Ecocash ZiG PZW201 -> PROCESSING
//   Innbucks USD PZW212 -> PENDING      PayGo ZiG   PZW210 -> PENDING
//   Omari USD    PZW216 -> PENDING
//   Zimswitch USD/ZWG -> HTTP 400 at the provider (not enabled for this
//   merchant), so Zimswitch is deliberately NOT offered.
//
// IMPORTANT: friendly names such as "ECOCASH" are NOT valid codes. Sending one
// produces the misleading "Can not perform transaction of the specified amount
// in the specified currency", which looks like a pricing fault.
// ---------------------------------------------------------------------------

export type PesepayCurrency = 'USD' | 'ZiG';

export type PesepayRail = 'ecocash' | 'innbucks' | 'paygo' | 'omari';

interface RailSpec {
  code: string;
  min: number;
  max: number;
  /** EcoCash/Omari need the payer MSISDN in paymentMethodRequiredFields. */
  requiresPhone: boolean;
}

export const PESEPAY_RAILS: Record<PesepayRail, Partial<Record<PesepayCurrency, RailSpec>>> = {
  ecocash: {
    USD: { code: 'PZW211', min: 1, max: 500, requiresPhone: true },
    ZiG: { code: 'PZW201', min: 2, max: 8000, requiresPhone: true },
  },
  innbucks: {
    USD: { code: 'PZW212', min: 1, max: 1000, requiresPhone: false },
  },
  paygo: {
    ZiG: { code: 'PZW210', min: 1, max: 2400, requiresPhone: false },
  },
  omari: {
    USD: { code: 'PZW216', min: 0.5, max: 500, requiresPhone: true },
  },
};

const PESEPAY_CURRENCIES: PesepayCurrency[] = ['USD', 'ZiG'];

/** Pesepay's code is "ZiG"; callers commonly send "ZWG"/"ZWD". */
export function normalizeGatewayCurrency(value: unknown): PesepayCurrency | null {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'ZWG' || raw === 'ZWD' || raw === 'ZIG') return 'ZiG';
  if (raw === 'USD') return 'USD';
  return null;
}

export function isPesepayCurrency(value: unknown): value is PesepayCurrency {
  const normalized = normalizeGatewayCurrency(value);
  return normalized !== null && PESEPAY_CURRENCIES.includes(normalized);
}

export function isPesepayRail(value: unknown): value is PesepayRail {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PESEPAY_RAILS, value.toLowerCase())
  );
}

export function resolveRail(
  rail: PesepayRail,
  currency: PesepayCurrency
): RailSpec | undefined {
  return PESEPAY_RAILS[rail]?.[currency];
}

export function listAvailableRails(
  currency: PesepayCurrency
): { rail: PesepayRail; code: string; min: number; max: number; requiresPhone: boolean }[] {
  return (Object.keys(PESEPAY_RAILS) as PesepayRail[])
    .map((rail) => {
      const spec = PESEPAY_RAILS[rail][currency];
      return spec ? { rail, ...spec } : null;
    })
    .filter((x): x is { rail: PesepayRail; code: string; min: number; max: number; requiresPhone: boolean } => x !== null);
}

export function getPesepayResultUrl(): string {
  if (process.env.PESEPAY_RESULT_URL) return process.env.PESEPAY_RESULT_URL;
  const base = process.env.BASE_URL || 'https://wifi.preyone.com';
  return `${base.replace(/\/$/, '')}/api/payments/pesepay/callback`;
}

export function getPesepayReturnUrl(): string {
  if (process.env.PESEPAY_RETURN_URL) return process.env.PESEPAY_RETURN_URL;
  const base = process.env.BASE_URL || 'https://wifi.preyone.com';
  return `${base.replace(/\/$/, '')}/payment-status`;
}

export interface PesepayGatewayRequest {
  amount: number;
  currencyCode: string;
  paymentMethod: string;
  reasonForPayment: string;
  reference: string;
  phone?: string;
  email?: string;
  fullName?: string;
  /**
   * Overrides the global getPesepayReturnUrl() for this payment only. Used by
   * the website checkout so the customer lands back on the marketing site,
   * while staff POS sales keep returning to the portal/payment-status page.
   */
  returnUrl?: string;
}

export interface PesepayGatewayResponse {
  success: boolean;
  referenceNumber?: string;
  redirectUrl?: string;
  pollUrl?: string;
  status?: string;
  statusDescription?: string;
  instructions?: string;
  error?: string;
  /** Server-side diagnostic. Logged, never returned to the customer. */
  detail?: string;
}

export async function initiatePesepayPayment(
  paymentRequest: PesepayGatewayRequest
): Promise<PesepayGatewayResponse> {
  try {
    const config = getPesepayConfig();
    if (!config.integrationKey || !config.encryptionKey) {
      // Fail closed everywhere. A mock response in a non-production environment
      // hands the caller a poll URL that can never complete.
      return { success: false, error: 'Pesepay is not configured on this server.' };
    }

    const currency = normalizeGatewayCurrency(paymentRequest.currencyCode);
    if (!currency) {
      return { success: false, error: `Unsupported currency ${paymentRequest.currencyCode}.` };
    }
    if (!isPesepayRail(paymentRequest.paymentMethod)) {
      return { success: false, error: `Unsupported payment method ${paymentRequest.paymentMethod}.` };
    }
    const rail = paymentRequest.paymentMethod.toLowerCase() as PesepayRail;
    const spec = resolveRail(rail, currency);
    if (!spec) {
      return {
        success: false,
        error: `${rail} is not available in ${currency}. Please contact support.`,
      };
    }

    const amount = Number(paymentRequest.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, error: 'Invalid payment amount.' };
    }
    if (amount < spec.min) {
      return {
        success: false,
        error: `The minimum ${rail} payment in ${currency} is ${spec.min.toFixed(2)}.`,
      };
    }
    if (amount > spec.max) {
      return {
        success: false,
        error: `The maximum ${rail} payment in ${currency} is ${spec.max.toFixed(2)}.`,
      };
    }
    if (spec.requiresPhone && !paymentRequest.phone) {
      return { success: false, error: `A mobile number is required for ${rail}.` };
    }

    const formattedPhone = paymentRequest.phone ? formatPhoneNumber(paymentRequest.phone) : undefined;

    const requestBody: Record<string, unknown> = {
      currencyCode: currency,
      paymentMethodCode: spec.code,
      customer: {
        email: paymentRequest.email || '',
        name: paymentRequest.fullName || 'GUEST',
        ...(formattedPhone ? { phoneNumber: formattedPhone } : {}),
      },
      amountDetails: { amount, currencyCode: currency },
      reasonForPayment: paymentRequest.reasonForPayment,
      returnUrl: paymentRequest.returnUrl || getPesepayReturnUrl(),
      resultUrl: getPesepayResultUrl(),
      merchantReference: paymentRequest.reference,
    };

    // "paymentMethodRequiredFields" must ALWAYS be present on v2 make-payment.
    // Leaving it out entirely makes Pesepay return a bare HTTP 500 with a null
    // message, even for rails that genuinely require no extra fields (InnBucks,
    // PayGo). The inner key is only needed by the phone-prompt rails, and it
    // must be spelled "customerPhoneNumber" - "phone" is silently ignored.
    requestBody.paymentMethodRequiredFields = spec.requiresPhone && formattedPhone
      ? { customerPhoneNumber: formattedPhone }
      : {};

    const { decrypted, data, error } = await postEncryptedPayload(requestBody, config);

    if (error) {
      return { success: false, error };
    }

    const result = decrypted ?? data;
    if (!result) {
      return { success: false, error: 'No payment response received from provider' };
    }

    return {
      success: true,
      referenceNumber: result.referenceNumber || result.reference,
      redirectUrl: result.redirectUrl,
      pollUrl: result.pollUrl,
      status: result.transactionStatus || result.status,
      statusDescription: result.transactionStatusDescription,
      instructions: result.instructions,
    };
  } catch (error: unknown) {
    console.error('Pesepay gateway initiation error:', error);
    const detail = error instanceof Error ? error.message : 'Unknown error';
    // Never surface a transport/parser message to the customer.
    return {
      success: false,
      error: 'We could not reach the payment provider. Please try again.',
      detail,
    };
  }
}

