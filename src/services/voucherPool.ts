import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { isRuijieCloudConfigured, mintRuijieVoucherForTier } from './ruijieMint';

function positiveInt(raw: string | undefined, fallback: number, min: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
}

export const VOUCHER_POOL_TARGET = positiveInt(process.env.VOUCHER_POOL_TARGET, 10, 1);
export const VOUCHER_POOL_LOW_WATERMARK = positiveInt(process.env.VOUCHER_POOL_LOW_WATERMARK, 5, 0);
const VOUCHER_POOL_LOCK = 'preyone:voucher-pool';
const DEFAULT_INTERVAL_MIN = 15;

export interface VoucherPoolTierStatus {
  tierName: string;
  available: number;
  target: number;
  lowWatermark: number;
}

export interface VoucherPoolStatus {
  configured: boolean;
  tiers: VoucherPoolTierStatus[];
  totalAvailable: number;
}

export interface VoucherPoolTierResult {
  tierName: string;
  before: number;
  after: number;
  minted: number;
  errors: string[];
}

export interface VoucherPoolRefillResult {
  skipped: boolean;
  reason?: string;
  locked: boolean;
  tiers: VoucherPoolTierResult[];
}

export interface ClaimedPoolVoucher {
  code_no: string;
  tier_name: string | null;
  user_group_id: string | null;
  profile_uuid: string | null;
  ruijie_expiry: string | number | null;
}

const ACTIVE_TIERS_SQL = `
  SELECT vp.tier_name
    FROM voucher_profiles vp
    JOIN packages p ON p.tier_name = vp.tier_name AND p.deleted_at IS NULL
   WHERE vp.active = TRUE
   ORDER BY vp.tier_name`;

const AVAILABLE_COUNT_SQL = `
  SELECT COUNT(*)::int AS count
    FROM ruijie_vouchers
   WHERE tier_name = $1
     AND pool_status = 'available'
     AND payment_id IS NULL
     AND (ruijie_expiry IS NULL OR ruijie_expiry > (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)`;

async function availableCount(client: PoolClient, tierName: string): Promise<number> {
  const { rows } = await client.query(AVAILABLE_COUNT_SQL, [tierName]);
  return Number(rows[0]?.count ?? 0);
}

export async function getVoucherPoolStatus(): Promise<VoucherPoolStatus> {
  if (!isRuijieCloudConfigured()) {
    return { configured: false, tiers: [], totalAvailable: 0 };
  }
  const { rows } = await pool.query(`
    SELECT vp.tier_name, COUNT(rv.id)::int AS available
      FROM voucher_profiles vp
      JOIN packages p ON p.tier_name = vp.tier_name AND p.deleted_at IS NULL
      LEFT JOIN ruijie_vouchers rv
        ON rv.tier_name = vp.tier_name
       AND rv.pool_status = 'available'
       AND rv.payment_id IS NULL
       AND (rv.ruijie_expiry IS NULL OR rv.ruijie_expiry > (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
     WHERE vp.active = TRUE
     GROUP BY vp.tier_name
     ORDER BY vp.tier_name`);
  const tiers = rows.map((row) => ({
    tierName: String(row.tier_name),
    available: Number(row.available ?? 0),
    target: VOUCHER_POOL_TARGET,
    lowWatermark: VOUCHER_POOL_LOW_WATERMARK,
  }));
  return {
    configured: true,
    tiers,
    totalAvailable: tiers.reduce((sum, tier) => sum + tier.available, 0),
  };
}

export async function claimPooledVoucher(
  client: PoolClient,
  tierName: string,
  paymentId: string
): Promise<ClaimedPoolVoucher | null> {
  const { rows } = await client.query(
    `WITH candidate AS (
       SELECT id
         FROM ruijie_vouchers
        WHERE tier_name = $1
          AND pool_status = 'available'
          AND payment_id IS NULL
          AND (ruijie_expiry IS NULL OR ruijie_expiry > (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
        ORDER BY created_at ASC, code_no ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE ruijie_vouchers rv
        SET pool_status = 'assigned',
            payment_id = $2,
            assigned_at = NOW(),
            source = 'online'
       FROM candidate c
      WHERE rv.id = c.id
      RETURNING rv.code_no, rv.tier_name, rv.user_group_id, rv.profile_uuid, rv.ruijie_expiry`,
    [tierName, paymentId]
  );
  return (rows[0] as ClaimedPoolVoucher | undefined) ?? null;
}

/**
 * Staff-sale counterpart of claimPooledVoucher.
 *
 * Ruijie's API quota can be exhausted for minutes at a time ("code 44: Too many
 * requests"), and a sale must not fail just because a mint is briefly blocked.
 * The pool already holds genuine, tier-matched codes minted ahead of time, so a
 * throttled mint falls back to the oldest usable one. No payment_id is set —
 * this is a counter sale, not an online checkout.
 */
