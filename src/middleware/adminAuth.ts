import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { FIELD_STAFF_ROLES, loadPermissions } from './rbac';

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
  /** Transit company for the Transit Operations realm; null (Level 0) sees all. */
  companyId?: string | null;
  /** Portal company for the POS/invoice/WiFi realm; null when unassigned. */
  portalCompanyId?: string | null;
  /** Effective permission codes resolved from role_permissions + user_permissions. */
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
    const decoded = jwt.verify(auth.slice(7), getJwtSecret(), { algorithms: ['HS256'] }) as AdminUser;
    // Check if user still exists and is approved (revoke deactivated users)
    const { rows } = await pool.query(
      'SELECT id, approved, role, company_id, portal_company_id FROM admin_users WHERE id = $1',
      [decoded.id]
    );
    if (rows.length === 0 || !rows[0].approved) {
      res.status(401).json({ error: 'Account deactivated or removed' });
      return;
    }
    // Field staff must never use the web admin portal
    if (FIELD_STAFF_ROLES.includes(rows[0].role)) {
      res.status(403).json({ error: 'Field staff must use the Preyone Transit Mobile App.' });
      return;
    }
    const permissions = await loadPermissions(
      rows[0].role,
      decoded.id,
      rows[0].company_id ?? null,
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
