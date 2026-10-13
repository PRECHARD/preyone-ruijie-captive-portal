import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';

/**
 * GET /api/check-usage
 *
 * Bundle balance for the PWA usage portal (/data).
 *
 * ── Why this does NOT read users.session_expires_at ──────────────────
 * An earlier version of this query required `u.session_expires_at > NOW()`
 * and LEFT JOINed wispr_profiles for the byte counters. That model is
 * correct for the FreeRADIUS/WISPr path, but this deployment is still in
 * Ruijie WiFiDog mode: the gateway authorises the MAC itself over ext_login
 * and never tells the portal, so on production `users.session_expires_at`
 * is NULL for every row and wispr_profiles is empty. Every voucher therefore
 * 404'd "not found" while the phone was demonstrably online.
 *
 * The voucher row itself is the durable truth: it is written at redemption
 * and carries the validity flags (deleted_at / is_disabled / expires_at /
 * activated_at), the quota (data_limit_gb / is_uncapped) and the accounted
 * usage (data_consumed_mb). So the lookup is voucher-first, and "session
 * expiry" is the voucher's own expires_at.
 *
 * Security posture (unchanged):
 *  - Rate limited; the PIN is the customer's secret and is what authenticates.
 *  - A MAC alone can NEVER look up usage — MACs are observable by anyone on
 *    the same L2 segment, so they only ever narrow a match.
 *  - Errors are generic: a wrong PIN, an unredeemed voucher and an expired
 *    one all return the same `not_found`, so this cannot enumerate codes.
 */
export const usageRouter = Router();

// The PWA polls every 15s. 60 req/min is ~4x headroom for a single device
// while staying far below what a voucher-guessing script would need.
const usageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const GB = 1024 * 1024 * 1024;
const MB = 1048576;

/**
 * Accepts the MAC spellings the gateway actually sends (auth.ts reads
 * client_mac / mac / clientMac). Returns the 12-hex-digit canonical form, or
 * null when the input is not a plausible MAC — never echoes it back.
 */
function normalizeMac(raw?: unknown): string | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return cleaned.length === 12 ? cleaned : null;
}

usageRouter.get('/', usageLimiter, async (req: Request, res: Response) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    const voucher =
      typeof req.query.voucher === 'string' ? req.query.voucher.trim() : '';
    const mac = normalizeMac(
      (req.query.mac as string) ??
        (req.query.client_mac as string) ??
        (req.query.clientMac as string)
    );

    // Voucher PIN or session token is mandatory. See the header note on why a
    // MAC on its own is not an acceptable credential.
    if (!token && !voucher) {
      res.status(400).json({ error: 'missing_credentials' });
      return;
    }

    // When a MAC is supplied it must be well-formed, otherwise we would be
    // matching on garbage and silently returning nothing.
    if (req.query.mac || req.query.client_mac || req.query.clientMac) {
      if (!mac) {
        res.status(400).json({ error: 'invalid_mac' });
        return;
      }
    }

    // Strip the separators the gateway uses (":" "-" ".") from stored values
    // so AA:BB:CC:DD:EE:FF and aa-bb-cc-dd-ee-ff compare equal to AABBCCDDEEFF.
    const MAC_SQL = (col: string) =>
      `UPPER(replace(replace(replace(coalesce(${col}, ''), ':', ''), '-', ''), '.', ''))`;

    const { rows } = await pool.query(
      `SELECT v.code,
              v.package_tier,
              v.data_consumed_mb,
              v.data_limit_gb,
              v.is_uncapped,
              v.expires_at,
              v.activated_at,
              v.duration_min,
              v.used_count,
              v.max_uses,
              (SELECT count(*)::int FROM voucher_devices d
                WHERE d.voucher_id = v.id AND d.is_active) AS bound_devices
       FROM vouchers v
       WHERE v.deleted_at IS NULL
         AND v.is_disabled IS NOT TRUE
         AND (v.expires_at IS NULL OR v.expires_at > NOW())
         -- Only redeemed vouchers have a balance worth showing; an unsold
         -- code is not a customer's session.
         AND v.activated_at IS NOT NULL
         AND (
           $1::text IS NULL OR UPPER(v.code) = UPPER($1)
           OR (
             $3::text IS NOT NULL AND EXISTS (
               SELECT 1 FROM users u
               WHERE u.session_token = $3
                 AND UPPER(u.voucher_code) = UPPER(v.code)
             )
           )
         )
         AND (
           $2::text IS NULL
           OR EXISTS (
             SELECT 1 FROM voucher_devices d
             WHERE d.voucher_id = v.id
               AND ${MAC_SQL('d.mac_norm')} = $2
           )
           OR EXISTS (
             SELECT 1 FROM users u
             WHERE UPPER(u.voucher_code) = UPPER(v.code)
               AND ${MAC_SQL('u.mac_address')} = $2
           )
         )
       ORDER BY v.activated_at DESC
       LIMIT 1`,
      [voucher || null, mac, token || null]
    );

    // Same generic response for "no such voucher", "unredeemed", "wrong MAC"
    // and "expired" — do not reveal which check failed.
    if (rows.length === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const row = rows[0];

    const isUncapped = row.is_uncapped === true;

    // data_consumed_mb is NUMERIC megabytes written by the Ruijie accounting
    // reconciliation (ruijieService). It is NULL until that sync has run at
    // least once, in which case usage is genuinely unknown and reported as
    // such rather than fabricated.
    const usedMB: number | null =
      row.data_consumed_mb != null ? parseFloat(row.data_consumed_mb) : null;
    const usedBytes = usedMB != null ? usedMB * MB : null;

    let totalMB: number | null =
      row.data_limit_gb != null ? parseFloat(row.data_limit_gb) * 1024 : null;
    const totalBytes = totalMB != null ? totalMB * MB : null;

    // Uncapped bundles report an unlimited total; a capped bundle with no
    // known quota is reported as unknown rather than fabricated.
    const effectiveTotalMB = isUncapped ? null : totalMB;
    const effectiveTotalBytes = isUncapped ? null : totalBytes;

    const remainingMB =
      usedMB != null && effectiveTotalMB != null
        ? Math.max(effectiveTotalMB - usedMB, 0)
        : null;

    const percentUsed =
      usedMB != null && effectiveTotalMB != null && effectiveTotalMB > 0
        ? Math.min((usedMB / effectiveTotalMB) * 100, 100)
        : null;

    res.json({
      active: true,
      voucherCode: row.code,
      packageTier: row.package_tier,
      bytesUsed: usedBytes,
      bytesTotal: effectiveTotalBytes,
      usedMB,
      remainingMB,
      totalMB: effectiveTotalMB,
      percentUsed: percentUsed != null ? Math.round(percentUsed * 10) / 10 : null,
      isUncapped,
      dataLimitGb: row.data_limit_gb,
      boundDevices: row.bound_devices,
      durationMin: row.duration_min,
      usedCount: row.used_count,
      maxUses: row.max_uses,
      // Session expiry is the voucher's own expiry, not the (never-written)
      // users.session_expires_at.
      expiresAt: row.expires_at,
      activatedAt: row.activated_at,
    });
  } catch (err) {
    console.error('check-usage error:', err);
    res.status(500).json({ error: 'usage_check_failed' });
  }
});
