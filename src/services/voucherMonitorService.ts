import webpush from 'web-push';
import type { PushSubscription, RequestOptions as WebPushRequestOptions } from 'web-push';
import { pool } from '../db/pool';
import { isRuijieCloudConfigured } from './ruijieCloud';
import type { RuijieVoucher } from './ruijieCloud';
import { getRuijieRoster } from './ruijieRoster';

/**
 * Hybrid multi-tier voucher alerting (80% reminder / 95% critical).
 *
 * The sweep runs inside the portal process (see startVoucherMonitor below).
 * Because PM2 runs 4 clusters of the same app, every step is claim-based:
 *
 *  1. Tier choice is pure: pct >= 95 fires ONLY the 95 alert (a bundle that
 *     jumps 70 -> 96 must not double-ping), pct >= 80 fires the 80 reminder.
 *  2. The (voucher, tier) claim is a single atomic upsert — INSERT ... ON
 *     CONFLICT DO UPDATE ... WHERE last_alerted_used_mb < EXCLUDED... — so
 *     exactly one cluster wins each crossing. The epsilon comparison also
 *     makes a quota reload re-arm the alert: when Ruijie's usedQuota resets
 *     and climbs past the old mark again, the next crossing wins the claim.
 *  3. Unlimited bundles (quotaMb <= 0) never alert — there is no threshold.
 *
 * Delivery is hybrid by design:
 *  - Web Push to every browser that tapped ENABLE DATA ALERTS on /data
 *    (push_subscriptions), best-effort: 404/410 endpoints are pruned.
 *  - The captive-portal banner always works even with zero subscribers,
 *    because the event row itself is what GET /api/alerts/pending serves to
 *    the wifi landing page and /data.
 * A sweep therefore never throws because of one voucher or one endpoint.
 */

export const ALERT_TIERS = [80, 95] as const;
export type AlertTier = 80 | 95;

/**
 * Admin-configurable thresholds (Settings → Alert Thresholds).
 *
 * The *storage slots* stay 80/95 — `voucher_alert_state.tier` and
 * `voucher_alert_events.tier` are keyed on those two integers, and the
 * Consumption tab's badge vocabulary reads them. What is configurable is the
 * percentage that fires each slot, so an operator can warn at 70 and go
 * critical at 90 without a schema change (and without orphaning alert history).
 */
export interface AlertThresholds {
  /** Percentage that fires the "low" reminder (stored as tier 80). */
  warn: number;
  /** Percentage that fires the "critical" push (stored as tier 95). */
  critical: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = { warn: 80, critical: 95 };

/** Settings keys backing the two thresholds (plain `settings` rows). */
export const ALERT_THRESHOLD_KEYS = {
  warn: 'voucher_alert_warn_pct',
  critical: 'voucher_alert_crit_pct',
} as const;

/** Pure: coerce anything (form input, env, DB text) into sane thresholds. */
export function normalizeAlertThresholds(
  input: { warn?: unknown; critical?: unknown } | null | undefined
): AlertThresholds {
  const parse = (value: unknown, fallback: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return fallback;
    return Math.round(n * 10) / 10;
  };
  const warn = parse(input?.warn, DEFAULT_ALERT_THRESHOLDS.warn);
  const critical = parse(input?.critical, DEFAULT_ALERT_THRESHOLDS.critical);
  // A critical threshold at or below the warning level would fire both slots on
  // the same crossing. Keep the pair ordered and at least 5 points apart.
  if (critical <= warn) return { warn, critical: Math.min(100, warn + 5) };
  return { warn, critical };
}

const THRESHOLD_CACHE_MS = 60_000;
let thresholdCache: { at: number; value: AlertThresholds } | null = null;

/**
 * Read the configured thresholds. Cached for 60s per worker so the 5-minute
 * sweep and the analytics tab do not query `settings` on every request. Any
 * failure silently falls back to 80/95 — alerting must never break on a
 * settings read.
 */
export async function loadAlertThresholds(): Promise<AlertThresholds> {
  if (thresholdCache && Date.now() - thresholdCache.at < THRESHOLD_CACHE_MS) {
    return thresholdCache.value;
  }
  let value = DEFAULT_ALERT_THRESHOLDS;
  try {
    const { rows } = await pool.query(
      'SELECT key, value FROM settings WHERE key = ANY($1::text[])',
      [[ALERT_THRESHOLD_KEYS.warn, ALERT_THRESHOLD_KEYS.critical]]
    );
    const byKey = new Map<string, string>(rows.map((r: any) => [String(r.key), String(r.value)]));
    value = normalizeAlertThresholds({
      warn: byKey.get(ALERT_THRESHOLD_KEYS.warn),
      critical: byKey.get(ALERT_THRESHOLD_KEYS.critical),
    });
  } catch {
    value = DEFAULT_ALERT_THRESHOLDS;
  }
  thresholdCache = { at: Date.now(), value };
  return value;
}

/** Test-only: forget the cached thresholds. */
export function __resetAlertThresholdsForTests(): void {
  thresholdCache = null;
}

export const MONITOR_POLL_MS = 5 * 60 * 1000;
/** Re-alert only after this much NEW usage beyond the last alert (MB). */
const RE_ALERT_EPSILON_MB = 1;
/** Pending alerts older than this stop appearing on the portal banner. */
const PENDING_FRESHNESS_H = 24;

/**
 * Pure: the tier slot to fire for a percentage, or null when below all tiers.
 * `thresholds` defaults to 80/95; the returned value is always the storage slot
 * (80 or 95), never the configured percentage.
 */
export function chooseAlertTier(
  pct: number,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS
): AlertTier | null {
  if (!Number.isFinite(pct)) return null;
  const { warn, critical } = normalizeAlertThresholds(thresholds);
  if (pct >= critical) return 95;
  if (pct >= warn) return 80;
  return null;
}

/** Pure: usage percentage for a capped Ruijie voucher, or null (unlimited/invalid). */
export function voucherPct(v: { quotaMb?: number; usedQuotaMb?: number }): number | null {
  const total = Number(v.quotaMb);
  const used = Number(v.usedQuotaMb);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(used) || used < 0) return null;
  return Math.min((used / total) * 100, 100);
}

