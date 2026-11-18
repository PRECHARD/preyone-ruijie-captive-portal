import { Router, Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import type { PoolClient } from 'pg';
import { requireAdminAuth } from '../middleware/adminAuth';
import {
  initiateEcoCashPayment,
  initiatePesepayPayment,
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
import { RuijieApiError } from '../services/ruijieCloud';
import { isRuijieCloudConfigured, findRuijieProfile, mintRuijieVoucherForTier } from '../services/ruijieMint';
import { claimPooledVoucher } from '../services/voucherPool';
import { requireStarlinkAuth } from '../middleware/starlinkAuth';
import { createStarlinkInvoice, applyStarlinkPayment, getStarlinkKit } from '../db/starlink';
import { getStarlinkPlan } from '../plans/starlinkPlans';
import { syncSaleToLedgerAndStock } from '../db/accounting';
import { canonicalPlanId, syncPlanModules } from '../plans/entitlements';

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

// Marker written when WE closed a checkout on the payment window (never when the
// gateway itself reported a failure). A row carrying it may still be completed
// if the gateway later confirms the money: the customer was charged, so the
// voucher must be delivered even though the portal already showed a timeout.
const LOCAL_EXPIRY_PREFIX = 'Payment window expired';

function isLocallyExpired(pay: { status?: string | null; error_message?: string | null }): boolean {
  return pay.status === 'failed' && String(pay.error_message ?? '').startsWith(LOCAL_EXPIRY_PREFIX);
}

/** Gateway-confirmed success may complete a pending row, or one we expired locally. */
function canComplete(pay: { status?: string | null; error_message?: string | null }): boolean {
  return VALID_TRANSITIONS[String(pay.status)]?.includes('completed') || isLocallyExpired(pay);
}

export const paymentsRouter = Router();

// Throttle gateway reconciliation per payment while the portal polls /status:
// the seamless flow has no hosted-page return, so /status is the only heartbeat.
// Keeps a minimum 10s gap between check-payment calls for the same payment and
// lets only one in-flight at a time (reset on process restart is harmless).
const RECONCILE_GAP_MS = 10_000;
// A checkout must never remain pending forever when the customer's mobile-money
// line never delivers the approval prompt (observed live 2026-11-17: EcoCash
// prompt never arrived, gateway reported FAILED, our row stayed pending). After
// this window the payment is closed locally after one final gateway check, so
// the portal stops spinning and reporting stops showing phantom pending sales.
const PAYMENT_EXPIRY_MIN = Math.max(3, Number(process.env.PAYMENT_EXPIRY_MIN ?? 10));
const lastReconcileAt = new Map<string, number>();
const reconciling = new Set<string>();

const PHONE_RE = /^2637\d{8}$/;

// Written into payments.error_message when a Ruijie mint fails so the customer's
// own status poll can render the "taking longer than expected" screen. Prefix is
// greppable and completePayment clears error_message on success, so the marker
// disappears as soon as the voucher is finally issued.
const RUIJIE_MINT_PENDING_PREFIX = 'ruijie_mint_pending: ';

function normalizeZwPhone(input: string): string {
  let p = String(input ?? '').replace(/[^\d+]/g, '');
  p = p.replace(/^\+/, '');
  if (p.startsWith('00')) p = p.slice(2);
  // 263 0 771... (country code with the local trunk 0 still attached)
  if (p.startsWith('2630')) p = '263' + p.slice(4);
  else if (p.startsWith('0')) p = '263' + p.slice(1);
  // Bare national significant number, e.g. 771 327 202
  else if (/^7\d{8}$/.test(p)) p = '263' + p;
  return p;
}

function isValidZwPhone(phone: string): boolean {
  return PHONE_RE.test(phone);
}

/**
 * Persist a checkout that was rejected before it could become a `payments` row
 * (bad phone, unknown tier, unconfigured gateway). Without this the customer
 * sees an error and the admin console has no record of the attempt at all —
 * which is exactly what happened on 2026-11-16 (six 422s, zero rows).
 */
async function recordRejectedAttempt(opts: {
  stage: string;
  reason: string;
  rawPhone?: unknown;
  tier?: unknown;
  amount?: unknown;
  currency?: unknown;
  paymentMethod?: string;
  macAddress?: string | null;
  req?: Request;
}): Promise<void> {
  try {
    const forwarded = String(opts.req?.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    const amount = Number(opts.amount);
    await pool.query(
      `INSERT INTO payment_attempts
        (stage, reason, raw_phone, package_tier, amount, currency, payment_method,
         client_mac, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        opts.stage,
        opts.reason,
        opts.rawPhone == null ? null : String(opts.rawPhone).slice(0, 64),
        opts.tier == null ? null : String(opts.tier).slice(0, 80),
        Number.isFinite(amount) ? amount : null,
        opts.currency ? String(opts.currency).toUpperCase().slice(0, 8) : 'USD',
        opts.paymentMethod ?? 'EcoCash (Pesepay)',
        opts.macAddress ?? null,
        forwarded || opts.req?.ip || null,
        String(opts.req?.headers['user-agent'] || '').slice(0, 300) || null,
      ]
    );
  } catch (err) {
    // Never let audit logging block a customer's checkout.
    console.error('payment_attempts insert failed:', err);
  }
}

// Pesepay reports transaction status as a string, not a numeric code. Anything we
// do not recognise is treated as "pending" so an unrecognised value can never
// mint a voucher by accident.
function parsePesepayStatus(raw: unknown): { state: 'completed' | 'failed' | 'refunded' | 'pending'; label: string } {
  if (raw === undefined || raw === null || raw === '') return { state: 'pending', label: 'pending' };
  const str = String(raw).trim();
  const upper = str.toUpperCase();

  if (PESEPAY_SUCCESS_STATUSES.includes(upper)) return { state: 'completed', label: upper };
  if (upper === 'REFUNDED' || upper === 'REVERSED') return { state: 'refunded', label: upper };
  if (PESEPAY_FAILED_STATUSES.includes(upper)) return { state: 'failed', label: upper };
  // Pesepay terminal states that are not in the shared lists. TIME_OUT is a
  // dead checkout (the mobile-money prompt was never approved), TIMEOUT is the
  // same state spelled differently. Treating these as pending is what left
  // abandoned checkouts in the payments table forever.
  if (upper === 'TIME_OUT' || upper === 'TIMEOUT') return { state: 'failed', label: upper };
  return { state: 'pending', label: str };
}

async function getOrCreateUserByPhone(phone: string, fullName?: string): Promise<{ id: string }> {
  const existing = await pool.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [phone]);
  if (existing.rows.length > 0) {
    // Repeat buyers reuse the row from their first checkout, which may still be
    // the placeholder "Guest User" (or the phone itself). Refresh it with the
    // name they just entered so the account and downloaded voucher stay
    // accurate; never overwrite a real name with a placeholder.
    const trimmed = (fullName || '').trim();
    if (trimmed && trimmed !== 'Guest User') {
      await pool.query(
        `UPDATE users SET full_name = $2
          WHERE id = $1
            AND (full_name IS NULL OR full_name = '' OR full_name = 'Guest User' OR full_name = phone)`,
        [existing.rows[0].id, trimmed]
      );
    }
    return existing.rows[0];
  }

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
  customer_name: string | null;
  phone_number: string | null;
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
           bandwidth_mbps_up, bandwidth_mbps_down, sold_by, price_amount, package_tier, max_devices,
           holder_name, holder_phone)
         VALUES ($1::text, $2::int, 1, NULL, $3::numeric, $4::boolean,
                 $5::int, $6::int, NULL, $7::numeric, $8::text, $9::int, $10::text, $11::text)
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
          (pay.customer_name && String(pay.customer_name).trim()) || null,
          pay.phone_number || null,
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

// Record an operations alert when a Ruijie Cloud voucher could not be minted for
// a payment that HAS already been charged by Pesepay. Without this the failure is
// invisible: the transaction rolls back, the payment stays 'pending', and the
// customer has paid but received nothing.
//
// Two properties matter:
//  1. It runs AFTER the rollback, on its own connection — a row inserted inside
//     the doomed transaction would be rolled back with it and the alert lost.
//  2. It never throws. Failing to record the failure must not replace the real
//     error the caller needs to see.
async function recordRuijieMintFailure(paymentId: string, pay: any, mintError: unknown): Promise<void> {
  const code = mintError instanceof RuijieApiError ? String(mintError.code) : 'unknown';
  const detail = (mintError as Error)?.message || String(mintError);

  // Two independent best-effort writes: a failure of one must not skip the other.
  // The alert is for operations; the marker is what the customer's own status
  // poll reads to show the "taking longer than expected" screen.
  await Promise.all([
    (async () => {
      try {
        const reference = pay.pesepay_reference || 'not recorded';
        // phone_number is on the payment row; email lives on users.
        let email: string | null = null;
        try {
          const u = await pool.query('SELECT email FROM users WHERE id = $1', [pay.user_id]);
          email = u.rows[0]?.email ?? null;
        } catch {
          // Contact lookup is best-effort; never block the alert on it.
        }
        const contact = [pay.phone_number, email].filter(Boolean).join(' / ') || 'no contact on file';
        await pool.query(
          `INSERT INTO alerts (type, severity, title, message, target_type, target_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            'ruijie_mint_failure',
            'critical',
            'Ruijie voucher mint failed — customer has paid',
            [
              `Payment ${paymentId} (${pay.tier_name}) was charged by Pesepay but no Ruijie voucher could be issued.`,
              `Pesepay reference: ${reference}.`,
              `Customer contact: ${contact}.`,
              `Amount: ${pay.amount} ${pay.currency}.`,
              `Ruijie error [${code}]: ${detail}`,
              `Action: issue the code manually or refund, then complete the payment.`,
            ].join(' '),
            'payment',
            String(paymentId),
          ]
        );
      } catch (alertErr) {
        console.error('Failed to record ruijie_mint_failure alert', alertErr);
      }
    })(),
    (async () => {
      try {
        // Guarded on status='pending' so a late-arriving webhook retry that has
        // already completed the payment is never downgraded. completePayment
        // clears error_message on success, so this marker self-heals.
        await pool.query(
          `UPDATE payments SET error_message = $2 WHERE id = $1 AND status = 'pending'`,
          [paymentId, `${RUIJIE_MINT_PENDING_PREFIX}${code}: ${detail}`]
        );
      } catch (markerErr) {
        console.error('Failed to mark payment for support follow-up', markerErr);
      }
    })(),
  ]);
}

