import { pool } from '../db/pool';

/**
 * Company-wide monthly revenue target.
 *
 * Deliberately additive: the value lives in the existing `settings` table
 * (`monthly_revenue_target`) so no schema change was required and older
 * clients that never learned about the widget keep working untouched.
 *
 * Two routers expose it — `/api/admin/revenue-target` (canonical, mounted by
 * the admin router) and `/api/admin/reports/revenue-target` (kept as a
 * backwards-compatible alias because the first shipped release of the widget
 * used it). Both funnel through the helpers below so the two can never drift.
 */

export interface RevenueTargetSnapshot {
  target: number;
  achieved: number;
  remaining: number;
  /** Uncapped: 140 means the month is already 1.4x over target. */
  pct: number | null;
  currency: string;
  salesCount: number;
  monthStart: string;
  monthEnd: string;
  label: string;
  configured: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const REVENUE_TARGET_MAX = 1_000_000_000;

export const REVENUE_TARGET_KEYS = {
  target: 'monthly_revenue_target',
  updatedAt: 'monthly_revenue_target_updated_at',
  updatedBy: 'monthly_revenue_target_updated_by',
} as const;

/** Settings read that must never take an endpoint down with it. */
export async function readSetting(key: string): Promise<string | null> {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length > 0 ? String(rows[0].value ?? '') : null;
  } catch {
    return null;
  }
}

export async function loadRevenueTarget(): Promise<RevenueTargetSnapshot> {
  const [targetRaw, updatedAtRaw, updatedByRaw] = await Promise.all([
    readSetting(REVENUE_TARGET_KEYS.target),
    readSetting(REVENUE_TARGET_KEYS.updatedAt),
    readSetting(REVENUE_TARGET_KEYS.updatedBy),
  ]);

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS achieved,
            COUNT(*)::int                    AS sales_count,
            MIN(currency)                    AS currency,
            date_trunc('month', NOW())::date AS month_start,
            (date_trunc('month', NOW()) + INTERVAL '1 month')::date AS next_month
       FROM sales
      WHERE sold_at >= date_trunc('month', NOW())
        AND sold_at <  date_trunc('month', NOW()) + INTERVAL '1 month'`
  );
  const row = rows[0] ?? {};
  const target = Math.max(0, Number(targetRaw) || 0);
  const achieved = Math.round((Number(row.achieved) || 0) * 100) / 100;
  const monthStart = row.month_start ? new Date(row.month_start) : new Date();
  const nextMonth = row.next_month ? new Date(row.next_month) : new Date();

  return {
    target,
    achieved,
    remaining: Math.max(0, Math.round((target - achieved) * 100) / 100),
    pct: target > 0 ? Math.round((achieved / target) * 1000) / 10 : null,
    currency: String(row.currency || 'USD'),
    salesCount: Number(row.sales_count) || 0,
    monthStart: monthStart.toISOString(),
    monthEnd: nextMonth.toISOString(),
    label: monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    configured: target > 0,
    updatedAt: updatedAtRaw || null,
    updatedBy: updatedByRaw || null,
  };
}

/**
 * Validate an incoming target. Returns the rounded value, or a message the
 * route can hand straight back as a 400.
 */
export function parseRevenueTarget(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  const target = Number(raw);
  if (!Number.isFinite(target) || target < 0 || target > REVENUE_TARGET_MAX) {
    return { ok: false, error: 'target must be a positive number (or 0 to clear it)' };
  }
  return { ok: true, value: Math.round(target * 100) / 100 };
}

export async function saveRevenueTarget(value: number, actorName: string): Promise<RevenueTargetSnapshot> {
  const stamp = new Date().toISOString();
  await pool.query(
    `INSERT INTO settings (key, value) VALUES
       ($1, $2),
       ($3, $4),
       ($5, $6)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      REVENUE_TARGET_KEYS.target,
      String(value),
      REVENUE_TARGET_KEYS.updatedAt,
      stamp,
      REVENUE_TARGET_KEYS.updatedBy,
      actorName,
    ]
  );
  return loadRevenueTarget();
}
