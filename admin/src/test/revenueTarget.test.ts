import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REVENUE_TARGET,
  monthlyTargetPct,
  monthlyTargetPctRaw,
  resolveMonthlyTarget,
} from '../utils/revenueTarget';

/**
 * The monthly revenue target is a settings key behind
 * `/api/admin/revenue-target`. When a tenant has not saved one the API answers
 * `target: 0` (and the Wi-Fi dashboard's sales-summary does the same), so the
 * gauge used to read "no target set" at 0%. It now falls back to $500 — a
 * display default only.
 */

describe('DEFAULT_REVENUE_TARGET', () => {
  it('is $500', () => {
    expect(DEFAULT_REVENUE_TARGET).toBe(500);
  });
});

describe('resolveMonthlyTarget', () => {
  it('keeps a saved positive target', () => {
    expect(resolveMonthlyTarget(1500)).toBe(1500);
    expect(resolveMonthlyTarget('250.50')).toBe(250.5);
  });

  it('falls back to the baseline for missing, zero, negative or junk values', () => {
    for (const value of [undefined, null, 0, -10, '', 'abc', NaN, Infinity]) {
      expect(resolveMonthlyTarget(value)).toBe(DEFAULT_REVENUE_TARGET);
    }
  });

  it('honours an explicit fallback', () => {
    expect(resolveMonthlyTarget(0, 1000)).toBe(1000);
  });
});

describe('monthlyTargetPct', () => {
  it('computes the fraction of target', () => {
    expect(monthlyTargetPct(125, 500)).toBe(25);
    expect(monthlyTargetPct(0, 500)).toBe(0);
  });

  it('clamps to 100 so the ring never overlaps itself', () => {
    expect(monthlyTargetPct(1500, 500)).toBe(100);
  });

  it('returns 0 for a non-positive or invalid target', () => {
    expect(monthlyTargetPct(100, 0)).toBe(0);
    expect(monthlyTargetPct(100, -5)).toBe(0);
    expect(monthlyTargetPct(100, Number.NaN)).toBe(0);
  });
});

describe('monthlyTargetPctRaw', () => {
  it('reports over-achievement for the headline number', () => {
    expect(monthlyTargetPctRaw(1500, 500)).toBe(300);
    expect(monthlyTargetPctRaw(125, 500)).toBe(25);
  });

  it('never returns negative percentages', () => {
    expect(monthlyTargetPctRaw(-50, 500)).toBe(0);
  });
});
