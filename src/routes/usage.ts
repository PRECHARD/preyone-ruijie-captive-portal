import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import {
  fetchRuijieAccountingRecords,
  listRuijieOnlineUsers,
} from '../services/ruijieService';
import { isRuijieCloudConfigured } from '../services/ruijieCloud';

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
 * ── Where the usage numbers come from ────────────────────────────────
 * Ruijie Cloud is queried live when a device MAC is supplied, because
 * vouchers.data_consumed_mb only fills in once syncAccountingData() can map a
 * station MAC to a voucher — and in WiFiDog mode it never can (no binding is
 * recorded). The customer does have their own MAC though: the gateway passes
 * client_mac and the success-page button carries it into /data. See
 * liveUsageByMac() below for the caching story.
 *
 * Security posture:
 *  - Rate limited; the PIN is the customer's secret and is what authenticates.
 *  - A MAC alone can NEVER look up usage — MACs are observable by anyone on
 *    the same L2 segment. It is not a credential and not even a WHERE filter
 *    (see the note in the handler): it only selects which station's live
 *    usage to display, and only after a valid PIN has already authenticated
 *    the caller.
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

// ── Live usage straight from Ruijie Cloud ───────────────────────────────────
// Ruijie's Open API returns station usage keyed by MAC (the accounting
// records all come back with code=null), and in WiFiDog mode the portal never
// learns which MAC belongs to which voucher, so the periodic
// syncAccountingData() can only attribute through voucher_devices /
// users.mac_address — both of which are empty for real customers. The
// customer, however, DOES have their own MAC: the gateway hands it over as
// client_mac and /data carries it through. So when one is supplied we ask
// Ruijie live for that station's usage rather than waiting for a sync that
// can never match.
//
// The whole tenant roster is fetched, not a per-MAC query — there is no
// single-MAC endpoint — and the result is cached so the PWA's 15s polling
// costs at most one Ruijie call per minute no matter how many devices poll.
let liveUsageCache: { at: number; byMac: Map<string, number> } | null = null;
const LIVE_USAGE_CACHE_MS = 60_000;

async function liveUsageByMac(): Promise<Map<string, number>> {
  if (!isRuijieCloudConfigured()) return new Map();
  if (liveUsageCache && Date.now() - liveUsageCache.at < LIVE_USAGE_CACHE_MS) {
    return liveUsageCache.byMac;
  }

  const byMac = new Map<string, number>();
  const bump = (mac: unknown, mb: unknown) => {
    const m = String(mac ?? '').toLowerCase().replace(/[^a-f0-9]/g, '');
    const n = Number(mb);
    if (m.length !== 12 || !Number.isFinite(n)) return;
    byMac.set(m, Math.max(byMac.get(m) ?? 0, n));
  };

  // Either call failing must not take the endpoint down — an empty map just
  // means we fall back to whatever the vouchers table already holds.
  const [online, records] = await Promise.all([
    // Only mac + usedMb are read here — skip the sta_users telemetry merge.
    listRuijieOnlineUsers({ stationTelemetry: false }).catch(() => []),
    fetchRuijieAccountingRecords().catch(() => []),
  ]);
  for (const u of online) bump(u.mac, u.usedMb);
  for (const r of records) bump(r.mac, r.usedMb);

  liveUsageCache = { at: Date.now(), byMac };
  return byMac;
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

    // A supplied MAC must be well-formed: it selects which Ruijie station's
    // usage to report, and garbage would silently yield "unknown" instead.
    if (req.query.mac || req.query.client_mac || req.query.clientMac) {
      if (!mac) {
        res.status(400).json({ error: 'invalid_mac' });
        return;
      }
    }

    // NOTE: the MAC is deliberately NOT a WHERE-clause filter here. In WiFiDog
    // mode the gateway authorises the MAC itself and never records the binding
    // locally, so the customer's own MAC will not exist in voucher_devices or
    // users — requiring a local match would 404 every real lookup. The voucher
    // PIN is what authenticates; the MAC only chooses which station's live
    // usage to display. A MAC alone still cannot look up anything.

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
              $2::text IS NOT NULL AND EXISTS (
                SELECT 1 FROM users u
                WHERE u.session_token = $2
                  AND UPPER(u.voucher_code) = UPPER(v.code)
              )
            )
          )
        ORDER BY v.activated_at DESC
        LIMIT 1`,
      [voucher || null, token || null]
    );

    // Same generic response for "no such voucher", "unredeemed" and "expired"
    // — do not reveal which check failed.
    if (rows.length === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const row = rows[0];

    const isUncapped = row.is_uncapped === true;

    // data_consumed_mb is NUMERIC megabytes written by the Ruijie accounting
    // reconciliation. In WiFiDog mode it stays NULL (see the module header), so
    // it is only a fallback for when a live lookup is impossible.
    let usedMB: number | null =
      row.data_consumed_mb != null ? parseFloat(row.data_consumed_mb) : null;
    let usageSource: 'ruijie_live' | 'voucher_accounting' | 'none' =
      usedMB != null ? 'voucher_accounting' : 'none';

    // Is this station online right now, as Ruijie sees it? Reported so the
    // portal badge reflects reality rather than the voucher's own validity.
    let onlineNow: boolean | null = null;

    if (mac) {
      try {
        const live = await liveUsageByMac();
        const liveMb = live.get(mac.toLowerCase());
        if (liveMb != null) {
          onlineNow = true;
          // Live is authoritative: prefer it, and take the larger of the two in
          // case the voucher figure was written by an earlier partial sync.
          if (usedMB == null || liveMb > usedMB) {
            usedMB = liveMb;
            usageSource = 'ruijie_live';
          }
        } else {
          // The roster was fetched successfully but has no trace of this MAC.
          onlineNow = false;
        }
      } catch {
        // Live lookup unavailable — leave usageSource as whatever the
        // vouchers table gave us and report onlineNow as unknown.
      }
    }

    let totalMB: number | null =
      row.data_limit_gb != null ? parseFloat(row.data_limit_gb) * 1024 : null;
    const totalBytes = totalMB != null ? totalMB * MB : null;
    const usedBytes = usedMB != null ? usedMB * MB : null;

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
      // Where the used figure came from. ruijie_live is the real accounting
      // number; voucher_accounting is the (possibly stale) reconciled column;
      // none means usage is genuinely unknown and the UI must not invent it.
      usageSource,
      // True/false when a MAC was supplied and the Ruijie roster was reachable,
      // null when we could not tell (no MAC given, or the lookup failed).
      onlineNow,
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
