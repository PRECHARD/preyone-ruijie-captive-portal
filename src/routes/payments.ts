import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { initiateEcoCashPayment, decryptResponse, verifyPaymentStatus } from '../services/pesepayService';
import { transformToWISPrProfile } from '../utils/wisprTransformer';
import { bypassRuijieFirewall } from '../services/ruijieService';

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
      [paymentId, userId, packageId, phone, amount, currency, merchantReference, merchantReference, ruijieAuthUrl || null, macAddress || null]
    );

    await client.query('COMMIT');

    // 4. Initiate Pesepay EcoCash payment
    const pesepayResponse = await initiateEcoCashPayment({
      amount,
      currency,
      phone,
      reference: merchantReference,
      description: `${displayName} - ${billingPeriod} package`,
      returnUrl: `${process.env.BASE_URL || 'https://portal.preyone.com'}/api/payments/callback?ref=${merchantReference}`,
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

        if (userRows.length > 0 && pkgRows.length > 0) {
          const sessionExpires = new Date(Date.now() + pkgRows[0].duration_min * 60 * 1000);
          await client.query('UPDATE users SET session_expires_at = $1 WHERE id = $2', [sessionExpires, payment.user_id]);

          if (userRows[0].mac_address) {
            const wisprProfile = transformToWISPrProfile({
              macAddress: userRows[0].mac_address,
              packageData: pkgRows[0],
            });
            await bypassRuijieFirewall(userRows[0].mac_address, payment.ruijie_auth_url || '', wisprProfile.bandwidthDownKbps, wisprProfile.dataQuotaBytes);
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

    if (userRows.length > 0 && packageRows.length > 0) {
      const sessionExpires = new Date(Date.now() + packageRows[0].duration_min * 60 * 1000);
      await client.query('UPDATE users SET session_expires_at = $1 WHERE id = $2', [sessionExpires, payment.user_id]);

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

    res.json({
      success: true,
      message: 'Payment processed successfully',
      paymentId: payment.id,
    });
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
