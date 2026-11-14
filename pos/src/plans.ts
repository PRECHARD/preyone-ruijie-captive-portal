/**
 * Marketing catalog for the Upgrade modal.
 * Checkout IDs must match /api/subscription/plans (and companies.plan_type).
 * `invoicing_15` is live once v5 migration + subscription catalog ship.
 */
export interface PlanTierCard {
  id: string;
  name: string;
  price: number;
  devices: number;
  tagline: string;
  /** False when the live API cannot fulfil this tier yet. */
  checkoutReady: boolean;
}

export const PLAN_DISPLAY: PlanTierCard[] = [
  {
    id: 'standard_10',
    name: 'POS Only',
    price: 10,
    devices: 1,
    tagline: 'Till only — one registered device.',
    checkoutReady: true,
  },
  {
    id: 'invoicing_15',
    name: 'POS + Invoicing',
    price: 15,
    devices: 3,
    tagline: 'POS and invoicing — up to 3 devices.',
    checkoutReady: true,
  },
  {
    id: 'growth_20',
    name: 'POS + Invoicing',
    price: 20,
    devices: 6,
    tagline: 'POS and invoicing — up to 6 devices.',
    checkoutReady: true,
  },
  {
    id: 'unlimited_30',
    name: 'Unlimited',
    price: 30,
    devices: 9999,
    tagline: 'Unlimited devices, priority support.',
    checkoutReady: true,
  },
];

/** Merge API tiers with display labels; keep API price/devices when present. */
export function mergePlanTiers(
  apiTiers?: Array<{ id: string; name: string; price: number; devices: number; tagline: string }>
): PlanTierCard[] {
  const byId = new Map((apiTiers ?? []).map((t) => [t.id, t]));
  return PLAN_DISPLAY.map((d) => {
    const api = byId.get(d.id);
    if (!api) return d;
    return {
      ...d,
      price: api.price,
      devices: api.devices,
      checkoutReady: true,
      tagline: d.tagline || api.tagline,
    };
  });
}
