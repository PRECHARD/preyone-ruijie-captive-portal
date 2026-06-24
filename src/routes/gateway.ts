import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';

export const gatewayRouter = Router();

// ── Gateway health check ──
// The EG105G-P sends this every ~2 minutes to verify the auth server is alive
// GET /ping/?gw_sn=<serial>&gw_id=<mac>&dev_model=<model>&dev_softversion=<fw>&sys_uptime=<seconds>
gatewayRouter.get('/ping', async (req: Request, res: Response) => {
  const { gw_sn, gw_id, dev_model, dev_softversion, sys_uptime } = req.query;

  // Log gateway heartbeats for admin dashboard
  try {
    await pool.query(
      `INSERT INTO gateway_heartbeats (gw_sn, gw_id, dev_model, dev_softversion, sys_uptime, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (gw_sn) DO UPDATE SET
         last_seen = NOW(),
         gw_id = EXCLUDED.gw_id,
         dev_model = EXCLUDED.dev_model,
         dev_softversion = EXCLUDED.dev_softversion,
         sys_uptime = EXCLUDED.sys_uptime,
         ip_address = EXCLUDED.ip_address`,
      [gw_sn as string, gw_id as string, dev_model as string, dev_softversion as string, sys_uptime as string, req.ip]
    );
  } catch { /* non-critical */ }

  res.set('Content-Type', 'text/plain');
  res.send('OK');
});

// ── Session verification (called by gateway via WISPr / redirect) ──
// GET /auth?token=<session_token>
// Returns Auth: 1 if session is valid, Auth: 0 otherwise
gatewayRouter.get('/auth', async (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) {
    res.set('Content-Type', 'text/plain');
    res.send('Auth: 0');
    return;
  }

  try {
    const { rows } = await pool.query(
      'SELECT session_expires_at FROM users WHERE session_token = $1',
      [token]
    );
    if (rows.length > 0 && new Date(rows[0].session_expires_at) > new Date()) {
      res.set('Content-Type', 'text/plain');
      res.send('Auth: 1');
    } else {
      res.set('Content-Type', 'text/plain');
      res.send('Auth: 0');
    }
  } catch {
    res.set('Content-Type', 'text/plain');
    res.send('Auth: 0');
  }
});

// ── Gateway captive portal redirect handler ──
// When the EG105G-P redirects a user here, preserve all params and serve portal
// GET /portal?wlanuserip=<ip>&wlanacname=<name>&ssid=<ssid>&mac=<mac>&nasip=<gw_ip>&url=<original>
gatewayRouter.get('/portal', (req: Request, res: Response) => {
  const queryString = new URLSearchParams();
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string') queryString.set(key, val);
  }
  res.redirect(`/?${queryString.toString()}`);
});
