/**
 * Monthly revenue target resolution.
 *
 * The canonical value lives behind `/api/admin/revenue-target` (a `settings`
 * key, see `src/services/revenueTarget.ts`). A tenant that has never saved one
 * answers `configured: false` with `target: 0`, and the Wi-Fi dashboard's
 * `sales-summary` reports `target: 0` as well — which used to render an empty
 * gauge labelled "no target set".
 *
 * The dashboard therefore assumes a baseline target instead of showing nothing.
 * This is a **display default only**: nothing here writes to the database, and a
 * saved target always wins.
 */

export const DEFAULT_REVENUE_TARGET = 500;

/** Use the stored target when it is a usable positive number, else the default. */
export function resolveMonthlyTarget(stored: unknown, fallback: number = DEFAULT_REVENUE_TARGET): number {
  const n = Number(stored);
  if (!Number.isFinite(n) || n <= 0) return fallback > 0 ? fallback : 0;
  return n;
}

/** Percent of target, clamped to 0-100 so a ring never wraps past a full circle. */
export function monthlyTargetPct(achieved: unknown, target: unknown): number {
  const t = Number(target);
  const a = Number(achieved);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (!Number.isFinite(a) || a <= 0) return 0;
  return Math.min(100, (a / t) * 100);
}

/** Unclamped percentage — used for the headline number, which may exceed 100%. */
export function monthlyTargetPctRaw(achieved: unknown, target: unknown): number {
  const t = Number(target);
  const a = Number(achieved);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (!Number.isFinite(a) || a <= 0) return 0;
  return (a / t) * 100;
}