export async function claimPooledVoucherForStaff(
  tierName: string,
  comment?: string | null
): Promise<ClaimedPoolVoucher | null> {
  const { rows } = await pool.query(
    `WITH candidate AS (
       SELECT id
         FROM ruijie_vouchers
        WHERE tier_name = $1
          AND pool_status = 'available'
          AND payment_id IS NULL
          AND (ruijie_expiry IS NULL OR ruijie_expiry > (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
        ORDER BY created_at ASC, code_no ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE ruijie_vouchers rv
        SET pool_status = 'assigned',
            assigned_at = NOW(),
            source = 'staff',
            comment = COALESCE($2, rv.comment)
       FROM candidate c
      WHERE rv.id = c.id
      RETURNING rv.code_no, rv.tier_name, rv.user_group_id, rv.profile_uuid, rv.ruijie_expiry`,
    [tierName, comment ?? null]
  );
  return (rows[0] as ClaimedPoolVoucher | undefined) ?? null;
}

/**
 * Give unused pool claims back to stock.
 *
 * A claim is committed the moment it is made, so a sale that aborts afterwards
 * (a drained pool mid-bulk, a rolled-back transaction, a duplicate code) would
 * otherwise strand real inventory in `pool_status='assigned'` with no voucher
 * row behind it — never sellable again. Codes that are not from the pool are
 * ignored, so callers can pass every mint they hold.
 */
export async function releasePooledVouchers(codeNos: string[]): Promise<number> {
  if (codeNos.length === 0) return 0;
  const { rowCount } = await pool.query(
    `UPDATE ruijie_vouchers
        SET pool_status = 'available',
            assigned_at = NULL,
            source = 'seed',
            comment = 'Pool ' || COALESCE(tier_name, '')
      WHERE code_no = ANY($1::text[])
        AND pool_status = 'assigned'
        AND payment_id IS NULL
        AND source = 'staff'`,
    [codeNos]
  );
  return rowCount ?? 0;
}

export async function refillVoucherPool(
  options: { force?: boolean } = {}
): Promise<VoucherPoolRefillResult> {
  if (!isRuijieCloudConfigured()) {
    return { skipped: true, reason: 'Ruijie Cloud is not configured', locked: false, tiers: [] };
  }

  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked`,
      [VOUCHER_POOL_LOCK]
    );
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) {
      return { skipped: true, reason: 'Another worker is refilling the pool', locked: false, tiers: [] };
    }

    const { rows: tierRows } = await client.query(ACTIVE_TIERS_SQL);
    const results: VoucherPoolTierResult[] = [];

    for (const row of tierRows) {
      const tierName = String(row.tier_name);
      const before = await availableCount(client, tierName);
      if (!options.force && before > VOUCHER_POOL_LOW_WATERMARK) {
        results.push({ tierName, before, after: before, minted: 0, errors: [] });
        continue;
      }

      const errors: string[] = [];
      let minted = 0;
      const deficit = Math.max(0, VOUCHER_POOL_TARGET - before);
      for (let i = 0; i < deficit; i++) {
        try {
          const voucher = await mintRuijieVoucherForTier(tierName, `Pool ${tierName}`);
          const inserted = await client.query(
            `INSERT INTO ruijie_vouchers
               (code_no, tier_name, user_group_id, profile_uuid, ruijie_expiry, payment_id,
                source, comment, pool_status)
             VALUES ($1, $2, $3, $4, $5, NULL, 'seed', $6, 'available')
             ON CONFLICT (code_no) DO NOTHING
             RETURNING id`,
            [
              voucher.codeNo,
              tierName,
              voucher.userGroupId,
              voucher.profile,
              voucher.expiryTime ?? null,
              voucher.comment,
            ]
          );
          if (inserted.rowCount) minted += 1;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
          break;
        }
      }

      results.push({
        tierName,
        before,
        after: await availableCount(client, tierName),
        minted,
        errors,
      });
    }

    return { skipped: false, locked: true, tiers: results };
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [VOUCHER_POOL_LOCK]);
      } catch {
      }
    }
    client.release();
  }
}

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerStartupTimer: ReturnType<typeof setTimeout> | null = null;
let workerTicking = false;

export function startVoucherPoolWorker(): void {
  if (workerTimer || process.env.ENABLE_VOUCHER_POOL === 'false') return;

  const intervalMin = Math.max(1, Number(process.env.VOUCHER_POOL_INTERVAL_MIN ?? DEFAULT_INTERVAL_MIN));

  const tick = () => {
    if (workerTicking) return;
    workerTicking = true;
    refillVoucherPool()
      .then((result) => {
        if (!result.skipped) {
          const minted = result.tiers.reduce((sum, tier) => sum + tier.minted, 0);
          if (minted > 0) console.log(`[voucher-pool] refilled ${minted} voucher(s)`);
          for (const tier of result.tiers) {
            if (tier.errors.length > 0) {
              console.error(`[voucher-pool] ${tier.tierName}: ${tier.errors[0]}`);
            }
          }
        }
      })
      .catch((err) => console.error('[voucher-pool] refill failed', err))
      .finally(() => {
        workerTicking = false;
      });
  };

  workerStartupTimer = setTimeout(tick, 15_000);
  workerStartupTimer.unref?.();
  workerTimer = setInterval(tick, intervalMin * 60_000);
  workerTimer.unref?.();
  console.log(`Voucher stock pool scheduled every ${intervalMin} minute(s).`);
}
