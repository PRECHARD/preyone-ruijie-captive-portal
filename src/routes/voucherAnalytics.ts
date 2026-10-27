import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth } from '../middleware/adminAuth';
import { isRuijieCloudConfigured } from '../services/ruijieCloud';
import type { RuijieVoucher } from '../services/ruijieCloud';
import { getRuijieRoster } from '../services/ruijieRoster';
import type { RuijieRoster } from '../services/ruijieRoster';
import {
  DEFAULT_ALERT_THRESHOLDS,
  loadAlertThresholds,
  normalizeAlertThresholds,
  voucherPct,
} from '../services/voucherMonitorService';
import type { AlertThresholds } from '../services/voucherMonitorService';

/**
 * GET /api/admin/voucher-analytics — the data behind the
 * "Voucher Consumption & Status" tab (WiFi Vouchers section).
 *
 * One Ruijie roster pull (2 paged API calls, ~108 vouchers) joined in-memory
 * with the local alert history, so the tab can show dual-threshold status,
 * live-ness and exactly how many 80/95 alerts each PIN has fired — without
 * any new background sync. Read-only; same auth as the rest of /api/admin.
 */
export const voucherAnalyticsRouter = Router();

voucherAnalyticsRouter.use(requireAdminAuth);

const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
voucherAnalyticsRouter.use(analyticsLimiter);

export type ConsumptionStatus = 'ok' | 'low' | 'critical' | 'exhausted' | 'unlimited' | 'idle' | 'disabled' | 'expired';

interface AlertAggregate {
  t80: number;
  t95: number;
  lastAt: Date | null;
}

/** One row of the consumption table (mirrors admin/src/types/wifi.ts). */
export interface ConsumptionRow {
  code: string;
  packageName: string | null;
  holderName: string | null;
  holderPhone: string | null;
  priceAmount: number | null;
  usedMB: number | null;
  totalMB: number | null;
  pct: number | null;
  expiryTime: number | null;
  status: ConsumptionStatus;
  onlineNow: boolean;
  activeDevices: number;
  maxDevices: number | null;
  alertsSent: { t80: number; t95: number };
  lastAlertAt: Date | null;
  /** false when the row came from the local DB because the roster was unavailable. */
  usageKnown: boolean;
}

/**
 * Join a Ruijie roster with local holder details and alert history.
 * Extracted from the handler so the live path and the degraded path share the
 * same shapes; `alertsSent` keys are always present.
 */
async function buildLiveRows(
  vouchers: RuijieVoucher[],
  alertMap: Map<string, AlertAggregate>,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  now: number = Date.now()
): Promise<ConsumptionRow[]> {
  const codes = vouchers
    .map((v) => String(v.voucherCode ?? '').trim().toLowerCase())
    .filter(Boolean);
  const localByCode = new Map<string, { holderName: string | null; holderPhone: string | null; priceAmount: number | null; packageTier: string | null }>();
  if (codes.length > 0) {
    const { rows: localRows } = await pool.query(
      `SELECT lower(code) AS code, holder_name, holder_phone, price_amount, package_tier
         FROM vouchers
        WHERE lower(code) = ANY($1::text[]) AND deleted_at IS NULL`,
      [[...new Set(codes)]]
    );
    for (const row of localRows) {
      localByCode.set(String(row.code), {
        holderName: row.holder_name ?? null,
        holderPhone: row.holder_phone ?? null,
        priceAmount: row.price_amount == null ? null : Number(row.price_amount),
        packageTier: row.package_tier ?? null,
      });
    }
  }

  const built = vouchers.map((v): ConsumptionRow => {
    const pct = voucherPct(v);
    const code = v.voucherCode || '';
    const local = localByCode.get(code.toLowerCase());
    const alerts = alertMap.get(code) || { t80: 0, t95: 0, lastAt: null };
    return {
      code,
      packageName: v.packageName ?? local?.packageTier ?? null,
      holderName: local?.holderName ?? null,
      holderPhone: local?.holderPhone ?? null,
      priceAmount: local?.priceAmount ?? null,
      usedMB: v.usedQuotaMb ?? null,
      totalMB: v.quotaMb ?? null,
      pct: pct == null ? null : Math.round(pct * 10) / 10,
      expiryTime: v.expiryTime ?? null,
      status: consumptionStatus(v, pct, now, thresholds),
      onlineNow: (v.currentClients ?? 0) > 0,
      activeDevices: Math.max(0, Math.trunc(Number(v.currentClients ?? 0))),
      maxDevices: Number.isFinite(Number(v.maxClients)) && Number(v.maxClients) > 0
        ? Math.trunc(Number(v.maxClients))
        : null,
      alertsSent: { t80: alerts.t80, t95: alerts.t95 },
      lastAlertAt: alerts.lastAt,
      usageKnown: true,
    };
  });

  // Depleted + expired codes are dead stock: drop them from the live table
  // instead of letting them pile up at the bottom month after month.
  return sortConsumptionRows(built.filter((row) => !isDrainedAndExpired(row, now)));
}

