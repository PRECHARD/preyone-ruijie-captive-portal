import type { Response } from 'express';
import { pool } from '../db/pool';

// ── SaaS subscription guard (3-tier engine) ───────────────────────────────
// Shared by POST /api/pos/devices/register and /auto-register (and available
// to any future device/sync endpoint that must respect the plan). Reads the
// tier off the companies row that requireCompany already loaded, then
// enforces in this order (per the subscription spec):
//   1. active device count vs the plan's max_devices, for a device that is
//      not registered yet        -> 403 DEVICE_LIMIT_EXCEEDED
//   2. subscription expiration   -> 403 SUBSCRIPTION_EXPIRED
//      (manual suspension        -> 403 SUBSCRIPTION_SUSPENDED)
// A device that already has a registration row re-registers without counting
// against the cap (it is already one of the counted rows), but a lapsed
// subscription still blocks it. Companies with no plan row yet — or a NULL
// max_devices — are grandfathered: there is nothing to enforce against.
// Returns true when the caller may proceed; false once a response was sent.
export async function enforceSubscriptionGuard(
  res: Response,
  companyId: string,
  existingDevice: boolean
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT max_devices, subscription_status, subscription_expires_at
       FROM companies WHERE id = $1`,
    [companyId]
  );
  const plan = rows[0];
  if (!plan) return true;

  if (!existingDevice && plan.max_devices !== null && plan.max_devices !== undefined) {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pos_devices
        WHERE company_id = $1 AND status = 'active'`,
      [companyId]
    );
    const active = Number(countRows[0]?.n ?? 0);
    const max = Number(plan.max_devices);
    if (active >= max) {
      res.status(403).json({
        error: `Device limit reached: your subscription allows ${max} active device(s). Upgrade your plan to register more devices.`,
        code: 'DEVICE_LIMIT_EXCEEDED',
        max_devices: max,
        active_devices: active,
      });
      return false;
    }
  }

  const expiresAt = plan.subscription_expires_at ? new Date(plan.subscription_expires_at) : null;
  if ((expiresAt && expiresAt.getTime() <= Date.now()) || plan.subscription_status === 'expired') {
    res.status(403).json({
      error: 'Subscription expired. Renew your plan to continue registering devices.',
      code: 'SUBSCRIPTION_EXPIRED',
      subscription_expires_at: expiresAt ? expiresAt.toISOString() : null,
    });
    return false;
  }

  if (plan.subscription_status === 'suspended') {
    res.status(403).json({
      error: 'Subscription suspended. Renew your plan to re-enable device registration.',
      code: 'SUBSCRIPTION_SUSPENDED',
    });
    return false;
  }

  return true;
}
