import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { requireApiKey } from '../middleware/adminAuth';

export const adminRouter = Router();

adminRouter.use(requireApiKey);

adminRouter.get('/users', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    'SELECT id, full_name, email, phone, voucher_code, accepted_tos, mac_address, ip_address, created_at, session_expires_at FROM users ORDER BY created_at DESC LIMIT 500'
  );
  res.json(rows);
});

adminRouter.get('/access-log', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT al.id, al.event, al.mac_address, al.ip_address, al.detail, al.created_at, u.full_name, u.email
     FROM access_log al LEFT JOIN users u ON u.id = al.user_id ORDER BY al.created_at DESC LIMIT 1000`
  );
  res.json(rows);
});

adminRouter.post('/vouchers', async (req: Request, res: Response) => {
  const { code, durationMin = 60, maxUses = 1, expiresAt } = req.body as {
    code: string; durationMin?: number; maxUses?: number; expiresAt?: string;
  };
  if (!code) { res.status(422).json({ error: 'code is required' }); return; }
  const { rows } = await pool.query(
    'INSERT INTO vouchers (code, duration_min, max_uses, expires_at) VALUES ($1, $2, $3, $4) RETURNING *',
    [code.toUpperCase(), durationMin, maxUses, expiresAt ?? null]
  );
  res.status(201).json(rows[0]);
});

adminRouter.get('/vouchers', async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM vouchers ORDER BY created_at DESC');
  res.json(rows);
});