/**
 * Pure: a voucher whose data bundle is spent (100%) AND whose expiry has
 * passed. Those rows are removed from the Consumption tab automatically —
 * they are neither actionable (nothing left to upsell) nor live (expired).
 */
export function isDrainedAndExpired(
  row: { pct: number | null; expiryTime?: number | null },
  now: number = Date.now()
): boolean {
  const pct = row.pct == null ? null : Number(row.pct);
  if (pct == null || !Number.isFinite(pct) || pct < 100) return false;
  const expiry = Number(row.expiryTime);
  return Number.isFinite(expiry) && expiry > 0 && expiry <= now;
}

/** Pure: map a roster row + pct onto the tab's status taxonomy. */
export function consumptionStatus(
  v: { quotaMb?: number; usedQuotaMb?: number; disableStatus?: number; expiryTime?: number },
  pct: number | null,
  now: number = Date.now(),
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS
): ConsumptionStatus {
  const expiry = Number(v.expiryTime);
  if (Number.isFinite(expiry) && expiry > 0 && expiry <= now) return 'expired';
  if (v.disableStatus != null && Number(v.disableStatus) !== 0) return 'disabled';
  if (pct == null) return 'unlimited';
  if (pct >= 100) return 'exhausted';
  const { warn, critical } = normalizeAlertThresholds(thresholds);
  if (pct >= critical) return 'critical';
  if (pct >= warn) return 'low';
  if (pct > 0) return 'ok';
  return 'idle';
}

/**
 * The four-tier hierarchy the Consumption tab renders, in order:
 *
 *   1. `critical` — low/critical quota usage (default 80%+, critical 95%+).
 *      Needs an upsell now, so it always sits on top.
 *   2. `drained`  — quota-bound bundle fully consumed (100%).
 *   3. `ok`       — healthy capped vouchers (plus idle codes never used).
 *   4. `unlimited`— uncapped bundles, which have no depletion risk and are
 *      therefore least urgent of the live codes.
 *
 * `disabled` (cancelled) and `expired` are dead stock and keep the previous
 * behaviour of sinking below every live tier, expired always last.
 */
export function consumptionTier(status: ConsumptionStatus): number {
  switch (status) {
    case 'critical':
    case 'low':
      return 0;
    case 'exhausted':
      return 1;
    case 'ok':
    case 'idle':
      return 2;
    case 'unlimited':
      return 3;
    case 'disabled':
      return 4;
    case 'expired':
      return 5;
    default:
      return 2;
  }
}

/**
 * Four-tier, urgency-first ordering for the consumption table (pure,
 * unit-tested).
 *
 * Tier order is fixed (critical/low → drained → ok → unlimited → disabled →
 * expired). Inside a tier, vouchers with a live client come first — an online
 * code is the one an operator is being asked about right now — then higher
 * pct, then PIN ascending for a stable order.
 */
export function sortConsumptionRows<T extends {
  status: ConsumptionStatus;
  pct: number | null;
  code: string;
  onlineNow?: boolean;
}>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const byTier = consumptionTier(a.status) - consumptionTier(b.status);
    if (byTier !== 0) return byTier;
    const aOnline = a.onlineNow === true ? 1 : 0;
    const bOnline = b.onlineNow === true ? 1 : 0;
    if (aOnline !== bOnline) return bOnline - aOnline;
    const ap = a.pct ?? -1;
    const bp = b.pct ?? -1;
    if (bp !== ap) return bp - ap;
    return a.code.localeCompare(b.code);
  });
}

