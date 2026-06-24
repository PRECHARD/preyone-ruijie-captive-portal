import * as CryptoJS from 'crypto-js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';

const execFileAsync = promisify(execFile);

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

const PESEPAY_V2_URL = 'https://api.pesepay.com/api/payments-engine/v2/payments/make-payment';

function getPesepayConfig(): PesepayConfig {
  return {
    integrationKey: process.env.PESEPAY_INTEGRATION_KEY || process.env.PESEPAY_API_KEY || '',
    encryptionKey: process.env.PESEPAY_ENCRYPTION_KEY || '',
    baseUrl: process.env.PESEPAY_BASE_URL || PESEPAY_V2_URL,
  };
}

function encryptPayload(payloadObject: any, encryptionKey: string): string {
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

async function curlPost(url: string, body: string, integrationKey: string): Promise<{ status: number; data: any }> {
  const reqFile = `/tmp/pesepay-req-${Date.now()}.json`;
  const resFile = `/tmp/pesepay-res-${Date.now()}.json`;
  await writeFile(reqFile, body, 'utf8');
  try {
    const { stdout } = await execFileAsync('curl', [
      '-s', '-w', '%{http_code}',
      '-X', 'POST',
      url,
      '-H', `authorization: ${integrationKey}`,
      '-H', 'Content-Type: application/json',
      '-d', `@${reqFile}`,
      '-o', resFile,
    ], { timeout: 30000 });
    const status = parseInt(stdout.trim(), 10);
    const raw = await readFile(resFile, 'utf8');
    let data: any;
    try { data = JSON.parse(raw); } catch { data = { raw }; }
    return { status, data };
  } finally {
    try { await unlink(reqFile); } catch {}
    try { await unlink(resFile); } catch {}
  }
}

async function curlGet(url: string, integrationKey: string): Promise<any> {
  const { stdout } = await execFileAsync('curl', [
    '-s', url,
    '-H', `authorization: ${integrationKey}`,
  ], { timeout: 15000 });
  try { return JSON.parse(stdout); } catch { return { raw: stdout }; }
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
    const encryptedPayload = encryptPayload(requestBody, config.encryptionKey);
    const jsonBody = JSON.stringify({ payload: encryptedPayload });
    const { status, data } = await curlPost(config.baseUrl, jsonBody, config.integrationKey);

    if (status >= 400) {
      console.error('Pesepay API error:', data);
      return { success: false, error: data.message || data.error || 'Payment initiation failed' };
    }

    if (data.payload) {
      const decrypted = decryptResponse(data.payload, config.encryptionKey);
      if (!decrypted) {
        return { success: false, error: 'Failed to decrypt Pesepay response' };
      }
      return {
        success: true,
        pollUrl: decrypted.pollUrl || decrypted.redirectUrl,
        transactionId: decrypted.referenceNumber || decrypted.reference,
      };
    }

    if (data.pollUrl || data.redirectUrl) {
      return {
        success: true,
        pollUrl: data.pollUrl || data.redirectUrl,
        transactionId: data.referenceNumber || data.reference,
      };
    }

    return { success: false, error: 'No poll URL received from payment provider' };
  } catch (error: unknown) {
    console.error('Pesepay integration error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: 'Payment service error: ' + msg };
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
    const data = await curlGet(checkUrl, config.integrationKey);

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
