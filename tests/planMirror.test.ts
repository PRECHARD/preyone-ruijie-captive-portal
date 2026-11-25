import { describe, expect, it, vi } from 'vitest';
import { syncPlanModules } from '../src/plans/entitlements';

function recorder() {
  const calls: unknown[][] = [];
  const client = {
    query: vi.fn(async (_sql: string, params?: unknown[]) => {
      calls.push(params ?? []);
      return { rows: [] };
    }),
  };
  return { client, calls };
}

describe('syncPlanModules', () => {
  it('keeps PreTill POS-only: invoice mirror is suspended, POS is active', async () => {
    const { client, calls } = recorder();
    await syncPlanModules(client, 'company-1', 'standard_10');

    expect(calls).toEqual([
      ['company-1', 'pos', 'standard_10', 'active'],
      ['company-1', 'invoice', 'standard_10', 'suspended'],
    ]);
  });

  it('activates both mirror rows for every POS + Invoice tier', async () => {
    for (const plan of ['pos_invoice_15', 'growth_20', 'unlimited_30'] as const) {
      const { client, calls } = recorder();
      await syncPlanModules(client, 'company-1', plan);
      expect(calls).toEqual([
        ['company-1', 'pos', plan, 'active'],
        ['company-1', 'invoice', plan, 'active'],
      ]);
    }
  });
});
