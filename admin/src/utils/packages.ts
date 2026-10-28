import type { AuthUser } from '../context/AuthContext';

/**
 * Client-side mirror of src/config/packages.ts.
 *
 * The server is the authority (POST /vouchers returns 403 for a non-CEO promo
 * mint), but the mint UI should never offer a tier the account cannot sell.
 * Keep this list in sync when a new `ceoExclusive` tier is added server-side.
 */
export const CEO_EXCLUSIVE_TIERS = ['prePromo_Monthly'];

export function isCeoExclusiveTier(tierName?: string | null): boolean {
  if (!tierName) return false;
  const needle = tierName.trim().toLowerCase();
  return CEO_EXCLUSIVE_TIERS.some((tier) => tier.toLowerCase() === needle);
}

/** True only for the logged-in CEO account. */
export function canMintCeoExclusive(user?: Pick<AuthUser, 'role'> | null): boolean {
  return user?.role === 'CEO';
}

/**
 * Filter a package list for the voucher mint pickers: promo tiers disappear for
 * everyone except the CEO. `ceo_exclusive` from GET /api/admin/packages is
 * honoured too, so a tier newly flagged server-side is hidden even before this
 * list is updated.
 */
export function packagesForMinting<T extends { tier_name: string; ceo_exclusive?: boolean }>(
  packages: T[],
  user?: Pick<AuthUser, 'role'> | null
): T[] {
  if (canMintCeoExclusive(user)) return packages;
  return packages.filter((p) => !p.ceo_exclusive && !isCeoExclusiveTier(p.tier_name));
}
