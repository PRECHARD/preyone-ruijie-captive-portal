import { describe, it, expect } from 'vitest';
import {
  CEO_EXCLUSIVE_TIERS,
  PACKAGE_CATALOG,
  findCatalogPackage,
  isCeoExclusiveTier,
} from '../src/config/packages';
import { userGroupPolicyFromPackage } from '../src/services/ruijieUserGroups';

/**
 * The package catalogue is the seed source for `src/db/migrate.ts` and the
 * policy source for Ruijie User Group provisioning. A typo here ships a tier
 * with the wrong speed/quota, or makes a CEO-only promo sellable by staff.
 */

describe('package catalogue', () => {
  it('registers the micro, stream and promo tiers with the agreed specs', () => {
    const micro = findCatalogPackage('preMicro_Daily');
    expect(micro).toMatchObject({
      priceAmount: 0.5,
      durationMin: 1440,
      dataLimitGb: 2,
      isUncapped: false,
      bandwidthMbpsUp: 2,
      bandwidthMbpsDown: 2,
      maxDevices: 1,
    });

    const stream = findCatalogPackage('preStream_Daily');
    expect(stream).toMatchObject({
      priceAmount: 2,
      durationMin: 1440,
      dataLimitGb: null,
      isUncapped: true,
      bandwidthMbpsUp: 10,
      bandwidthMbpsDown: 10,
      maxDevices: 1,
    });

    const promo = findCatalogPackage('prePromo_Monthly');
    expect(promo).toMatchObject({
      priceAmount: 15,
      durationMin: 43200,
      dataLimitGb: null,
      isUncapped: true,
      bandwidthMbpsUp: 5,
      bandwidthMbpsDown: 5,
      maxDevices: 2,
      ceoExclusive: true,
    });
  });

  it('has no duplicate tier names (the packages table is keyed by tier_name)', () => {
    const names = PACKAGE_CATALOG.map((p) => p.tierName.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks only the promo tier CEO-exclusive, case-insensitively', () => {
    expect(CEO_EXCLUSIVE_TIERS).toEqual(['prePromo_Monthly']);
    expect(isCeoExclusiveTier('prePromo_Monthly')).toBe(true);
    expect(isCeoExclusiveTier('  PREPROMO_MONTHLY ')).toBe(true);
    expect(isCeoExclusiveTier('preMicro_Daily')).toBe(false);
    expect(isCeoExclusiveTier('PreMax')).toBe(false);
    expect(isCeoExclusiveTier(null)).toBe(false);
    expect(isCeoExclusiveTier(undefined)).toBe(false);
  });
});

describe('userGroupPolicyFromPackage', () => {
  it('maps an uncapped package to an unlimited (0 MB) quota', () => {
    const policy = userGroupPolicyFromPackage({
      tier_name: 'prePromo_Monthly',
      display_name: 'Promo Monthly',
      duration_min: 43200,
      data_limit_gb: null,
      is_uncapped: true,
      bandwidth_mbps_up: 5,
      bandwidth_mbps_down: 5,
      max_devices: 2,
    });

    expect(policy).toEqual({
      name: 'prePromo_Monthly',
      comment: 'Promo Monthly',
      timePeriodMin: 43200,
      quotaMb: 0,
      noOfDevice: 2,
      rateLimitKbpsUp: 5120,
      rateLimitKbpsDown: 5120,
    });
  });

  it('converts GB → MB and Mbps → Kbps for a capped micro pass', () => {
    const policy = userGroupPolicyFromPackage({
      tier_name: 'preMicro_Daily',
      display_name: 'Micro Pass',
      duration_min: 1440,
      data_limit_gb: '2.00',
      is_uncapped: false,
      bandwidth_mbps_up: 2,
      bandwidth_mbps_down: 2,
      max_devices: 1,
    });

    expect(policy.quotaMb).toBe(2048);
    expect(policy.rateLimitKbpsUp).toBe(2048);
    expect(policy.rateLimitKbpsDown).toBe(2048);
    expect(policy.noOfDevice).toBe(1);
  });
});
