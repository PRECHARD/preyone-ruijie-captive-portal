import { Router, Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import type { PoolClient } from 'pg';
import { requireAdminAuth } from '../middleware/adminAuth';
import {
  initiatePesepayPayment,
  authorizeOmariPayment,
  decryptResponse,
  isPesepayConfigured,
  verifyPaymentStatus,
  normalizePaymentAmount,
  normalizeGatewayCurrency,
  isPesepayCurrency,
  isPesepayRail,
  PESEPAY_SUCCESS_STATUSES,
  PESEPAY_FAILED_STATUSES,
} from '../services/pesepayService';
import type { PesepayCurrency, PesepayRail } from '../services/pesepayService';
import { isRuijieCloudConfigured, findRuijieProfile, mintRuijieVoucherForTier } from '../services/ruijieMint';
import { claimPooledVoucher, refillVoucherPool } from '../services/voucherPool';
import { requireStarlinkAuth } from '../middleware/starlinkAuth';
import { createStarlinkInvoice, applyStarlinkPayment, getStarlinkKit } from '../db/starlink';
import { PLAN_TIERS } from './subscription';
import { isCeoExclusiveTier } from '../config/packages';
import { sendOnlinePaymentReceiptEmail } from '../services/notificationService';
import type { OnlinePaymentEmailData } from '../services/notificationService';

const JWT_SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';
let _jwtSecretWarned = false;
function getJwtSecret(): string {
  if (!_jwtSecretWarned && JWT_SECRET === 'preyone-jwt-secret-change-in-production') {
    console.warn('WARNING: JWT_SECRET is not set. Using insecure default. Set JWT_SECRET in .env for production.');
    _jwtSecretWarned = true;
  }
  return JWT_SECRET;
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['completed', 'failed'],
  completed: ['refunded'],
  failed: [],
  refunded: [],
};

export const paymentsRouter = Router();

// Throttle gateway reconciliation per payment while the portal polls /status:
// the seamless flow has no hosted-page return, so /status is the only heartbeat.
// Keeps a minimum 10s gap between check-payment calls for the same payment and
// lets only one in-flight at a time (reset on process restart is harmless).
const RECONCILE_GAP_MS = 10_000;
const lastReconcileAt = new Map<string, number>();
const reconciling = new Set<string>();

const PHONE_RE = /^2637\d{8}$/;

// Written into payments.error_message when a Ruijie mint fails so the customer's
// own status poll can render the "taking longer than expected" screen. Prefix is
// greppable and completePayment clears error_message on success, so the marker
// disappears as soon as the voucher is finally issued.
const RUIJIE_MINT_PENDING_PREFIX = 'ruijie_mint_pending: ';

function normalizeZwPhone(input: string): string {
  let p = String(input || '').replace(/[^\d+]/g, '');
  p = p.replace(/^\+/, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = '263' + p.slice(1);
  return p;
}

function isValidZwPhone(phone: string): boolean {
  return PHONE_RE.test(phone);
}

// Pesepay reports transaction status as a string, not a numeric code. Anything we
// do not recognise is treated as "pending" so an unrecognised value can never
// mint a voucher by accident.
function parsePesepayStatus(raw: unknown): { state: 'completed' | 'failed' | 'refunded' | 'pending'; label: string } {
  if (raw === undefined || raw === null || raw === '') return { state: 'pending', label: 'pending' };
  const str = String(raw).trim();
  const upper = str.toUpperCase();

  if (PESEPAY_SUCCESS_STATUSES.includes(upper)) return { state: 'completed', label: upper };
  if (upper === 'REFUNDED') return { state: 'refunded', label: upper };
  if (PESEPAY_FAILED_STATUSES.includes(upper)) return { state: 'failed', label: upper };
  return { state: 'pending', label: str };
}

async function getOrCreateUserByPhone(phone: string, fullName?: string): Promise<{ id: string }> {
  const existing = await pool.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [phone]);
  if (existing.rows.length > 0) return existing.rows[0];

  const name = (fullName && fullName.trim()) || phone;
  const created = await pool.query(
    'INSERT INTO users (full_name, phone, accepted_tos) VALUES ($1, $2, TRUE) RETURNING id',
    [name, phone]
  );
  return created.rows[0];
}

function uniqueVoucherCode(): string {
  // Base32-ish (no 0,1,O,I) so codes are easy to read out loud
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(8);
  let code = 'CT-';
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

interface LegacyMintContext {
  duration_min: number;
  data_limit_gb: number | null;
  is_uncapped: boolean;
  bandwidth_mbps_up: number;
  bandwidth_mbps_down: number;
  amount: number | string;
  tier_name: string;
  max_devices: number | null;
}

// Legacy local voucher mint, used only while Ruijie Cloud is not configured.
// Retries on the rare unique-code collision via savepoints so an aborted insert
// does not poison the transaction.
async function mintLegacyVoucher(client: PoolClient, pay: LegacyMintContext): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await client.query('SAVEPOINT mint_voucher');
      const voucher = await client.query(
        `INSERT INTO vouchers
          (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped,
           bandwidth_mbps_up, bandwidth_mbps_down, sold_by, price_amount, package_tier, max_devices)
         VALUES ($1, $2, 1, NULL, $3, $4, $5, $6, NULL, $7, $8, $9)
         RETURNING id, code`,
        [
          uniqueVoucherCode(),
          pay.duration_min,
          pay.data_limit_gb,
          pay.is_uncapped,
          pay.bandwidth_mbps_up,
          pay.bandwidth_mbps_down,
          pay.amount,
          pay.tier_name,
          pay.max_devices,
        ]
      );
      const code = voucher.rows[0].code;
      await client.query('RELEASE SAVEPOINT mint_voucher');
      return code;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT mint_voucher');
      if ((err as Error).message?.includes('duplicate key')) continue;
      throw err;
    }
  }
  throw new Error('Could not generate a unique voucher code');
}

type SaleOwner = { id: string; fullName: string };

// Online sales belong to the CEO. The name is stored on the transaction at
// initiation (before the gateway confirms) so the admin console never shows an
// anonymous "Online" seller, even while a payment is still pending.
const DEFAULT_ONLINE_SALE_OWNER_NAME = 'Prechard Muvirimi';

// A sale must always be attributable to a person, exactly like a staff-created
// voucher is. Portal/gateway payments belong to the CEO by default; the
// ONLINE_SALE_OWNER_ID override lets ops reassign them without a redeploy.
async function resolveOnlineSaleOwner(client: PoolClient): Promise<SaleOwner | null> {
  const override = process.env.ONLINE_SALE_OWNER_ID;
  if (override) {
    const hit = await client.query(
      `SELECT id, full_name FROM admin_users WHERE id = $1 AND status = 'active'`,
      [override]
    );
    if (hit.rows.length > 0) return { id: hit.rows[0].id, fullName: hit.rows[0].full_name };
  }
  const owner = await client.query(
    `SELECT id, full_name FROM admin_users
     WHERE status = 'active' AND role = 'CEO'
     ORDER BY created_at ASC LIMIT 1`
  );
  return owner.rows.length > 0
    ? { id: owner.rows[0].id, fullName: owner.rows[0].full_name }
    : null;
}

// The admin voucher form and the sales list share one fixed set of methods.
// Gateways return their own labels ('EcoCash (Pesepay)'), which would otherwise
// land next to 'Cash' as an option the UI cannot render.
// Order matters: 'ecocash' contains 'cash', so EcoCash must be tested first.
function normalizeSaleMethod(raw?: string | null): string {
  const value = (raw || '').trim();
  if (!value) return 'Cash';
  const lower = value.toLowerCase();
  if (lower.includes('ecocash')) return 'EcoCash';
  if (lower.includes('onemoney') || lower.includes('one money')) return 'OneMoney';
  if (lower.includes('omari')) return 'Omari';
  if (lower.includes('innbucks') || lower.includes('inn bucks')) return 'InnBucks';
  if (lower.includes('cash')) return 'Cash';
  return value;
}

const NOTIFICATION_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Recipients for the online-payment advice. ONLINE_PAYMENT_RECIPIENTS wins
 * when set; otherwise every approved CEO/Manager gets a copy. Falls back to
 * admin@preyone.com so a production with no management account still alerts
 * someone instead of silently dropping the payment advice.
 */
