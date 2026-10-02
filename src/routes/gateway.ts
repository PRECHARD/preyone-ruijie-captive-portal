import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { bindDevice, normalizeMac } from '../services/deviceBinding';

/**
 * Build the RADIUS reply attributes for an authorized session.
 * Shared by the MAC branch (a device bound at redemption) and the voucher-code
 * branch (a device binding itself with a code it already owns).
 */
function buildRadAttrs(row: any): Record<string, unknown> {
  const now = Date.now();
  const expiresAt = new Date(row.session_end || row.session_expires_at).getTime();
  const sessionTimeout = Math.max(0, Math.floor((expiresAt - now) / 1000));

  const radAttrs: Record<string, unknown> = {
    'control:Auth-Type': 'Accept',
    'Session-Timeout': String(sessionTimeout),
    'Idle-Timeout': '1800',
  };

  if (row.bandwidth_up_kbps > 0) {
    radAttrs['WISPr-Bandwidth-Max-Up'] = row.bandwidth_up_kbps;
  }
  if (row.bandwidth_down_kbps > 0) {
    radAttrs['WISPr-Bandwidth-Max-Down'] = row.bandwidth_down_kbps;
  }
  if (!row.is_uncapped && row.data_quota_bytes > 0) {
    radAttrs['ChilliSpot-Max-Total-Octets'] = row.data_quota_bytes;
  }
  return radAttrs;
}

export const gatewayRouter = Router();

