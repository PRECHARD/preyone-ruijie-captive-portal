import { describe, it, expect } from 'vitest';
import { STARLINK_PLANS, getStarlinkPlan } from '../src/plans/starlinkPlans';

describe('Starlink plan catalog', () => {
  it('lists the six packages at the agreed USD monthly prices', () => {
    expect(STARLINK_PLANS.map((p) => [p.name, p.priceUsd])).toEqual([
      ['Residential Lite', 45],
      ['Residential Standard', 65],
      ['Residential', 77],
      ['Business Priority Lite', 110],
      ['Business Priority', 135],
      ['Business Priority Plus', 235],
    ]);
  });

  it('ranks plans in ascending price order', () => {
    const prices = STARLINK_PLANS.map((p) => p.priceUsd);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  it('resolves known codes and rejects unknown ones', () => {
    expect(getStarlinkPlan('residential_standard')?.priceUsd).toBe(65);
    expect(getStarlinkPlan('business_priority_lite')?.priceUsd).toBe(110);
    expect(getStarlinkPlan('standard_10')).toBeNull();
    expect(getStarlinkPlan(undefined)).toBeNull();
  });
});