// Complete a payment: mint a voucher, close the payment, record a transaction.
// Returns the voucher code on success.
//
// Runs inside a single PostgreSQL transaction that takes a row-level lock on
// the payment (SELECT ... FOR UPDATE) BEFORE minting. Concurrent webhook
// callbacks for the same payment therefore serialize: the second caller blocks
// on the lock, re-reads status === 'completed' and returns the already-minted
// voucher code instead of minting a second one (double-mint prevention).
async function completePayment(paymentId: string): Promise<string> {
  const client = await pool.connect();
  // Hoisted so the catch block can describe the payment in the alert even
  // though `pay` itself is scoped to the try.
  let payRow: any = null;
  let ruijieMintError: unknown = null;
  try {
    await client.query('BEGIN');

    // duration_min / data_limit_gb / is_uncapped / bandwidth_mbps_* / max_devices
    // live on `packages`, not `payments` — they must be pulled off the join or the
    // voucher INSERT below silently receives undefined for every one of them.
    const payment = await client.query(
      `SELECT p.*, pk.tier_name, pk.price_amount, pk.duration_min, pk.data_limit_gb,
              pk.is_uncapped, pk.bandwidth_mbps_up, pk.bandwidth_mbps_down, pk.max_devices
       FROM payments p
       JOIN packages pk ON pk.id = p.package_id
       WHERE p.id = $1
       FOR UPDATE OF p`,
      [paymentId]
    );
    if (payment.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Payment not found');
    }
    const pay = payment.rows[0];
    payRow = pay;

    // Double-mint guard: another webhook may have completed this payment while
    // we waited on the row lock. If so, return the existing voucher code and
    // do NOT mint a second voucher.
    if (pay.status === 'completed') {
      await client.query('COMMIT');
      if (pay.voucher_code) return pay.voucher_code;
      throw new Error('Payment already completed but no voucher code recorded');
    }

    if (!canComplete(pay)) {
      await client.query('ROLLBACK');
      throw new Error(`Payment cannot be completed from status '${pay.status}'`);
    }
    if (isLocallyExpired(pay)) {
      // Late approval after our local timeout: honour the money and raise it
      // for finance review instead of silently keeping the customer's cash.
      console.warn(
        `[payments] gateway confirmed locally expired payment ${paymentId} ` +
          `(${pay.pesepay_reference ?? 'no reference'}); completing late`
      );
    }

    // Pick the voucher source. Ruijie Cloud is the network's single source of
    // access: when configured, the code MUST come from Ruijie (never a locally
    // fabricated placeholder) and an unmapped tier fails loudly so the paid
    // customer is never handed a code that cannot grant internet.
    //
    // Prefer the pre-minted stock pool: those codes already exist in Ruijie, so
    // claiming one costs no API call and cannot fail because background sync
    // exhausted the minute quota. Minting is the fallback only when the pool has
    // no usable code for this tier.
    let code: string;
    let usedPool = false;
    let ruijieSource: { ruijie_expiry: number | null; user_group_id: string; profile_uuid: string; comment: string } | null = null;
    if (isRuijieCloudConfigured()) {
      const pooled = await claimPooledVoucher(client, pay.tier_name, paymentId);
      if (pooled) {
        code = pooled.code_no;
        usedPool = true;
        console.log(`[payments] claimed pooled voucher ${code} for ${paymentId} (${pay.tier_name})`);
      } else {
        console.warn(`[payments] voucher pool empty for ${pay.tier_name}; minting for ${paymentId}`);
        try {
          const minted = await mintRuijieVoucherForTier(pay.tier_name, `Payment ${paymentId}`);
          code = minted.codeNo;
          ruijieSource = {
            ruijie_expiry: minted.expiryTime ?? null,
            user_group_id: minted.userGroupId,
            profile_uuid: minted.profile,
            comment: minted.comment,
          };
        } catch (err) {
          // Remember why so the catch below can raise an operations alert once the
          // transaction is safely rolled back.
          ruijieMintError = err;
          throw err;
        }
      }
    } else {
      // Legacy local mint — only reachable while Ruijie Cloud is not configured.
      code = await mintLegacyVoucher(client, pay);
    }

    // Record the Ruijie issuance for audit/reconciliation regardless of which
    // path minted it (null fields for the legacy local path). A pooled code is
    // already in ruijie_vouchers (claimPooledVoucher set payment_id/source), so
    // there is nothing to insert.
    if (ruijieSource && !usedPool) {
      await client.query(
        `INSERT INTO ruijie_vouchers
          (code_no, tier_name, user_group_id, profile_uuid, ruijie_expiry, payment_id, source, comment)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::bigint, $6::uuid, 'online', $7::text)`,
        [code, pay.tier_name, ruijieSource.user_group_id, ruijieSource.profile_uuid, ruijieSource.ruijie_expiry, paymentId, ruijieSource.comment]
      );
    }

    // RETURNING: `pay` was read before this UPDATE, so its completed_at is still
    // NULL — the voucher and sale rows must carry the real completion time, not
    // a stale one, or the sale lands on the wrong day in the revenue report.
    const { rows: completedRows } = await client.query(
      `UPDATE payments
       SET status = 'completed', completed_at = NOW(), voucher_code = $2, error_message = NULL
       WHERE id = $1
       RETURNING completed_at`,
      [paymentId, code]
    );
    const completedAt: Date = completedRows[0]?.completed_at ?? new Date();

    await client.query(
      `INSERT INTO transactions
        (payment_id, user_id, package_tier, amount, currency, payment_method, voucher_code, status, completed_at)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::numeric, $5::text, $6::text, $7::text, 'completed', NOW())`,
      [paymentId, pay.user_id, pay.tier_name, pay.amount, pay.currency, pay.payment_method, code]
    );

    // ── Account for the sale ────────────────────────────────────────────────
    // The Ruijie Cloud path mints the code remotely and never created a local
    // `vouchers` row, so a paid voucher was invisible to the admin voucher list
    // and no `sales` row was ever written — the customer paid and nobody could
    // see it. Both writes happen here, inside this transaction, so a completed
    // payment is always attributed to a seller.
    const owner = await resolveOnlineSaleOwner(client);

    await client.query(
      `INSERT INTO vouchers
         (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped,
          bandwidth_mbps_up, bandwidth_mbps_down, sold_by, price_amount, package_tier,
          max_devices, holder_name, holder_phone, created_at)
       SELECT $1::text, $2::int, 1, NULL, $3::numeric, $4::boolean,
              $5::int, $6::int, $7::uuid, $8::numeric, $9::text, $10::int,
              $11::text, $12::text, $13::timestamptz
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
        (pay.customer_name && String(pay.customer_name).trim()) || null,
        pay.phone_number || null,
        completedAt,
      ]
    );

    // The legacy local mint already inserted the row with sold_by NULL; the
    // statement above skips it, so attribute it here instead.
    await client.query(
      `UPDATE vouchers SET sold_by = $2::uuid
       WHERE code = $1 AND sold_by IS NULL AND $2::uuid IS NOT NULL`,
      [code, owner?.id ?? null]
    );

    await client.query(
      `INSERT INTO sales
         (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency,
          payment_method, payment_reference, sold_at)
       SELECT v.id, v.code, $2::uuid, $3::text, $4::numeric, $5::text,
              $6::text, $7::text, $8::timestamptz
       FROM vouchers v
       WHERE v.code = $1
         AND NOT EXISTS (SELECT 1 FROM sales WHERE voucher_code = $1)`,
      [
        code,
        owner?.id ?? null,
        owner?.fullName ?? null,
        pay.amount,
        pay.currency || 'USD',
        normalizeSaleMethod(pay.payment_method),
        pay.pesepay_reference || null,
        completedAt,
      ]
    );

    await client.query('COMMIT');
    return code;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failure — original error is what matters.
    }
    // Only Ruijie mint failures are alerted: 'payment not found' and the
    // double-mint/transition guards are ordinary control flow, not incidents.
    if (ruijieMintError) {
      await recordRuijieMintFailure(paymentId, payRow, ruijieMintError);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /api/payments/initiate
 * Body: { tier, phone, currency?, fullName?, macAddress? }
 */
paymentsRouter.post('/initiate', async (req: Request, res: Response) => {
  const body = req.body || {};
  // The portal posts rail-era aliases (account_identifier / client_phone /
  // package_id) while older cached clients post tier / phone. Accept both: a
  // mismatch here is what silently black-holed every checkout on 2026-11-16.
  const tier = body.tier ?? body.package_id ?? body.packageTier ?? body.tier_name;
  const rawPhone = body.phone ?? body.account_identifier ?? body.client_phone ?? body.contactPhone;
  const fullName = body.fullName ?? body.client_name ?? body.name;
  const currency = body.currency;
  const macAddress = body.macAddress ?? body.mac ?? body.client_mac ?? null;
  const railMethod = body.payment_rail === 'omari' ? "O'mari (Pesepay)" : 'EcoCash (Pesepay)';
  const attemptBase = {
    rawPhone,
    tier,
    amount: body.amount,
    currency,
    macAddress,
    paymentMethod: railMethod,
    req,
  };

  if (!isPesepayConfigured()) {
    const reason = 'Online payments are not configured yet. Please buy your voucher at the Preyone shop.';
    await recordRejectedAttempt({ ...attemptBase, stage: 'config', reason });
    res.status(422).json({ error: reason });
    return;
  }

  const normalizedPhone = normalizeZwPhone(rawPhone);
  if (!isValidZwPhone(normalizedPhone)) {
    const reason = 'Please enter a valid Zimbabwe phone number (e.g. 0771 327 202).';
    await recordRejectedAttempt({ ...attemptBase, stage: 'validation', reason });
    res.status(422).json({ error: reason });
    return;
  }

  if (!tier) {
    const reason = 'Unknown package tier.';
    await recordRejectedAttempt({ ...attemptBase, stage: 'validation', reason });
    res.status(422).json({ error: reason });
    return;
  }

  const pkgResult = await pool.query(
    `SELECT id, tier_name, price_amount, price_currency, duration_min, data_limit_gb,
            is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, max_devices
     FROM packages WHERE tier_name = $1 LIMIT 1`,
    [tier]
  );
  if (pkgResult.rows.length === 0) {
    const reason = 'Unknown package tier.';
    await recordRejectedAttempt({ ...attemptBase, stage: 'validation', reason });
    res.status(422).json({ error: reason });
    return;
  }
  const pkg = pkgResult.rows[0];

  // Ruijie Cloud is the single source of internet access: a package with no
  // active profile mapping must NOT be chargeable, or the customer pays and
  // can never be given a usable code. Reject before any Pesepay charge.
  if (isRuijieCloudConfigured()) {
    const profile = await findRuijieProfile(pkg.tier_name);
    if (!profile) {
      const reason = `Package '${pkg.tier_name}' is not currently available online (no Ruijie Cloud profile mapping). Please buy at the Preyone shop.`;
      await recordRejectedAttempt({ ...attemptBase, stage: 'ruijie_profile', reason });
      res.status(502).json({ error: reason });
      return;
    }
  }

  const user = await getOrCreateUserByPhone(normalizedPhone, fullName);
  // Sub-dollar tiers (0.99 PreLite) are billed as a flat 1.00: EcoCash settles in
  // whole dollars. The payments row stores the SAME value sent to Pesepay so the
  // webhook's amount-match check compares against the actual charge.
  const amount = normalizePaymentAmount(Number(pkg.price_amount));
  const resolvedCurrency = String(currency || pkg.price_currency || 'USD').toUpperCase();

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
       merchant_reference, client_mac, webhook_token, customer_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text, 'pending')
     RETURNING id`,
    [
      user.id,
      pkg.id,
      normalizedPhone,
      amount,
      resolvedCurrency,
      'EcoCash (Pesepay)',
      merchantReference,
      macAddress,
      webhookToken,
      (fullName || '').trim() || null,
    ]
  );
  const paymentId = paymentInsert.rows[0].id;

  const baseUrl = (process.env.BASE_URL || 'https://wifi.preyone.com').replace(/\/$/, '');

  try {
    const result = await initiateEcoCashPayment({
      amount,
      currency: resolvedCurrency,
      phone: normalizedPhone,
      reference: merchantReference,
      description: `${pkg.tier_name} — pre-paid internet access`,
      // Pesepay redirects the customer's browser here once they have approved (or
      // abandoned) the EcoCash push. It carries no token: the status token is
      // minted server-side by /return so a mangled query string cannot break it.
      returnUrl: `${baseUrl}/api/payments/return?ref=${encodeURIComponent(merchantReference)}`,
      // Appended to resultUrl by pesepayService; Pesepay echoes it back.
      webhookToken,
    });

    if (!result.success || !result.pollUrl) {
      const message = result.error || 'Pesepay did not return a payment page';
      if (result.detail) {
        console.error(`Payment ${paymentId} initiation transport failure: ${result.detail}`);
      }
      await pool.query(
        `UPDATE payments SET status = 'failed', error_message = $2 WHERE id = $1`,
        [paymentId, message]
      );
      res.status(502).json({ error: message, status: 'failed', paymentId });
      return;
    }

    // Keep Pesepay's own reference for reconciliation, and the hosted page URL so
    // support can re-send a customer to the prompt they abandoned.
    await pool.query(
      `UPDATE payments
          SET pesepay_reference = $2, pesepay_poll_url = $3, error_message = NULL
        WHERE id = $1`,
      [paymentId, result.transactionId ?? null, result.pollUrl]
    );

    res.status(200).json({
      paymentId,
      reference: merchantReference,
      pesepayReference: result.transactionId ?? null,
      // The client must navigate here: Pesepay hosts the EcoCash approval page.
      pesepayPollUrl: result.pollUrl,
      status: 'pending',
      statusToken: jwt.sign({ paymentId, type: 'status' }, getJwtSecret(), { algorithm: 'HS256', expiresIn: '2h' }),
      amount,
      phone: normalizedPhone,
      message: 'Approve the EcoCash request on your phone to complete the payment.',
    });
  } catch (err) {
    const message = (err as Error).message || 'Payment provider request failed';
    await pool.query(
      `UPDATE payments SET status = 'failed', error_message = $2 WHERE id = $1`,
      [paymentId, message]
    );
    res.status(502).json({ error: message, status: 'failed', paymentId, statusToken: jwt.sign({ paymentId, type: 'status' }, getJwtSecret(), { algorithm: 'HS256', expiresIn: '2h' }) });
  }
});