async function onlinePaymentRecipients(): Promise<string[]> {
  const out = new Set<string>();
  const configured = (process.env.ONLINE_PAYMENT_RECIPIENTS || '')
    .split(/[,;]/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => NOTIFICATION_EMAIL_RE.test(email));

  for (const email of configured) out.add(email);

  if (configured.length === 0) {
    try {
      const result = await pool.query(
        `SELECT email FROM admin_users
          WHERE role IN ('CEO', 'Manager') AND approved = TRUE
            AND deleted_at IS NULL AND email IS NOT NULL`
      );
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      for (const row of rows) {
        const email = String(row.email || '').trim().toLowerCase();
        if (NOTIFICATION_EMAIL_RE.test(email)) out.add(email);
      }
    } catch (err) {
      console.error('Online payment recipient lookup failed:', err);
    }
  }

  if (out.size === 0) out.add('admin@preyone.com');
  return [...out];
}

async function notifyOnlinePayment(data: OnlinePaymentEmailData): Promise<void> {
  const recipients = await onlinePaymentRecipients();
  await sendOnlinePaymentReceiptEmail(recipients, data);
}

async function recordVoucherPoolFallback(
  paymentId: string,
  pay: any,
  voucherCode: string,
  mintError: unknown
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO alerts (type, severity, title, message, target_type, target_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'ruijie_mint_fallback',
        'warning',
        'Local fallback voucher issued',
        `Payment ${paymentId} (${pay.tier_name}) completed with local voucher ${voucherCode}. ` +
          `The stock pool was empty and the 3s Ruijie direct mint failed: ${(mintError as Error)?.message ?? String(mintError)}`,
        'payment',
        String(paymentId),
      ]
    );
  } catch (err) {
    console.error('Failed to record local voucher fallback alert', err);
  }
}

