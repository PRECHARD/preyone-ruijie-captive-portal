import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { modulesForPlan, planNameFor } from '../plans/entitlements';

export interface CompanyContext {
  id: string;
  name: string;
  modules: string[];
  plan_type: string | null;
  plan_name: string | null;
  /** User-facing plan name (PreTill, PreBiz, …). Kept for older callers. */
  plan_tier?: string | null;
  subscription_status: string | null;
  subscription_expires_at: string | Date | null;
}

declare global {
  namespace Express {
    interface Request {
      company?: CompanyContext;
    }
  }
}

export async function loadCompany(companyId: string | null | undefined, req: Request): Promise<CompanyContext | null> {
  // POS and Invoice come from companies.plan_type. Any other active module
  // (WiFi) is still read from subscriptions so the launcher can show it.
  let query = `SELECT c.id, c.name, c.plan_type, c.subscription_status, c.subscription_expires_at,
            COALESCE(
              (SELECT json_agg(s.module ORDER BY s.module)
                 FROM subscriptions s
                WHERE s.company_id = c.id
                  AND s.status = 'active'
                  AND s.module NOT IN ('pos', 'invoice')),
              '[]'::json
            ) AS extra_modules
       FROM companies c`;
  let id = companyId;
  if (!id) {
    // Backward compat: unassigned accounts resolve to the singleton company
    query += ` ORDER BY c.created_at LIMIT 1`;
  } else {
    query += ` WHERE c.id = $1`;
  }
  const { rows } = await pool.query<{
    id: string;
    name: string;
    plan_type: string | null;
    subscription_status: string | null;
    subscription_expires_at: string | Date | null;
    extra_modules: string[] | null;
  }>(query, id ? [id] : []);
  if (rows.length === 0) return null;
  const row = rows[0];
  const extras = Array.isArray(row.extra_modules) ? row.extra_modules : [];
  const planName = planNameFor(row.plan_type);
  req.company = {
    id: row.id,
    name: row.name,
    plan_type: row.plan_type ?? null,
    plan_name: planName,
    plan_tier: planName,
    subscription_status: row.subscription_status ?? null,
    subscription_expires_at: row.subscription_expires_at ?? null,
    modules: [...modulesForPlan(row.plan_type), ...extras.filter((m) => m !== 'pos' && m !== 'invoice')],
  };
  return req.company;
}

/**
 * Guard: requires the authenticated user to belong to a company.
 * Loads the company + active modules onto req.company.
 * Must run after requireAdminAuth.
 *
 * Unassigned accounts fall back to the singleton company rather than being
 * rejected. This mirrors loadCompany() and the /me session payload, and exists
 * because admin_users.portal_company_id is nullable and signup may not populate it --
 * hard-failing here locked the entire POS module (every route past this guard)
 * behind a 403 for accounts that were otherwise valid and approved.
 *
 * The fallback only applies while there is exactly one company to fall back to.
 * As soon as a second company exists, an unassigned account is denied instead of
 * being silently granted the first company's data.
 */
export async function requireCompany(req: Request, res: Response, next: NextFunction): Promise<void> {
  // The portal realm is keyed by admin_users.portal_company_id. company_id now
  // points at transit_companies and must never be resolved against `companies`.
  const portalCompanyId = (req.adminUser as { portalCompanyId?: string | null } | undefined)?.portalCompanyId ?? null;
  try {
    if (portalCompanyId) {
      const company = await loadCompany(portalCompanyId, req);
      if (company) {
        next();
        return;
      }
      res.status(403).json({ error: 'Company not found' });
      return;
    }

    const { rows } = await pool.query('SELECT id FROM companies ORDER BY created_at LIMIT 2');
    if (rows.length !== 1) {
      res.status(403).json({ error: 'No company assigned to this account' });
      return;
    }
    const company = await loadCompany(rows[0].id, req);
    if (!company) {
      res.status(403).json({ error: 'Company not found' });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Guard: requires the company to have at least one of the given modules
 * enabled (active subscription). Must run after requireCompany.
 */
export function moduleAccess(...modules: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const company = req.company;
    if (!company) {
      res.status(403).json({ error: 'Company context not loaded' });
      return;
    }
    if (!company.modules.some((m: string) => modules.includes(m))) {
      const label = modules.includes('invoice') ? 'Invoice' : modules.includes('pos') ? 'POS' : modules.join(' or ');
      res.status(403).json({
        error: `${label} is not on your plan.`,
        code: 'PLAN_MODULE_DISABLED',
        module: modules[0] ?? null,
        plan_name: company.plan_name ?? null,
      });
      return;
    }
    next();
  };
}