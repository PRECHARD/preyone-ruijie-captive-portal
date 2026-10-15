import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import {
  fetchRuijieAccountingRecords,
  listRuijieOnlineUsers,
} from '../services/ruijieService';
import { isRuijieCloudConfigured, getAllRuijieVouchers } from '../services/ruijieCloud';
import type { RuijieVoucher } from '../services/ruijieCloud';

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
 * Three sources are merged by MAX — never by preference, so a stale-but-real
 * figure is never replaced by a fresher-but-zero one and we never
 * under-report:
 *
 *  1. Ruijie's own per-voucher counters (voucher/getList → quota/usedQuota,
 *     keyed by the voucher CODE). Verified live 2026-10-15: all 108 Ruijie
 *     vouchers fetch in 2 pages, every local code matches, 62 carry non-zero
 *     usage. This is the only source that works with a PIN alone, and the
 *     gateway enforces the bundle against exactly these counters — so it is
 *     what lets a customer on /data watch their balance while the portal is
 *     not yet in the auth path and no MAC binding exists locally.
 *  2. The live station roster, when a device MAC is supplied (the gateway
 *     passes client_mac and the success-page button carries it into /data).
 *  3. vouchers.data_consumed_mb, the reconciled column — a fallback only,
 *     because syncAccountingData() needs a MAC binding that WiFiDog mode
 *     never records.
 *
 * A code our DB has never seen (a Ruijie-minted staff sale redeemed on
 * Ruijie's own portal) is answered straight from Ruijie too — but only when
 * the voucher shows real customer activity (login minutes / usage / a live
 * client), so unsold stock cannot be probed for existence. See
 * ruijieOnlyResponse() below. liveUsageByMac() holds the caching story.
 *
 * Security posture:
 *  - Rate limited; the PIN is the customer's secret and is what authenticates.
 *  - A MAC alone can NEVER look up usage — MACs are observable by anyone on
 *    the same L2 segment. It is not a credential and not even a WHERE filter
 *    (see the note in the handler): it only selects which station's live
 *    usage to display, and only after a valid PIN has already authenticated
 *    the caller.
 *  - Errors are generic: a wrong PIN, an unredeemed voucher and an expired
 *    one all return the same `not_found`, so this cannot enumerate codes —
 *    and a Ruijie-only code answers only with customer activity on it, so
 *    Ruijie-side stock is equally unprobeable.
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

// ── Ruijie's own per-voucher accounting ─────────────────────────────────────
// voucher/getList reports quota/usedQuota/usedTime keyed by the voucher CODE
// (see module header). One cached roster fetch — 2 getList pages at
// pageSize=100 for the current 108 vouchers — serves every lookup for a
// minute, so the PWA's 15s polling and even a guessing script cost at most
// one upstream pair per minute.
let voucherCache: { at: number; byCode: Map<string, RuijieVoucher> } | null = null;
const VOUCHER_CACHE_MS = 60_000;

async function ruijieVoucherByCode(rawCode: string): Promise<RuijieVoucher | null> {
  const code = rawCode.trim().toLowerCase();
  if (!code || !isRuijieCloudConfigured()) return null;
  if (!voucherCache || Date.now() - voucherCache.at >= VOUCHER_CACHE_MS) {
    try {
      const all = await getAllRuijieVouchers();
      const byCode = new Map<string, RuijieVoucher>();
      for (const v of all) {
        const key = (v.voucherCode || v.codeNo || '').trim().toLowerCase();
        if (key && !byCode.has(key)) byCode.set(key, v);
      }
      voucherCache = { at: Date.now(), byCode };
    } catch {
      // Refresh failed: keep serving the last roster (bounded staleness)
      // rather than collapsing every lookup to "unknown" for one blip, but
      // still advance the clock so a hard outage cannot turn each 15s poll
      // into a pair of upstream calls.
      if (!voucherCache) return null;
      voucherCache = { at: Date.now(), byCode: voucherCache.byCode };
    }
  }
  return voucherCache.byCode.get(code) ?? null;
}

// Test-only: both module caches outlive a single request by design.
export function __resetUsageCachesForTests(): void {
  liveUsageCache = null;
  voucherCache = null;
}

// Response for a code Ruijie knows but our DB does not (handled in the
// handler's not_found branch). The field set mirrors the local path so the
// PWA renders it unchanged; anything we genuinely cannot know locally is
// null rather than invented.
function ruijieOnlyResponse(rv: RuijieVoucher, typed: string) {
  const usedMB = rv.usedQuotaMb ?? null;
  const totalMB = rv.quotaMb ?? null;
  const remainingMB =
    usedMB != null && totalMB != null ? Math.max(totalMB - usedMB, 0) : null;
  const percentUsed =
    usedMB != null && totalMB != null && totalMB > 0
      ? Math.min((usedMB / totalMB) * 100, 100)
      : null;
  return {
    active: true,
    voucherCode: rv.voucherCode || rv.codeNo || typed.trim(),
    packageTier: rv.packageName ?? null,
    bytesUsed: usedMB != null ? usedMB * MB : null,
    bytesTotal: totalMB != null ? totalMB * MB : null,
    usedMB,
    remainingMB,
    totalMB,
    percentUsed: percentUsed != null ? Math.round(percentUsed * 10) / 10 : null,
    isUncapped: false,
    dataLimitGb: totalMB != null ? totalMB / 1024 : null,
    usageSource: usedMB != null ? ('ruijie_voucher' as const) : ('none' as const),
    onlineNow: rv.currentClients != null ? rv.currentClients > 0 : null,
    boundDevices: null,
    durationMin: rv.timePeriodMin ?? null,
    usedCount: null,
    maxUses: null,
    expiresAt: rv.expiryTime ? new Date(rv.expiryTime).toISOString() : null,
    activatedAt: rv.loginTime ? new Date(rv.loginTime).toISOString() : null,
  };
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
      // Not in our DB. While the portal is not in the auth path a customer
      // can hold a Ruijie-minted code (staff sale redeemed on Ruijie's own
      // portal) that never produced a local row — ask Ruijie for the code
      // itself, gated on real customer activity so unsold stock stays
      // unprobeable (see module header).
      if (voucher) {
        const rv = await ruijieVoucherByCode(voucher);
        const hasActivity =
          rv != null &&
          ((rv.usedTimeMin ?? 0) > 0 ||
            (rv.usedQuotaMb ?? 0) > 0 ||
            (rv.currentClients ?? 0) > 0);
        const enabled = rv != null && (rv.disableStatus ?? 0) === 0;
        const expired = rv != null && rv.expiryTime != null && rv.expiryTime <= Date.now();
        if (rv && hasActivity && enabled && !expired) {
          res.json(ruijieOnlyResponse(rv, voucher));
          return;
        }
      }
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const row = rows[0];

    // Ruijie's own counters for this code (null when the cloud is not
    // configured / unreachable / the code is unknown there). Consulted first:
    // it is the number the gateway enforces and the only one that exists
    // without a local MAC binding.
    const rv = await ruijieVoucherByCode(row.code);

    const isUncapped = row.is_uncapped === true;

    // Best figure seen so far, with its provenance. Sources merge by MAX (see
    // module header): a stale-but-real number is never swapped for a fresher
    // zero, so this can only overstate freshness, never understate usage.
    let usedMB: number | null = null;
    let usageSource: 'ruijie_live' | 'ruijie_voucher' | 'voucher_accounting' | 'none' = 'none';
    const offer = (mb: unknown, source: typeof usageSource): void => {
      const n = typeof mb === 'number' ? mb : parseFloat(String(mb));
      if (!Number.isFinite(n)) return;
      if (usedMB == null || n > usedMB) {
        usedMB = n;
        usageSource = source;
      }
    };
    offer(rv?.usedQuotaMb, 'ruijie_voucher');
    // data_consumed_mb is NUMERIC megabytes written by the Ruijie accounting
    // reconciliation; NULL for every voucher syncAccountingData() could not
    // attribute (see module header).
    offer(row.data_consumed_mb, 'voucher_accounting');

    // Is this station online right now, as Ruijie sees it? Reported so the
    // portal badge reflects reality rather than the voucher's own validity.
    let onlineNow: boolean | null = null;

    if (mac) {
      try {
        const live = await liveUsageByMac();
        const liveMb = live.get(mac.toLowerCase());
        if (liveMb != null) {
          onlineNow = true;
          // Live roster wins when it is the larger figure (same MAX rule as
          // above — e.g. session bytes ahead of the quota reconciliation).
          if (usedMB == null || liveMb > usedMB) {
            usedMB = liveMb;
            usageSource = 'ruijie_live';
          }
        } else {
          // The roster was fetched successfully but has no trace of this MAC.
          onlineNow = false;
        }
      } catch {
        // Live lookup unavailable — leave usageSource as whatever we already
        // have and report onlineNow as unknown (or Ruijie's client count below).
      }
    }

    // PIN-only online signal: Ruijie reports the live client count per
    // voucher, so a customer who never passed a MAC still gets a real answer.
    if (onlineNow == null && rv?.currentClients != null) {
      onlineNow = rv.currentClients > 0;
    }

    // Quota: Ruijie's counter is what the gateway enforces; the local
    // data_limit_gb is the fallback when Ruijie does not know the code.
    let totalMB: number | null =
      rv?.quotaMb != null
        ? rv.quotaMb
        : row.data_limit_gb != null
          ? parseFloat(row.data_limit_gb) * 1024
          : null;
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
      packageTier: row.package_tier ?? rv?.packageName ?? null,
      bytesUsed: usedBytes,
      bytesTotal: effectiveTotalBytes,
      usedMB,
      remainingMB,
      totalMB: effectiveTotalMB,
      percentUsed: percentUsed != null ? Math.round(percentUsed * 10) / 10 : null,
      isUncapped,
      dataLimitGb: row.data_limit_gb,
      // Where the used figure came from. ruijie_voucher is Ruijie's own
      // per-voucher counter (what the gateway enforces); ruijie_live is the
      // station roster keyed by MAC; voucher_accounting is the (possibly
      // stale) reconciled column; none means usage is genuinely unknown and
      // the UI must not invent it.
      usageSource,
      // True/false when answerable (MAC roster reachable, or Ruijie's live
      // client count for the voucher), null when we could not tell.
      onlineNow,
      boundDevices: row.bound_devices,
      durationMin: row.duration_min,
      usedCount: row.used_count,
      maxUses: row.max_uses,
      // Session expiry is the voucher's own expiry, not the (never-written)
      // users.session_expires_at; Ruijie's own expiry fills the rare NULL.
      expiresAt: row.expires_at ?? (rv?.expiryTime ? new Date(rv.expiryTime).toISOString() : null),
      activatedAt: row.activated_at,
    });
  } catch (err) {
    console.error('check-usage error:', err);
    res.status(500).json({ error: 'usage_check_failed' });
  }
});
