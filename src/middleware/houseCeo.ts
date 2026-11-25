import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db/pool';

/**
 * Platform ("house") tenant helpers.
 *
 * The Preyone house company is the first portal company ever created; it is
 * the tenant that owns the platform subscription ledger and the operator who
 * provisions client companies. Nothing else may act on another tenant's row.
 *
 * Deliberately not cached: a provisioning request can run immediately after a
 * migrate/seed, and a stale id would point at the wrong tenant.
 */
export async function houseCompanyId(): Promise<string | null> {
  const { rows } = await pool.query(
    'SELECT id FROM companies ORDER BY created_at ASC, id ASC LIMIT 1'
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

export function isHouseCeo(
  user: { role?: string | null; portalCompanyId?: string | null } | undefined,
  houseId: string | null
): boolean {
  return !!user && user.role === 'CEO' && !!houseId && user.portalCompanyId === houseId;
}

declare global {
  namespace Express {
    interface Request {
      /** Set by requireHouseCeo so handlers never re-query the house row. */
      houseCompanyId?: string;
    }
  }
}

/**
 * Restricts a route to the CEO bound to the primary Preyone tenant.
 *
 * A CEO of a client company must not be able to provision tenants or read the
 * platform's client list, and an unbound (super-admin style) session is denied
 * too: the house CEO is an explicit tenant membership, not the absence of one.
 */
export async function requireHouseCeo(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const houseId = await houseCompanyId();
    if (!isHouseCeo(req.adminUser, houseId)) {
      res.status(403).json({
        error: 'Only the Preyone house CEO can manage client tenants.',
        code: 'HOUSE_CEO_ONLY',
      });
      return;
    }
    req.houseCompanyId = houseId ?? undefined;
    next();
  } catch (err) {
    next(err);
  }
}
