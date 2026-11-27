/**
 * USD cash helpers for the invoice document drawer. Mirrors the POS till
 * helper so both checkout surfaces show the same quick-amount ladder.
 */

export const USD_DENOMINATIONS = [1, 2, 5, 10, 20, 50, 100] as const;

const round2 = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;

export function cashQuickAmounts(balance: number): number[] {
  const due = round2(Math.max(0, balance));
  if (!Number.isFinite(due)) return [];

  const above = USD_DENOMINATIONS.filter((d) => d > due + 0.005);
  const next = above.slice(0, 3);
  if (100 > due + 0.005 && !next.includes(100)) next.push(100);

  return [...new Set([due, ...next].map(round2))].filter((v) => v > 0);
}

export function cashChange(tendered: number, applied: number): number {
  return round2(Math.max(0, round2(tendered) - round2(applied)));
}
