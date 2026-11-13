/**
 * Marketing catalog for the Upgrade modal (invoice workspace).
 * Same IDs as POS — checkout only for tiers the live API accepts.
 */
export interface PlanTierCard {
  id: string;
  name: string;
  price: number;
  devices: number;
  tagline: string;
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
