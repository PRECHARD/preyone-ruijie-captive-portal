import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import {
  initiateEcoCashPayment,
  initiatePesepayPayment,
  decryptResponse,
  verifyPaymentStatus,
  isPesepayCurrency,
  isPesepayRail,
} from '../services/pesepayService';
import type { PesepayCurrency, PesepayRail } from '../services/pesepayService';
import { transformToWISPrProfile } from '../utils/wisprTransformer';
import { bypassRuijieFirewall } from '../services/ruijieService';
import { buildRuijieSuccessUrl } from '../utils/redirect';

export const paymentsRouter = Router();

interface PaymentInitiationRequest {
  tier: string;
  displayName: string;
  amount: number;
  currency: string;
  billingPeriod: string;
  dataLimitGb: number | null;
  isUncapped: boolean;
  bandwidthUp: number;
  bandwidthDown: number;
  phone: string;
  fullName: string;
  macAddress?: string;
  ipAddress?: string;
}

paymentsRouter.post('/initiate', async (req: Request, res: Response) => {
  const {
    tier,
    displayName,
    amount,
    currency,
    billingPeriod,
    dataLimitGb,
    isUncapped,
    bandwidthUp,
    bandwidthDown,
    phone,
    fullName,
    macAddress,
    ipAddress,
  } = req.body as PaymentInitiationRequest;
  const ruijieAuthUrl = (req.body as any).ruijieAuthUrl as string | undefined;

  // Validate required fields
  if (!tier || !amount || !currency || !phone || !fullName) {
    res.status(400).json({ error: 'Missing required payment fields' });
    return;
  }

  // Force USD — reject any other currency
  const paymentCurrency = 'USD';
  if (currency !== paymentCurrency) {
    res.status(400).json({ error: 'Only USD is supported' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get or create user
    let userId: string;
    const { rows: existingUsers } = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE phone = $1 LIMIT 1',
      [phone]
    );

    if (existingUsers.length > 0) {
      userId = existingUsers[0].id;
    } else {
      const { rows: newUsers } = await client.query<{ id: string }>(
        `INSERT INTO users (full_name, phone, accepted_tos, mac_address, ip_address)
         VALUES ($1, $2, $3, $4, $5::inet)
         RETURNING id`,
        [fullName, phone, true, macAddress || null, ipAddress || null]
      );
      userId = newUsers[0].id;
    }

    // 2. Get package by tier — fetch price_amount for validation
    const { rows: packages } = await client.query<{ id: string; price_amount: number }>(
      'SELECT id, price_amount FROM packages WHERE tier_name = $1',
      [tier]
    );

    if (packages.length === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Invalid package tier' });
      return;
    }

    const packageId = packages[0].id;

    // 2a. Validate amount matches package price
    const dbAmount = parseFloat(String(packages[0].price_amount));
    if (Math.abs(dbAmount - Number(amount)) > 0.01) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Amount does not match package price' });
      return;
    }

    // 3. Create payment record
    const paymentId = uuidv4();
    const merchantReference = `PREYONE-${paymentId.substring(0, 8).toUpperCase()}-${Date.now()}`;

    const { rows: paymentRows } = await client.query<{ id: string }>(
      `INSERT INTO payments (id, user_id, package_id, phone_number, amount, currency, payment_method, pesepay_reference, merchant_reference, ruijie_auth_url, client_mac, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'EcoCash', $7, $8, $9, $10, 'pending')
       RETURNING id`,
      [paymentId, userId, packageId, phone, amount, paymentCurrency, merchantReference, merchantReference, ruijieAuthUrl || null, macAddress || null]
    );

    await client.query('COMMIT');

    // 4. Build returnUrl preserved through callback
    const baseCallbackUrl = process.env.BASE_URL || 'https://portal.preyone.com';
    const callbackUrl = baseCallbackUrl.startsWith('http')
      ? new URL('/api/payments/callback', baseCallbackUrl)
      : new URL(`https://portal.preyone.com/api/payments/callback`);
    callbackUrl.searchParams.set('ref', merchantReference);
    if (macAddress) callbackUrl.searchParams.set('mac', macAddress);

    const pesepayResponse = await initiateEcoCashPayment({
      amount,
      currency: paymentCurrency,
      phone,
      fullName,
      email: `${phone.replace(/\D/g, '')}@preyone.com`,
      reference: merchantReference,
      description: `${displayName} - ${billingPeriod} package`,
      returnUrl: callbackUrl.toString(),
    });

    if (!pesepayResponse.success) {
      // Update payment status to failed
      await pool.query(
        'UPDATE payments SET status = $1, error_message = $2 WHERE id = $3',
        ['failed', pesepayResponse.error, paymentId]
      );
      res.status(400).json({ error: pesepayResponse.error || 'Failed to initiate payment' });
      return;
    }

    // Update payment with Pesepay details
    await pool.query(
      'UPDATE payments SET pesepay_poll_url = $1 WHERE id = $2',
      [pesepayResponse.pollUrl, paymentId]
    );

    res.json({
      success: true,
      paymentId,
      pesepayReference: merchantReference,
      pesepayPollUrl: pesepayResponse.pollUrl,
      amount,
      phone,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Payment initiation error:', error);
    res.status(500).json({ error: 'Payment processing failed' });
  } finally {
    client.release();
  }
});

// Webhook endpoint to receive encrypted Pesepay callbacks
paymentsRouter.post('/webhook', async (req: Request, res: Response) => {
  try {
    const { payload } = req.body;
    if (!payload) return res.status(400).send('Missing payload');

    const decrypted = decryptResponse(payload, process.env.PESEPAY_ENCRYPTION_KEY || '');
    if (!decrypted) return res.status(400).send('Invalid payload');

    const merchantRef = decrypted.merchantReference || decrypted.merchant_reference || decrypted.reference;
    const transactionStatus = decrypted.transactionStatus || decrypted.status || decrypted.transaction_status;
    const receivedAmount = decrypted.amount || decrypted.transactionAmount;

    if (!merchantRef) return res.status(400).send('Missing merchant reference in payload');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query('SELECT id, user_id, phone_number, amount, package_id, status, ruijie_auth_url FROM payments WHERE merchant_reference = $1 FOR UPDATE', [merchantRef]);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).send('Payment not found');
      }

      const payment = rows[0];

      if (payment.status === 'completed') {
        await client.query('COMMIT');
        return res.status(200).send('OK (Already Processed)');
      }

      if (receivedAmount !== undefined && receivedAmount !== null && receivedAmount !== '') {
        const parsedReceived = Number(receivedAmount);
        if (!isNaN(parsedReceived) && Math.abs(Number(payment.amount) - parsedReceived) > 0.01) {
          await client.query('ROLLBACK');
          return res.status(400).send('Amount mismatch');
        }
      }

      if (transactionStatus === 'SUCCESS' || transactionStatus === 'COMPLETED' || transactionStatus === 'PAID') {
        await client.query('UPDATE payments SET status = $1, completed_at = $2 WHERE merchant_reference = $3', ['completed', new Date(), merchantRef]);

        const { rows: userRows } = await client.query('SELECT mac_address FROM users WHERE id = $1', [payment.user_id]);
        const { rows: pkgRows } = await client.query('SELECT tier_name, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, duration_min FROM packages WHERE id = $1', [payment.package_id]);

        if (pkgRows.length > 0) {
          await client.query(
            `INSERT INTO transactions (payment_id, user_id, package_tier, amount, currency, payment_method, status, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'completed', NOW())`,
            [payment.id, payment.user_id, pkgRows[0].tier_name, payment.amount, 'USD', 'EcoCash']
          );
        }

        const { rows: ceoRows } = await client.query(
          `SELECT id, full_name FROM admin_users WHERE role = 'CEO' ORDER BY created_at ASC LIMIT 1`
        );
        const ceoId = ceoRows.length > 0 ? ceoRows[0].id : null;
        const ceoName = ceoRows.length > 0 ? ceoRows[0].full_name : null;

        if (userRows.length > 0 && pkgRows.length > 0) {
          const sessionExpires = new Date(Date.now() + pkgRows[0].duration_min * 60 * 1000);
          const slug = pkgRows[0].tier_name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
          const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          const bytes = crypto.randomBytes(4);
          let rand = '';
          for (let j = 0; j < 4; j++) rand += chars[bytes[j] % chars.length];
          const vc = `${slug}-${rand}`;

          const { rows: vRows } = await client.query(
            `INSERT INTO vouchers (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, package_tier, sold_by, price_amount)
             VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [vc, pkgRows[0].duration_min, sessionExpires, pkgRows[0].data_limit_gb, pkgRows[0].is_uncapped, pkgRows[0].bandwidth_mbps_up, pkgRows[0].bandwidth_mbps_down, pkgRows[0].tier_name, ceoId, payment.amount]
          );

          if (ceoId && vRows.length > 0) {
            await client.query(
              `INSERT INTO sales (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [vRows[0].id, vc, ceoId, ceoName, payment.amount, 'USD']
            );
          }

          const webhookSessionToken = uuidv4();
          await client.query('UPDATE users SET session_token = $1, session_expires_at = $2, voucher_code = $3 WHERE id = $4', [webhookSessionToken, sessionExpires, vc, payment.user_id]);

          if (userRows[0].mac_address) {
            const wispr = transformToWISPrProfile({
              macAddress: userRows[0].mac_address,
              packageData: pkgRows[0],
            });

            await client.query(
              `INSERT INTO wispr_profiles (user_id, mac_address, bandwidth_up_kbps, bandwidth_down_kbps, data_quota_bytes, is_uncapped, session_end)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                payment.user_id,
                wispr.macAddress,
                wispr.bandwidthUpKbps,
                wispr.bandwidthDownKbps,
                wispr.dataQuotaBytes,
                wispr.isUncapped,
                sessionExpires,
              ]
            );

            await bypassRuijieFirewall(userRows[0].mac_address, payment.ruijie_auth_url || '', wispr.bandwidthDownKbps, wispr.dataQuotaBytes);
          }
        }

        await client.query('COMMIT');
        return res.status(200).send('OK');
      }

      await client.query('COMMIT');
      return res.status(200).send('Ignored non-success status');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Webhook inner error:', err);
      return res.status(500).send('Webhook processing error');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Webhook outer error:', err);
    return res.status(500).send('Webhook processing error');
  }
});

paymentsRouter.get('/callback', async (req: Request, res: Response) => {
  const reference = req.query.ref as string;

  if (!reference) {
    res.status(400).json({ error: 'Missing reference' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: payments } = await client.query<{
      id: string;
      user_id: string;
      package_id: string;
      amount: number;
      status: string;
      ruijie_auth_url: string | null;
    }>(
      'SELECT id, user_id, package_id, amount, status, ruijie_auth_url FROM payments WHERE pesepay_reference = $1 FOR UPDATE',
      [reference]
    );

    if (payments.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    const payment = payments[0];

    if (payment.status === 'completed') {
      await client.query('COMMIT');
      // If the payment was already completed, redirect with existing session_token
      const { rows: existingUser } = await pool.query('SELECT session_token FROM users WHERE id = $1', [payment.user_id]);
      const existingToken = existingUser.length > 0 ? existingUser[0].session_token : null;
      if (existingToken) {
        const ep = new URLSearchParams();
        ep.set('token', existingToken);
        res.redirect(`/success.html?${ep.toString()}`);
        return;
      }
      res.json({ success: true, message: 'Payment already processed.', paymentId: payment.id });
      return;
    }

    const verification = await verifyPaymentStatus(reference);
    if (verification.status === 'completed' || verification.status === 'success' || verification.status === 'PAID') {
      await client.query(
        'UPDATE payments SET status = $1, completed_at = $2 WHERE id = $3',
        ['completed', new Date(), payment.id]
      );
    } else {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Payment not confirmed by Pesepay', status: verification.status });
      return;
    }

    const { rows: userRows } = await client.query<{ mac_address: string }>(
      'SELECT mac_address FROM users WHERE id = $1',
      [payment.user_id]
    );

    const { rows: packageRows } = await client.query<{
      tier_name: string;
      data_limit_gb: number | null;
      is_uncapped: boolean;
      bandwidth_mbps_up: number;
      bandwidth_mbps_down: number;
      duration_min: number;
    }>(
      'SELECT tier_name, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, duration_min FROM packages WHERE id = $1',
      [payment.package_id]
    );

    if (packageRows.length > 0) {
      await client.query(
        `INSERT INTO transactions (payment_id, user_id, package_tier, amount, currency, payment_method, status, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'completed', NOW())`,
        [payment.id, payment.user_id, packageRows[0].tier_name, payment.amount, 'USD', 'EcoCash']
      );
    }

    let voucherCode: string | null = null;
    let soldById: string | null = null;
    let soldByName: string | null = null;

    const { rows: ceoRows } = await pool.query(
      `SELECT id, full_name FROM admin_users WHERE role = 'CEO' ORDER BY created_at ASC LIMIT 1`
    );
    if (ceoRows.length > 0) {
      soldById = ceoRows[0].id;
      soldByName = ceoRows[0].full_name;
    }

    if (packageRows.length > 0) {
      const slug = packageRows[0].tier_name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const bytes = crypto.randomBytes(4);
      let rand = '';
      for (let j = 0; j < 4; j++) rand += chars[bytes[j] % chars.length];
      voucherCode = `${slug}-${rand}`;
    }
    if (voucherCode) voucherCode = voucherCode.toUpperCase();

    const sessionToken = uuidv4();
    const sessionExpires = packageRows.length > 0
      ? new Date(Date.now() + packageRows[0].duration_min * 60 * 1000)
      : new Date();

    if (userRows.length > 0 && packageRows.length > 0) {
      await client.query('UPDATE users SET session_token = $1, session_expires_at = $2, voucher_code = $3 WHERE id = $4', [sessionToken, sessionExpires, voucherCode, payment.user_id]);

      const { rows: voucherRows } = await client.query(
        `INSERT INTO vouchers (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, package_tier, sold_by, price_amount)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [voucherCode, packageRows[0].duration_min, sessionExpires, packageRows[0].data_limit_gb, packageRows[0].is_uncapped, packageRows[0].bandwidth_mbps_up, packageRows[0].bandwidth_mbps_down, packageRows[0].tier_name, soldById, payment.amount]
      );

      if (soldById && voucherRows.length > 0) {
        await client.query(
          `INSERT INTO sales (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [voucherRows[0].id, voucherCode, soldById, soldByName, payment.amount, 'USD']
        );
      }

      if (userRows[0].mac_address) {
        const wispr = transformToWISPrProfile({
          macAddress: userRows[0].mac_address,
          packageData: packageRows[0],
        });

        await client.query(
          `INSERT INTO wispr_profiles (user_id, mac_address, bandwidth_up_kbps, bandwidth_down_kbps, data_quota_bytes, is_uncapped, session_end)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            payment.user_id,
            wispr.macAddress,
            wispr.bandwidthUpKbps,
            wispr.bandwidthDownKbps,
            wispr.dataQuotaBytes,
            wispr.isUncapped,
            sessionExpires,
          ]
        );

        await bypassRuijieFirewall(userRows[0].mac_address, payment.ruijie_auth_url || '', wispr.bandwidthDownKbps, wispr.dataQuotaBytes);
      }
    }

    await client.query('COMMIT');

    const successUrl = buildRuijieSuccessUrl(req, {
      sessionToken,
      macAddress: userRows.length > 0 ? userRows[0].mac_address : undefined,
      packageData: packageRows.length > 0 ? {
        data_limit_gb: packageRows[0].data_limit_gb,
        is_uncapped: packageRows[0].is_uncapped,
        bandwidth_mbps_up: packageRows[0].bandwidth_mbps_up,
        bandwidth_mbps_down: packageRows[0].bandwidth_mbps_down,
        duration_min: packageRows[0].duration_min,
      } : undefined,
    });

    res.redirect(successUrl);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Payment callback error:', error);
    res.status(500).json({ error: 'Callback processing failed' });
  } finally {
    client.release();
  }
});

paymentsRouter.get('/status/:paymentId', async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;

    const { rows } = await pool.query(
      'SELECT id, status, pesepay_reference, amount, completed_at FROM payments WHERE id = $1',
      [paymentId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    res.json({
      paymentId: rows[0].id,
      status: rows[0].status,
      reference: rows[0].pesepay_reference,
      amount: rows[0].amount,
      completedAt: rows[0].completed_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Status lookup failed' });
  }
});

// ---------------------------------------------------------------------------
// Pesepay gateway: invoices, POS shifts and company subscriptions
// ---------------------------------------------------------------------------

const PESEPAY_TARGET_TYPES = ['invoice', 'shift', 'subscription'] as const;
const SUBSCRIPTION_MODULES = ['pos', 'invoice', 'wifi'] as const;

type PesepayTargetType = (typeof PESEPAY_TARGET_TYPES)[number];

interface PesepayInitiateRequest {
  amount: number;
  currencyCode: string;
  reasonForPayment: string;
  tenant_id: string;
  paymentMethod?: string;
  targetType?: string;
  targetId?: string;
  documentId?: string;
  shiftId?: string;
  subscriptionModule?: string;
  planTier?: string;
  phone?: string;
  email?: string;
  fullName?: string;
}

interface PesepayIntentRow {
  id: string;
  reference: string;
  tenant_id: string;
  amount: number;
  currency: string;
  payment_method: PesepayRail;
  target_type: PesepayTargetType;
  target_id: string | null;
  shift_id: string | null;
  subscription_module: string | null;
  plan_tier: string | null;
  status: string;
}

class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function asUuid(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
    ? value.trim()
    : null;
}

async function applyDocumentPayment(
  client: any,
  intent: PesepayIntentRow,
  reference: string
): Promise<Record<string, unknown>> {
  if (!intent.target_id) {
    throw new HttpError(400, 'No document recorded for this payment intent');
  }

  const { rows } = await client.query(
    `SELECT id, doc_number, total, amount_paid, shift_id FROM pos_documents WHERE id = $1 FOR UPDATE`,
    [intent.target_id]
  );

  if (rows.length === 0) {
    throw new HttpError(404, 'Document not found');
  }

  const doc = rows[0];
  const balance = Number(doc.total) - Number(doc.amount_paid);

  if (Number(intent.amount) - balance > 0.01) {
    throw new HttpError(400, 'Amount exceeds outstanding document balance');
  }

  if (intent.target_type === 'shift' && intent.shift_id && doc.shift_id !== intent.shift_id) {
    throw new HttpError(400, 'Document does not belong to the recorded shift');
  }

  await client.query(
    `INSERT INTO pos_document_payments (document_id, amount, method, reference, shift_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [doc.id, intent.amount, intent.payment_method, reference, intent.shift_id || doc.shift_id]
  );

  const { rows: updated } = await client.query(
    `UPDATE pos_documents
        SET amount_paid = LEAST(total, amount_paid + $2),
            status = CASE WHEN amount_paid + $2 >= total THEN 'paid' ELSE 'partial' END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING status`,
    [doc.id, intent.amount]
  );

  return {
    documentId: doc.id,
    documentNumber: doc.doc_number,
    status: updated.length > 0 ? updated[0].status : 'paid',
  };
}

async function applySubscriptionPayment(
  client: any,
  intent: PesepayIntentRow
): Promise<Record<string, unknown>> {
  if (!intent.subscription_module) {
    throw new HttpError(400, 'No subscription module recorded for this payment intent');
  }

  const { rows } = await client.query(
    `UPDATE subscriptions
        SET plan_tier = COALESCE($2, plan_tier),
            status = 'active',
            updated_at = NOW()
      WHERE company_id = $1 AND module = $3
      RETURNING id, plan_tier, status`,
    [intent.tenant_id, intent.plan_tier, intent.subscription_module]
  );

  if (rows.length === 0) {
    throw new HttpError(404, 'Subscription not found');
  }

  return {
    subscriptionId: rows[0].id,
    module: intent.subscription_module,
    planTier: rows[0].plan_tier,
    status: rows[0].status,
  };
}

paymentsRouter.post('/pesepay/initiate', async (req: Request, res: Response) => {
  const body = req.body as PesepayInitiateRequest;

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'Invalid amount' });
    return;
  }

  if (!isPesepayCurrency(body.currencyCode)) {
    res.status(400).json({ error: 'currencyCode must be USD or ZWG' });
    return;
  }
  const currencyCode = body.currencyCode.toUpperCase() as PesepayCurrency;

  const reasonForPayment = typeof body.reasonForPayment === 'string' ? body.reasonForPayment.trim() : '';
  if (!reasonForPayment) {
    res.status(400).json({ error: 'reasonForPayment is required' });
    return;
  }

  const tenantId = asUuid(body.tenant_id);
  if (!tenantId) {
    res.status(400).json({ error: 'tenant_id must be a valid UUID' });
    return;
  }

  const paymentMethod: PesepayRail = body.paymentMethod ? body.paymentMethod.toLowerCase() as PesepayRail : 'ecocash';
  if (!isPesepayRail(paymentMethod)) {
    res.status(400).json({ error: 'Unsupported Pesepay payment method' });
    return;
  }

  const targetType = (body.targetType || 'invoice') as PesepayTargetType;
  if (!PESEPAY_TARGET_TYPES.includes(targetType)) {
    res.status(400).json({ error: 'targetType must be invoice, shift or subscription' });
    return;
  }

  const targetId = asUuid(body.targetId || body.documentId);
  const shiftId = asUuid(body.shiftId);

  if ((targetType === 'invoice' || targetType === 'shift') && !targetId) {
    res.status(400).json({ error: 'targetId (document) is required for invoice and shift payments' });
    return;
  }

  let subscriptionModule: string | null = null;
  if (targetType === 'subscription') {
    subscriptionModule = typeof body.subscriptionModule === 'string' ? body.subscriptionModule.trim().toLowerCase() : '';
    if (!SUBSCRIPTION_MODULES.includes(subscriptionModule as (typeof SUBSCRIPTION_MODULES)[number])) {
      res.status(400).json({ error: 'subscriptionModule must be pos, invoice or wifi' });
      return;
    }
  }

  try {
    const { rows: tenantRows } = await pool.query('SELECT id FROM companies WHERE id = $1', [tenantId]);
    if (tenantRows.length === 0) {
      res.status(404).json({ error: 'Unknown tenant' });
      return;
    }

    if (targetType === 'subscription') {
      const { rows: subRows } = await pool.query(
        'SELECT id FROM subscriptions WHERE company_id = $1 AND module = $2',
        [tenantId, subscriptionModule]
      );
      if (subRows.length === 0) {
        res.status(404).json({ error: 'Subscription not found' });
        return;
      }
    } else {
      const { rows: docRows } = await pool.query(
        'SELECT id, total, amount_paid, shift_id FROM pos_documents WHERE id = $1',
        [targetId]
      );
      if (docRows.length === 0) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      if (targetType === 'shift' && shiftId && docRows[0].shift_id !== shiftId) {
        res.status(400).json({ error: 'Document does not belong to the supplied shift' });
        return;
      }
      const balance = Number(docRows[0].total) - Number(docRows[0].amount_paid);
      if (amount - balance > 0.01) {
        res.status(400).json({ error: 'Amount exceeds outstanding document balance' });
        return;
      }
    }

    const reference = `PREYONE-${uuidv4().substring(0, 8).toUpperCase()}-${Date.now()}`;

    await pool.query(
      `INSERT INTO pesepay_intents
         (reference, tenant_id, amount, currency, payment_method, purpose, reason_for_payment,
          target_type, target_id, shift_id, subscription_module, plan_tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        reference,
        tenantId,
        amount,
        currencyCode,
        paymentMethod,
        reasonForPayment,
        reasonForPayment,
        targetType,
        targetId,
        shiftId,
        subscriptionModule,
        typeof body.planTier === 'string' && body.planTier.trim() ? body.planTier.trim() : null,
      ]
    );

    const pesepayResponse = await initiatePesepayPayment({
      amount,
      currencyCode,
      paymentMethod,
      reasonForPayment,
      reference,
      phone: body.phone,
      email: body.email,
      fullName: body.fullName,
    });

    if (!pesepayResponse.success) {
      await pool.query(
        `UPDATE pesepay_intents SET status = 'failed' WHERE reference = $1`,
        [reference]
      );
      res.status(400).json({ error: pesepayResponse.error || 'Failed to initiate payment', referenceNumber: reference });
      return;
    }

    await pool.query(
      `UPDATE pesepay_intents
          SET provider_reference = $2, redirect_url = $3, poll_url = $4
        WHERE reference = $1`,
      [reference, pesepayResponse.referenceNumber || null, pesepayResponse.redirectUrl || null, pesepayResponse.pollUrl || null]
    );

    res.json({
      success: true,
      referenceNumber: reference,
      pesepayReference: pesepayResponse.referenceNumber || reference,
      redirectUrl: pesepayResponse.redirectUrl,
      pollUrl: pesepayResponse.pollUrl,
      instructions: pesepayResponse.instructions,
      amount,
      currencyCode,
      paymentMethod,
      tenantId,
      targetType,
      targetId,
    });
  } catch (error) {
    console.error('Pesepay initiation error:', error);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

paymentsRouter.post('/pesepay/callback', async (req: Request, res: Response) => {
  const integrationKey = process.env.PESEPAY_INTEGRATION_KEY || '';
  const providedKey = req.header('authorization') || '';

  if (!integrationKey || !safeEqual(providedKey, integrationKey)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const payload = req.body?.payload
      ? decryptResponse(req.body.payload, process.env.PESEPAY_ENCRYPTION_KEY || '')
      : req.body;

    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    const reference =
      payload.referenceNumber ||
      payload.merchantReference ||
      payload.merchant_reference ||
      payload.reference;

    if (!reference) {
      res.status(400).json({ error: 'Missing reference in payload' });
      return;
    }

    const candidates = [
      payload.merchantReference,
      payload.merchant_reference,
      payload.referenceNumber,
      payload.reference,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    const transactionStatus = String(
      payload.transactionStatus || payload.transaction_status || payload.status || ''
    ).toUpperCase();

    if (transactionStatus !== 'SUCCESS') {
      res.status(200).json({
        success: true,
        referenceNumber: reference,
        status: transactionStatus || 'UNKNOWN',
        applied: false,
        message: 'Ignored non-success status',
      });
      return;
    }

    const receivedAmount = payload.amountDetails?.amount ?? payload.amount;
    if (receivedAmount !== undefined && receivedAmount !== null && receivedAmount !== '') {
      const parsed = Number(receivedAmount);
      if (!Number.isFinite(parsed)) {
        res.status(400).json({ error: 'Invalid amount in payload' });
        return;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT id, reference, tenant_id, amount, currency, payment_method, target_type,
                target_id, shift_id, subscription_module, plan_tier, status
           FROM pesepay_intents
          WHERE reference = ANY($1::text[]) OR provider_reference = ANY($1::text[])
          FOR UPDATE`,
        [candidates]
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Payment intent not found' });
        return;
      }

      const intent = rows[0] as PesepayIntentRow;

      if (intent.status === 'completed') {
        await client.query('COMMIT');
        res.status(200).json({
          success: true,
          referenceNumber: reference,
          status: 'completed',
          applied: false,
          message: 'Already processed',
        });
        return;
      }

      if (receivedAmount !== undefined && receivedAmount !== null && receivedAmount !== '') {
        if (Math.abs(Number(intent.amount) - Number(receivedAmount)) > 0.01) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: 'Amount mismatch' });
          return;
        }
      }

      const applied =
        intent.target_type === 'subscription'
          ? await applySubscriptionPayment(client, intent)
          : await applyDocumentPayment(client, intent, reference);

      await client.query(
        `UPDATE pesepay_intents
            SET status = 'completed', completed_at = NOW(), provider_reference = COALESCE($2, provider_reference)
          WHERE id = $1`,
        [intent.id, payload.referenceNumber || null]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        referenceNumber: reference,
        status: 'completed',
        applied: true,
        targetType: intent.target_type,
        ...applied,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      const statusCode = err instanceof HttpError ? err.statusCode : 500;
      if (statusCode === 500) console.error('Pesepay callback error:', err);
      res.status(statusCode).json({ error: err instanceof Error ? err.message : 'Callback processing failed' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Pesepay callback error:', err);
    res.status(500).json({ error: 'Callback processing failed' });
  }
});
