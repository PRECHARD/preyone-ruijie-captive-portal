import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';

export async function maintenanceCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Skip maintenance check for admin/pos routes and static assets
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/pos') || req.path.startsWith('/api/transit') || req.path.startsWith('/js/') || req.path.startsWith('/css/') || req.path.startsWith('/images/')) {
    next();
    return;
  }
  // The payment webhook MUST stay reachable during maintenance. Pesepay delivers
  // callbacks for payments already in flight; if we 503 them the customer is
  // charged but no voucher is ever minted. Only the webhook is exempt —
  // /initiate stays closed so no new sales start while maintenance is on.
  if (req.method === 'POST' && req.path === '/api/payments/webhook') {
    next();
    return;
  }
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'maintenance_mode'");
    if (rows.length > 0 && rows[0].value === 'true') {
      const { rows: msgRows } = await pool.query("SELECT value FROM settings WHERE key = 'maintenance_message'");
      const message = msgRows.length > 0 ? msgRows[0].value : 'System under maintenance. Please check back later.';
      res.status(503).json({ error: 'maintenance', message });
      return;
    }
  } catch { /* skip if DB error */ }
  next();
}
