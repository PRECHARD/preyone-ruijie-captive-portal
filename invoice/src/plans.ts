/**
 * Display labels for the invoice Upgrade modal. Same ids as POS.
 * invoicing_15 is accepted from older API responses and shown as PreBiz.
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
    name: 'PreTill',
    price: 10,
    devices: 1,
    tagline: 'POS only. One registered device.',
    checkoutReady: true,
  },
  {
    id: 'pos_invoice_15',
    name: 'PreBiz',
    price: 15,
    devices: 3,
    tagline: 'POS and Invoice. Up to 3 devices.',
    checkoutReady: true,
  },
  {
    id: 'growth_20',
    name: 'PrePro',
    price: 20,
    devices: 6,
    tagline: 'POS and Invoice. Up to 6 devices.',
    checkoutReady: true,
  },
  {
    id: 'unlimited_30',
    name: 'PreUnlimited',
    price: 30,
    devices: 9999,
    tagline: 'POS and Invoice. Unlimited devices.',
    checkoutReady: true,
  },
];

function canonicalTierId(id: string): string {
  return id === 'invoicing_15' ? 'pos_invoice_15' : id;
}

export function mergePlanTiers(
  apiTiers?: Array<{ id: string; name: string; price: number; devices: number; tagline: string }>
): PlanTierCard[] {
  const byId = new Map((apiTiers ?? []).map((t) => [canonicalTierId(t.id), t]));
  return PLAN_DISPLAY.map((d) => {
    const api = byId.get(d.id);
    if (!api) return d;
    return {
      ...d,
      price: api.price,
      devices: api.devices,
      checkoutReady: true,
    };
  });
}