/**
 * POST /api/payments/webhook — Pesepay server-to-server callback (resultUrl).
 *
 * Pesepay POSTs `{ payload: "<AES-CBC ciphertext>" }`. We decrypt it with
 * PESEPAY_ENCRYPTION_KEY, which is the authentication step: a payload that does
 * not decrypt cleanly was not produced by Pesepay holding our key, so it is
 * rejected before any payment row is touched.
 *
 * The decrypted body carries the merchantReference we generated at initiate,
 * which is the lookup key. A per-payment webhook token is ALSO required when
 * present, because Pesepay echoes resultUrl back — defence in depth so that
 * even a replayed, correctly-encrypted payload for an unrelated reference
 * cannot mint a voucher.
 */
paymentsRouter.post('/webhook', async (req: Request, res: Response) => {
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
    `SELECT p.id, p.status, p.voucher_code, p.amount, p.currency, p.phone_number, p.webhook_token, p.error_message
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
    if (!canComplete(pay)) {
      res.json({ status: 'ok', state: pay.status });
      return;
    }
    try {
      const voucherCode = await completePayment(pay.id);
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

  // Still pending (AWAITING / PROCESSING) — acknowledge so Pesepay stops re-posting.
  res.json({ status: 'ok', state: 'pending' });
});

/**
 * GET /api/payments/return — the customer's browser comes back here from
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
 * GET /api/payments/status/:paymentId — polling endpoint for the portal.
 *
 * GET /api/payments/status?id=… (and ?referenceNumber=…) is kept as an alias:
 * field portal builds still poll the query form, and when only the path form
 * existed every poll 404'd, so checkout could never resolve and hung forever.
 */
async function sendPaymentStatus(req: Request, res: Response, paymentIdParam: string) {
  try {
    const paymentId = String(paymentIdParam || '');
    if (!paymentId) {
      res.status(404).json({ error: 'Payment not found' });
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
    try {
      const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as any;
      if (decoded.paymentId !== paymentId) {
        res.status(403).json({ error: 'Token does not match this payment' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT p.id, p.status, p.amount, p.completed_at, p.voucher_code, p.pesepay_reference,
              p.error_message, p.created_at, p.customer_name, pk.tier_name,
              s.sold_by_name
       FROM payments p
       JOIN packages pk ON pk.id = p.package_id
       LEFT JOIN LATERAL (
         SELECT sold_by_name FROM sales
          WHERE voucher_code = p.voucher_code
          ORDER BY sold_at DESC
          LIMIT 1
       ) s ON TRUE
       WHERE p.id = $1`,
      [paymentId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Seamless EcoCash has no hosted page, so the customer never hits /return.
    // If the webhook also stalls, /status is the only heartbeat left - reconcile
    // against the gateway here so the voucher self-mints while the portal polls.
    // Rate-gated so repeated 3s polls stay cheap for Pesepay.
    let pay = rows[0];
    if (pay.status === 'pending' && pay.pesepay_reference) {
      const now = Date.now();
      const nextAllowed = (lastReconcileAt.get(paymentId) || 0) + RECONCILE_GAP_MS;
      if (now >= nextAllowed && !reconciling.has(paymentId)) {
        reconciling.add(paymentId);
        lastReconcileAt.set(paymentId, now);
        try {
          const check = await verifyPaymentStatus(pay.pesepay_reference);
          const parsed = parsePesepayStatus(check.status);
          if (check.found && parsed.state === 'completed') {
            try {
              const voucherCode = await completePayment(paymentId);
              console.log(`Reconciled payment ${paymentId} on status poll -> ${voucherCode}`);
            } catch (err) {
              // A concurrent webhook may have just completed it; re-read below.
              console.error('Status poll completion failed', err);
            }
          } else if (check.found && (parsed.state === 'failed' || parsed.state === 'refunded')) {
            await pool.query(
              `UPDATE payments SET status = $2, error_message = $3
               WHERE id = $1 AND status = 'pending'`,
              [paymentId, parsed.state, `Gateway reported ${parsed.label} (status check)`]
            );
          }
        } catch (err) {
          console.error('Status poll reconciliation failed', err);
        } finally {
          reconciling.delete(paymentId);
        }
      }
      const fresh = await pool.query(
        'SELECT status, completed_at, voucher_code, error_message FROM payments WHERE id = $1',
        [paymentId]
      );
      if (fresh.rows.length > 0) pay = { ...pay, ...fresh.rows[0] };
    }

    // Hard expiry: close a checkout that has outlived the payment window even
    // when the gateway never returns a terminal state. One final gateway check
    // guards against ever failing a customer who actually paid.
    if (pay.status === 'pending' && pay.created_at) {
      const ageMin = (Date.now() - new Date(pay.created_at).getTime()) / 60_000;
      if (ageMin >= PAYMENT_EXPIRY_MIN) {
        let settled = false;
        if (pay.pesepay_reference) {
          try {
            const finalCheck = await verifyPaymentStatus(pay.pesepay_reference);
            const finalParsed = parsePesepayStatus(finalCheck.status);
            if (finalCheck.found && finalParsed.state === 'completed') {
              await completePayment(paymentId);
              settled = true;
            } else if (finalCheck.found && (finalParsed.state === 'failed' || finalParsed.state === 'refunded')) {
              await pool.query(
                `UPDATE payments SET status = $2, error_message = $3
                 WHERE id = $1 AND status = 'pending'`,
                [paymentId, finalParsed.state, `Gateway reported ${finalParsed.label} (expiry check)`]
              );
            }
          } catch (err) {
            // Gateway unreachable: local expiry still applies.
            console.error('Expiry gateway check failed', err);
          }
        }
        if (!settled) {
          await pool.query(
            `UPDATE payments
                SET status = 'failed',
                    error_message = COALESCE(error_message, $2)
              WHERE id = $1 AND status = 'pending'`,
            [
              paymentId,
              `Payment window expired after ${PAYMENT_EXPIRY_MIN} minutes without confirmation. ` +
                `If EcoCash deducted you, contact support with reference ${pay.pesepay_reference ?? paymentId}.`,
            ]
          );
        }
        const expired = await pool.query(
          'SELECT status, completed_at, voucher_code, error_message FROM payments WHERE id = $1',
          [paymentId]
        );
        if (expired.rows.length > 0) pay = { ...pay, ...expired.rows[0] };
      }
    }

    res.json({
      paymentId: pay.id,
      status: pay.status,
      amount: pay.amount,
      completedAt: pay.completed_at,
      voucherCode: pay.voucher_code ?? null,
      // Lets the portal re-open the correct package modal after the customer
      // returns from Pesepay's hosted page.
      tier: pay.tier_name,
      // The customer has paid but Ruijie could not issue a code yet. The portal
      // swaps its waiting copy for a "still working on it" panel and keeps
      // polling, because a later poll may reconcile successfully.
      supportRequired: String(pay.error_message || '').startsWith('ruijie_mint_pending: '),
      // Shown to the customer as proof of purchase in support conversations.
      reference: pay.pesepay_reference ?? null,
      // Printed on the success page and the downloaded JPEG so the buyer and
      // seller are both explicit, not inferred from the linked user row.
      holderName: pay.customer_name ?? null,
      soldByName: pay.sold_by_name ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Status lookup failed' });
  }
}

// Canonical route (used by current portal builds).
paymentsRouter.get('/status/:paymentId', (req: Request, res: Response) =>
  sendPaymentStatus(req, res, String(req.params.paymentId || ''))
);

// Compatibility alias for cached portal builds that poll the query form.
paymentsRouter.get('/status', async (req: Request, res: Response) => {
  try {
    let id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!id) {
      const ref = typeof req.query.referenceNumber === 'string' ? req.query.referenceNumber : '';
      if (ref) {
        const { rows } = await pool.query(
          `SELECT id FROM payments
            WHERE merchant_reference = $1 OR pesepay_reference = $1
            ORDER BY created_at DESC LIMIT 1`,
          [ref]
        );
        id = rows[0]?.id ?? '';
      }
    }
    await sendPaymentStatus(req, res, id);
  } catch (err) {
    res.status(500).json({ error: 'Status lookup failed' });
  }
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
    `SELECT id, doc_number, doc_type, total, amount_paid, shift_id, tax_pct, currency, company_id
       FROM pos_documents WHERE id = $1 FOR UPDATE`,
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

  const payIns = await client.query(
    `INSERT INTO pos_document_payments (document_id, amount, method, reference, shift_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
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

  // Post to the enterprise GL and decrement stock if not already applied
  // (office invoices created outside POS checkout may still need stock pulled).
  const companyId = doc.company_id || intent.tenant_id;
  if (companyId) {
    await syncSaleToLedgerAndStock(client, {
      companyId,
      documentId: doc.id,
      paymentId: Number(payIns.rows[0].id),
      amount: Number(intent.amount),
      method: intent.payment_method,
      docType: doc.doc_type,
      docNumber: doc.doc_number,
      reference,
      taxPct: Number(doc.tax_pct) || undefined,
      currency: doc.currency || intent.currency,
    });
  }

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

  // plan_type wins. A legacy module payment cannot grant Invoice on PreTill
  // or take it away from PreBiz and above. Re-sync after the row update.
  const { rows: planRows } = await client.query(
    `SELECT plan_type FROM companies WHERE id = $1`,
    [intent.tenant_id]
  );
  if (planRows[0]?.plan_type) {
    await syncPlanModules(client, intent.tenant_id, planRows[0].plan_type);
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

// ── Subscription renewal webhook ───────────────────────────────────────────
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
      const purchasedTier = intent ? canonicalPlanId(intent.plan_tier) : null;

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

      const company = updated[0];

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

      if (company.plan_type) {
        await syncPlanModules(client, company.id, company.plan_type);
      }

      await client.query('COMMIT');

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
// Starlink portal � Pese checkout (POST /api/payments/pese/checkout)
//
// Serves the three portal actions: Wallet Top Up, Data Top Up and Kit
// Purchase. Authenticated with the starlink-customer JWT (never the admin
// session), so a subscriber can only ever charge their own account. Each
// checkout creates a starlink_invoices row (PENDING) plus a pesepay_intents
// row with target_type = 'starlink'; the existing /pesepay/callback webhook
// settles it (invoice -> PAID, wallet/kit credited) via applyStarlinkPayment.
// ===========================================================================

interface StarlinkCheckoutBody {
  kind: 'wallet_topup' | 'data_topup' | 'kit_purchase' | 'plan_change' | 'plan_renewal';
  amount: number;
  planCode?: string;
  invoiceId?: string;
  paymentMethod?: string;
  phone?: string;
  returnUrl?: string;
  kitId?: string;
  gb?: number;
  bundleName?: string;
  kitNumber?: string;
  nickname?: string;
}

const STARLINK_KINDS = ['wallet_topup', 'data_topup', 'kit_purchase', 'plan_change', 'plan_renewal'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const base = process.env.STARLINK_BASE_URL || 'https://starlink.preyone.com';
  return `${base.replace(/\/$/, '')}/starlink/portal`;
}

paymentsRouter.post('/pese/checkout', requireStarlinkAuth, async (req: Request, res: Response) => {
  const customer = req.starlinkCustomer!;
  const body = req.body as StarlinkCheckoutBody;

  const kind = body.kind;
  if (!STARLINK_KINDS.includes(kind)) {
    res.status(400).json({ error: 'kind must be wallet_topup, data_topup, kit_purchase or plan_change' });
    return;
  }

  // Plan changes are priced from the server-side catalog, never from the client.
  const planTarget = kind === 'plan_change' ? getStarlinkPlan(body.planCode) : null;
  if (kind === 'plan_change') {
    if (!planTarget) { res.status(400).json({ error: 'Choose a valid plan' }); return; }
    if (planTarget.code === customer.plan_code) { res.status(409).json({ error: 'You are already on this plan' }); return; }
  }

  // A renewal pays the PENDING invoice the renewal job issued — never a new one.
  let renewalInvoice: { id: string; invoice_number: string; amount: number; meta: Record<string, unknown> } | null = null;
  if (kind === 'plan_renewal') {
    const invoiceId = String(body.invoiceId || '');
    if (!UUID_RE.test(invoiceId)) { res.status(400).json({ error: 'Choose a renewal invoice to pay' }); return; }
    const { rows } = await pool.query(
      `SELECT id, invoice_number, amount, meta FROM starlink_invoices
        WHERE id = $1 AND customer_id = $2 AND kind = 'plan_renewal' AND status = 'PENDING'`,
      [invoiceId, customer.id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'No pending renewal found' }); return; }
    renewalInvoice = { ...rows[0], amount: Number(rows[0].amount) };
  }

  const amount = renewalInvoice ? renewalInvoice.amount
    : planTarget ? planTarget.priceUsd : Number(body.amount);
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
  } else if (planTarget) {
    meta = { plan_code: planTarget.code, plan_name: planTarget.name };
    description = `Starlink ${planTarget.name} plan (monthly)`;
  } else if (renewalInvoice) {
    meta = renewalInvoice.meta;
    description = `Starlink plan renewal ${renewalInvoice.invoice_number}`;
  } else {
    description = 'Starlink Wallet Top-Up';
  }

  const returnUrl = safeStarlinkReturnUrl(body.returnUrl) || starlinkDefaultReturnUrl();

  // Tenant: the portal company (same singleton rule as /pesepay/initiate) �
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
      const invoice = renewalInvoice ?? await createStarlinkInvoice({
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

// ── Abandoned-checkout reconciliation ───────────────────────────────────────
//
// /status only reconciles while the customer's browser is still polling. A
// customer who closes the tab after approving (or abandoning) EcoCash leaves
// the row `pending` forever: a paid customer gets no voucher, and reporting
// shows phantom pending sales. This sweep re-checks old references directly
// with Pesepay and applies the same terminal transitions as the webhook.
//
// Four PM2 workers load this module, so `pg_try_advisory_lock` elects a single
// sweeper per tick; `completePayment` is double-mint-safe on its own as well.
const RECONCILE_LOCK_KEY = 'preyone:payment_reconcile';
const RECONCILE_MIN_AGE_MIN = Math.max(
  5,
  Number(process.env.PAYMENT_RECONCILE_MIN_AGE_MIN ?? 15)
);
const RECONCILE_INTERVAL_MIN = Math.max(
  1,
  Number(process.env.PAYMENT_RECONCILE_INTERVAL_MIN ?? 10)
);
const RECONCILE_BATCH = 100;

export interface PaymentReconcileResult {
  scanned: number;
  completed: number;
  failed: number;
  refunded: number;
  skipped: number;
}

export async function reconcilePendingPaymentsOnce(): Promise<PaymentReconcileResult> {
  const result: PaymentReconcileResult = {
    scanned: 0,
    completed: 0,
    failed: 0,
    refunded: 0,
    skipped: 0,
  };
  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [RECONCILE_LOCK_KEY]
    );
    if (!lock.rows[0]?.locked) return result;

    const { rows } = await pool.query(
      `SELECT id, status, error_message, pesepay_reference, created_at
         FROM payments
        WHERE (
                status = 'pending'
                OR (
                  status = 'failed'
                  AND error_message LIKE 'Payment window expired%'
                  AND created_at > now() - interval '24 hours'
                )
              )
          AND pesepay_reference IS NOT NULL
          AND created_at < now() - ($1 || ' minutes')::interval
        ORDER BY created_at ASC
        LIMIT ${RECONCILE_BATCH}`,
      [String(RECONCILE_MIN_AGE_MIN)]
    );

    for (const row of rows) {
      result.scanned += 1;
      const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60_000;
      const expired = ageMin >= PAYMENT_EXPIRY_MIN;
      try {
        const check = await verifyPaymentStatus(row.pesepay_reference);

        // A row we closed locally on the payment window is only ever moved
        // forward by a gateway-confirmed success: the customer's money arrived
        // after our timeout, so honour it. Anything else leaves the row failed
        // (never re-expired or downgraded) so reporting stays stable.
        if (isLocallyExpired(row)) {
          const parsed = check.found ? parsePesepayStatus(check.status) : null;
          if (parsed?.state === 'completed') {
            await completePayment(row.id);
            result.completed += 1;
            console.log(`[payments] late approval completed ${row.id} (${parsed.label})`);
          } else {
            result.skipped += 1;
          }
        } else if (!check.found) {
          // not_found means the gateway has no record yet; never fail on that
          // until the payment window has fully elapsed.
          if (expired) {
            const updated = await pool.query(
              `UPDATE payments SET status = 'failed', error_message = $2
                WHERE id = $1 AND status = 'pending'`,
              [row.id, `Payment window expired after ${PAYMENT_EXPIRY_MIN} minutes; the gateway has no record of this checkout.`]
            );
            if (updated.rowCount) {
              result.failed += 1;
              console.log(`[payments] expired ${row.id} (gateway not found)`);
            } else {
              result.skipped += 1;
            }
          } else {
            result.skipped += 1;
          }
        } else {
          const parsed = parsePesepayStatus(check.status);
          if (parsed.state === 'completed') {
            // Safe: completePayment re-reads the row under FOR UPDATE and
            // returns the existing code if a webhook won the race.
            await completePayment(row.id);
            result.completed += 1;
            console.log(`[payments] reconciled ${row.id} -> completed (${parsed.label})`);
          } else if (parsed.state === 'failed' || parsed.state === 'refunded') {
            const updated = await pool.query(
              `UPDATE payments
                  SET status = $2, error_message = $3
                WHERE id = $1 AND status = 'pending'`,
              [row.id, parsed.state, `Gateway reported ${parsed.label} (reconciled)`]
            );
            if (updated.rowCount) {
              if (parsed.state === 'failed') result.failed += 1;
              else result.refunded += 1;
              console.log(`[payments] reconciled ${row.id} -> ${parsed.state} (${parsed.label})`);
            } else {
              result.skipped += 1;
            }
          } else if (expired) {
            // Gateway still reports pending after the payment window: close it
            // locally so the portal and reporting do not hang indefinitely.
            const updated = await pool.query(
              `UPDATE payments SET status = 'failed', error_message = $2
                WHERE id = $1 AND status = 'pending'`,
              [
                row.id,
                `Payment window expired after ${PAYMENT_EXPIRY_MIN} minutes without confirmation ` +
                  `(gateway: ${parsed.label}). If EcoCash deducted you, contact support with reference ${row.pesepay_reference}.`,
              ]
            );
            if (updated.rowCount) {
              result.failed += 1;
              console.log(`[payments] expired ${row.id} after ${PAYMENT_EXPIRY_MIN}m (gateway ${parsed.label})`);
            } else {
              result.skipped += 1;
            }
          } else {
            result.skipped += 1;
          }
        }
      } catch (err) {
        // A mint failure leaves the row pending with its support marker; the
        // next sweep retries. Never let one payment abort the batch.
        result.skipped += 1;
        console.error(`[payments] reconcile failed for ${row.id}:`, err);
      }
      // Be polite to the gateway: at most ~5 checks per second.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [RECONCILE_LOCK_KEY]);
    } catch (err) {
      console.error('[payments] failed to release reconcile lock:', err);
    }
    lockClient.release();
  }
  return result;
}

let paymentReconcileTimer: ReturnType<typeof setInterval> | null = null;

export function startPaymentReconciliation(): void {
  if (process.env.ENABLE_PAYMENT_RECONCILE === 'false') return;
  if (paymentReconcileTimer) return;

  const run = () => {
    reconcilePendingPaymentsOnce()
      .then((r) => {
        if (r.completed || r.failed || r.refunded) {
          console.log(
            `[payments] sweep: scanned=${r.scanned} completed=${r.completed} failed=${r.failed} refunded=${r.refunded} skipped=${r.skipped}`
          );
        }
      })
      .catch((err) => console.error('[payments] sweep failed:', err));
  };

  // One pass shortly after boot: webhooks may have been missed while down.
  const firstRun = setTimeout(run, 90_000);
  if (typeof firstRun.unref === 'function') firstRun.unref();

  paymentReconcileTimer = setInterval(run, RECONCILE_INTERVAL_MIN * 60_000);
  if (typeof paymentReconcileTimer.unref === 'function') paymentReconcileTimer.unref();

  console.log(
    `Payment reconciliation scheduled every ${RECONCILE_INTERVAL_MIN} minute(s) for pending older than ${RECONCILE_MIN_AGE_MIN} minute(s).`
  );
}
