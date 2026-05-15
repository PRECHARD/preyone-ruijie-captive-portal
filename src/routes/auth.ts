import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { buildRuijieSuccessUrl } from '../utils/redirect';

export const authRouter = Router();

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const signupValidators = [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),

  body('phone').trim().matches(/^\+?[\d\s\-()]{7,20}$/).withMessage('Valid phone number is required'),
  body('voucherCode').trim().notEmpty().withMessage('Voucher code is required'),
  body('acceptedTos').custom((value) => value === true).withMessage('You must accept the terms'),
];

authRouter.post('/signup', signupLimiter, signupValidators, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
    return;
  }

  const { fullName, phone, voucherCode, acceptedTos } = req.body as {
    fullName: string; phone: string; voucherCode: string; acceptedTos: boolean;
  };

  const macAddress = (req.query.mac as string) ?? (req.headers['x-client-mac'] as string) ?? null;
  const ipAddress  = (req.query.ip  as string) ?? req.ip ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Voucher is now required
    const { rows } = await client.query<{
      id: string; duration_min: number; max_uses: number; used_count: number; expires_at: string | null;
    }>('SELECT id, duration_min, max_uses, used_count, expires_at FROM vouchers WHERE code = $1', [voucherCode.toUpperCase()]);

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Invalid Voucher code.' });
      return;
    }
    const v = rows[0];
    if (v.used_count >= v.max_uses) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Voucher has already been used the maximum number of times.' });
      return;
    }
    if (v.expires_at && new Date(v.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Voucher has expired.' });
      return;
    }
    await client.query('UPDATE vouchers SET used_count = used_count + 1 WHERE id = $1', [v.id]);
    const sessionDurationMin = v.duration_min;

    const sessionToken   = uuidv4();
    const sessionExpires = new Date(Date.now() + sessionDurationMin * 60 * 1000);

    const { rows: userRows } = await client.query<{ id: string }>(
      `INSERT INTO users (full_name, phone, voucher_code, accepted_tos, mac_address, ip_address, session_token, session_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8)
       ON CONFLICT (session_token) DO NOTHING
       RETURNING id`,
      [fullName, phone, voucherCode ?? null, acceptedTos, macAddress, ipAddress, sessionToken, sessionExpires]
    );

    await client.query(
      `INSERT INTO access_log (user_id, event, mac_address, ip_address, detail) VALUES ($1, 'login', $2, $3::inet, $4)`,
      [userRows[0]?.id, macAddress, ipAddress, `session=${sessionDurationMin}min`]
    );

    await client.query('COMMIT');

    const ruijieSuccessUrl = buildRuijieSuccessUrl(req, sessionToken);
    res.json({ success: true, sessionToken, sessionExpiresAt: sessionExpires.toISOString(), redirectUrl: ruijieSuccessUrl });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

authRouter.get('/status', async (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) { res.status(400).json({ error: 'Missing token' }); return; }
  const { rows } = await pool.query('SELECT session_expires_at FROM users WHERE session_token = $1', [token]);
  if (rows.length === 0) { res.json({ active: false }); return; }
  const active = new Date(rows[0].session_expires_at) > new Date();
  res.json({ active, expiresAt: rows[0].session_expires_at });
});

