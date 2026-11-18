/**
 * Starlink customer portal plan catalog — single source of truth.
 * Prices are USD per month. The portal fetches this via GET /api/starlink/plans.
 */

export type StarlinkPlanCode =
  | 'residential_lite'
  | 'residential_standard'
  | 'residential'
  | 'business_priority_lite'
  | 'business_priority'
  | 'business_priority_plus';

export interface StarlinkPlan {
  code: StarlinkPlanCode;
  name: string;
  priceUsd: number;
  cadence: 'month';
  rank: number;
  perks: string[];
}

export const STARLINK_PLANS: readonly StarlinkPlan[] = [
  {
    code: 'residential_lite',
    name: 'Residential Lite',
    priceUsd: 45,
    cadence: 'month',
    rank: 1,
    perks: ['Unlimited data', 'Standard speeds at home', 'Self-service portal access', 'Preyone Payment billing'],
  },
  {
    code: 'residential_standard',
    name: 'Residential Standard',
    priceUsd: 65,
    cadence: 'month',
    rank: 2,
    perks: ['Unlimited data', 'Faster speeds at home', 'Priority support queue', 'Preyone Payment billing'],
  },
  {
    code: 'residential',
    name: 'Residential',
    priceUsd: 77,
    cadence: 'month',
    rank: 3,
    perks: ['Higher speeds in congested areas', 'Unlimited data', 'Priority support queue', 'Ideal for remote work'],
  },
  {
    code: 'business_priority_lite',
    name: 'Business Priority Lite',
    priceUsd: 110,
    cadence: 'month',
    rank: 4,
    perks: ['Priority performance for small teams', 'Multi-site kit management', 'USD invoicing'],
  },
  {
    code: 'business_priority',
    name: 'Business Priority',
    priceUsd: 135,
    cadence: 'month',
    rank: 5,
    perks: ['Priority performance for teams', 'Multi-site kit management', 'USD invoicing'],
  },
  {
    code: 'business_priority_plus',
    name: 'Business Priority Plus',
    priceUsd: 235,
    cadence: 'month',
    rank: 6,
    perks: ['Top-tier performance for teams', 'Multi-site kit management', 'Dedicated account contact', 'USD invoicing'],
  },
];

export function getStarlinkPlan(code: string | null | undefined): StarlinkPlan | null {
  return STARLINK_PLANS.find((p) => p.code === code) ?? null;
}