/** Pure: can this voucher ever alert? Usable + capped + a code to key on. */
export function isAlertCandidate(v: RuijieVoucher): boolean {
  if (!v.voucherCode) return false;
  // disableStatus: 0 = usable in Ruijie; anything else is disabled/expired stock.
  if (v.disableStatus != null && Number(v.disableStatus) !== 0) return false;
  return voucherPct(v) != null;
}

/** The exact copy each tier pushes — shared with the portal banner wording. */
export function buildAlertCopy(
  tier: AlertTier
): { title: string; body: string } {
  if (tier === 95) {
    return {
      title: 'ULTRANET // RUNNING DRY — 95%',
      body: 'Almost out of data. Buy a new bundle at wifi.preyone.com to stay connected.',
    };
  }
  return {
    title: 'ULTRANET // DATA THRESHOLD 80%',
    body: 'You have used 80% of your bundle. Top up now to stay online.',
  };
}

export function buildPushPayload(
  tier: AlertTier,
  voucherCode: string,
  pct: number
): Record<string, unknown> {
  const copy = buildAlertCopy(tier);
  return {
    title: copy.title,
    body: copy.body,
    url: '/data',
    tag: `preyone-alert-${tier}-${voucherCode}`,
    tier,
    pct: Math.round(pct),
  };
}

let vapidConfigured = false;

/** Idempotent; returns false when the VAPID env keys are absent (portal-only mode). */
export function configureWebPush(): boolean {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'https://wifi.preyone.com',
    publicKey,
    privateKey
  );
  vapidConfigured = true;
  return true;
}

/** Test hook: lets a suite re-run configureWebPush after mutating env. */
export function __resetVapidForTests(): void {
  vapidConfigured = false;
}

export interface SweepSummary {
  scanned: number;
  candidates: number;
  claimed: number;
  sent: number;
  noSubscribers: number;
  failed: number;
}

/**
 * Dispatch Web Push for one alert. Never throws; dead endpoints (404/410)
 * are deleted so the table cannot grow stale entries forever.
 */
export async function dispatchPush(
  voucherCode: string,
  tier: AlertTier,
  payload: Record<string, unknown>
): Promise<{ status: string; detail: string }> {
  if (!configureWebPush()) {
    return { status: 'no_vapid_keys', detail: 'VAPID keys not configured' };
  }
  const { rows } = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE voucher_code = $1',
    [voucherCode]
  );
  if (rows.length === 0) return { status: 'no_subscribers', detail: '0 subscriptions' };

  let ok = 0;
  let pruned = 0;
  let failed = 0;
  const options: WebPushRequestOptions = {
    TTL: tier === 95 ? 3600 : 6 * 3600,
    urgency: tier === 95 ? 'high' : 'normal',
    topic: `preyone-alert-${tier}`,
  };
  for (const sub of rows) {
    const record: PushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(record, JSON.stringify(payload), options);
      ok += 1;
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        pruned += 1;
      } else {
        failed += 1;
      }
    }
  }
  if (failed === 0 && pruned === 0) return { status: 'sent', detail: `${ok}/${rows.length} delivered` };
  if (ok > 0) return { status: 'partial', detail: `${ok} sent, ${pruned} pruned, ${failed} failed` };
  return { status: 'failed', detail: `${pruned} pruned, ${failed} failed` };
}

