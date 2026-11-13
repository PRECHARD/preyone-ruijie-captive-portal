// Canonical package catalogue.
//
// `src/db/migrate.ts` seeds the `packages` table from PACKAGE_CATALOG, and the
// Admin Console reads the live rows from `GET /api/admin/packages`. Keeping one
// array here means a tier can never be seeded without its policy flags, and the
// Ruijie User Group provisioner can derive a group policy from the same data.
//
// ADDITIVE RULE: append tiers, never rename an existing `tierName`. The tier
// name is the key that `voucher_profiles`, `ruijie_vouchers`, historical
// payments and live vouchers all reference.

export interface PackageCatalogEntry {
  tierName: string;
  displayName: string;
  priceAmount: number;
  priceCurrency: string;
  billingPeriod: string;
  durationMin: number;
  /** `null` + isUncapped=true means unlimited data. */
  dataLimitGb: number | null;
  isUncapped: boolean;
  bandwidthMbpsUp: number;
  bandwidthMbpsDown: number;
  maxDevices: number | null;
  /** Only the CEO may mint vouchers on this tier (enforced server-side). */
  ceoExclusive?: boolean;
  /** Short operator-facing note, surfaced in the admin catalogue. */
  tag?: string;
  description?: string;
}

export const PACKAGE_CATALOG: PackageCatalogEntry[] = [
  // ── Orange band (entry level) ──────────────────────────────────────
  { tierName: 'PreLite', displayName: 'Daily Basic', priceAmount: 1.00, priceCurrency: 'USD', billingPeriod: 'daily', durationMin: 1440, dataLimitGb: 5, isUncapped: false, bandwidthMbpsUp: 5, bandwidthMbpsDown: 5, maxDevices: 1 },
  { tierName: 'PreLite Plus', displayName: 'Starter', priceAmount: 1.99, priceCurrency: 'USD', billingPeriod: '2days', durationMin: 2880, dataLimitGb: 10, isUncapped: false, bandwidthMbpsUp: 5, bandwidthMbpsDown: 5, maxDevices: 1 },
  { tierName: 'PreLink', displayName: 'Weekly Standard', priceAmount: 4.99, priceCurrency: 'USD', billingPeriod: 'weekly', durationMin: 10080, dataLimitGb: 20, isUncapped: false, bandwidthMbpsUp: 5, bandwidthMbpsDown: 5, maxDevices: 1 },
  // ── Micro + streaming daily passes ─────────────────────────────────
  // The micro pass is the cheapest entry point on the network: a small
  // 2 GB allowance capped at 2 Mbps so one customer cannot saturate an AP.
  { tierName: 'preMicro_Daily', displayName: 'Micro Pass', priceAmount: 0.50, priceCurrency: 'USD', billingPeriod: 'daily', durationMin: 1440, dataLimitGb: 2, isUncapped: false, bandwidthMbpsUp: 2, bandwidthMbpsDown: 2, maxDevices: 1, tag: 'Micro pass · 2 Mbps', description: '2 GB at 2/2 Mbps for one device, one day.' },
  // Movie-download tier: uncapped data, 10/10 Mbps, one device.
  { tierName: 'preStream_Daily', displayName: 'Stream Daily', priceAmount: 2.00, priceCurrency: 'USD', billingPeriod: 'daily', durationMin: 1440, dataLimitGb: null, isUncapped: true, bandwidthMbpsUp: 10, bandwidthMbpsDown: 10, maxDevices: 1, tag: 'Movie download tier', description: 'Uncapped data at 10/10 Mbps for one device, one day.' },
  // ── Cyan band (monthly) ────────────────────────────────────────────
  { tierName: 'PreGo', displayName: 'PreGo', priceAmount: 7.99, priceCurrency: 'USD', billingPeriod: 'monthly', durationMin: 43200, dataLimitGb: 30, isUncapped: false, bandwidthMbpsUp: 5, bandwidthMbpsDown: 5, maxDevices: 1 },
  { tierName: 'PreFlow', displayName: 'PreFlow', priceAmount: 9.99, priceCurrency: 'USD', billingPeriod: 'monthly', durationMin: 43200, dataLimitGb: 40, isUncapped: false, bandwidthMbpsUp: 5, bandwidthMbpsDown: 5, maxDevices: 1 },
  { tierName: 'PreCore', displayName: 'PreCore', priceAmount: 14.99, priceCurrency: 'USD', billingPeriod: 'monthly', durationMin: 43200, dataLimitGb: null, isUncapped: true, bandwidthMbpsUp: 5, bandwidthMbpsDown: 5, maxDevices: 1 },
  // CEO promo: sold only from the CEO's own console session.
  { tierName: 'prePromo_Monthly', displayName: 'Promo Monthly', priceAmount: 15.00, priceCurrency: 'USD', billingPeriod: 'monthly', durationMin: 43200, dataLimitGb: null, isUncapped: true, bandwidthMbpsUp: 5, bandwidthMbpsDown: 5, maxDevices: 2, ceoExclusive: true, tag: 'CEO exclusive', description: 'Unlimited monthly promo, 5/5 Mbps on two devices.' },
  // ── Blue band (business) ───────────────────────────────────────────
  { tierName: 'PreBizPlus', displayName: 'Business', priceAmount: 19.99, priceCurrency: 'USD', billingPeriod: 'monthly', durationMin: 43200, dataLimitGb: null, isUncapped: true, bandwidthMbpsUp: 10, bandwidthMbpsDown: 10, maxDevices: 1 },
  { tierName: 'PreFam', displayName: 'Family Pack', priceAmount: 24.99, priceCurrency: 'USD', billingPeriod: 'monthly', durationMin: 43200, dataLimitGb: null, isUncapped: true, bandwidthMbpsUp: 10, bandwidthMbpsDown: 10, maxDevices: 2 },
  { tierName: 'PreBizPro', displayName: 'Business Pro', priceAmount: 29.99, priceCurrency: 'USD', billingPeriod: 'monthly', durationMin: 43200, dataLimitGb: null, isUncapped: true, bandwidthMbpsUp: 10, bandwidthMbpsDown: 10, maxDevices: 3 },
  // ── Purple band (premium) ──────────────────────────────────────────
  { tierName: 'PreMax', displayName: 'Monthly Pro', priceAmount: 34.99, priceCurrency: 'USD', billingPeriod: 'monthly', durationMin: 43200, dataLimitGb: null, isUncapped: true, bandwidthMbpsUp: 15, bandwidthMbpsDown: 15, maxDevices: 1 },
  { tierName: 'PreUltra', displayName: 'Monthly Unlimited', priceAmount: 44.99, priceCurrency: 'USD', billingPeriod: 'monthly', durationMin: 43200, dataLimitGb: null, isUncapped: true, bandwidthMbpsUp: 15, bandwidthMbpsDown: 15, maxDevices: 1 },
  { tierName: 'PreExecutive', displayName: 'VIP Tier', priceAmount: 59.99, priceCurrency: 'USD', billingPeriod: 'monthly', durationMin: 43200, dataLimitGb: null, isUncapped: true, bandwidthMbpsUp: 30, bandwidthMbpsDown: 30, maxDevices: 1 },
];

/** Tiers that only the CEO may see in the mint UI and mint server-side. */
export const CEO_EXCLUSIVE_TIERS: string[] = PACKAGE_CATALOG
  .filter((p) => p.ceoExclusive)
  .map((p) => p.tierName);

/** Case-insensitive because tier names arrive from forms and query strings. */
export function isCeoExclusiveTier(tierName: string | null | undefined): boolean {
  if (!tierName) return false;
  const needle = tierName.trim().toLowerCase();
  return CEO_EXCLUSIVE_TIERS.some((tier) => tier.toLowerCase() === needle);
}

export function findCatalogPackage(tierName: string | null | undefined): PackageCatalogEntry | null {
  if (!tierName) return null;
  const needle = tierName.trim().toLowerCase();
  return PACKAGE_CATALOG.find((p) => p.tierName.toLowerCase() === needle) ?? null;
}
