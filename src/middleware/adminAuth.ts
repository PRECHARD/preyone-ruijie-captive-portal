import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { loadPermissions } from './rbac';

const JWT_SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';
let _jwtSecretWarned = false;
function getJwtSecret(): string {
  if (!_jwtSecretWarned && JWT_SECRET === 'preyone-jwt-secret-change-in-production') {
    console.warn('WARNING: JWT_SECRET is not set. Using insecure default. Set JWT_SECRET in .env for production.');
    _jwtSecretWarned = true;
  }
  return JWT_SECRET;
}

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  fullName: string;
  /**
   * Realm fields are camelCase in memory and snake_case in SQL. The DB columns
   * are admin_users.company_id (transit_companies) and portal_company_id
   * (companies); these carry the same values under the naming the rest of the
   * codebase reads them by.
   */
  /** Transit company (transit_companies). Scopes Transit Operations; NULL = platform ops. */
  companyId?: string | null;
  /** Portal company (companies). Scopes POS/invoice/WiFi; NULL = resolved by fallback. */
  portalCompanyId?: string | null;
  /**
   * Effective capability set (role + user + company grants). The admin console
   * gates its entire navigation on this array, so it must be populated on every
   * authenticated request, not only inside route handlers that guard themselves.
   */
  permissions?: string[];
}

declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminUser;
    }
  }
}

export async function requireAdminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const decoded = jwt.verify(auth.slice(7), getJwtSecret()) as AdminUser;
    // Re-read tenancy from the database on every request. Both realm columns are
    // deliberately NOT taken from the token: a token minted before an
    // assignment change (or before the two-realm split existed) would otherwise
    // pin the account to a stale tenant for the whole 7-day lifetime.
    // Permissions are resolved the same way -- from the current role and the
    // transit company -- so a revoked grant takes effect immediately instead of
    // persisting until the token expires.
    const { rows } = await pool.query(
      'SELECT id, role, approved, company_id, portal_company_id FROM admin_users WHERE id = $1',
      [decoded.id]
    );
    if (rows.length === 0 || !rows[0].approved) {
      res.status(401).json({ error: 'Account deactivated or removed' });
      return;
    }
    const permissions = await loadPermissions(
      rows[0].role,
      rows[0].id,
      rows[0].company_id ?? null
    );
    req.adminUser = {
      ...decoded,
      role: rows[0].role,
      companyId: rows[0].company_id ?? null,
      portalCompanyId: rows[0].portal_company_id ?? null,
      permissions,
    };
    next();
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Invalid or expired token' });
    } else {
      next(err);
    }
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.adminUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!roles.includes(req.adminUser.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