/**
 * One full evaluation pass over the Ruijie roster. Safe to run concurrently
 * on all clusters: claims decide who dispatches.
 */
export async function runVoucherAlertSweep(): Promise<SweepSummary> {
  const summary: SweepSummary = {
    scanned: 0,
    candidates: 0,
    claimed: 0,
    sent: 0,
    noSubscribers: 0,
    failed: 0,
  };
  if (!isRuijieCloudConfigured()) return summary;

  // Loaded lazily: a sweep with no alert candidates (all unlimited/disabled)
  // must not touch the database at all — same contract the tests assert.
  let thresholds: AlertThresholds | null = null;

  let vouchers: RuijieVoucher[];
  try {
    // Shared snapshot instead of a raw pull: the sweep runs on every worker and
    // used to spend a Ruijie call each time, which is what exhausted the tenant
    // quota (code 44). `getRuijieRoster()` reuses one cross-worker snapshot and
    // serves the last good copy when upstream is throttled.
    const roster = await getRuijieRoster();
    vouchers = roster.vouchers;
  } catch (err) {
    console.error('[voucher-monitor] roster fetch failed', err);
    return summary;
  }

  for (const v of vouchers) {
    summary.scanned += 1;
    if (!isAlertCandidate(v)) continue;
    const pct = voucherPct(v)!;
    thresholds ??= await loadAlertThresholds();
    const tier = chooseAlertTier(pct, thresholds);
    if (tier == null) continue;
    summary.candidates += 1;

    const usedMb = Number(v.usedQuotaMb);
    const totalMb = Number(v.quotaMb);
    const code = v.voucherCode!;

    // Atomic cross-cluster claim: exactly one caller gets a row back.
    const { rows: claimed } = await pool.query(
      `INSERT INTO voucher_alert_state (voucher_code, tier, last_alerted_used_mb)
       VALUES ($1, $2, $3)
       ON CONFLICT (voucher_code, tier) DO UPDATE
         SET last_alerted_used_mb = EXCLUDED.last_alerted_used_mb,
             last_alerted_at = NOW()
       WHERE voucher_alert_state.last_alerted_used_mb + $4 < EXCLUDED.last_alerted_used_mb
       RETURNING id`,
      [code, tier, usedMb, RE_ALERT_EPSILON_MB]
    );
    if (claimed.length === 0) continue;
    summary.claimed += 1;

    let pushStatus = 'pending';
    let pushDetail: string | null = null;
    try {
      const result = await dispatchPush(code, tier, buildPushPayload(tier, code, pct));
      pushStatus = result.status;
      pushDetail = result.detail;
      if (result.status === 'sent' || result.status === 'partial') summary.sent += 1;
      else if (result.status === 'no_subscribers') summary.noSubscribers += 1;
      else summary.failed += 1;
    } catch (err) {
      pushStatus = 'failed';
      pushDetail = err instanceof Error ? err.message : 'dispatch error';
      summary.failed += 1;
      console.error('[voucher-monitor] push dispatch failed', err);
    }

    // The event row is the audit trail AND the portal-banner feed.
    try {
      await pool.query(
        `INSERT INTO voucher_alert_events
           (voucher_code, tier, used_mb, total_mb, pct, push_status, push_detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [code, tier, usedMb, totalMb, pct, pushStatus, pushDetail]
      );
    } catch (err) {
      console.error('[voucher-monitor] event insert failed', err);
    }
  }
  return summary;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * In-process monitor. Each PM2 cluster runs its own timer; the claim SQL
 * guarantees a threshold crossing is dispatched exactly once. Disable with
 * VOUCHER_MONITOR_DISABLED=1 (used by tests and one-off debug sessions).
 */
export function startVoucherMonitor(): void {
  if (process.env.VOUCHER_MONITOR_DISABLED === '1') {
    console.log('[voucher-monitor] disabled via VOUCHER_MONITOR_DISABLED');
    return;
  }
  if (timer) return;
  if (!configureWebPush()) {
    console.warn('[voucher-monitor] VAPID keys missing — portal banners only, no Web Push');
  }
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const s = await runVoucherAlertSweep();
      if (s.claimed > 0) {
        console.log(
          `[voucher-monitor] sweep: ${s.claimed} alert(s) claimed, ${s.sent} pushed, ` +
            `${s.noSubscribers} portal-only, ${s.failed} failed (${s.scanned} scanned)`
        );
      }
    } catch (err) {
      console.error('[voucher-monitor] sweep crashed', err);
    } finally {
      ticking = false;
    }
  };
  timer = setInterval(tick, MONITOR_POLL_MS);
  timer.unref?.();
  // First pass shortly after boot so a restart does not wait a full interval.
  const first = setTimeout(tick, 60 * 1000);
  first.unref?.();
}

export function stopVoucherMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export { PENDING_FRESHNESS_H };
