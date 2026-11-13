// Single rule for Preyone POS / Invoice plans.
//
// companies.plan_type decides which modules a company may open and how many
// devices it may register. The subscriptions table is kept in step with that
// column (see syncPlanModules and db/migrations/v4_plan_entitlements.sql) so
// older readers stay correct, but enforcement reads plan_type.
//
// Display names follow the WiFi package catalogue (PreLite, PreBizPlus,
// PreUltra, …): a short Pre + Pascal token. Live voucher SKUs are not reused.
// Stable ids (standard_10, …) stay so existing rows and Pesepay intents keep
// working. Prices, device caps and the SQL trigger in v4 must stay in lockstep.

export const PLAN_TIERS = ['standard_10', 'pos_invoice_15', 'growth_20', 'unlimited_30'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];
export type PlanModule = 'pos' | 'invoice';

export interface PlanTierInfo {
  id: PlanTier;
  name: string;
  price: number;
  devices: number;
  tagline: string;
  modules: PlanModule[];
}

export const TIER_CATALOG: PlanTierInfo[] = [
  {
    id: 'standard_10',
    name: 'PreTill',
    price: 10,
    devices: 1,
    modules: ['pos'],
    tagline: 'POS only. One registered device.',
  },
  {
    id: 'pos_invoice_15',
    name: 'PreBiz',
    price: 15,
    devices: 3,
    modules: ['pos', 'invoice'],
    tagline: 'POS and Invoice. Up to 3 devices.',
  },
  {
    id: 'growth_20',
    name: 'PrePro',
    price: 20,
    devices: 6,
    modules: ['pos', 'invoice'],
    tagline: 'POS and Invoice. Up to 6 devices.',
  },
  {
    id: 'unlimited_30',
    name: 'PreUnlimited',
    price: 30,
    devices: 9999,
    modules: ['pos', 'invoice'],
    tagline: 'POS and Invoice. Unlimited devices.',
  },
];

export const isPlanTier = (v: unknown): v is PlanTier => PLAN_TIERS.includes(v as PlanTier);

/** Production started the $15 tier as invoicing_15. Checkout and enforcement treat it as PreBiz. */
const LEGACY_PLAN_IDS: Record<string, PlanTier> = {
  invoicing_15: 'pos_invoice_15',
};

export function canonicalPlanId(v: unknown): PlanTier | null {
  if (typeof v !== 'string') return null;
  const id = v.trim();
  if (isPlanTier(id)) return id;
  return LEGACY_PLAN_IDS[id] ?? null;
}

export function tierById(planType: string | null | undefined): PlanTierInfo | null {
  const id = canonicalPlanId(planType);
  return id ? TIER_CATALOG.find((t) => t.id === id) ?? null : null;
}

export function planNameFor(planType: string | null | undefined): string | null {
  return tierById(planType)?.name ?? null;
}

/** Modules granted by the plan. Unknown or missing plans grant nothing. */
export function modulesForPlan(planType: string | null | undefined): PlanModule[] {
  return tierById(planType)?.modules.slice() ?? [];
}

export interface EntitlementSnapshot {
  modules: string[];
  subscription_status?: string | null;
  subscription_expires_at?: string | Date | null;
  plan_name?: string | null;
}

export interface EntitlementDenial {
  code: 'SUBSCRIPTION_EXPIRED' | 'SUBSCRIPTION_SUSPENDED' | 'PLAN_MODULE_DISABLED';
  error: string;
  module?: string;
}

/** A lapsed plan can still be opened. It cannot record a new sale or invoice. */
export function subscriptionBlock(company: EntitlementSnapshot): EntitlementDenial | null {
  const status = company.subscription_status || 'active';
  const raw = company.subscription_expires_at;
  const expiresAt = raw ? new Date(raw) : null;
  const expiredByDate =
    !!expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now();
  if (expiredByDate || status === 'expired') {
    return {
      code: 'SUBSCRIPTION_EXPIRED',
      error: 'Your subscription has expired. Renew your plan to record new sales and invoices.',
    };
  }
  if (status === 'suspended') {
    return {
      code: 'SUBSCRIPTION_SUSPENDED',
      error: 'Your subscription is suspended. Renew your plan to record new sales and invoices.',
    };
  }
  return null;
}

/** Invoice documents (invoices and quotations) require the invoice module and a live plan. */
export function invoiceBlock(company: EntitlementSnapshot): EntitlementDenial | null {
  const lapse = subscriptionBlock(company);
  if (lapse) return lapse;
  if (!company.modules.includes('invoice')) {
    return {
      code: 'PLAN_MODULE_DISABLED',
      module: 'invoice',
      error: 'Invoice is not on your plan. Upgrade to PreBiz or higher.',
    };
  }
  return null;
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/**
 * Rewrite the pos and invoice rows so they match plan_type.
 * Wifi rows are left alone: WiFi vouchers are not part of these four plans.
 */
export async function syncPlanModules(
  client: Queryable,
  companyId: string,
  planType: string
): Promise<void> {
  const granted = new Set(modulesForPlan(planType));
  for (const module of ['pos', 'invoice'] as const) {
    const status = granted.has(module) ? 'active' : 'suspended';
    await client.query(
      `INSERT INTO subscriptions (company_id, module, plan_tier, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, module) DO UPDATE
         SET status = EXCLUDED.status,
             plan_tier = EXCLUDED.plan_tier,
             updated_at = NOW()`,
      [companyId, module, planType, status]
    );
  }
}
