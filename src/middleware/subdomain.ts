import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';

export interface TenantContext {
  id: string;
  slug: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      tenantSlug?: string;
      tenant?: TenantContext | null;
    }
  }
}

// Static app domains that must never be interpreted as tenant slugs.
const STATIC_SUBDOMAINS: ReadonlySet<string> = new Set(['app', 'admin', 'pos', 'wifi']);

/**
 * Resolves a dynamic <slug>.preyone.com host into a tenant company.
 * Static app subdomains and unknown slugs pass through untouched (tenant = null).
 */
export async function resolveTenant(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const rawHost = req.headers.host || '';
    const tenantSlug = rawHost.split(':')[0].split('.')[0].toLowerCase();
    req.tenantSlug = tenantSlug;

    if (!tenantSlug || STATIC_SUBDOMAINS.has(tenantSlug)) return next();

    const { rows } = await pool.query<{ id: string; slug: string; name: string }>(
      'SELECT id, slug, name FROM companies WHERE slug = $1 LIMIT 1',
      [tenantSlug]
    );

    req.tenant = rows.length ? { id: rows[0].id, slug: rows[0].slug, name: rows[0].name } : null;
    next();
  } catch (err) {
    next(err);
  }
}