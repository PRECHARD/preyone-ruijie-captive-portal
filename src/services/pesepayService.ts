/**
 * Pesepay EcoCash Payment Integration Service
 * Handles all communication with Pesepay API for EcoCash transactions
 */

interface PesepayConfig {
  apiKey: string;
  apiId: string;
  baseUrl: string;
  merchantId: string;
}

interface InitiatePaymentRequest {
  amount: number;
  currency: string;
  phone: string;
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

import * as CryptoJS from 'crypto-js';

function getPesepayConfig(): PesepayConfig {
  return {
    apiKey: process.env.PESEPAY_API_KEY || '',
    apiId: process.env.PESEPAY_API_ID || '',
    baseUrl: process.env.PESEPAY_BASE_URL || 'https://api.pesepay.com/api/postpay',
    merchantId: process.env.PESEPAY_MERCHANT_ID || '',
  };
}

/**
 * Encrypt a payload object using AES-CBC per Pesepay encryption scheme.
 * Uses full encryption key and the first 16 chars as IV.
 */
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

/**
 * Decrypts a Pesepay encrypted payload string using AES-CBC and returns parsed JSON
 */
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

/**
 * Initiate an EcoCash payment request with Pesepay
 * Automatically targets EcoCash payment method
 */
export async function initiateEcoCashPayment(
  paymentRequest: InitiatePaymentRequest
): Promise<PesepayPaymentResponse> {
  try {
    // Validate configuration
    if (!getPesepayConfig().apiKey || !getPesepayConfig().apiId || !getPesepayConfig().merchantId) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Pesepay credentials not configured in production');
      }
      console.warn('Pesepay configuration incomplete. Using mock response.');
      return generateMockResponse(paymentRequest);
    }

    // Prepare EcoCash-specific payload
    const payload = {
      invoice: {
        id: paymentRequest.reference,
        amount: paymentRequest.amount,
        currency: paymentRequest.currency, // Typically ZWL or USD
        description: paymentRequest.description,
        items: [
          {
            description: paymentRequest.description,
            quantity: 1,
            unitAmount: paymentRequest.amount,
          },
        ],
      },
      payment: {
        method: 'ecocash', // Force EcoCash payment method
        phone: formatPhoneNumber(paymentRequest.phone),
      },
      merchant: {
        id: getPesepayConfig().merchantId,
      },
      returnUrl: paymentRequest.returnUrl,
    };

    // Call Pesepay API
    const response = await fetch(getPesepayConfig().baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getPesepayConfig().apiKey}`,
        'X-API-Id': getPesepayConfig().apiId,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Pesepay API error:', data);
      return {
        success: false,
        error: data.message || 'Payment initiation failed',
      };
    }

    // Extract poll URL from response
    const pollUrl = data.redirectUrl || data.pollUrl || data.url;

    if (!pollUrl) {
      return {
        success: false,
        error: 'No redirect URL received from payment provider',
      };
    }

    return {
      success: true,
      pollUrl,
      transactionId: data.transactionId || data.reference,
    };
  } catch (error) {
    console.error('Pesepay integration error:', error);
    return {
      success: false,
      error: 'Payment service error: ' + (error instanceof Error ? error.message : 'Unknown error'),
    };
  }
}

/**
 * Format phone number for EcoCash (remove leading + and spaces)
 * EcoCash expects format: 263771327202 or 0771327202
 */
function formatPhoneNumber(phone: string): string {
  // Remove all non-digit characters
  const cleaned = phone.replace(/\D/g, '');

  // Handle Zimbabwean numbers
  if (cleaned.startsWith('263')) {
    return cleaned; // Already in +263 format without the +
  }

  if (cleaned.startsWith('0')) {
    return '263' + cleaned.substring(1); // Convert 0771... to 263771...
  }

  // If it doesn't start with 263 or 0, prepend 263
  return '263' + cleaned;
}

/**
 * Verify payment status with Pesepay API
 */
export async function verifyPaymentStatus(reference: string): Promise<{
  status: string;
  amount?: number;
  currency?: string;
}> {
  try {
    if (!getPesepayConfig().apiKey || !getPesepayConfig().apiId) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Pesepay credentials not configured in production');
      }
      return { status: 'unknown' };
    }

    const response = await fetch(`${getPesepayConfig().baseUrl}/verify/${reference}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${getPesepayConfig().apiKey}`,
        'X-API-Id': getPesepayConfig().apiId,
      },
    });

    const data = await response.json();

    return {
      status: data.status || 'unknown',
      amount: data.invoice?.amount,
      currency: data.invoice?.currency,
    };
  } catch (error) {
    console.error('Payment verification error:', error);
    return { status: 'error' };
  }
}

/**
 * Generate mock Pesepay response for development/testing
 */
function generateMockResponse(
  paymentRequest: InitiatePaymentRequest
): PesepayPaymentResponse {
  const mockTransactionId = `TXN-${Date.now()}`;
  const mockPollUrl = `https://payments.pesepay.com/poll?ref=${paymentRequest.reference}&amount=${paymentRequest.amount}`;

  console.info('Using mock Pesepay response for development. Configure PESEPAY_* env vars for production.');

  return {
    success: true,
    pollUrl: mockPollUrl,
    transactionId: mockTransactionId,
  };
}
