import * as CryptoJS from 'crypto-js';
import axios from 'axios';

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
}

interface PesepayPaymentResponse {
  success: boolean;
  pollUrl?: string;
  error?: string;
  transactionId?: string;
}

export type PesepayCurrency = 'USD' | 'ZWG';

export type PesepayRail = 'ecocash' | 'innbucks' | 'zimswitch' | 'visa' | 'mastercard';

const PESEPAY_RAIL_CODES: Record<PesepayRail, string> = {
  ecocash: 'ECOCASH',
  innbucks: 'INNBUCKS',
  zimswitch: 'ZIMSWITCH',
  visa: 'VISA',
  mastercard: 'MASTERCARD',
};

const PESEPAY_CURRENCIES: PesepayCurrency[] = ['USD', 'ZWG'];

interface PesepayGatewayRequest {
  amount: number;
  currencyCode: PesepayCurrency;
  paymentMethod: PesepayRail;
  reasonForPayment: string;
  reference: string;
  phone?: string;
  email?: string;
  fullName?: string;
}

interface PesepayGatewayResponse {
  success: boolean;
  referenceNumber?: string;
  redirectUrl?: string;
  pollUrl?: string;
  instructions?: string;
  error?: string;
}

const PESEPAY_V2_URL = 'https://api.pesepay.com/api/payments-engine/v2/payments/make-payment';

function getPesepayResultUrl(): string {
  if (process.env.PESEPAY_RESULT_URL) return process.env.PESEPAY_RESULT_URL;
  const base = process.env.BASE_URL || 'https://portal.preyone.com';
  return `${base.replace(/\/$/, '')}/api/payments/pesepay/callback`;
}

function getPesepayReturnUrl(): string {
  if (process.env.PESEPAY_RETURN_URL) return process.env.PESEPAY_RETURN_URL;
  const base = process.env.BASE_URL || 'https://portal.preyone.com';
  return `${base.replace(/\/$/, '')}/payment-status`;
}

export function isPesepayCurrency(value: unknown): value is PesepayCurrency {
  return typeof value === 'string' && PESEPAY_CURRENCIES.includes(value.toUpperCase() as PesepayCurrency);
}

export function isPesepayRail(value: unknown): value is PesepayRail {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PESEPAY_RAIL_CODES, value.toLowerCase());
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
  const key = CryptoJS.enc.Utf8.parse(encryptionKey);
  const iv = CryptoJS.enc.Utf8.parse(encryptionKey.substring(0, 16));
  const decrypted = CryptoJS.AES.decrypt(encryptedString, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const txt = decrypted.toString(CryptoJS.enc.Utf8);
  try {
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

function getRequestBody(paymentRequest: InitiatePaymentRequest) {
  return {
    currencyCode: paymentRequest.currency,
    paymentMethodCode: 'ECOCASH',
    customer: {
      email: paymentRequest.email || 'customer@preyone.com',
      phone: formatPhoneNumber(paymentRequest.phone),
      name: paymentRequest.fullName || 'WiFi Customer',
    },
    amountDetails: {
      amount: paymentRequest.amount,
      currencyCode: paymentRequest.currency,
    },
    reasonForPayment: paymentRequest.description,
    returnUrl: paymentRequest.returnUrl,
    resultUrl: `${process.env.BASE_URL || 'https://wifi.preyone.com'}/api/payments/webhook`,
    merchantReference: paymentRequest.reference,
  };
}

function describePesepayError(error: unknown): string {
  if (error instanceof Error && 'isAxiosError' in error && (error as any).isAxiosError) {
    const axiosErr = error as any;
    if (axiosErr.response) {
      const msg = axiosErr.response.data?.message || axiosErr.response.data?.error || `HTTP ${axiosErr.response.status}`;
      return 'Payment service error: ' + msg;
    }
  }
  const msg = error instanceof Error ? error.message : 'Unknown error';
  return 'Payment service error: ' + msg;
}

async function postEncryptedPayload(
  requestBody: any,
  config: PesepayConfig
): Promise<{ decrypted: any | null; data: any; error?: string }> {
  const encryptedPayload = encryptPayload(requestBody, config.encryptionKey);

  const response = await axios.post(config.baseUrl, { payload: encryptedPayload }, {
    headers: { authorization: config.integrationKey },
    timeout: 30000,
    validateStatus: () => true,
  });

  const data = response.data;

  if (response.status >= 400) {
    console.error('Pesepay API error:', data);
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

export async function initiateEcoCashPayment(
  paymentRequest: InitiatePaymentRequest
): Promise<PesepayPaymentResponse> {
  try {
    const config = getPesepayConfig();
    if (!config.integrationKey || !config.encryptionKey) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Pesepay credentials not configured in production');
      }
      console.warn('Pesepay configuration incomplete. Using mock response.');
      return generateMockResponse(paymentRequest);
    }

    const requestBody = getRequestBody(paymentRequest);
    const { decrypted, data, error } = await postEncryptedPayload(requestBody, config);

    if (error) {
      return { success: false, error };
    }

    if (decrypted) {
      return {
        success: true,
        pollUrl: decrypted.pollUrl || decrypted.redirectUrl,
        transactionId: decrypted.referenceNumber || decrypted.reference,
      };
    }

    if (data?.pollUrl || data?.redirectUrl) {
      return {
        success: true,
        pollUrl: data.pollUrl || data.redirectUrl,
        transactionId: data.referenceNumber || data.reference,
      };
    }

    return { success: false, error: 'No poll URL received from payment provider' };
  } catch (error: unknown) {
    console.error('Pesepay integration error:', error);
    return { success: false, error: describePesepayError(error) };
  }
}

export async function initiatePesepayPayment(
  paymentRequest: PesepayGatewayRequest
): Promise<PesepayGatewayResponse> {
  try {
    const config = getPesepayConfig();
    if (!config.integrationKey || !config.encryptionKey) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Pesepay credentials not configured in production');
      }
      console.warn('Pesepay configuration incomplete. Using mock response.');
      return generateMockGatewayResponse(paymentRequest);
    }

    const requestBody = {
      currencyCode: paymentRequest.currencyCode,
      paymentMethodCode: PESEPAY_RAIL_CODES[paymentRequest.paymentMethod],
      customer: {
        email: paymentRequest.email || 'customer@preyone.com',
        ...(paymentRequest.phone ? { phone: formatPhoneNumber(paymentRequest.phone) } : {}),
        name: paymentRequest.fullName || 'Preyone Customer',
      },
      amountDetails: {
        amount: paymentRequest.amount,
        currencyCode: paymentRequest.currencyCode,
      },
      reasonForPayment: paymentRequest.reasonForPayment,
      returnUrl: getPesepayReturnUrl(),
      resultUrl: getPesepayResultUrl(),
      merchantReference: paymentRequest.reference,
    };

    const { decrypted, data, error } = await postEncryptedPayload(requestBody, config);

    if (error) {
      return { success: false, error };
    }

    const source = decrypted || data || {};
    const redirectUrl = source.redirectUrl || source.pollUrl || data?.redirectUrl || data?.pollUrl;

    if (!redirectUrl) {
      return { success: false, error: 'No redirect URL received from Pesepay' };
    }

    return {
      success: true,
      referenceNumber: source.referenceNumber || source.reference || paymentRequest.reference,
      redirectUrl,
      pollUrl: source.pollUrl || source.redirectUrl,
      instructions: source.instructions || source.ussdString || source.paymentInstructions,
    };
  } catch (error: unknown) {
    console.error('Pesepay gateway error:', error);
    return { success: false, error: describePesepayError(error) };
  }
}

