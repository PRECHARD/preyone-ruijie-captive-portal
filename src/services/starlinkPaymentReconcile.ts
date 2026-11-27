/**
 * Starlink-only payment verification and abandoned-checkout recovery.
 *
 * This deliberately mirrors the row-locked transaction in
 * /api/payments/pesepay/callback and never touches the WiFi `payments` table
 * or any invoice/POS handler. It is used by both the 2-24 hour sweep and the
 * authenticated customer "Verify Payment Now" action.
 */
import { pool } from '../db/pool';
import { applyStarlinkPayment } from '../db/starlink';
import {
  verifyPaymentStatus,
  PESEPAY_SUCCESS_STATUSES,
  PESEPAY_FAILED_STATUSES,
} from './pesepayService';
import { dispatchStarlinkPaymentReceipt } from './starlinkPaymentNotices';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECONCILE_LOCK_KEY = 'preyone:starlink_payment_reconcile';
const MIN_AGE_MIN = 2;
const MAX_AGE_HOURS = 24;
const BATCH = 100;
const AMOUNT_TOLERANCE = 0.01;

export class StarlinkIntentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type GatewayState = 'completed' | 'failed' | 'pending';

export interface StarlinkVerifyResult {
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  message: string;
  invoiceNumber?: string;
  providerReference?: string;
  alreadyPaid?: boolean;
  amount?: number;
}

export interface StarlinkVerifyOptions {
  /** Customer JWT id. When present the intent must belong to that customer. */
  customerId?: string;
  /** Sweep uses 2 minutes; manual verification accepts an immediate retry. */
  minAgeMinutes?: number;
  /** After this age a still-pending gateway response is closed locally. */
  maxAgeHours?: number;
  actor?: 'sweep' | 'customer';
}

export interface StarlinkReconcileResult {
  scanned: number;
  completed: number;
  failed: number;
  pending: number;
  skipped: number;
}

interface StarlinkIntentRow {
  id: string;
  reference: string;
  provider_reference: string | null;
  amount: number;
  status: string;
  target_id: string | null;
  created_at: string | Date;
  target_type: string;
  invoice_number: string | null;
  invoice_status: string | null;
  customer_id: string | null;
}

function interpretStatus(raw: unknown): { state: GatewayState; label: string } {
  const upper = String(raw ?? '').trim().toUpperCase();
  if (!upper) return { state: 'pending', label: 'pending' };
  if (PESEPAY_SUCCESS_STATUSES.includes(upper)) return { state: 'completed', label: upper };
  if (
    upper === 'REFUNDED' ||
    upper === 'REVERSED' ||
    upper === 'TIME_OUT' ||
    upper === 'TIMEOUT' ||
    PESEPAY_FAILED_STATUSES.includes(upper)
  ) {
    return { state: 'failed', label: upper };
  }
  // Unknown values are pending. A new gateway status must never settle money.
  return { state: 'pending', label: upper };
}

async function loadIntent(intentId: string, customerId?: string): Promise<StarlinkIntentRow> {
  if (!UUID_RE.test(intentId)) {
    throw new StarlinkIntentError(400, 'Invalid payment reference');
  }
  const { rows } = await pool.query(
    `SELECT i.id, i.reference, i.provider_reference, i.amount, i.status, i.target_id,
            i.target_type, i.created_at,
            inv.invoice_number, inv.status AS invoice_status, inv.customer_id
       FROM pesepay_intents i
       LEFT JOIN starlink_invoices inv ON inv.id = i.target_id
      WHERE i.id = $1 AND i.target_type = 'starlink'`,
    [intentId]
  );
  const row = (rows[0] as StarlinkIntentRow) ?? null;
  if (!row) throw new StarlinkIntentError(404, 'Payment not found');
  // Same 404 for a foreign intent so the endpoint cannot enumerate invoices.
  if (customerId && row.customer_id !== customerId) {
    throw new StarlinkIntentError(404, 'Payment not found');
  }
  return row;
}

function ageMinutes(row: StarlinkIntentRow): number {
  return (Date.now() - new Date(row.created_at).getTime()) / 60_000;
}

