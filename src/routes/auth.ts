import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { buildRuijieSuccessUrl, WISPrSessionConfig } from '../utils/redirect';

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

  const macAddress = (req.query.mac as string) ?? (req.query.clientMac as string) ?? (req.headers['x-client-mac'] as string) ?? null;
  const ipAddress  = (req.query.ip  as string) ?? req.ip ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{
      id: string; duration_min: number; max_uses: number; used_count: number; expires_at: string | null;
      data_limit_gb: number | null; is_uncapped: boolean; bandwidth_mbps_up: number; bandwidth_mbps_down: number;
      package_tier: string;
    }>('SELECT id, duration_min, max_uses, used_count, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, package_tier FROM vouchers WHERE code = $1 FOR UPDATE', [voucherCode.toUpperCase()]);

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Invalid Voucher code.' });
      return;
    }
    const v = rows[0];
    if (v.used_count >= v.max_uses) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Voucher has already reached maximum allocations.' });
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
       RETURNING id`,
      [fullName, phone, voucherCode, acceptedTos, macAddress, ipAddress, sessionToken, sessionExpires]
    );

    await client.query(
      `INSERT INTO voucher_redemptions (voucher_id, voucher_code, user_id, full_name, mac_address, ip_address) VALUES ($1, $2, $3, $4, $5, $6::inet)`,
      [v.id, voucherCode.toUpperCase(), userRows[0].id, fullName, macAddress, ipAddress]
    );

    await client.query(
      `INSERT INTO access_log (user_id, event, mac_address, ip_address, detail) VALUES ($1, 'login', $2, $3::inet, $4)`,
      [userRows[0].id, macAddress, ipAddress, `session=${sessionDurationMin}min`]
    );

    await client.query('COMMIT');

    const redirectConfig: WISPrSessionConfig = {
      sessionToken,
      macAddress: macAddress || undefined,
      packageData: {
        data_limit_gb: v.data_limit_gb,
        is_uncapped: v.is_uncapped,
        bandwidth_mbps_up: v.bandwidth_mbps_up,
        bandwidth_mbps_down: v.bandwidth_mbps_down,
        duration_min: sessionDurationMin,
      },
    };

    const ruijieSuccessUrl = buildRuijieSuccessUrl(req, redirectConfig);
    res.json({
      success: true,
      sessionToken,
      sessionExpiresAt: sessionExpires.toISOString(),
      redirectUrl: ruijieSuccessUrl,
      bandwidthMbpsUp: v.bandwidth_mbps_up,
      bandwidthMbpsDown: v.bandwidth_mbps_down,
      dataLimitGb: v.data_limit_gb,
      isUncapped: v.is_uncapped,
      durationMin: sessionDurationMin,
      macAddress: macAddress,
      ipAddress: ipAddress,
      voucherCode: voucherCode.toUpperCase(),
      packageTier: v.package_tier,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Authentication failed.' });
  } finally {
    client.release();
  }
});

authRouter.get('/status', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) { res.status(400).json({ error: 'Missing token' }); return; }
    const { rows } = await pool.query(
      `SELECT u.session_expires_at, u.voucher_code, wp.data_used_bytes, wp.data_quota_bytes,
              v.data_limit_gb, v.is_uncapped, p.tier_name AS package_tier
       FROM users u
       LEFT JOIN wispr_profiles wp ON wp.user_id = u.id
       LEFT JOIN vouchers v ON UPPER(u.voucher_code) = v.code
       LEFT JOIN packages p ON p.tier_name = v.package_tier
       WHERE u.session_token = $1`,
      [token]
    );
    if (rows.length === 0) { res.json({ active: false }); return; }
    const row = rows[0];
    const active = new Date(row.session_expires_at) > new Date();
    res.json({
      active,
      expiresAt: row.session_expires_at,
      bytesUsed: row.data_used_bytes ? parseInt(row.data_used_bytes) : null,
      bytesTotal: row.data_quota_bytes ? parseInt(row.data_quota_bytes) : null,
      dataLimitGb: row.data_limit_gb,
      isUncapped: row.is_uncapped,
      voucherCode: row.voucher_code,
      packageTier: row.package_tier,
    });
  } catch (err) {
    console.error('Status error:', err);
    res.status(500).json({ error: 'Status check failed.' });
  }
});


