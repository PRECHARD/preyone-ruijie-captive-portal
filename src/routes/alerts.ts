import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { buildAlertCopy, PENDING_FRESHNESS_H } from '../services/voucherMonitorService';
import type { AlertTier } from '../services/voucherMonitorService';

/**
 * /api/alerts — the customer-facing half of the hybrid alert channel.
 *
 *  GET    /public-key     → VAPID public key (so /data can subscribe)
 *  POST   /subscribe      → store a Push API subscription for a voucher PIN
 *  DELETE /subscribe      → drop a subscription (endpoint dies / user opts out)
 *  GET    /pending        → unacknowledged alert events for the portal banner
 *  POST   /ack            → dismiss an alert for good
 *
 * Security posture (mirrors /api/check-usage): the voucher PIN is the only
 * credential. A MAC alone can never read alerts. Everything is rate limited,
 * endpoints must be https (push services only), and responses never echo
 * secrets. Errors are generic.
 */
export const alertsRouter = Router();

const alertsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
alertsRouter.use(alertsLimiter);

function normalizeVoucher(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toLowerCase();
  return code.length >= 3 && code.length <= 64 ? code : null;
}

alertsRouter.get('/public-key', (_req: Request, res: Response) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    // Not an error: without keys the portal still shows banners; /data just
    // hides the push opt-in.
    res.status(200).json({ publicKey: null });
    return;
  }
  res.json({ publicKey });
});

alertsRouter.post('/subscribe', async (req: Request, res: Response) => {
  const voucher = normalizeVoucher(req.body?.voucher);
  const sub = req.body?.subscription;
  const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint : '';
  const p256dh = typeof sub?.keys?.p256dh === 'string' ? sub.keys.p256dh : '';
  const auth = typeof sub?.keys?.auth === 'string' ? sub.keys.auth : '';

  if (!voucher) { res.status(400).json({ error: 'invalid_voucher' }); return; }
  if (!endpoint.startsWith('https://') || endpoint.length > 2048) {
    res.status(400).json({ error: 'invalid_endpoint' }); return;
  }
  if (p256dh.length < 20 || auth.length < 10) {
    res.status(400).json({ error: 'invalid_keys' }); return;
  }

  const ua = typeof req.headers['user-agent'] === 'string'
    ? req.headers['user-agent'].slice(0, 200)
    : null;

  // One row per browser endpoint; re-subscribing moves it to the latest PIN.
  await pool.query(
    `INSERT INTO push_subscriptions (voucher_code, endpoint, p256dh, auth, user_agent, last_used_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (endpoint) DO UPDATE
       SET voucher_code = EXCLUDED.voucher_code,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           last_used_at = NOW()`,
    [voucher, endpoint, p256dh, auth, ua]
  );
  res.json({ ok: true });
});

alertsRouter.delete('/subscribe', async (req: Request, res: Response) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
  if (!endpoint) { res.status(400).json({ error: 'invalid_endpoint' }); return; }
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  res.json({ ok: true });
});

alertsRouter.get('/pending', async (req: Request, res: Response) => {
  const voucher = normalizeVoucher(req.query.voucher);
  if (!voucher) { res.status(400).json({ error: 'invalid_voucher' }); return; }

  const { rows } = await pool.query(
    `SELECT id, tier, pct, used_mb, total_mb, created_at
     FROM voucher_alert_events
     WHERE voucher_code = $1
       AND acknowledged_at IS NULL
       AND created_at > NOW() - ($2 || ' hours')::interval
     ORDER BY created_at DESC
     LIMIT 5`,
    [voucher, String(PENDING_FRESHNESS_H)]
  );

  res.json({
    alerts: rows.map((r) => {
      const copy = buildAlertCopy(Number(r.tier) as AlertTier);
      return {
        id: r.id,
        tier: Number(r.tier),
        title: copy.title,
        body: copy.body,
        pct: r.pct == null ? null : Number(r.pct),
        usedMB: r.used_mb == null ? null : Number(r.used_mb),
        totalMB: r.total_mb == null ? null : Number(r.total_mb),
        createdAt: r.created_at,
      };
    }),
  });
});

alertsRouter.post('/ack', async (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const voucher = normalizeVoucher(req.body?.voucher);
  if (!id || !voucher) { res.status(400).json({ error: 'invalid_request' }); return; }
  // UUID ids are unguessable, but the PIN must still match: an ack can never
  // dismiss another customer's alert.
  await pool.query(
    `UPDATE voucher_alert_events
     SET acknowledged_at = NOW()
     WHERE id = $1 AND voucher_code = $2 AND acknowledged_at IS NULL`,
    [id, voucher]
  );
  res.json({ ok: true });
});