function pending(message: string, row: StarlinkIntentRow): StarlinkVerifyResult {
  return {
    status: 'PENDING',
    message,
    invoiceNumber: row.invoice_number ?? undefined,
    providerReference: row.provider_reference || row.reference,
  };
}

function failed(message: string, row: StarlinkIntentRow): StarlinkVerifyResult {
  return {
    status: 'FAILED',
    message,
    invoiceNumber: row.invoice_number ?? undefined,
    providerReference: row.provider_reference || row.reference,
  };
}

/** Marks intent + invoice terminal without deleting or rewriting audit rows. */
async function markIntentFailed(row: StarlinkIntentRow, reason: string): Promise<StarlinkVerifyResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT status FROM pesepay_intents WHERE id = $1 FOR UPDATE`,
      [row.id]
    );
    const locked = rows[0];
    if (!locked) {
      await client.query('ROLLBACK');
      throw new StarlinkIntentError(404, 'Payment not found');
    }
    const status = String(locked.status).toLowerCase();
    if (status === 'completed' || String(row.invoice_status) === 'PAID') {
      await client.query('COMMIT');
      return {
        status: 'SUCCESS',
        message: 'Payment was already confirmed by another check.',
        invoiceNumber: row.invoice_number ?? undefined,
        providerReference: row.provider_reference || row.reference,
        alreadyPaid: true,
      };
    }
    if (status !== 'failed') {
      await client.query(`UPDATE pesepay_intents SET status = 'failed' WHERE id = $1`, [row.id]);
    }
    await client.query(
      `UPDATE starlink_invoices
          SET status = 'FAILED',
              meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
                'payment_failure_reason', $2, 'failed_at', NOW()
              )
        WHERE id = $1 AND status = 'PENDING'`,
      [row.target_id, reason.slice(0, 400)]
    );
    await client.query('COMMIT');
    return failed(reason, row);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Same row-locked settlement shape as the Pesepay webhook. */
async function applyConfirmedPayment(
  row: StarlinkIntentRow,
  label: string
): Promise<StarlinkVerifyResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, reference, provider_reference, amount, target_id, status
         FROM pesepay_intents WHERE id = $1 FOR UPDATE`,
      [row.id]
    );
    const locked = (rows[0] as StarlinkIntentRow | undefined) ?? null;
    if (!locked) {
      await client.query('ROLLBACK');
      throw new StarlinkIntentError(404, 'Payment not found');
    }
    if (String(locked.status).toLowerCase() === 'completed') {
      await client.query('COMMIT');
      return {
        status: 'SUCCESS',
        message: 'Payment was already settled.',
        invoiceNumber: row.invoice_number ?? undefined,
        providerReference: row.provider_reference || row.reference,
        alreadyPaid: true,
      };
    }
    if (String(locked.status).toLowerCase() === 'failed') {
      await client.query('COMMIT');
      return failed('Payment was already closed. Start a new checkout to retry.', row);
    }

    const applied = await applyStarlinkPayment(
      client,
      {
        target_id: locked.target_id,
        amount: Number(locked.amount),
        provider_reference: row.provider_reference || null,
      },
      row.reference
    );

    await client.query(
      `UPDATE pesepay_intents
          SET status = 'completed', completed_at = NOW(),
              provider_reference = COALESCE($2, provider_reference)
        WHERE id = $1`,
      [locked.id, row.provider_reference || row.reference]
    );
    await client.query('COMMIT');

    // Strictly after commit; claim logic in the dispatcher makes this once-only.
    if (!applied.alreadyPaid && applied.receiptEventKey) {
      void dispatchStarlinkPaymentReceipt(applied.receiptEventKey);
    }

    return {
      status: 'SUCCESS',
      message: `Payment confirmed (${label}). Your invoice is paid and credits are applied.`,
      invoiceNumber: applied.invoiceNumber,
      providerReference: row.provider_reference || row.reference,
      alreadyPaid: applied.alreadyPaid,
      amount: applied.amount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Re-check one Starlink intent with the gateway and apply its terminal state.
 * A gateway amount outside ±$0.01 is never credited.
 */
export async function verifyStarlinkPaymentIntent(
  intentId: string,
  options: StarlinkVerifyOptions = {}
): Promise<StarlinkVerifyResult> {
  const row = await loadIntent(intentId, options.customerId);
  const status = String(row.status).toLowerCase();
  if (status === 'completed' || String(row.invoice_status) === 'PAID') {
    return {
      status: 'SUCCESS',
      message: 'Payment is already confirmed.',
      invoiceNumber: row.invoice_number ?? undefined,
      providerReference: row.provider_reference || row.reference,
      alreadyPaid: true,
    };
  }
  if (status === 'failed' || String(row.invoice_status) === 'FAILED') {
    return failed('Payment was not completed. Start a new checkout to retry.', row);
  }

  const mins = ageMinutes(row);
  if (options.minAgeMinutes && mins < options.minAgeMinutes) {
    return pending('Payment is still processing. Please try again in a moment.', row);
  }

  // The checkout stores both our merchant reference and the gateway's own
  // reference. Older rows may only have one of them accepted by check-payment.
  let check = await verifyPaymentStatus(row.provider_reference || row.reference);
  if (!check.found && row.reference && row.reference !== row.provider_reference) {
    check = await verifyPaymentStatus(row.reference);
  }

  if (!check.found) {
    if (options.maxAgeHours && mins >= options.maxAgeHours * 60) {
      return markIntentFailed(row, 'Payment window expired — the gateway has no record of this checkout.');
    }
    return pending('The payment gateway has no record of this checkout yet.', row);
  }

  const parsed = interpretStatus(check.status);
  if (parsed.state === 'pending') {
    if (options.maxAgeHours && mins >= options.maxAgeHours * 60) {
      return markIntentFailed(row, `Payment window expired (gateway: ${parsed.label}).`);
    }
    return pending(`Payment is still processing (gateway: ${parsed.label}).`, row);
  }
  if (parsed.state === 'failed') {
    return markIntentFailed(row, `Gateway reported ${parsed.label}.`);
  }

  if (check.amount !== undefined && check.amount !== null) {
    const received = Number(check.amount);
    if (Number.isFinite(received) && Math.abs(Number(row.amount) - received) > AMOUNT_TOLERANCE) {
      if (options.maxAgeHours && mins >= options.maxAgeHours * 60) {
        return markIntentFailed(row, 'Payment amount did not match the invoice; nothing was credited.');
      }
      return pending('The confirmed amount does not match this invoice. No credit was applied.', row);
    }
  }

  return applyConfirmedPayment(row, parsed.label);
}

/** Sweep pending Starlink intents aged 2 minutes up to 24 hours. */
export async function reconcileStarlinkIntentsOnce(): Promise<StarlinkReconcileResult> {
  const result: StarlinkReconcileResult = {
    scanned: 0,
    completed: 0,
    failed: 0,
    pending: 0,
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
      `SELECT id FROM pesepay_intents
        WHERE target_type = 'starlink'
          AND LOWER(status) = 'pending'
          AND created_at < NOW() - INTERVAL '2 minutes'
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at ASC
        LIMIT $1`,
      [BATCH]
    );

    for (const row of rows as Array<{ id: string }>) {
      result.scanned += 1;
      try {
        const outcome = await verifyStarlinkPaymentIntent(row.id, {
          minAgeMinutes: MIN_AGE_MIN,
          maxAgeHours: MAX_AGE_HOURS,
          actor: 'sweep',
        });
        if (outcome.status === 'SUCCESS') result.completed += 1;
        else if (outcome.status === 'FAILED') result.failed += 1;
        else result.pending += 1;
        if (outcome.status !== 'PENDING') {
          console.log(`[starlink] reconciled ${row.id} -> ${outcome.status} (${outcome.message})`);
        }
      } catch (err) {
        result.skipped += 1;
        console.error(`[starlink] reconciliation failed for ${row.id}:`, err);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [RECONCILE_LOCK_KEY]);
    } catch (err) {
      console.error('[starlink] failed to release reconciliation lock:', err);
    }
    lockClient.release();
  }
  return result;
}