// ── RADIUS auth endpoint (called by FreeRADIUS rest module) ──
// FreeRADIUS sends GET /api/radius/auth?mac=<Calling-Station-Id>&username=<User-Name>
// Returns JSON with Auth-Type and session attributes if active session found.
gatewayRouter.get('/api/radius/auth', async (req: Request, res: Response) => {
  const rawMac = (req.query.mac as string || '').replace(/[^A-Fa-f0-9:-]/g, '');
  const rawUsername = req.query.username as string || '';

  if (!rawMac && !rawUsername) {
    return res.status(400).json({ error: 'missing mac or username' });
  }

  // Normalize MAC: strip separators, uppercase
  const macClean = rawMac.toUpperCase().replace(/[:-]/g, '');
  const usernameClean = rawUsername.toUpperCase().replace(/[:-]/g, '');

  try {
    // Check sessions by mac address (format-agnostic) or username
    // Strip all non-hex chars from mac_address for comparison
    const { rows } = await pool.query(
      `SELECT u.session_expires_at, u.mac_address, w.bandwidth_up_kbps, w.bandwidth_down_kbps,
              w.data_quota_bytes, w.data_used_bytes, w.is_uncapped, w.session_end
       FROM users u
       LEFT JOIN wispr_profiles w ON w.user_id = u.id
       WHERE (
              (u.mac_address IS NOT NULL AND REPLACE(REPLACE(UPPER(u.mac_address), ':', ''), '-', '') = $1)
              OR
              (u.mac_address IS NOT NULL AND REPLACE(REPLACE(UPPER(u.mac_address), ':', ''), '-', '') = $2)
             )
         AND u.session_expires_at > NOW()
         AND u.session_token IS NOT NULL
       ORDER BY u.created_at DESC
       LIMIT 1`,
      [macClean || '', usernameClean || '']
    );

    if (rows.length > 0) {
      return res.json(buildRadAttrs(rows[0]));
    }

    // ── Voucher-code branch ──────────────────────────────────────────────
    // The gateway sends User-Name = whatever the customer typed, and ext_login
    // puts the voucher code there (see buildRuijieSuccessUrl). A MAC that has no
    // session of its own can therefore present a code it already owns and bind
    // itself, which is how one purchase covers a phone + laptop + TV without
    // burning another max_uses allocation on a second redemption.
    //
    // Only codes that were genuinely redeemed and still have a live session are
    // honoured, so this cannot mint access out of nothing.
    // Match case-insensitively: Ruijie codes are lowercase, legacy Preyone
    // codes uppercase. The stored v.code casing is what the gateway issued.
    const rawCode = (rawUsername || '').trim().toUpperCase();
    const deviceMac = normalizeMac(rawMac);
    if (rawCode && deviceMac) {
      const vres = await pool.query(
        `SELECT v.id AS voucher_id, v.code, v.package_tier, v.max_devices,
                u.id AS user_id, u.session_expires_at,
                w.bandwidth_up_kbps, w.bandwidth_down_kbps, w.data_quota_bytes,
                w.data_used_bytes, w.is_uncapped, w.session_end
         FROM vouchers v
         JOIN users u ON UPPER(u.voucher_code) = UPPER(v.code)
         LEFT JOIN wispr_profiles w ON w.user_id = u.id
         WHERE UPPER(v.code) = $1
           AND (v.expires_at IS NULL OR v.expires_at > NOW())
           AND u.session_expires_at > NOW()
           AND u.session_token IS NOT NULL
         ORDER BY u.created_at DESC
         LIMIT 1`,
        [rawCode]
      );

      if (vres.rows.length > 0) {
        const v = vres.rows[0];
        const outcome = await bindDevice({
          voucherId: v.voucher_id,
          voucherCode: v.code,
          tierName: v.package_tier,
          maxDevices: v.max_devices,
          mac: deviceMac,
          userId: v.user_id,
        });

        if (outcome.ok) {
          console.log(
            `RADIUS: device ${deviceMac} authorized via voucher ${v.code} ` +
            `(${outcome.activeDevices}/${outcome.limit} devices${outcome.bound ? ', newly bound' : ''})`
          );
          return res.json(buildRadAttrs(v));
        }

        // Device limit reached — refuse rather than silently over-serve, since
        // Ruijie's own user group enforces the same number gateway-side.
        if (outcome.reason === 'device_limit_reached') {
          console.warn(
            `RADIUS: rejected ${deviceMac} for voucher ${v.code} — ` +
            `device limit ${outcome.limit} reached`
          );
        }
      }
    }

    return res.status(404).json({ error: 'session not found' });
  } catch (err) {
    console.error('RADIUS auth error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// ── RADIUS accounting endpoint (called by FreeRADIUS rest module) ──
// FreeRADIUS sends GET /api/radius/acct?mac=<Calling-Station-Id>&status=<Acct-Status-Type>&input=<Acct-Input-Octets>&output=<Acct-Output-Octets>&session=<Acct-Session-Id>
// Updates data_used_bytes for the session matching the MAC address.
gatewayRouter.get('/api/radius/acct', async (req: Request, res: Response) => {
  const mac = (req.query.mac as string || '').replace(/[:-]/g, '').toUpperCase();
  const status = req.query.status as string || '';
  const inputStr = req.query.input as string || '0';
  const outputStr = req.query.output as string || '0';
  const sessionId = req.query.session as string || '';

  if (!mac || !status) {
    return res.status(400).json({ error: 'missing mac or status' });
  }

  try {
    const inputOctets = parseInt(inputStr, 10) || 0;
    const outputOctets = parseInt(outputStr, 10) || 0;
    const totalOctets = inputOctets + outputOctets;

    if (status === 'Stop' || status === 'Interim-Update') {
      await pool.query(
        `UPDATE wispr_profiles
         SET data_used_bytes = GREATEST(data_used_bytes, $1)
         WHERE id = (
           SELECT w.id FROM wispr_profiles w
           JOIN users u ON u.id = w.user_id
           WHERE REPLACE(REPLACE(UPPER(u.mac_address), ':', ''), '-', '') = $2
           ORDER BY w.session_end DESC NULLS LAST
           LIMIT 1
         )`,
        [totalOctets, mac]
      );
      if (status === 'Stop') {
        await pool.query(
          `UPDATE wispr_profiles
           SET session_end = NOW()
           WHERE id = (
             SELECT w.id FROM wispr_profiles w
             JOIN users u ON u.id = w.user_id
             WHERE REPLACE(REPLACE(UPPER(u.mac_address), ':', ''), '-', '') = $1
             ORDER BY w.session_end DESC NULLS LAST
             LIMIT 1
           )`,
          [mac]
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('RADIUS acct error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

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
// GET /auth?token=<session_token>   — verify by session token
// GET /auth?mac=<client_mac>        — verify by MAC address
// GET /auth?token=<t>&mac=<m>       — verify both match
// Returns Auth: 1 if session is valid, Auth: 0 otherwise
gatewayRouter.get('/auth', async (req: Request, res: Response) => {
  const token = req.query.token as string | undefined;
  const mac = (req.query.mac as string | undefined)?.toUpperCase();

  try {
    if (token) {
      const { rows } = await pool.query(
        'SELECT session_expires_at FROM users WHERE session_token = $1',
        [token]
      );
      if (rows.length > 0 && new Date(rows[0].session_expires_at) > new Date()) {
        res.set('Content-Type', 'text/plain');
        res.send('Auth: 1');
        return;
      }
    } else if (mac) {
      const { rows } = await pool.query(
        `SELECT session_expires_at FROM users
         WHERE mac_address = $1 AND session_expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [mac]
      );
      if (rows.length > 0) {
        res.set('Content-Type', 'text/plain');
        res.send('Auth: 1');
        return;
      }
    }
    res.set('Content-Type', 'text/plain');
    res.send('Auth: 0');
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
