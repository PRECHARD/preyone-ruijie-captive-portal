import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';

export const FIELD_STAFF_ROLES = ['CONDUCTOR', 'DRIVER', 'TICKET_SELLER'] as const;

export const PERMISSIONS = {
  SYSTEM_DEVELOPER: 'system.developer',
  COMPANY_ADMIN: 'company.admin',
  OPERATIONS_MANAGE: 'operations.manage',
  FINANCE_VIEW: 'finance.view',
  TRANSIT_FIELD_APP: 'transit.field_app',
  ROUTE_TEMPLATES_MANAGE: 'route.templates.manage',
} as const;

/**
 * Load effective permissions for a role, plus any per-user grants and any
 * company-wide grants. Covers both auth realms (admin_users.id or
 * transit_users.id).
 *
 * Precedence is a union, not a hierarchy: a company grant cannot remove a role
 * permission, and a role default cannot suppress a per-user grant. Passing a
 * companyId is what lets a field-staff owner hold a narrow capability (e.g.
 * route template management) without being promoted to COMPANY_ADMIN.
 */
export async function loadPermissions(
  role: string,
  userId?: string | null,
  companyId?: string | null,
): Promise<string[]> {
  const params: any[] = [];
  const branches: string[] = [];
  const push = (sql: (placeholder: string) => string, value: any): void => {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    branches.push(sql(`$${params.length}`));
  };
  push((p) => `SELECT rp.permission_code FROM role_permissions rp WHERE rp.role = ${p}`, role);
  push((p) => `SELECT up.permission_code FROM user_permissions up WHERE up.user_id = ${p}`, userId);
  push(
    (p) => `SELECT cp.permission_code FROM company_permissions cp WHERE cp.company_id = ${p}`,
    companyId,
  );
  if (branches.length === 0) return [];
  const { rows } = await pool.query(branches.join(' UNION '), params);
  return rows.map((r: any) => r.permission_code);
}

function hasAny(permissions: string[] | undefined, required: string[]): boolean {
  if (!permissions || permissions.length === 0) return false;
  return required.some((p) => permissions.includes(p));
}

/** Require ANY of the given permissions on an admin-portal request (req.adminUser.permissions). */
export function requirePermission(...required: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.adminUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!hasAny(req.adminUser.permissions, required)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

/** Require ANY of the given permissions on a transit-API request (req.transit.user.permissions). */
export function requireTransitPermission(...required: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const perms = (req as any).transit?.user?.permissions as string[] | undefined;
    if (!hasAny(perms, required)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

/**
 * Append a WHERE fragment scoping vouchers by sold_by to the provided params array.
 * Returns the SQL fragment string to add to WHERE clauses, or null (no scope needed = Level 0).
 * Params are appended with correct $N indexing so callers can mix them freely.
 */
export function scopeVoucherCondition(req: Request, params: any[]): string | null {
  const u = req.adminUser;
  if (!u) return null;
  if (u.role === 'Staff') {
    params.push(u.id);
    return `v.sold_by = $${params.length}`;
  }
  if (u.companyId) {
    params.push(u.companyId);
    return `v.sold_by IN (SELECT id FROM admin_users WHERE company_id = $${params.length} AND deleted_at IS NULL)`;
  }
  return null;
}

/** Same as scopeVoucherCondition but for queries on users that don't JOIN vouchers. */
export function scopeUserVoucherCodeCondition(req: Request, params: any[], alias: string): string | null {
  const u = req.adminUser;
  if (!u) return null;
  if (u.role === 'Staff') {
    params.push(u.id);
    return `${alias}.voucher_code IN (SELECT code FROM vouchers WHERE sold_by = $${params.length})`;
  }
  if (u.companyId) {
    params.push(u.companyId);
    return `${alias}.voucher_code IN (SELECT code FROM vouchers WHERE sold_by IN (SELECT id FROM admin_users WHERE company_id = $${params.length} AND deleted_at IS NULL))`;
  }
  return null;
}