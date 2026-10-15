import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth } from '../middleware/adminAuth';
import { getAllRuijieVouchers, isRuijieCloudConfigured } from '../services/ruijieCloud';
import type { RuijieVoucher } from '../services/ruijieCloud';
import { voucherPct } from '../services/voucherMonitorService';

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

export type ConsumptionStatus = 'ok' | 'low' | 'critical' | 'exhausted' | 'unlimited' | 'idle' | 'disabled';

/** Pure: map a roster row + pct onto the tab's status taxonomy. */
export function consumptionStatus(
  v: { quotaMb?: number; usedQuotaMb?: number; disableStatus?: number },
  pct: number | null
): ConsumptionStatus {
  if (v.disableStatus != null && Number(v.disableStatus) !== 0) return 'disabled';
  if (pct == null) return 'unlimited';
  if (pct >= 100) return 'exhausted';
  if (pct >= 95) return 'critical';
  if (pct >= 80) return 'low';
  if (pct > 0) return 'ok';
  return 'idle';
}

const STATUS_ORDER: Record<ConsumptionStatus, number> = {
  exhausted: 0,
  critical: 1,
  low: 2,
  ok: 3,
  idle: 4,
  unlimited: 5,
  disabled: 6,
};

voucherAnalyticsRouter.get('/', async (_req: Request, res: Response) => {
  const live = isRuijieCloudConfigured();
  let vouchers: RuijieVoucher[] = [];
  if (live) {
    try {
      vouchers = await getAllRuijieVouchers();
    } catch (err) {
      console.error('[voucher-analytics] roster fetch failed', err);
      res.status(502).json({ error: 'ruijie_unavailable' });
      return;
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

  const rows = vouchers.map((v) => {
    const pct = voucherPct(v);
    const code = v.voucherCode || '';
    const alerts = alertMap.get(code) || { t80: 0, t95: 0, lastAt: null as Date | null };
    return {
      code,
      packageName: v.packageName ?? null,
      usedMB: v.usedQuotaMb ?? null,
      totalMB: v.quotaMb ?? null,
      pct: pct == null ? null : Math.round(pct * 10) / 10,
      status: consumptionStatus(v, pct),
      onlineNow: (v.currentClients ?? 0) > 0,
      alertsSent: { t80: alerts.t80, t95: alerts.t95 },
      lastAlertAt: alerts.lastAt,
    };
  });

  rows.sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return (b.pct ?? -1) - (a.pct ?? -1);
  });

  const summary = {
    total: rows.length,
    ok: 0, low: 0, critical: 0, exhausted: 0, unlimited: 0, idle: 0, disabled: 0,
  };
  for (const row of rows) summary[row.status] += 1;

  res.json({ generatedAt: new Date(), live, summary, rows });
});
