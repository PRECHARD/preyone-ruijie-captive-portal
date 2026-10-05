import { pool } from '../db/pool';
import { findRuijieProfile, isRuijieCloudConfigured } from './ruijieMint';

/**
 * Multi-device voucher binding.
 *
 * A voucher code authorizes more than one device. Devices are attached here
 * rather than at redemption because the only trustworthy source of a client MAC
 * is the gateway itself, which first reveals it on a RADIUS auth request.
 *
 * Device limit precedence: Ruijie Cloud's user group `no_of_device` wins,
 * because Ruijie is the network's actual enforcement plane — the gateway checks
 * it before any of our attributes are applied. `vouchers.max_devices` is the
 * fallback when Ruijie is not configured.
 */

/** Reduce any MAC spelling to 12 uppercase hex chars, or null if unusable. */
export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = mac.replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(hex) ? hex : null;
}

export interface VoucherDevice {
  id: string;
  voucherId: string;
  voucherCode: string;
  userId: string | null;
  macAddress: string;
  label: string | null;
  isActive: boolean;
  boundAt: string;
  lastSeenAt: string | null;
}

/**
 * How many devices a voucher may authorize.
 * Falls back to 1 so an unmapped/misconfigured voucher is never open-ended.
 */
export async function getDeviceLimit(
  tierName: string | null,
  maxDevices: number | null
): Promise<number> {
  try {
    if (tierName && isRuijieConfigured()) {
      const profile = await findRuijieProfile(tierName);
      if (profile?.no_of_device && profile.no_of_device > 0) {
        return profile.no_of_device;
      }
    }
  } catch (err) {
    console.error('Device limit lookup fell back to local value:', err);
  }
  if (maxDevices && maxDevices > 0) return maxDevices;
  return 1;
}

// Overridable so tests can exercise the Ruijie-precedence branch without
// standing up the whole module graph. Defaults to the real check.
let ruijieConfigured: (() => boolean) | null = null;
export function __setRuijieConfiguredProbe(fn: (() => boolean) | null): void {
  ruijieConfigured = fn;
}
function isRuijieConfigured(): boolean {
  return ruijieConfigured ? ruijieConfigured() : isRuijieCloudConfigured();
}

export type BindOutcome =
  | { ok: true; bound: boolean; activeDevices: number; limit: number }
  | { ok: false; reason: 'device_limit_reached'; activeDevices: number; limit: number }
  | { ok: false; reason: 'invalid_mac' };

/**
 * Attach a MAC to a voucher, idempotently.
 *
 * Re-authenticating an already-bound device is always allowed and refreshes
 * last_seen_at — a device that is already on the voucher must never be locked
 * out by its own reconnection.
 */
export async function bindDevice(input: {
  voucherId: string;
  voucherCode: string;
  tierName: string | null;
  maxDevices: number | null;
  mac: string;
  userId?: string | null;
  label?: string | null;
}): Promise<BindOutcome> {
  const macNorm = normalizeMac(input.mac);
  if (!macNorm) return { ok: false, reason: 'invalid_mac' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the voucher row so two devices authenticating simultaneously cannot
    // both read "1 of 1 used" and both insert.
    const vres = await client.query(
      `SELECT id, package_tier, max_devices FROM vouchers WHERE id = $1 FOR UPDATE`,
      [input.voucherId]
    );
    if (vres.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid_mac' };
    }
    const voucher = vres.rows[0];
    const limit = await getDeviceLimit(voucher.package_tier ?? input.tierName, voucher.max_devices);

    const existing = await client.query(
      `SELECT id, is_active FROM voucher_devices
       WHERE voucher_id = $1 AND mac_norm = $2`,
      [input.voucherId, macNorm]
    );

    if (existing.rows.length > 0) {
      // Reconnect of a known device: reactivate if it had been unbound, but do
      // not consume another slot.
      await client.query(
        `UPDATE voucher_devices
         SET is_active = TRUE, last_seen_at = NOW(), unbound_at = NULL,
             user_id = COALESCE($3, user_id)
         WHERE id = $1`,
        [existing.rows[0].id, input.userId ?? null]
      );
      const count = await countActiveDevices(client, input.voucherId);
      await client.query('COMMIT');
      return { ok: true, bound: false, activeDevices: count, limit };
    }

    const count = await countActiveDevices(client, input.voucherId);
    if (count >= limit) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'device_limit_reached', activeDevices: count, limit };
    }

    await client.query(
      `INSERT INTO voucher_devices
         (voucher_id, voucher_code, user_id, mac_address, mac_norm, label, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        input.voucherId,
        input.voucherCode,
        input.userId ?? null,
        input.mac,
        macNorm,
        input.label ?? null,
      ]
    );
    await client.query('COMMIT');
    return { ok: true, bound: true, activeDevices: count + 1, limit };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function countActiveDevices(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  voucherId: string
): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::int AS n FROM voucher_devices WHERE voucher_id = $1 AND is_active`,
    [voucherId]
  );
  return res.rows[0]?.n ?? 0;
}

export async function listDevices(voucherId: string): Promise<VoucherDevice[]> {
  const { rows } = await pool.query(
    `SELECT id, voucher_id, voucher_code, user_id, mac_address, label, is_active,
            bound_at, last_seen_at
     FROM voucher_devices
     WHERE voucher_id = $1
     ORDER BY is_active DESC, bound_at ASC`,
    [voucherId]
  );
  // Map snake_case columns to the camelCase shape VoucherDevice promises, so
  // callers never have to remember which layer renamed what.
  return rows.map((r: any) => ({
    id: r.id,
    voucherId: r.voucher_id,
    voucherCode: r.voucher_code,
    userId: r.user_id,
    macAddress: r.mac_address,
    label: r.label,
    isActive: r.is_active,
    boundAt: r.bound_at,
    lastSeenAt: r.last_seen_at,
  }));
}

/**
 * Release a device slot. The row is kept (deactivated) rather than deleted so
 * the audit trail survives and re-binding stays idempotent.
 */
export async function unbindDevice(voucherId: string, mac: string): Promise<boolean> {
  const macNorm = normalizeMac(mac);
  if (!macNorm) return false;
  const { rowCount } = await pool.query(
    `UPDATE voucher_devices
     SET is_active = FALSE, unbound_at = NOW()
     WHERE voucher_id = $1 AND mac_norm = $2 AND is_active`,
    [voucherId, macNorm]
  );
  return (rowCount ?? 0) > 0;
}