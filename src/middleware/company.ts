import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';

export interface CompanyContext {
  id: string;
  name: string;
  modules: string[];
  plan_tier?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      company?: CompanyContext;
    }
  }
}

export async function loadCompany(companyId: string | null | undefined, req: Request): Promise<CompanyContext | null> {
  let query = `SELECT c.id, c.name,
            (SELECT MAX(s.plan_tier) FROM subscriptions s WHERE s.company_id = c.id) AS plan_tier,
            COALESCE(
              (SELECT json_agg(s.module ORDER BY s.module)
                 FROM subscriptions s
                WHERE s.company_id = c.id AND s.status = 'active'),
              '[]'::json
            ) AS modules
       FROM companies c`;
  let id = companyId;
  if (!id) {
    // Backward compat: unassigned accounts resolve to the singleton company
    query += ` ORDER BY c.created_at LIMIT 1`;
  } else {
    query += ` WHERE c.id = $1`;
  }
  const { rows } = await pool.query<{ id: string; name: string; modules: string[]; plan_tier: string | null }>(query, id ? [id] : []);
  if (rows.length === 0) return null;
  req.company = { id: rows[0].id, name: rows[0].name, modules: rows[0].modules ?? [], plan_tier: rows[0].plan_tier ?? null };
  return req.company;
}

/**
 * Guard: requires the authenticated user to belong to a company.
 * Loads the company + active modules onto req.company.
 * Must run after requireAdminAuth.
 */
export async function requireCompany(req: Request, res: Response, next: NextFunction): Promise<void> {
  const companyId = (req.adminUser as { company_id?: string | null } | undefined)?.company_id;
  if (!companyId) {
    res.status(403).json({ error: 'No company assigned to this account' });
    return;
  }
  try {
    const company = await loadCompany(companyId, req);
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
      res.status(403).json({ error: `Required module not enabled: ${modules.join(' or ')}` });
      return;
    }
    next();
  };
}