voucherAnalyticsRouter.get('/', async (_req: Request, res: Response) => {
  const live = isRuijieCloudConfigured();
  // Configured alert thresholds drive the low/critical taxonomy as well as the
  // push sweep, so the badge an operator sees matches the alert they receive.
  const thresholds = await loadAlertThresholds();
  let roster: RuijieRoster | null = null;
  if (live) {
    try {
      roster = await getRuijieRoster();
    } catch (err) {
      // Ruijie is unreachable and we have never cached a roster. Fall through
      // to the local vouchers table: the tab must still list the PINs instead
      // of collapsing to a "ruijie_unavailable" empty state.
      console.error('[voucher-analytics] roster unavailable, using local vouchers', err);
    }
  }

  // Alert history aggregate — one query for the whole tab.
  const { rows: alertRows } = await pool.query(
    `SELECT voucher_code, tier, COUNT(*)::int AS hits, MAX(created_at) AS last_at
     FROM voucher_alert_events
     WHERE created_at > NOW() - INTERVAL '30 days'
     GROUP BY voucher_code, tier`
  );
  const alertMap = new Map<string, { t80: number; t95: number; lastAt: Date | null }>();
  for (const row of alertRows) {
    const entry = alertMap.get(row.voucher_code) || { t80: 0, t95: 0, lastAt: null as Date | null };
    if (Number(row.tier) === 95) entry.t95 += Number(row.hits);
    else entry.t80 += Number(row.hits);
    const last = row.last_at ? new Date(row.last_at) : null;
    if (last && (!entry.lastAt || last > entry.lastAt)) entry.lastAt = last;
    alertMap.set(row.voucher_code, entry);
  }

  let rows: ConsumptionRow[];

  if (roster) {
    rows = await buildLiveRows(roster.vouchers, alertMap, thresholds);
  } else {
    // Local-only view: every PIN we know about, with usage unknown. Fields the
    // Ruijie roster normally supplies (used/total/pct/devices) stay null so the
    // UI renders "—" rather than inventing numbers.
    const { rows: localRows } = await pool.query(
      `SELECT code, package_tier, holder_name, holder_phone, price_amount, expires_at, is_disabled
         FROM vouchers
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 500`
    );
    const now = Date.now();
    rows = sortConsumptionRows(localRows.map((v: any) => {
      const code = String(v.code ?? '');
      const expiry = v.expires_at ? new Date(v.expires_at).getTime() : null;
      const status: ConsumptionStatus = v.is_disabled
        ? 'disabled'
        : expiry != null && Number.isFinite(expiry) && expiry <= now
          ? 'expired'
          : 'idle';
      const alerts = alertMap.get(code) || { t80: 0, t95: 0, lastAt: null as Date | null };
      return {
        code,
        packageName: v.package_tier ?? null,
        holderName: v.holder_name ?? null,
        holderPhone: v.holder_phone ?? null,
        priceAmount: v.price_amount == null ? null : Number(v.price_amount),
        usedMB: null,
        totalMB: null,
        pct: null,
        expiryTime: expiry,
        status,
        onlineNow: false,
        activeDevices: 0,
        maxDevices: null,
        alertsSent: { t80: alerts.t80, t95: alerts.t95 },
        lastAlertAt: alerts.lastAt,
        usageKnown: false,
      };
    }));
  }

  const summary = {
    total: rows.length,
    ok: 0, low: 0, critical: 0, exhausted: 0, unlimited: 0, idle: 0, disabled: 0, expired: 0,
  };
  for (const row of rows) summary[row.status] += 1;

  const degraded = live && !roster;
  res.json({
    generatedAt: new Date(),
    live,
    stale: roster?.stale ?? false,
    rosterFetchedAt: roster?.fetchedAt ?? null,
    degraded,
    warning: degraded
      ? 'Ruijie Cloud is temporarily unavailable or rate-limiting us, so live usage is paused. Showing local vouchers — PINs and holders are current, usage will refresh automatically.'
      : null,
    thresholds: { warn: thresholds.warn, critical: thresholds.critical },
    summary,
    rows,
  });
});