export async function verifyPaymentStatus(reference: string): Promise<{
  status: string;
  amount?: number;
  currency?: string;
}> {
  try {
    const config = getPesepayConfig();
    if (!config.integrationKey || !config.encryptionKey) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Pesepay credentials not configured in production');
      }
      return { status: 'unknown' };
    }

    const baseCheckUrl = 'https://api.pesepay.com/api/payments-engine/v1/payments/check-payment';
    const checkUrl = `${baseCheckUrl}?referenceNumber=${reference}`;

    const response = await axios.get(checkUrl, {
      headers: { authorization: config.integrationKey },
      timeout: 15000,
      validateStatus: () => true,
    });

    const data = response.data;

    if (data.payload) {
      const decrypted = decryptResponse(data.payload, config.encryptionKey);
      if (decrypted) {
        return {
          status: decrypted.transactionStatus || decrypted.status || 'unknown',
          amount: decrypted.amountDetails?.amount || decrypted.amount,
          currency: decrypted.currencyCode,
        };
      }
    }

    return {
      status: data.transactionStatus || data.status || 'unknown',
      amount: data.amount || data.amountDetails?.amount,
      currency: data.currency || data.currencyCode,
    };
  } catch (error: unknown) {
    console.error('Payment verification error:', error);
    return { status: 'error' };
  }
}

function generateMockResponse(paymentRequest: InitiatePaymentRequest): PesepayPaymentResponse {
  const mockTransactionId = `TXN-${Date.now()}`;
  const mockPollUrl = `https://payments.pesepay.com/poll?ref=${paymentRequest.reference}`;
  console.info('Using mock Pesepay response for development.');
  return {
    success: true,
    pollUrl: mockPollUrl,
    transactionId: mockTransactionId,
  };
}

function generateMockGatewayResponse(paymentRequest: PesepayGatewayRequest): PesepayGatewayResponse {
  console.info('Using mock Pesepay response for development.');
  return {
    success: true,
    referenceNumber: `PSE-${Date.now()}`,
    redirectUrl: `https://payments.pesepay.com/poll?ref=${paymentRequest.reference}`,
    pollUrl: `https://payments.pesepay.com/poll?ref=${paymentRequest.reference}`,
    instructions: `Approve ${paymentRequest.currencyCode} ${paymentRequest.amount} in your ${paymentRequest.paymentMethod} wallet.`,
  };
}
