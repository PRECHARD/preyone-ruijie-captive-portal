/**
 * Monthly trading cycle.
 *
 * Revenue dashboards and the monthly target used to roll over at midnight on
 * the 1st (`date_trunc('month', ...)`). Operations closes the books on the
 * evening of the 2nd, so the 1st and 2nd still belong to the previous cycle.
 * The canonical window is therefore:
 *
 *   [3rd of month 00:00, 3rd of next month 00:00)
 *
 * implemented as `date_trunc('month', now - 2 days) + 2 days`, which needs no
 * schema change and keeps every existing `sales` row intact.
 */
export const REVENUE_CYCLE_START_DAY = 3;

const CYCLE_SHIFT_DAYS = REVENUE_CYCLE_START_DAY - 1;

/**
 * SQL expression for the start of the active cycle, relative to `nowExpr`
 * (a SQL timestamp expression such as `NOW()` or `CURRENT_DATE`).
 */
export function revenueCycleStartSql(nowExpr = 'NOW()'): string {
  return `(date_trunc('month', ${nowExpr} - INTERVAL '${CYCLE_SHIFT_DAYS} days') + INTERVAL '${CYCLE_SHIFT_DAYS} days')`;
}

/** SQL expression for the exclusive end of the active cycle. */
export function revenueCycleEndSql(nowExpr = 'NOW()'): string {
  return `(${revenueCycleStartSql(nowExpr)} + INTERVAL '1 month')`;
}

/**
 * SQL expression for the calendar month that contains the active cycle's
 * start. `sales_targets.target_month` is stored as the 1st of a month, so this
 * keeps existing target rows matched without migrating them.
 */
export function revenueCycleMonthSql(nowExpr = 'NOW()'): string {
  return `date_trunc('month', ${revenueCycleStartSql(nowExpr)})`;
}
