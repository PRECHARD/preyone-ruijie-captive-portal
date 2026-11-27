/**
 * Shared USD cash helpers for the POS till and document-payment modal.
 * The same denomination ladder feeds every quick-amount row, so the exact
 * balance is always the first choice and no two buttons show the same value.
 */

export const USD_DENOMINATIONS = [1, 2, 5, 10, 20, 50, 100] as const;

const round2 = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Quick cash choices: the current balance first, then the next logical USD
 * bills above it, including $100 where it is above the balance. Round bills
 * that already equal the balance are de-duplicated.
 */
export function cashQuickAmounts(balance: number): number[] {
  const due = round2(Math.max(0, balance));
  if (!Number.isFinite(due)) return [];

  const above = USD_DENOMINATIONS.filter((d) => d > due + 0.005);
  const next = above.slice(0, 3);
  if (100 > due + 0.005 && !next.includes(100)) next.push(100);

  return [...new Set([due, ...next].map(round2))].filter((v) => v > 0);
}

/** Change owed for a cash payment, rounded to cents and never negative. */
export function cashChange(tendered: number, applied: number): number {
  return round2(Math.max(0, round2(tendered) - round2(applied)));
}
