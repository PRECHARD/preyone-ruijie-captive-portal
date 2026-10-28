import type { PoolClient } from 'pg';

/**
 * Local voucher domain model.
 *
 * The captive portal must be able to redeem a PIN with **zero** dependence on
 * Ruijie Cloud: the customer is standing in front of the gateway, the tenant API
 * quota is frequently exhausted (`code 44`), and a redemption that waits on an
 * outbound HTTP call turns a paid voucher into a "rejected" screen.
 *
 * Everything in this module is either a pure function (testable without a
 * database) or a single local SQL statement. No Ruijie client is imported here,
 * deliberately — `tests/portalRedeem.test.ts` asserts the redemption path never
 * reaches for one.
 */

/** The columns the portal needs to authorise and describe a session. */
export interface LocalVoucherRow {
  id: string;
  code: string;
  duration_min: number;
  max_uses: number;
  used_count: number;
  expires_at: string | Date | null;
  data_limit_gb: number | string | null;
  is_uncapped: boolean;
  bandwidth_mbps_up: number;
  bandwidth_mbps_down: number;
  package_tier: string | null;
  is_disabled?: boolean | null;
  deleted_at?: string | Date | null;
}

export type VoucherRejection = 'invalid' | 'exhausted' | 'expired' | 'disabled';

export interface VoucherAccepted {
  ok: true;
  voucher: LocalVoucherRow;
}

export interface VoucherRejected {
  ok: false;
  reason: VoucherRejection;
  message: string;
}

export type VoucherVerdict = VoucherAccepted | VoucherRejected;

/**
 * Case-insensitive lookup, row-locked for the duration of the redemption
 * transaction so two phones racing on the same single-use PIN cannot both win.
 *
 * UPPER(code) matches the legacy Preyone codes while `code` itself keeps the
 * vendor's authoritative casing (Ruijie mints lowercase), which is what the
 * gateway must receive.
 */
export const VOUCHER_FOR_REDEMPTION_SQL = `
  SELECT id, code, duration_min, max_uses, used_count, expires_at,
         data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down,
         package_tier, is_disabled, deleted_at
    FROM vouchers
   WHERE UPPER(code) = $1
   FOR UPDATE`;

/** Trim + upper-case; the DB comparison is case-insensitive either way. */
export function normalizeVoucherCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, '').trim().toUpperCase();
}

export const REJECTION_MESSAGES: Record<VoucherRejection, string> = {
  invalid: 'Invalid Voucher code.',
  exhausted: 'Voucher has already reached maximum allocations.',
  expired: 'Voucher has expired.',
  disabled: 'This voucher is no longer valid.',
};

/**
 * Pure decision function — the single place that decides whether a stored row
 * may be redeemed. Kept side-effect free so the rules can be unit-tested
 * without a database.
 */
export function classifyLocalVoucher(row: LocalVoucherRow | null | undefined, now: Date = new Date()): VoucherVerdict {
  if (!row) return { ok: false, reason: 'invalid', message: REJECTION_MESSAGES.invalid };
  if (row.deleted_at) return { ok: false, reason: 'disabled', message: REJECTION_MESSAGES.disabled };
  if (row.is_disabled === true) return { ok: false, reason: 'disabled', message: REJECTION_MESSAGES.disabled };

  const maxUses = Number(row.max_uses);
  const usedCount = Number(row.used_count);
  if (Number.isFinite(maxUses) && Number.isFinite(usedCount) && usedCount >= maxUses) {
    return { ok: false, reason: 'exhausted', message: REJECTION_MESSAGES.exhausted };
  }

  if (row.expires_at) {
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < now.getTime()) {
      return { ok: false, reason: 'expired', message: REJECTION_MESSAGES.expired };
    }
  }

  return { ok: true, voucher: row };
}

/** Local-only read. Returns null when the PIN is unknown. */
export async function findVoucherForRedemption(
  client: Pick<PoolClient, 'query'>,
  code: string
): Promise<LocalVoucherRow | null> {
  const { rows } = await client.query<LocalVoucherRow>(VOUCHER_FOR_REDEMPTION_SQL, [code]);
  return rows[0] ?? null;
}

/** Consume one allocation. Returns the new used_count (or null if the row vanished). */
export async function markVoucherRedeemed(
  client: Pick<PoolClient, 'query'>,
  voucherId: string
): Promise<number | null> {
  const { rows } = await client.query<{ used_count: number }>(
    `UPDATE vouchers SET used_count = used_count + 1, activated_at = COALESCE(activated_at, NOW())
      WHERE id = $1
      RETURNING used_count`,
    [voucherId]
  );
  return rows.length > 0 ? Number(rows[0].used_count) : null;
}

export interface VoucherActivation {
  durationMin: number;
  dataLimitGb: number | null;
  isUncapped: boolean;
  bandwidthMbpsUp: number;
  bandwidthMbpsDown: number;
  packageTier: string | null;
}

/**
 * The session parameters handed straight back to the PWA on a successful local
 * redemption — no upstream round-trip, no waiting on Ruijie.
 */
export function buildVoucherActivation(row: LocalVoucherRow): VoucherActivation {
  const dataLimit = row.data_limit_gb == null ? null : Number(row.data_limit_gb);
  return {
    durationMin: Number(row.duration_min) || 60,
    dataLimitGb: dataLimit == null || !Number.isFinite(dataLimit) ? null : dataLimit,
    isUncapped: row.is_uncapped !== false,
    bandwidthMbpsUp: Number(row.bandwidth_mbps_up) || 2,
    bandwidthMbpsDown: Number(row.bandwidth_mbps_down) || 5,
    packageTier: row.package_tier ?? null,
  };
}

/** True when the package is a data-metered bundle (drives the RADIUS quota attr). */
export function isMeteredVoucher(row: LocalVoucherRow): boolean {
  const activation = buildVoucherActivation(row);
  return activation.isUncapped === false && activation.dataLimitGb != null && activation.dataLimitGb > 0;
}
