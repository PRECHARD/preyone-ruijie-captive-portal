import { describe, it, expect } from 'vitest';
import {
  CEO_EXCLUSIVE_TIERS,
  isCeoExclusiveTier,
  packagesForMinting,
} from '../utils/packages';

/**
 * The mint UI must never offer prePromo_Monthly to Staff/Manager. The backend
 * still returns 403 (tests/packageCeoGuard.test.ts), but hiding the tier keeps
 * the console honest and avoids a pointless failed request.
 */
describe('packagesForMinting', () => {
  const packages = [
    { tier_name: 'preMicro_Daily', display_name: 'Micro Pass' },
    { tier_name: 'preStream_Daily', display_name: 'Stream Daily' },
    { tier_name: 'prePromo_Monthly', display_name: 'Promo Monthly', ceo_exclusive: true },
  ];

  it('hides CEO-exclusive tiers from Staff and Manager', () => {
    for (const role of ['Staff', 'Manager']) {
      const visible = packagesForMinting(packages, { role });
      expect(visible.map((p) => p.tier_name)).toEqual(['preMicro_Daily', 'preStream_Daily']);
    }
  });

  it('shows every tier to the CEO', () => {
    expect(packagesForMinting(packages, { role: 'CEO' })).toHaveLength(3);
  });

  it('also hides a tier flagged server-side but missing from the local list', () => {
    const flagged = [{ tier_name: 'someFuturePromo', ceo_exclusive: true }];
    expect(packagesForMinting(flagged, { role: 'Manager' })).toEqual([]);
  });

  it('keeps the local CEO-exclusive list small and explicit', () => {
    expect(CEO_EXCLUSIVE_TIERS).toEqual(['prePromo_Monthly']);
    expect(isCeoExclusiveTier('prePromo_Monthly')).toBe(true);
    expect(isCeoExclusiveTier('PreMax')).toBe(false);
  });
});
