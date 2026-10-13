import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';

/**
 * GET /api/check-usage
 *
 * Live bundle balance for the PWA usage portal (/data). Accepts either a
 * session `token` (the strongest identifier — a random UUID) or a `voucher`
 * PIN, optionally narrowed by the device `mac`.
 *
 * Deliberately NOT modelled on /api/auth/status's query-string session token
 * alone: the PWA is opened from the gateway redirect and may only have the
 * voucher + MAC that the gateway handed it. The voucher PIN is the customer's
 * secret, so it is treated as the authenticating credential here.
 *
 * Security posture:
 *  - Rate limited (the PWA polls, so the ceiling is generous but far below
 *    anything that would let voucher codes be brute-forced).
 *  - A MAC alone can NEVER look up usage — MACs are observable by anyone on
 *    the same L2 segment, so they are only ever used to narrow a voucher/token
 *    match, never to authenticate.
 *  - Errors are generic; a wrong voucher and an expired session both return
 *    the same `not_found`, so the endpoint cannot be used to enumerate codes.
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

    // Voucher or session token is mandatory. See the header note on why a MAC
    // on its own is not an acceptable credential.
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

    // Strip the separators the gateway uses (":" "-" ".") from both sides so
    // AA:BB:CC:DD:EE:FF and aa-bb-cc-dd-ee-ff compare equal to AABBCCDDEEFF.
    const MAC_SQL = (col: string) =>
      `UPPER(replace(replace(replace(coalesce(${col}, ''), ':', ''), '-', ''), '.', ''))`;

    const { rows } = await pool.query(
      `SELECT u.session_expires_at,
              u.voucher_code,
              wp.data_used_bytes,
              wp.data_quota_bytes,
              v.data_limit_gb,
              v.is_uncapped,
              p.tier_name AS package_tier
       FROM users u
       LEFT JOIN wispr_profiles wp ON wp.user_id = u.id
       LEFT JOIN vouchers v        ON UPPER(v.code) = UPPER(u.voucher_code)
       LEFT JOIN packages p        ON p.tier_name  = v.package_tier
       WHERE u.session_expires_at > NOW()
         AND ($1::text IS NULL OR UPPER(u.voucher_code) = UPPER($1))
         AND (
           $2::text IS NULL
           OR ${MAC_SQL('u.mac_address')} = $2
           OR EXISTS (
             SELECT 1 FROM wispr_profiles w2
             WHERE w2.user_id = u.id AND ${MAC_SQL('w2.mac_address')} = $2
           )
         )
         AND (
           $3::text IS NULL OR u.session_token = $3
         )
       ORDER BY u.session_expires_at DESC
       LIMIT 1`,
      [voucher || null, mac, token || null]
    );

    // Same generic response for "no such voucher", "wrong MAC" and "session
    // expired" — do not reveal which check failed.
    if (rows.length === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const row = rows[0];

    const usedBytes: number | null =
      row.data_used_bytes != null ? parseInt(row.data_used_bytes, 10) : null;

    // Quota can be stored either as an explicit byte count on the WISPr
    // profile or only as a GB figure on the voucher — derive whichever exists.
    let totalBytes: number | null =
      row.data_quota_bytes != null ? parseInt(row.data_quota_bytes, 10) : null;
    if (totalBytes == null && row.data_limit_gb != null) {
      totalBytes = Math.round(parseFloat(row.data_limit_gb) * GB);
    }

    const isUncapped = row.is_uncapped === true;

    // Uncapped bundles report an unlimited total; a capped bundle with no
    // known quota is reported as unknown rather than fabricated.
    const effectiveTotal = isUncapped ? null : totalBytes;
    const remainingBytes =
      usedBytes != null && effectiveTotal != null
        ? Math.max(effectiveTotal - usedBytes, 0)
        : null;

    const percentUsed =
      usedBytes != null && effectiveTotal != null && effectiveTotal > 0
        ? Math.min((usedBytes / effectiveTotal) * 100, 100)
        : null;

    const toMB = (b: number | null) => (b == null ? null : b / 1048576);

    res.json({
      active: true,
      voucherCode: row.voucher_code,
      packageTier: row.package_tier,
      bytesUsed: usedBytes,
      bytesTotal: effectiveTotal,
      usedMB: toMB(usedBytes),
      remainingMB: toMB(remainingBytes),
      totalMB: toMB(effectiveTotal),
      percentUsed: percentUsed != null ? Math.round(percentUsed * 10) / 10 : null,
      isUncapped,
      dataLimitGb: row.data_limit_gb,
      expiresAt: row.session_expires_at,
    });
  } catch (err) {
    console.error('check-usage error:', err);
    res.status(500).json({ error: 'usage_check_failed' });
  }
});