// Complete a payment: claim or mint a voucher, close the payment, record the
// transaction and sale. Returns the voucher code on success.
//
// The payment row is locked (SELECT ... FOR UPDATE) before claiming stock or
// minting, so concurrent webhook/status callbacks for the same payment
// serialize: the second caller re-reads status === 'completed' and returns the
// existing code instead of claiming or minting a second voucher.
async function completePayment(paymentId: string): Promise<string> {
  // Idempotency: if already completed, return existing code without re-minting.
  const existing = await pool.query(
    "SELECT status, voucher_code FROM payments WHERE id = $1",
    [paymentId]
  );
  if (existing.rows.length === 0) throw new Error('Payment not found');
  if (existing.rows[0].status === 'completed' && existing.rows[0].voucher_code) {
    return existing.rows[0].voucher_code;
  }

  // Circuit breaker variables
  let code: string = '';
  let voucherAlreadyMinted = false;
  let voucherExpiry: string | number | null = null;
  let ruijieSource: { ruijie_expiry: number | null; user_group_id: string; profile_uuid: string; comment: string } | null = null;
  let poolFallbackError: unknown = null;

  // Circuit breaker: check if a Ruijie voucher was already minted for this payment
  // (prevents duplicate mints if a previous attempt failed at the DB recording step)
  const mintedCheck = await pool.query(
    `SELECT code_no, ruijie_expiry FROM ruijie_vouchers WHERE payment_id = $1 LIMIT 1`,
    [paymentId]
  );
  if (mintedCheck.rows.length > 0) {
    code = mintedCheck.rows[0].code_no;
    voucherExpiry = mintedCheck.rows[0].ruijie_expiry ?? null;
    voucherAlreadyMinted = true;
    console.warn(`[completePayment] Voucher ${code} already minted for payment ${paymentId}. Reusing.`);
  }

  // Fetch payment details (outside transaction)
  const paymentResult = await pool.query(
    `SELECT p.*, pk.tier_name, pk.display_name, pk.price_amount, pk.duration_min, pk.data_limit_gb,
            pk.is_uncapped, pk.bandwidth_mbps_up, pk.bandwidth_mbps_down, pk.max_devices,
            u.full_name AS customer_name, u.email AS customer_email
     FROM payments p
     JOIN packages pk ON pk.id = p.package_id
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.id = $1`,
    [paymentId]
  );
  if (paymentResult.rows.length === 0) {
    throw new Error('Payment not found');
  }
  const pay = paymentResult.rows[0];

  if (!VALID_TRANSITIONS[pay.status]?.includes('completed')) {
    throw new Error(`Payment cannot be completed from status '${pay.status}'`);
  }

  // Idempotency: already completed
  if (pay.status === 'completed' && pay.voucher_code) {
    return pay.voucher_code;
  }

  const ruijieConfigured = isRuijieCloudConfigured();
  const client = await pool.connect();

  if (voucherAlreadyMinted) {
    console.log(`[completePayment] Skipping mint - voucher already exists: ${code}`);
    ruijieSource = null;
  } else if (!ruijieConfigured) {
    // Legacy local mint (only when Ruijie Cloud is not configured)
    code = await mintLegacyVoucher(client, pay);
  }

  try {
    await client.query('BEGIN');

    // Re-check: another process may have completed while we were minting
    const recheck = await client.query(
      `SELECT status, voucher_code FROM payments WHERE id = $1 FOR UPDATE`,
      [paymentId]
    );
    if (recheck.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Payment not found');
    }
    if (recheck.rows[0].status === 'completed') {
      await client.query('COMMIT');
      if (recheck.rows[0].voucher_code) return recheck.rows[0].voucher_code;
      throw new Error('Payment already completed but no voucher code recorded');
    }

    if (ruijieConfigured && !voucherAlreadyMinted) {
      const claimed = await claimPooledVoucher(client, pay.tier_name, paymentId);
      if (claimed) {
        code = claimed.code_no;
        voucherExpiry = claimed.ruijie_expiry ?? null;
        console.log(`[completePayment] Claimed pooled voucher ${code} for payment ${paymentId}`);
      } else {
        try {
          const minted = await mintRuijieVoucherForTier(pay.tier_name, `Payment ${paymentId}`, {
            timeoutMs: 3000,
          });
          code = minted.codeNo;
          voucherExpiry = minted.expiryTime ?? null;
          ruijieSource = {
            ruijie_expiry: minted.expiryTime ?? null,
            user_group_id: minted.userGroupId,
            profile_uuid: minted.profile,
            comment: minted.comment,
          };
        } catch (err) {
          poolFallbackError = err;
          console.error(
            `[completePayment] Ruijie stock exhausted and direct mint failed for ${paymentId}; issuing local fallback`,
            err
          );
          code = await mintLegacyVoucher(client, pay);
        }
      }
    }

    // Record the Ruijie issuance for audit/reconciliation
    if (ruijieSource) {
      await client.query(
        `INSERT INTO ruijie_vouchers
          (code_no, tier_name, user_group_id, profile_uuid, ruijie_expiry, payment_id, source, comment)
         VALUES ($1, $2, $3, $4, $5, $6, 'online', $7)
         ON CONFLICT (code_no) DO NOTHING`,
        [code, pay.tier_name, ruijieSource.user_group_id, ruijieSource.profile_uuid, ruijieSource.ruijie_expiry, paymentId, ruijieSource.comment]
      );
    }

    // RETURNING: `pay` was read before this UPDATE, so its completed_at is still
    // NULL â€” the voucher and sale rows must carry the real completion time, not
    // a stale one, or the sale lands on the wrong day in the revenue report.
    const { rows: completedRows } = await client.query(
      `UPDATE payments
       SET status = 'completed', completed_at = NOW(), voucher_code = $2, error_message = NULL
       WHERE id = $1
       RETURNING completed_at`,
      [paymentId, code]
    );
    const completedAt: Date = completedRows[0]?.completed_at ?? new Date();

    // Update the existing pending transaction to completed (created at initiation).
    await client.query(
      `UPDATE transactions
       SET status = 'completed', voucher_code = $2, completed_at = NOW()
       WHERE payment_id = $1`,
      [paymentId, code]
    );

    // â”€â”€ Account for the sale â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // The Ruijie Cloud path mints the code remotely and never created a local
    // `vouchers` row, so a paid voucher was invisible to the admin voucher list
    // and no `sales` row was ever written â€” the customer paid and nobody could
    // see it. Both writes happen here, inside this transaction, so a completed
    // payment is always attributed to a seller.
    const owner = await resolveOnlineSaleOwner(client);

    await client.query(
      `INSERT INTO vouchers
         (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped,
          bandwidth_mbps_up, bandwidth_mbps_down, sold_by, price_amount, package_tier,
          max_devices, created_at)
       SELECT $1, $2, 1, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11
       WHERE NOT EXISTS (SELECT 1 FROM vouchers WHERE code = $1)`,
      [
        code,
        pay.duration_min,
        pay.data_limit_gb,
        pay.is_uncapped,
        pay.bandwidth_mbps_up,
        pay.bandwidth_mbps_down,
        owner?.id ?? null,
        pay.amount,
        pay.tier_name,
        pay.max_devices,
        completedAt,
      ]
    );

    // The legacy local mint already inserted the row with sold_by NULL; the
    // statement above skips it, so attribute it here instead.
    if (owner?.id) {
      await client.query(
        `UPDATE vouchers SET sold_by = $2
         WHERE code = $1 AND sold_by IS NULL`,
        [code, owner.id]
      );
    }

    const saleInsert = await client.query(
      `INSERT INTO sales
         (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency,
          payment_method, payment_reference, sold_at)
       SELECT v.id, v.code, $2::uuid, $3, $4, $5, $6, $7, $8
       FROM vouchers v
       WHERE v.code = $1
         AND NOT EXISTS (SELECT 1 FROM sales WHERE voucher_code = $1)
       RETURNING id, sold_at`,
      [
        code,
        owner?.id ?? null,
        owner?.fullName ?? DEFAULT_ONLINE_SALE_OWNER_NAME,
        pay.amount,
        pay.currency || 'USD',
        normalizeSaleMethod(pay.payment_method),
        pay.pesepay_reference || null,
        completedAt,
      ]
    );
    const saleRow = saleInsert?.rows?.[0] ?? null;

    await client.query('COMMIT');

    void notifyOnlinePayment({
      paymentId,
      merchantReference: pay.merchant_reference || null,
      gatewayReference: pay.pesepay_reference || null,
      gateway: 'Pesepay',
      channel: 'Preyone WiFi Portal (wifi.preyone.com)',
      paymentMethod: pay.payment_method || 'Online payment',
      status: 'completed',
      amount: pay.amount,
      currency: pay.currency || 'USD',
      initiatedAt: pay.created_at || null,
      completedAt,
      customerName: pay.customer_name || null,
      customerPhone: pay.phone_number || null,
      customerEmail: pay.customer_email || null,
      clientMac: pay.client_mac || null,
      packageTier: pay.tier_name,
      packageName: pay.display_name || null,
      durationMin: pay.duration_min,
      dataLimitGb: pay.data_limit_gb,
      isUncapped: pay.is_uncapped,
      bandwidthUpMbps: pay.bandwidth_mbps_up,
      bandwidthDownMbps: pay.bandwidth_mbps_down,
      maxDevices: pay.max_devices,
      voucherCode: code,
      voucherExpiry,
      saleId: saleRow?.id ?? null,
      soldByName: owner?.fullName ?? DEFAULT_ONLINE_SALE_OWNER_NAME,
      saleType: 'new',
      taxAmount: null,
      gatewayFee: null,
    }).catch((err) => console.error(`[payment-email] Payment ${paymentId} advice failed`, err));

    if (poolFallbackError) {
      void recordVoucherPoolFallback(paymentId, pay, code, poolFallbackError);
    }
    if (ruijieConfigured) {
      void refillVoucherPool().catch((err) => console.error('[voucher-pool] post-sale refill failed', err));
    }
    return code;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failure â€” original error is what matters.
    }
    // If minting succeeded but DB recording failed, log a critical alert
    // because a Ruijie voucher was minted but not recorded locally.
    if (ruijieSource && code) {
      console.error(`[completePayment] DB recording failed after minting voucher ${code} for payment ${paymentId}. Voucher may be orphaned.`);
      try {
        await pool.query(
          `INSERT INTO alerts (type, severity, title, message, target_type, target_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          ['orphaned_voucher', 'critical', 'Voucher minted but not recorded',
           `Payment ${paymentId} minted Ruijie voucher ${code} but DB recording failed. Voucher exists on Ruijie Cloud but not linked locally. Error: ${(err as Error)?.message}`,
           'payment', String(paymentId)]
        );
      } catch { /* best-effort */ }
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /api/payments/initiate
 *
 * Accepts the standardized portal payload:
 *   { payment_rail, account_identifier, client_name, client_phone, amount, package_id }
 *
 * The gateway call is queued and the HTTP response is returned immediately with
 * a transaction_id. The portal polls /status while Pesepay processes the charge.
 */
type CustomerPaymentRail = 'ecocash' | 'innbucks' | 'omari';

const CUSTOMER_RAIL_ALIASES: Record<string, { rail: CustomerPaymentRail; currency?: PesepayCurrency }> = {
  ecocash: { rail: 'ecocash' },
  ecocash_usd: { rail: 'ecocash', currency: 'USD' },
  innbucks: { rail: 'innbucks' },
  innbucks_usd: { rail: 'innbucks', currency: 'USD' },
  omari: { rail: 'omari' },
  omari_usd: { rail: 'omari', currency: 'USD' },
};

function resolveCustomerRail(raw: unknown): { rail: CustomerPaymentRail; currency?: PesepayCurrency } | null {
  const key = String(raw ?? 'ecocash').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CUSTOMER_RAIL_ALIASES[key] ?? null;
}

async function failPaymentInitiation(paymentId: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE payments SET status = 'failed', error_message = $2 WHERE id = $1 AND status = 'pending'`,
    [paymentId, message]
  );
  await pool.query(
    `UPDATE transactions SET status = 'failed' WHERE payment_id = $1 AND status = 'pending'`,
    [paymentId]
  );
}

interface QueuedPaymentInitiation {
  paymentId: string;
  rail: CustomerPaymentRail;
  amount: number;
  currency: PesepayCurrency;
  phone: string;
  fullName: string;
  merchantReference: string;
  tierName: string;
  returnUrl: string;
}

interface PaymentInitiationOutcome {
  success: boolean;
  referenceNumber?: string;
  authorizationCode?: string;
  pollUrl?: string;
  instructions?: string;
  status?: string;
  error?: string;
}

async function runPaymentInitiation(job: QueuedPaymentInitiation): Promise<PaymentInitiationOutcome> {
  try {
    const result = await initiatePesepayPayment({
      amount: job.amount,
      currencyCode: job.currency,
      phone: job.phone,
      fullName: job.fullName,
      email: '',
      paymentMethod: job.rail,
      reference: job.merchantReference,
      reasonForPayment: `${job.tierName} - pre-paid internet access`,
      returnUrl: job.returnUrl,
    });

    // The authorization rails only need a reference to continue; a poll URL is
    // useful but not mandatory for them. EcoCash keeps the original contract.
    const needsPollUrl = job.rail === 'ecocash';
    const hasEnoughToContinue =
      Boolean(result.pollUrl) || (Boolean(result.referenceNumber) && job.rail !== 'ecocash');
    if (!result.success || (needsPollUrl && !result.pollUrl) || !hasEnoughToContinue) {
      const message = result.error || 'Pesepay did not return a payment page';
      if (result.detail) {
        console.error(`Payment ${job.paymentId} initiation transport failure: ${result.detail}`);
      }
      await failPaymentInitiation(job.paymentId, message);
      return { success: false, error: message };
    }

    if (job.rail === 'omari' && !result.referenceNumber) {
      const message = 'Pesepay did not return an O\'mari authorization reference.';
      await failPaymentInitiation(job.paymentId, message);
      return { success: false, error: message };
    }

    await pool.query(
      `UPDATE payments
          SET pesepay_reference = $2, pesepay_poll_url = $3, error_message = NULL
        WHERE id = $1`,
      [job.paymentId, result.referenceNumber ?? null, result.pollUrl]
    );

    return {
      success: true,
      referenceNumber: result.referenceNumber,
      authorizationCode: result.authorizationCode,
      pollUrl: result.pollUrl,
      instructions: result.instructions,
      status: result.status,
    };
  } catch (err) {
    const message = (err as Error).message || 'Payment provider request failed';
    console.error(`Payment ${job.paymentId} initiation failed`, err);
    try {
      await failPaymentInitiation(job.paymentId, message);
    } catch (updateErr) {
      console.error(`Payment ${job.paymentId} failed to record initiation failure`, updateErr);
    }
    return { success: false, error: message };
  }
}

async function processQueuedPaymentInitiation(job: QueuedPaymentInitiation): Promise<void> {
  const outcome = await runPaymentInitiation(job);
  if (!outcome.success) {
    console.error(`Payment ${job.paymentId} queued initiation failed: ${outcome.error || 'unknown error'}`);
  }
}

paymentsRouter.post('/initiate', async (req: Request, res: Response) => {
  const packageRef = String(req.body?.package_id || req.body?.tier || '').trim();
  const rawPhone = req.body?.account_identifier || req.body?.client_phone || req.body?.phone;
  const fullName = req.body?.client_name || req.body?.fullName;
  const macAddress = req.body?.macAddress ?? null;
  const railConfig = resolveCustomerRail(req.body?.payment_rail || req.body?.paymentMethod);

  if (!isPesepayConfigured()) {
    res.status(422).json({
      error: 'Online payments are not configured yet. Please buy your voucher at the Preyone shop.',
    });
    return;
  }

  if (!railConfig) {
    res.status(422).json({ error: 'Unsupported payment method.' });
    return;
  }
  const paymentMethod = railConfig.rail;

  const normalizedPhone = normalizeZwPhone(rawPhone);
  const requiresPhone = paymentMethod === 'ecocash' || paymentMethod === 'omari';
  if (requiresPhone && !isValidZwPhone(normalizedPhone)) {
    res.status(422).json({ error: 'Please enter a valid Zimbabwe phone number (e.g. 0771 327 202).' });
    return;
  }

  const pkgResult = await pool.query(
    `SELECT id, tier_name, price_amount, price_currency, duration_min, data_limit_gb,
            is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, max_devices
     FROM packages
     WHERE tier_name = $1 OR id::text = $1
     LIMIT 1`,
    [packageRef]
  );
  if (pkgResult.rows.length === 0) {
    res.status(422).json({ error: 'Unknown package tier.' });
    return;
  }
  const pkg = pkgResult.rows[0];

  // CEO-exclusive promo tiers are never sold through the public checkout.
  if (isCeoExclusiveTier(pkg.tier_name)) {
    res.status(403).json({ error: 'This package is not available for online purchase.' });
    return;
  }

  // Ruijie Cloud is the single source of internet access: a package with no
  // active profile mapping must NOT be chargeable, or the customer pays and
  // can never be given a usable code. Reject before any Pesepay charge.
  if (isRuijieCloudConfigured()) {
    const profile = await findRuijieProfile(pkg.tier_name);
    if (!profile) {
      res.status(502).json({
        error: `Package '${pkg.tier_name}' is not currently available online (no Ruijie Cloud profile mapping). Please buy at the Preyone shop.`,
      });
      return;
    }
  }

  const requestCurrency = normalizeGatewayCurrency(req.body?.currency || pkg.price_currency || 'USD');
  if (!requestCurrency) {
    res.status(422).json({ error: 'Unsupported payment currency.' });
    return;
  }
  // The *_usd aliases are explicit: they must stay USD even if the package row
  // carries a different settlement currency.
  const resolvedCurrency = railConfig.currency ?? requestCurrency;

  const user = await getOrCreateUserByPhone(normalizedPhone, fullName);
  // Sub-dollar tiers (0.99 PreLite) are billed as a flat 1.00: EcoCash settles in
  // whole dollars. The payments row stores the SAME value sent to Pesepay so the
  // webhook's amount-match check compares against the actual charge.
  const amount = normalizePaymentAmount(Number(pkg.price_amount));

  // Pesepay has no signed-callback scheme of its own on this integration, so we
  // mint a per-payment token and append it to resultUrl. Pesepay echoes resultUrl
  // back on the callback, which proves the callback belongs to a payment we made.
  const webhookToken = randomBytes(32).toString('hex');

  // merchant_reference is the value we hand Pesepay and the value it returns in
  // the decrypted callback, so it must be set BEFORE the acquire call.
  const merchantReference = `PREY-${randomBytes(8).toString('hex').toUpperCase()}`;

  const paymentInsert = await pool.query(
    `INSERT INTO payments
      (user_id, package_id, phone_number, amount, currency, payment_method,
       merchant_reference, client_mac, webhook_token, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     RETURNING id`,
    [
      user.id,
      pkg.id,
      normalizedPhone,
      amount,
      resolvedCurrency,
      paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1) + ' (Pesepay)',
      merchantReference,
      macAddress,
      webhookToken,
    ]
  );
  const paymentId = paymentInsert.rows[0].id;

  // Record the transaction immediately (status: pending) so every payment
  // attempt is visible in the admin console, even if completion fails.
  await pool.query(
    `INSERT INTO transactions
      (payment_id, user_id, package_tier, amount, currency, payment_method, status, sold_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [paymentId, user.id, pkg.tier_name, amount, resolvedCurrency, paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1) + ' (Pesepay)', DEFAULT_ONLINE_SALE_OWNER_NAME]
  );

  const baseUrl = (process.env.BASE_URL || 'https://wifi.preyone.com').replace(/\/$/, '');
  const returnUrl = `${baseUrl}/api/payments/return?ref=${encodeURIComponent(merchantReference)}`;
  const statusToken = jwt.sign(
    { paymentId, type: 'status' },
    getJwtSecret(),
    { algorithm: 'HS256', expiresIn: '2h' }
  );

  const initiationJob: QueuedPaymentInitiation = {
    paymentId,
    rail: paymentMethod,
    amount,
    currency: resolvedCurrency,
    phone: normalizedPhone,
    fullName: fullName || 'GUEST',
    merchantReference,
    tierName: pkg.tier_name,
    returnUrl,
  };

  // EcoCash keeps the original async contract: the USSD push runs in the
  // background and the portal polls /status. InnBucks and O'mari have a second
  // customer step (authorization code / OTP), so their gateway reference must
  // be known BEFORE the response is sent.
  if (paymentMethod === 'ecocash') {
    setImmediate(() => {
      void processQueuedPaymentInitiation(initiationJob);
    });

    res.status(200).json({
      success: true,
      transaction_id: paymentId,
      paymentId,
      reference: merchantReference,
      referenceNumber: null,
      authorizationCode: null,
      pollUrl: null,
      instructions: null,
      requires_pin: false,
      status: 'pending',
      statusToken,
      amount,
      phone: normalizedPhone,
      rail: paymentMethod,
      currency: resolvedCurrency,
      message: 'Payment request queued. Approve the prompt on your phone to complete the payment.',
    });
    return;
  }

  const outcome = await runPaymentInitiation(initiationJob);
  if (!outcome.success) {
    res.status(502).json({
      success: false,
      transaction_id: paymentId,
      paymentId,
      status: 'failed',
      error: outcome.error || 'We could not start that payment. Please try again.',
    });
    return;
  }

  res.status(200).json({
    success: true,
    transaction_id: paymentId,
    paymentId,
    reference: merchantReference,
    referenceNumber: outcome.referenceNumber ?? null,
    authorizationCode: outcome.authorizationCode ?? null,
    pollUrl: outcome.pollUrl ?? null,
    instructions: outcome.instructions ?? null,
    requires_pin: paymentMethod === 'omari',
    status: 'pending',
    statusToken,
    amount,
    phone: normalizedPhone,
    rail: paymentMethod,
    currency: resolvedCurrency,
    message:
      paymentMethod === 'omari'
        ? "We sent an authorization PIN to your phone. Enter it below to complete the payment."
        : 'Payment request created. Enter the authorization code in your InnBucks app.',
  });
});

/**
 * POST /api/payments/authorize
 *
 * Second leg of the O'mari flow. The initiate call has already sent the OTP to
 * the payer, and returned a signed status token plus Pesepay's referenceNumber.
 * This endpoint spends that OTP, then the portal polls /status so the normal
 * webhook/reconciliation path mints the voucher exactly once.
 */
const paymentAuthorizeLimiter = rateLimit({
  windowMs: 60_000,
  max: 12,
  message: { error: 'Too many authorization attempts, please wait a moment.' },
});

paymentsRouter.post('/authorize', paymentAuthorizeLimiter, async (req: Request, res: Response) => {
  const paymentId = String(req.body?.transaction_id || req.body?.paymentId || '').trim();
  const pin = String(req.body?.pin || req.body?.otp || '').trim();
  const queryToken = req.query.token as string | undefined;
  const bodyToken = req.body?.token as string | undefined;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = bearerToken || bodyToken || queryToken;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!paymentId) {
    res.status(422).json({ error: 'Payment id is required' });
    return;
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  if (decoded.paymentId !== paymentId) {
    res.status(403).json({ error: 'Token does not match this payment' });
    return;
  }

  if (!/^\d{4,8}$/.test(pin)) {
    res.status(422).json({ error: 'Enter the numeric authorization PIN sent to your phone.' });
    return;
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, status, voucher_code, payment_method, pesepay_reference
       FROM payments
       WHERE id::text = $1`,
      [paymentId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    const pay = rows[0];
    if (pay.status === 'completed' && pay.voucher_code) {
      res.status(200).json({
        success: true,
        status: 'completed',
        voucherCode: pay.voucher_code,
      });
      return;
    }
    if (pay.status !== 'pending') {
      res.status(409).json({ error: 'This payment can no longer be authorized.' });
      return;
    }
    if (!String(pay.payment_method || '').toLowerCase().includes('omari')) {
      res.status(422).json({ error: 'This payment method does not use an authorization PIN.' });
      return;
    }
    if (!pay.pesepay_reference) {
      res.status(409).json({ error: 'The payment reference is not ready yet. Please try again.' });
      return;
    }

    const auth = await authorizeOmariPayment(String(pay.pesepay_reference), pin);
    if (!auth.success) {
      const message = auth.error || 'The authorization PIN was not accepted. Please try again.';
      if (auth.detail) console.error(`Payment ${paymentId} O'mari authorization detail: ${auth.detail}`);
      await failPaymentInitiation(paymentId, message);
      res.status(422).json({ success: false, status: 'failed', error: message });
      return;
    }

    res.status(200).json({
      success: true,
      status: 'processing',
      referenceNumber: auth.referenceNumber ?? pay.pesepay_reference,
      message: auth.message || 'Authorization accepted. Waiting for the payment to complete.',
    });
  } catch (err) {
    console.error('O\'mari authorization failed', err);
    res.status(500).json({ error: 'We could not authorize that payment. Please try again.' });
  }
});

/**
 * POST /api/payments/webhook â€” Pesepay server-to-server callback (resultUrl).
 *
 * Pesepay POSTs `{ payload: "<AES-CBC ciphertext>" }`. We decrypt it with
 * PESEPAY_ENCRYPTION_KEY, which is the authentication step: a payload that does
 * not decrypt cleanly was not produced by Pesepay holding our key, so it is
 * rejected before any payment row is touched.
 *
 * The decrypted body carries the merchantReference we generated at initiate,
 * which is the lookup key. A per-payment webhook token is ALSO required when
 * present, because Pesepay echoes resultUrl back â€” defence in depth so that
 * even a replayed, correctly-encrypted payload for an unrelated reference
 * cannot mint a voucher.
 */
paymentsRouter.post('/webhook', async (req: Request, res: Response) => {
  console.log('[webhook] Received Pesepay callback');
  const body: Record<string, any> = req.body || {};

  // Pesepay may post a bare query string on some configurations; accept both.
  const rawPayload: unknown =
    body?.payload ?? (typeof req.query.payload === 'string' ? req.query.payload : undefined);

  if (typeof rawPayload !== 'string' || !rawPayload.trim()) {
    res.status(400).json({ error: 'Missing payload' });
    return;
  }

  const encryptionKey = process.env.PESEPAY_ENCRYPTION_KEY || '';
  const decrypted = decryptResponse(rawPayload, encryptionKey);
  if (!decrypted || typeof decrypted !== 'object') {
    // Not decryptable => not from Pesepay. Never fall through to the DB here.
    res.status(400).json({ error: 'Invalid or undecryptable payload' });
    return;
  }

  const merchantRef =
    decrypted.merchantReference ?? decrypted.merchant_reference ?? decrypted.reference ?? null;
  if (!merchantRef) {
    res.status(400).json({ error: 'Missing merchant reference in payload' });
    return;
  }

  // The token is belt-and-braces: the AES payload already authenticates the
  // sender (only Pesepay and this server hold PESEPAY_ENCRYPTION_KEY). It is
  // enforced when present but NOT required, because if Pesepay ever strips the
  // query string off resultUrl, requiring it would 401 every genuine callback -
  // charging the customer and never minting a voucher. (See the 2026-09-22
  // incident.) Log when absent so we can see which behaviour Pesepay exhibits.
  const token = (req.query.token as string | undefined) ?? (body.token as string | undefined) ?? null;
  if (token !== null && !/^[a-f0-9]{64}$/i.test(String(token))) {
    res.status(401).json({ error: 'Malformed callback token.' });
    return;
  }
  if (token === null) {
    console.warn('Pesepay webhook arrived without a callback token; relying on payload decryption');
  }

  const { rows } = await pool.query(
    `SELECT p.id, p.status, p.voucher_code, p.amount, p.currency, p.phone_number, p.webhook_token
     FROM payments p
     WHERE p.merchant_reference = $1
     LIMIT 1`,
    [String(merchantRef)]
  );

  if (rows.length === 0) {
    res.status(404).json({ error: 'Unknown payment' });
    return;
  }

  const pay = rows[0];
  console.log(`[webhook] Found payment ${pay.id}, status: ${pay.status}, ref: ${merchantRef}`);

  // When Pesepay did echo the token, it must match this payment's own token.
  if (token !== null && String(pay.webhook_token) !== String(token)) {
    res.status(404).json({ error: 'Unknown payment' });
    return;
  }

  const parsed = parsePesepayStatus(
    decrypted.transactionStatus ?? decrypted.transaction_status ?? decrypted.status
  );

  // Guard against a tampered/replayed amount.
  const receivedAmount = decrypted.amount ?? decrypted.amountDetails?.amount ?? decrypted.transactionAmount;
  if (receivedAmount !== undefined && receivedAmount !== null && receivedAmount !== '') {
    const parsedAmount = Number(receivedAmount);
    if (!Number.isNaN(parsedAmount) && Math.abs(Number(pay.amount) - parsedAmount) > 0.01) {
      res.status(400).json({ error: 'Amount mismatch' });
      return;
    }
  }

  if (pay.status === 'completed' && pay.voucher_code) {
    res.json({ status: 'ok', state: 'completed' });
    return;
  }

  if (parsed.state === 'completed') {
    if (!VALID_TRANSITIONS[pay.status]?.includes('completed')) {
      res.json({ status: 'ok', state: pay.status });
      return;
    }
    try {
      const voucherCode = await completePayment(pay.id);
      console.log(`[webhook] Payment ${pay.id} completed with voucher ${voucherCode}`);
      res.json({ status: 'ok', voucherCode, state: 'completed' });
      return;
    } catch (err) {
      console.error('Pesepay webhook completion failed', err);
      res.status(500).json({ error: 'Failed to complete payment' });
      return;
    }
  }

  if (parsed.state === 'refunded') {
    if (!VALID_TRANSITIONS[pay.status]?.includes('refunded')) {
      res.json({ status: 'ok', state: pay.status });
      return;
    }
    await pool.query(
      `UPDATE payments SET status = 'refunded', error_message = $2 WHERE id = $1 AND status = $3`,
      [pay.id, `Payment ${parsed.label}`, pay.status]
    );
    await pool.query(
      `UPDATE transactions SET status = 'refunded' WHERE payment_id = $1 AND status = 'pending'`,
      [pay.id]
    );
    res.json({ status: 'ok', state: 'refunded' });
    return;
  }

  if (parsed.state === 'failed') {
    if (!VALID_TRANSITIONS[pay.status]?.includes('failed')) {
      res.json({ status: 'ok', state: pay.status });
      return;
    }
    await pool.query(
      `UPDATE payments SET status = 'failed', error_message = $2 WHERE id = $1 AND status = $3`,
      [pay.id, `Payment ${parsed.label}`, pay.status]
    );
    res.json({ status: 'ok', state: 'failed' });
    return;
  }

  // Still pending (AWAITING / PROCESSING) â€” acknowledge so Pesepay stops re-posting.
  res.json({ status: 'ok', state: 'pending' });
});

/**
 * GET /api/payments/return â€” the customer's browser comes back here from
 * Pesepay's hosted page once they have approved or abandoned the EcoCash push.
 *
 * The authoritative completion happens in the webhook above; this only forwards
 * the browser to the portal, which polls /status to display the voucher. The
 * status token is minted HERE rather than being placed in returnUrl, because
 * Pesepay appends its own query parameters to returnUrl and would corrupt it.
 */
paymentsRouter.get('/return', async (req: Request, res: Response) => {
  const ref = (req.query.ref as string | undefined) ?? null;
  if (!ref) {
    res.redirect('/?payment=invalid');
    return;
  }

  const { rows } = await pool.query(
    'SELECT id, status, pesepay_reference, amount FROM payments WHERE merchant_reference = $1 LIMIT 1',
    [String(ref)]
  );
  if (rows.length === 0) {
    res.redirect('/?payment=unknown');
    return;
  }

  const payment = rows[0];

  // Pesepay's result callback is NOT retried (documented), so a payment can be
  // genuinely settled while our webhook was never delivered - the customer is
  // charged and the voucher would never be minted. The customer arriving back
  // here is our reliable signal to reconcile against the gateway directly.
  //
  // Only pending payments are reconciled: completed/failed/refunded rows are
  // already terminal, and a second completion would risk a double mint.
  if (payment.status === 'pending' && payment.pesepay_reference) {
    const check = await verifyPaymentStatus(payment.pesepay_reference);
    const parsed = parsePesepayStatus(check.status);

    // check.found must gate the mint: a reference Pesepay does not recognise
    // must never produce a voucher, whatever status string came back with it.
    if (check.found && parsed.state === 'completed') {
      try {
        const voucherCode = await completePayment(payment.id);
        console.log(`Reconciled lost callback for payment ${payment.id} -> ${voucherCode}`);
      } catch (err) {
        // Never block the customer's return on a reconciliation failure: they
        // can still poll /status, and the webhook may still arrive.
        console.error('Reconciliation completion failed', err);
      }
    } else if (check.found && (parsed.state === 'failed' || parsed.state === 'refunded')) {
      await pool.query(
        `UPDATE payments SET status = $2, error_message = $3
         WHERE id = $1 AND status = 'pending'`,
        [payment.id, parsed.state, `Gateway reported ${parsed.label} (callback not received)`]
      );
    }
  }

  const token = jwt.sign(
    { paymentId: payment.id, type: 'status' },
    getJwtSecret(),
    { algorithm: 'HS256', expiresIn: '2h' }
  );
  res.redirect(`/?pay=${encodeURIComponent(payment.id)}&tok=${encodeURIComponent(token)}`);
});

/**
 * GET /api/payments/status?id=... (legacy: /status/:paymentId)
 *
 * Polling endpoint for the portal. Requires the signed status token returned by
 * /initiate. Reconciles pending payments against the gateway so the voucher can
 * self-mint even if the server-to-server webhook is delayed.
 */
async function handlePaymentStatus(
  req: Request,
  res: Response,
  paymentId: string,
  referenceNumber?: string
): Promise<void> {
  try {
    if (!paymentId && !referenceNumber) {
      res.status(422).json({ error: 'Payment id is required' });
      return;
    }

    // Require a signed status token or valid session JWT to prevent payment ID enumeration
    const authHeader = req.headers.authorization;
    const queryToken = req.query.token as string | undefined;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const token = bearerToken || queryToken;
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    if (paymentId && decoded.paymentId !== paymentId) {
      res.status(403).json({ error: 'Token does not match this payment' });
      return;
    }

    const { rows } = referenceNumber
      ? await pool.query(
          `SELECT p.id, p.status, p.amount, p.currency, p.completed_at, p.voucher_code, p.pesepay_reference,
                  p.error_message, pk.tier_name, pk.display_name AS package_name, pk.data_limit_gb,
                  pk.is_uncapped, pk.duration_min, pk.bandwidth_mbps_up, pk.bandwidth_mbps_down,
                  u.full_name AS client_name, COALESCE(p.phone_number, u.phone) AS client_phone
           FROM payments p
           JOIN packages pk ON pk.id = p.package_id
           JOIN users u ON u.id = p.user_id
           WHERE p.pesepay_reference = $1
           ORDER BY p.created_at DESC
           LIMIT 1`,
          [referenceNumber]
        )
      : await pool.query(
          `SELECT p.id, p.status, p.amount, p.currency, p.completed_at, p.voucher_code, p.pesepay_reference,
                  p.error_message, pk.tier_name, pk.display_name AS package_name, pk.data_limit_gb,
                  pk.is_uncapped, pk.duration_min, pk.bandwidth_mbps_up, pk.bandwidth_mbps_down,
                  u.full_name AS client_name, COALESCE(p.phone_number, u.phone) AS client_phone
           FROM payments p
           JOIN packages pk ON pk.id = p.package_id
           JOIN users u ON u.id = p.user_id
           WHERE p.id::text = $1`,
          [paymentId]
        );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // A reference lookup is still authorized by the token minted at initiate.
    if (decoded.paymentId !== rows[0].id) {
      res.status(403).json({ error: 'Token does not match this payment' });
      return;
    }
    const resolvedPaymentId = String(rows[0].id);

    // Seamless EcoCash has no hosted page, so the customer never hits /return.
    // If the webhook also stalls, /status is the only heartbeat left - reconcile
    // against the gateway here so the voucher self-mints while the portal polls.
    // Rate-gated so repeated 2s polls stay cheap for Pesepay.
    let pay = rows[0];
    if (pay.status === 'pending' && pay.pesepay_reference) {
      const now = Date.now();
      const nextAllowed = (lastReconcileAt.get(resolvedPaymentId) || 0) + RECONCILE_GAP_MS;
      if (now >= nextAllowed && !reconciling.has(resolvedPaymentId)) {
        reconciling.add(resolvedPaymentId);
        lastReconcileAt.set(resolvedPaymentId, now);
        try {
          const check = await verifyPaymentStatus(pay.pesepay_reference);
          const parsed = parsePesepayStatus(check.status);
          if (check.found && parsed.state === 'completed') {
            try {
              const voucherCode = await completePayment(resolvedPaymentId);
              console.log(`Reconciled payment ${resolvedPaymentId} on status poll -> ${voucherCode}`);
            } catch (err) {
              // A concurrent webhook may have just completed it; re-read below.
              console.error('Status poll completion failed', err);
            }
          } else if (check.found && (parsed.state === 'failed' || parsed.state === 'refunded')) {
            await pool.query(
              `UPDATE payments SET status = $2, error_message = $3
               WHERE id = $1 AND status = 'pending'`,
              [resolvedPaymentId, parsed.state, `Gateway reported ${parsed.label} (status check)`]
            );
            await pool.query(
              `UPDATE transactions SET status = $2
               WHERE payment_id = $1 AND status = 'pending'`,
              [resolvedPaymentId, parsed.state]
            );
          }
        } catch (err) {
          console.error('Status poll reconciliation failed', err);
        } finally {
          reconciling.delete(resolvedPaymentId);
        }
      }
      const fresh = await pool.query(
        'SELECT status, completed_at, voucher_code, error_message FROM payments WHERE id::text = $1',
        [resolvedPaymentId]
      );
      if (fresh.rows.length > 0) pay = { ...pay, ...fresh.rows[0] };
    }

    res.json({
      transaction_id: pay.id,
      paymentId: pay.id,
      status: pay.status,
      amount: pay.amount,
      completedAt: pay.completed_at,
      voucherCode: pay.voucher_code ?? null,
      // Lets the portal re-open the correct package modal after the customer
      // returns from Pesepay's hosted page.
      tier: pay.tier_name,
      packageName: pay.package_name ?? pay.tier_name ?? null,
      dataLimitGb: pay.data_limit_gb != null ? Number(pay.data_limit_gb) : null,
      isUncapped: Boolean(pay.is_uncapped),
      durationMin: pay.duration_min != null ? Number(pay.duration_min) : null,
      bandwidthMbpsUp: pay.bandwidth_mbps_up != null ? Number(pay.bandwidth_mbps_up) : null,
      bandwidthMbpsDown: pay.bandwidth_mbps_down != null ? Number(pay.bandwidth_mbps_down) : null,
      clientName: pay.client_name ?? null,
      clientPhone: pay.client_phone ?? null,
      currency: pay.currency ?? null,
      // The customer has paid but Ruijie could not issue a code yet. The portal
      // swaps its waiting copy for a "still working on it" panel and keeps
      // polling, because a later poll may reconcile successfully.
      supportRequired: String(pay.error_message || '').startsWith('ruijie_mint_pending: '),
      // Shown to the customer as proof of purchase in support conversations.
      reference: pay.pesepay_reference ?? null,
      referenceNumber: pay.pesepay_reference ?? null,
    });
  } catch (err) {
    console.error('Status lookup failed', err);
    res.status(500).json({ error: 'Status lookup failed' });
  }
}

// Query-string form is the documented portal contract: /status?id=<paymentId>
paymentsRouter.get('/status', (req: Request, res: Response) => {
  const id = String(req.query.id || req.query.paymentId || '').trim();
  const reference = String(req.query.referenceNumber || req.query.reference || '').trim();
  void handlePaymentStatus(req, res, id, reference || undefined);
});

// Kept for older clients and the ?pay=&tok= return flow.
paymentsRouter.get('/status/:paymentId', (req: Request, res: Response) => {
  void handlePaymentStatus(req, res, String(req.params.paymentId || '').trim());
});

// ===========================================================================
// Multi-rail Pesepay gateway (invoices, POS shifts, company
// subscriptions). Reconciled in from the local branch; kept byte-identical
// apart from the imports it needs, which are merged into the block above.

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
  /** 'starlink' is written only by /pese/checkout (portal customers); the
   *  admin-initiated /pesepay/initiate validation list stays unchanged. */
  target_type: PesepayTargetType | 'starlink';
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

// Constant-time compare for the gateway callback's shared secret. Uses the
// named crypto import so the file has a single 'crypto' import.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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

paymentsRouter.post('/pesepay/initiate', requireAdminAuth, async (req: Request, res: Response) => {
  const body = req.body as PesepayInitiateRequest;

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'Invalid amount' });
    return;
  }

  if (!isPesepayCurrency(body.currencyCode)) {
    res.status(400).json({ error: 'currencyCode must be USD or ZiG' });
    return;
  }
  // Pesepay's own code is "ZiG"; callers may send "ZWG"/"ZWD".
  const currencyCode = normalizeGatewayCurrency(body.currencyCode) as PesepayCurrency;

  const reasonForPayment = typeof body.reasonForPayment === 'string' ? body.reasonForPayment.trim() : '';
  if (!reasonForPayment) {
    res.status(400).json({ error: 'reasonForPayment is required' });
    return;
  }

  // The tenant is NEVER taken from the request body. It is derived from the
  // authenticated account so a caller can only ever charge their own company.
  //
  // admin_users.company_id is nullable and historically points at
  // transit_companies rather than companies, so it is only honoured when it
  // actually resolves to a portal company; otherwise the singleton portal
  // company is used. That mirrors loadCompany()'s existing backward-compatible
  // fallback for unassigned accounts, and becomes strictly per-company the
  // moment company_id is linked to `companies`.
  const sessionCompanyId =
    // Portal realm: keyed by admin_users.portal_company_id. company_id is a
    // transit_companies FK and can never resolve against the companies table.
    (req.adminUser as { portalCompanyId?: string | null } | undefined)?.portalCompanyId ?? null;
  const { rows: companyRows } = await pool.query(
    sessionCompanyId
      ? 'SELECT id FROM companies WHERE id = $1'
      : 'SELECT id FROM companies ORDER BY created_at LIMIT 1',
    sessionCompanyId ? [sessionCompanyId] : []
  );
  let tenantId = companyRows[0]?.id ?? null;
  if (!tenantId) {
    // Session names a company that does not exist in the portal company table.
    const { rows: fallbackRows } = await pool.query(
      'SELECT id FROM companies ORDER BY created_at LIMIT 1'
    );
    tenantId = fallbackRows[0]?.id ?? null;
  }
  if (!tenantId) {
    res.status(403).json({ error: 'No company is configured for online payments' });
    return;
  }
  // A body tenant_id is accepted only when it agrees with the session, so a
  // cross-tenant request fails loudly instead of quietly charging someone else.
  const requestedTenantId = asUuid(body.tenant_id);
  if (requestedTenantId && requestedTenantId !== tenantId) {
    res.status(403).json({ error: 'tenant_id does not match the authenticated account' });
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

/**
 * Customer-facing status lookup for a Pesepay intent.
 *
 * This endpoint is deliberately PUBLIC -- the person paying is not logged in --
 * so it must never trust the path or query alone. Access requires an HS256
 * status token that is bound to this exact intent, and the row read is further
 * constrained to that intent id. Without both, an attacker could enumerate
 * intent ids and learn other customers' payment amounts and outcomes.
 */
const pesepayStatusLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { error: 'Too many status checks, please wait a moment' },
});

type PesepayPublicStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

// pesepay_intents.status is stored lowercase; the public contract is uppercase.
const PESEDPAY_PUBLIC_STATUS: Record<string, PesepayPublicStatus> = {
  pending: 'PENDING',
  completed: 'SUCCESS',
  failed: 'FAILED',
};

/**
 * Mints the status token handed to the customer for a given intent. Callers
 * embed it in the page URL; Pesepay appends its own query parameters to
 * returnUrl, so the token is never placed there.
 */
export function signPesepayStatusToken(intentId: string, reference?: string): string {
  return jwt.sign({ intentId, reference, type: 'pesepay-status' }, getJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: '2h',
  });
}

paymentsRouter.get('/pesepay/status/:intentId', pesepayStatusLimiter, async (req: Request, res: Response) => {
  const intentId = req.params.intentId;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = bearerToken || queryToken;

  if (!token) {
    res.status(401).json({ error: 'A status token is required' });
    return;
  }

  let decoded: { intentId?: string; reference?: string; type?: string };
  try {
    decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as typeof decoded;
  } catch {
    res.status(401).json({ error: 'Invalid or expired status token' });
    return;
  }

  // A legacy 'status' token must not be replayed here, and the token must be
  // bound to this exact intent -- otherwise any valid token would unlock every
  // intent in the system.
  if (decoded.type !== 'pesepay-status' || !decoded.intentId) {
    res.status(401).json({ error: 'Invalid status token' });
    return;
  }
  if (decoded.intentId !== intentId) {
    res.status(403).json({ error: 'Token does not match this payment' });
    return;
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, reference, provider_reference, amount, currency, status, created_at, completed_at
         FROM pesepay_intents
        WHERE id = $1`,
      [intentId]
    );
    if (rows.length === 0) {
      // Same response as a wrong token so the endpoint cannot be used to test
      // which intent ids exist.
      res.status(404).json({ error: 'Payment not found' });
      return;
    }
    const intent = rows[0];

    res.json({
      status: PESEDPAY_PUBLIC_STATUS[String(intent.status)] ?? 'PENDING',
      referenceNumber: intent.provider_reference || intent.reference,
      amount: Number(intent.amount),
      currency: intent.currency,
      createdAt: intent.created_at,
      completedAt: intent.completed_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Unable to read payment status' });
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
        intent.target_type === 'starlink'
          ? await applyStarlinkPayment(client, { target_id: intent.target_id, amount: Number(intent.amount), provider_reference: undefined }, reference)
          : intent.target_type === 'subscription'
          ? await applySubscriptionPayment(client, intent)
          : await applyDocumentPayment(client, intent, reference);

      await client.query(
        `UPDATE pesepay_intents
            SET status = 'completed', completed_at = NOW(), provider_reference = COALESCE($2, provider_reference)
          WHERE id = $1`,
        [intent.id, payload.referenceNumber || null]
      );

      // Keep the website checkout ledger in step with the document it settled.
      // applyDocumentPayment() credits pos_documents, but nothing else writes
      // site_invoices.status, so every paid website invoice would stay
      // 'pending' forever -- and the replay guard then hands a buyer the wrong
      // state for an invoice they have already paid. A partial settlement
      // deliberately leaves it 'pending': it is not yet paid in full.
      if (intent.target_type === 'invoice') {
        await client.query(
          `UPDATE site_invoices
              SET status = CASE WHEN $2 = 'paid' THEN 'success' ELSE status END,
                  updated_at = NOW()
            WHERE intent_id = $1`,
          [intent.id, String((applied as Record<string, unknown>).status ?? '')]
        );
      }

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

// â”€â”€ Subscription renewal webhook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/payments/pesepay/webhook
//
// Point the Pesepay dashboard webhook at this URL for PLAN RENEWALS
// (/pesepay/callback remains the browser resultUrl that settles invoices and
// shifts). Same authentication as the callback: the integration key in the
// authorization header, with an optional AES-CBC `payload` envelope.
//
// On SUCCESS it extends companies.subscription_expires_at by 30 days from
// the later of now / the current expiry (renewing early never loses the
// remaining days), sets subscription_status back to 'active' and clears both
// dunning flags so the 3-day warning and 1-day urgent notice re-arm for the
// next cycle. Idempotency rides on the payment intent: a replayed delivery
// finds the intent already 'completed' and applies nothing, so the same
// payment can never extend the subscription twice across /callback and here.
paymentsRouter.post('/pesepay/webhook', async (req: Request, res: Response) => {
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

    const transactionStatus = String(
      payload.transactionStatus || payload.transaction_status || payload.status || ''
    ).toUpperCase();

    if (transactionStatus !== 'SUCCESS') {
      res.status(200).json({
        success: true,
        referenceNumber: reference ?? null,
        status: transactionStatus || 'UNKNOWN',
        applied: false,
        message: 'Ignored non-success status',
      });
      return;
    }

    const candidates = [
      payload.merchantReference,
      payload.merchant_reference,
      payload.referenceNumber,
      payload.reference,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: intentRows } = await client.query(
        `SELECT id, reference, tenant_id, target_type, status, plan_tier
           FROM pesepay_intents
          WHERE reference = ANY($1::text[]) OR provider_reference = ANY($1::text[])
          FOR UPDATE`,
        [candidates]
      );
      const intent = intentRows[0] || null;

      if (intent && intent.status === 'completed') {
        await client.query('COMMIT');
        res.status(200).json({
          success: true,
          referenceNumber: reference ?? null,
          status: 'completed',
          applied: false,
          message: 'Already processed',
        });
        return;
      }

      if (intent && intent.target_type !== 'subscription') {
        await client.query('COMMIT');
        res.status(200).json({
          success: true,
          referenceNumber: reference ?? null,
          applied: false,
          message: 'Ignored non-subscription payment',
        });
        return;
      }

      const companyId =
        asUuid(payload.company_id) ||
        asUuid(payload.tenant_id) ||
        (intent ? intent.tenant_id : null);

      if (!companyId) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'Unable to resolve the subscription owner (no company reference)' });
        return;
      }

      // A tier purchased through /api/subscription/checkout (or initiate with
      // planTier) is applied here. The value is validated against the fixed
      // tier list and interpolated as a literal so the query parameters stay
      // exactly [companyId]; the companies.plan_type CHECK is a second guard.
      const purchasedTier =
        intent && typeof intent.plan_tier === 'string' && (PLAN_TIERS as readonly string[]).includes(intent.plan_tier)
          ? intent.plan_tier
          : null;

      const { rows: updated } = await client.query(
        `UPDATE companies
            SET subscription_expires_at = GREATEST(COALESCE(subscription_expires_at, NOW()), NOW()) + INTERVAL '30 days',
                subscription_status = 'active',
                reminder_3day_sent = FALSE,
                reminder_1day_sent = FALSE,
                ${purchasedTier ? `plan_type = '${purchasedTier}',` : ''}
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, plan_type, subscription_expires_at, subscription_status`,
        [companyId]
      );

      if (updated.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Company not found' });
        return;
      }

      if (intent) {
        await client.query(
          `UPDATE pesepay_intents
              SET status = 'completed',
                  completed_at = NOW(),
                  provider_reference = COALESCE($2, provider_reference)
            WHERE id = $1`,
          [intent.id, payload.referenceNumber || null]
        );
      }

      await client.query('COMMIT');

      const company = updated[0];
      res.json({
        success: true,
        referenceNumber: reference ?? null,
        status: 'completed',
        applied: true,
        company_id: company.id,
        plan_type: company.plan_type,
        subscription_status: company.subscription_status,
        subscription_expires_at: company.subscription_expires_at,
        extended_days: 30,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      const statusCode = err instanceof HttpError ? err.statusCode : 500;
      if (statusCode === 500) console.error('Pesepay subscription webhook error:', err);
      res.status(statusCode).json({ error: err instanceof Error ? err.message : 'Webhook processing failed' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Pesepay subscription webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ===========================================================================
// Starlink portal ï¿½ Pese checkout (POST /api/payments/pese/checkout)
//
// Serves the three portal actions: Wallet Top Up, Data Top Up and Kit
// Purchase. Authenticated with the starlink-customer JWT (never the admin
// session), so a subscriber can only ever charge their own account. Each
// checkout creates a starlink_invoices row (PENDING) plus a pesepay_intents
// row with target_type = 'starlink'; the existing /pesepay/callback webhook
// settles it (invoice -> PAID, wallet/kit credited) via applyStarlinkPayment.
// ===========================================================================

interface StarlinkCheckoutBody {
  kind: 'wallet_topup' | 'data_topup' | 'kit_purchase';
  amount: number;
  paymentMethod?: string;
  phone?: string;
  returnUrl?: string;
  kitId?: string;
  gb?: number;
  bundleName?: string;
  kitNumber?: string;
  nickname?: string;
}

const STARLINK_KINDS = ['wallet_topup', 'data_topup', 'kit_purchase'] as const;

/** Return URLs must stay inside the Preyone ecosystem (open-redirect guard). */
function safeStarlinkReturnUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    const allowed =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === 'starlink.preyone.com' ||
      host.endsWith('.preyone.com');
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

function starlinkDefaultReturnUrl(): string {
  const base = process.env.STARLINK_BASE_URL || process.env.BASE_URL || 'https://starlink.preyone.com';
  return `${base.replace(/\/$/, '')}/starlink/portal`;
}

paymentsRouter.post('/pese/checkout', requireStarlinkAuth, async (req: Request, res: Response) => {
  const customer = req.starlinkCustomer!;
  const body = req.body as StarlinkCheckoutBody;

  const kind = body.kind;
  if (!STARLINK_KINDS.includes(kind)) {
    res.status(400).json({ error: 'kind must be wallet_topup, data_topup or kit_purchase' });
    return;
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'Enter a valid amount' });
    return;
  }
  if (amount > 2000) {
    res.status(400).json({ error: 'Maximum checkout amount is $2,000.00' });
    return;
  }

  const paymentMethod: PesepayRail = body.paymentMethod ? (body.paymentMethod.toLowerCase() as PesepayRail) : 'ecocash';
  if (!isPesepayRail(paymentMethod)) {
    res.status(400).json({ error: 'Unsupported payment method' });
    return;
  }

  // EcoCash / Omari need the payer MSISDN; default to the account's own number.
  const phone = String(body.phone || customer.phone || '').trim();

  let description = '';
  let meta: Record<string, unknown> = {};

  if (kind === 'data_topup') {
    const kitId = String(body.kitId || '');
    const gb = Number(body.gb);
    if (!kitId || !Number.isFinite(gb) || gb <= 0) {
      res.status(400).json({ error: 'Select a kit and a data bundle' });
      return;
    }
    const kit = await getStarlinkKit(kitId, customer.id);
    if (!kit) { res.status(404).json({ error: 'Kit not found on your account' }); return; }
    meta = { kit_id: kit.id, kit_number: kit.kit_number, gb, bundle: body.bundleName || `${gb}GB` };
    description = `Monthly Starlink ${gb}GB Top-Up`;
  } else if (kind === 'kit_purchase') {
    const kitNumber = String(body.kitNumber || '').trim();
    const nickname = String(body.nickname || '').trim();
    meta = kitNumber ? { kit_number: kitNumber, nickname } : { nickname };
    description = kitNumber ? `Starlink Kit Purchase - ${kitNumber}` : 'Starlink Kit Purchase';
  } else {
    description = 'Starlink Wallet Top-Up';
  }

  const returnUrl = safeStarlinkReturnUrl(body.returnUrl) || starlinkDefaultReturnUrl();

  // Tenant: the portal company (same singleton rule as /pesepay/initiate) ï¿½
  // never taken from the request body.
  const { rows: companyRows } = await pool.query('SELECT id FROM companies ORDER BY created_at LIMIT 1');
  const tenantId = companyRows[0]?.id ?? null;
  if (!tenantId) {
    res.status(403).json({ error: 'Online payments are not configured' });
    return;
  }

  const reference = `PREYONE-${uuidv4().substring(0, 8).toUpperCase()}-${Date.now()}`;
  let intentId: string | null = null;
  let invoiceNumber = '';

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invoice = await createStarlinkInvoice({
        customerId: customer.id,
        amount,
        description,
        kind,
        meta,
        client,
      });
      invoiceNumber = invoice.invoice_number;
      const { rows } = await client.query(
        `INSERT INTO pesepay_intents
           (reference, tenant_id, amount, currency, payment_method, purpose, reason_for_payment,
            target_type, target_id)
         VALUES ($1,$2,$3,'USD',$4,$5,$6,'starlink',$7)
         RETURNING id`,
        [reference, tenantId, amount, paymentMethod, kind, description, invoice.id]
      );
      intentId = rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const pesepayResponse = await initiatePesepayPayment({
      amount,
      currencyCode: 'USD',
      paymentMethod,
      reasonForPayment: `${description} (${invoiceNumber})`,
      reference,
      phone,
      email: customer.email,
      fullName: customer.full_name,
      returnUrl,
    });

    if (!pesepayResponse.success) {
      await pool.query(`UPDATE pesepay_intents SET status = 'failed' WHERE reference = $1`, [reference]);
      await pool.query(`UPDATE starlink_invoices SET status = 'FAILED' WHERE invoice_number = $1`, [invoiceNumber]);
      res.status(400).json({ error: pesepayResponse.error || 'Failed to initiate payment', invoiceNumber });
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
      invoiceNumber,
      referenceNumber: reference,
      pesepayReference: pesepayResponse.referenceNumber || reference,
      intentId,
      statusToken: intentId ? signPesepayStatusToken(intentId, reference) : null,
      redirectUrl: pesepayResponse.redirectUrl,
      pollUrl: pesepayResponse.pollUrl,
      instructions: pesepayResponse.instructions,
      amount,
      currencyCode: 'USD',
      paymentMethod,
      kind,
    });
  } catch (error) {
    console.error('Starlink Pese checkout error:', error);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});
