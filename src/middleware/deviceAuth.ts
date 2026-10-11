import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';

export interface DeviceAuth {
  device_id: string;
  company_id: string | null;
  shop_id: number | null;
}

declare global {
  namespace Express {
    interface Request {
      device?: DeviceAuth;
    }
  }
}

/**
 * Device hardware auth middleware
 * Validates Authorization: Bearer <device_token> against active pos_devices tokens.
 * Attaches req.device = { device_id, company_id, shop_id } and updates last_seen_at.
 * Must be used as async middleware (returns Promise<void>).
 */
export async function requireDeviceAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Device token required' });
    return;
  }
  const token = authHeader.slice('Bearer '.length);
  const { rows } = await pool.query(
    `SELECT id, device_id, company_id, shop_id, status, last_seen_at FROM pos_devices WHERE device_token = $1 AND status = 'active'`,
    [token]
  );
  const device = rows[0];
  if (!device) {
    res.status(401).json({ error: 'Invalid or revoked device token' });
    return;
  }
  // Update last_seen_at
  await pool.query(
    `UPDATE pos_devices SET last_seen_at = NOW() WHERE id = $1`,
    [device.id]
  ).catch(() => {});
  req.device = {
    device_id: device.device_id,
    company_id: device.company_id,
    shop_id: device.shop_id,
  };
  next();
}