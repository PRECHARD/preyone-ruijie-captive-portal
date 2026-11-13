import { describe, expect, it } from 'vitest';
import { tilesForModules, upgradeCopy } from '../src/shared/plans';

describe('desktop tiles follow the plan modules', () => {
  it('shows only POS for PreTill', () => {
    expect(tilesForModules(['pos']).map((tile) => tile.key)).toEqual(['pos']);
    expect(tilesForModules(['pos', 'wifi']).map((tile) => tile.title)).toEqual(['Preyone POS']);
  });

  it('shows POS and Invoice for PreBiz, PrePro and PreUnlimited', () => {
    const keys = tilesForModules(['invoice', 'pos', 'wifi']).map((tile) => tile.key);
    expect(keys).toEqual(['pos', 'invoice']);
    expect(tilesForModules(['pos', 'invoice']).map((tile) => tile.url)).toEqual([
      'https://pos.preyone.com',
      'https://invoice.preyone.com',
    ]);
  });

  it('shows nothing when the session has no modules', () => {
    expect(tilesForModules([])).toEqual([]);
    expect(tilesForModules(null)).toEqual([]);
    expect(tilesForModules(undefined)).toEqual([]);
  });

  it('tells a POS-only plan to upgrade before opening Invoice', () => {
    expect(upgradeCopy('invoice', 'PreTill')).toMatch(/PreTill does not include Invoice/);
    expect(upgradeCopy('invoice', 'PreTill')).toMatch(/PreBiz/);
    expect(upgradeCopy('invoice', null)).toMatch(/not on your plan/i);
  });
});
