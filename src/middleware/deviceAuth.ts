import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import {
  DEFAULT_LEASE_DAYS,
  fingerprintsMatch,
  hashFingerprint,
  isLeaseStale,
  leaseRemainingMs,
} from '../services/posLease';

export interface DeviceAuth {
  device_id: string;
  company_id: string | null;
  shop_id: number | null;
  /** True when the caller proved the hardware fingerprint bound at enrolment. */
  bound: boolean;
  /** Milliseconds left on the device's offline lease (0 when none/lapsed). */
  leaseRemainingMs: number;
}

declare global {
  namespace Express {
    interface Request {
      device?: DeviceAuth;
    }
  }
}

/** Header the till sends with every device-authenticated call. */
export const FINGERPRINT_HEADER = 'x-device-fingerprint';

function readFingerprint(req: Request): string | null {
  const raw = req.headers[FINGERPRINT_HEADER] ?? req.headers['x-preyone-fingerprint'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Device hardware auth middleware.
 *
 * Validates `Authorization: Bearer <device_token>` against active pos_devices
 * rows, then enforces the two properties the token alone cannot give us:
 *
 *   • hardware binding — when the device row carries a fingerprint hash, the
 *     request must present the same fingerprint. A copied token used on another
 *     machine is refused with 401 (it is an authentication failure, not a
 *     permission problem).
 *
 *   • offline lease — a device whose last check-in is older than its lease
 *     window, or whose minted lease has expired, is refused with 403
 *     `lease_expired` until it reconnects and re-mints. This is the cut-off that
 *     stops a suspended/lost till from selling forever offline.
 *
 * Must be used as async middleware (returns Promise<void>).
 */
export async function requireDeviceAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Device token required' });
    return;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Device token required' });
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, device_id, company_id, shop_id, status, last_seen_at, last_seen,
            fingerprint_hash, lease_expires_at, lease_days
       FROM pos_devices
      WHERE device_token = $1 AND status = 'active'`,
    [token]
  );
  const device = rows[0];
  if (!device) {
    res.status(401).json({ error: 'Invalid or revoked device token' });
    return;
  }

  // ── Hardware binding ────────────────────────────────────────────────────
  const fingerprint = readFingerprint(req);
  const presentedHash = hashFingerprint(fingerprint);
  const bound = Boolean(device.fingerprint_hash) && fingerprintsMatch(device.fingerprint_hash, presentedHash);
  if (device.fingerprint_hash && !bound) {
    res.status(401).json({
      error: fingerprint
        ? 'This device token is bound to different hardware.'
        : `Device fingerprint required (${FINGERPRINT_HEADER} header).`,
      code: 'DEVICE_FINGERPRINT_MISMATCH',
    });
    return;
  }

  // ── Offline lease cut-off ───────────────────────────────────────────────
  const leaseDays = Number(device.lease_days) || DEFAULT_LEASE_DAYS;
  const remaining = leaseRemainingMs(device.lease_expires_at);
  if (device.lease_expires_at && remaining <= 0) {
    res.status(403).json({
      error: 'Offline lease expired. Reconnect to the server to renew this till.',
      code: 'LEASE_EXPIRED',
    });
    return;
  }
  if (isLeaseStale(device.last_seen_at ?? device.last_seen, leaseDays)) {
    res.status(403).json({
      error: `No check-in for longer than the ${leaseDays}-day lease window. Reconnect to renew.`,
      code: 'LEASE_EXPIRED',
    });
    return;
  }

  // Touch the check-in clock only after every gate has passed, so a rejected
  // caller cannot keep a device looking alive.
  await pool.query(
    `UPDATE pos_devices SET last_seen_at = NOW(), last_seen = NOW() WHERE id = $1`,
    [device.id]
  ).catch(() => undefined);

  req.device = {
    device_id: device.device_id,
    company_id: device.company_id,
    shop_id: device.shop_id,
    bound,
    leaseRemainingMs: Math.max(0, remaining),
  };
  next();
}

/**
 * Scope a query's tenant to the authenticated device.
 * Returns null when the device has no company (unassigned hardware) — callers
 * must then refuse with 403 rather than falling back to "all companies".
 */
export function deviceTenant(req: Request): string | null {
  return req.device?.company_id ?? null;
}
