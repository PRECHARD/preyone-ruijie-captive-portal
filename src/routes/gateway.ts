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

/**
 * Has this session burned through its data allowance?
 *
 * The gateway enforces the cap itself via ChilliSpot-Max-Total-Octets, but if
 * it ever ignores that attribute the client browses for free. Rejecting here as
 * well makes the cap authoritative regardless of gateway behaviour.
 *
 * `data_quota_bytes` is the total cap (it is what we hand the gateway as
 * ChilliSpot-Max-Total-Octets), and `data_used_bytes` accumulates via RADIUS
 * accounting, so exhaustion is `used >= quota`.
 */
function isOverQuota(row: any): boolean {
  if (row.is_uncapped) return false;
  const quota = Number(row.data_quota_bytes ?? 0);
  const used = Number(row.data_used_bytes ?? 0);
  // A quota of 0 means no cap was set, not a zero-byte allowance.
  if (!Number.isFinite(quota) || quota <= 0) return false;
  if (!Number.isFinite(used)) return false;
  return used >= quota;
}

export const gatewayRouter = Router();

/**
 * Persist a RADIUS authentication decision so the dashboard's "Auth Success"
 * card reports real accept/reject outcomes instead of a derived placeholder.
 *
 * Never throws: failing to record an auth decision must not change what
 * FreeRADIUS is told. Awaited so tests and crash-dumps see the write.
 */
interface RadiusLogMeta {
  requestMethod?: string;
  requestUrl?: string;
  httpStatus?: number;
}

async function recordRadiusAuth(
  event: 'radius_accept' | 'radius_reject' | 'radius_stop',
  detail: string,
  mac: string,
  userId?: string | null,
  meta?: RadiusLogMeta
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO access_log
         (user_id, event, mac_address, detail, request_method, request_url, http_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId ?? null,
        event,
        mac || null,
        detail,
        meta?.requestMethod ?? null,
        meta?.requestUrl ?? null,
        meta?.httpStatus ?? null,
      ]
    );
  } catch (err) {
    console.error('RADIUS auth log write failed:', (err as Error).message);
  }
}

/** Request facts for the log row. `req.path` excludes query strings (MAC/PIN). */
function radiusLogMeta(req: Request, httpStatus: number): RadiusLogMeta {
  return { requestMethod: req.method, requestUrl: req.path, httpStatus };
}

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
      `SELECT u.id AS user_id, u.session_expires_at, u.mac_address, w.bandwidth_up_kbps, w.bandwidth_down_kbps,
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
      const row = rows[0];

      if (isOverQuota(row)) {
        console.warn(
          `RADIUS: rejected ${macClean} — data quota exhausted ` +
          `(${row.data_used_bytes}/${row.data_quota_bytes} bytes)`
        );
        await recordRadiusAuth('radius_reject', 'quota_exhausted', rawMac || macClean, row.user_id, radiusLogMeta(req, 403));
        // 403 makes rlm_rest emit an explicit reject. 404 would mean "no such
        // session" and would be indistinguishable from an unknown MAC.
        return res.status(403).json({
          error: 'data quota exhausted',
          'control:Auth-Type': 'Reject',
        });
      }

      await recordRadiusAuth('radius_accept', 'mac_session', rawMac || macClean, row.user_id, radiusLogMeta(req, 200));
      return res.json(buildRadAttrs(row));
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
          if (isOverQuota(v)) {
            console.warn(
              `RADIUS: rejected ${deviceMac} for voucher ${v.code} — ` +
              `data quota exhausted (${v.data_used_bytes}/${v.data_quota_bytes} bytes)`
            );
            await recordRadiusAuth('radius_reject', 'quota_exhausted', rawMac || deviceMac, v.user_id, radiusLogMeta(req, 403));
            return res.status(403).json({
              error: 'data quota exhausted',
              'control:Auth-Type': 'Reject',
            });
          }

          console.log(
            `RADIUS: device ${deviceMac} authorized via voucher ${v.code} ` +
            `(${outcome.activeDevices}/${outcome.limit} devices${outcome.bound ? ', newly bound' : ''})`
          );
          await recordRadiusAuth('radius_accept', 'voucher_code', rawMac || deviceMac, v.user_id, radiusLogMeta(req, 200));
          return res.json(buildRadAttrs(v));
        }

        // Device limit reached — refuse rather than silently over-serve, since
        // Ruijie's own user group enforces the same number gateway-side.
        if (outcome.reason === 'device_limit_reached') {
          console.warn(
            `RADIUS: rejected ${deviceMac} for voucher ${v.code} — ` +
            `device limit ${outcome.limit} reached`
          );
          await recordRadiusAuth('radius_reject', 'device_limit', rawMac || deviceMac, v.user_id, radiusLogMeta(req, 404));
        }
      }
    }

    await recordRadiusAuth('radius_reject', 'no_session', rawMac || macClean, null, radiusLogMeta(req, 404));
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
        await recordRadiusAuth(
          'radius_stop',
          `session=${sessionId || 'n/a'} in=${inputOctets} out=${outputOctets}`,
          mac,
          null,
          radiusLogMeta(req, 200)
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('RADIUS acct error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ── Client quota status (drives the "data finished" portal page) ──
// GET /api/gateway/quota?mac=<client_mac>
// Called by the captive portal when a device lands on /connect, so an
// exhausted client sees why it lost access instead of a bare voucher form.
//
// Deliberately does NOT return the voucher code: this endpoint is reachable by
// anyone on the captive network who knows a MAC, and a voucher code is a
// bearer credential for the whole allowance.
gatewayRouter.get('/api/gateway/quota', async (req: Request, res: Response) => {
  const mac = normalizeMac(req.query.mac as string);
  if (!mac) {
    return res.status(400).json({ error: 'missing mac' });
  }

  try {
    // A device can reach this endpoint two ways, so resolve both:
    //   - the redemption device, recorded on users.mac_address
    //   - a later device bound with the code it already owns (laptop, TV),
    //     recorded in voucher_devices
    // Only live sessions count; an expired one should see the voucher form.
    const { rows } = await pool.query(
      `WITH target AS (
         SELECT id FROM users
          WHERE REPLACE(REPLACE(UPPER(mac_address), ':', ''), '-', '') = $1
         UNION
         SELECT user_id FROM voucher_devices
          WHERE mac_norm = $1 AND is_active = true
       )
       SELECT w.data_quota_bytes, w.data_used_bytes, w.is_uncapped, v.package_tier
       FROM target t
       JOIN users u ON u.id = t.id
       LEFT JOIN wispr_profiles w ON w.user_id = u.id
       LEFT JOIN vouchers v ON UPPER(v.code) = UPPER(u.voucher_code)
       WHERE u.session_expires_at > NOW()
       ORDER BY u.created_at DESC
       LIMIT 1`,
      [mac]
    );

    if (rows.length === 0) {
      return res.json({ found: false, exhausted: false });
    }

    const row = rows[0];
    return res.json({
      found: true,
      exhausted: isOverQuota(row),
      uncapped: !!row.is_uncapped,
      usedBytes: Number(row.data_used_bytes ?? 0),
      quotaBytes: Number(row.data_quota_bytes ?? 0),
      packageTier: row.package_tier ?? null,
    });
  } catch (err) {
    console.error('quota status error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// ── End-user device beacon (device-model extraction) ───────────────
// The captive-portal page reports its browser User-Agent after a session is
// live. We only record it onto an ACTIVE session for that MAC so a caller
// cannot pollute arbitrary rows; the admin SPA parses it with ua-parser-js.
// GET /report-ua?mac=<client_mac>&ua=<urlencoded User-Agent>
gatewayRouter.get('/report-ua', async (req: Request, res: Response) => {
  const mac = (req.query.mac as string | undefined)?.trim().toUpperCase();
  const ua = (req.query.ua as string | undefined)?.trim();
  if (!mac || !ua || ua.length > 1024) {
    res.set('Content-Type', 'text/plain');
    res.status(400).send('bad request');
    return;
  }
  try {
    await pool.query(
      `UPDATE users SET user_agent = $1
       WHERE UPPER(mac_address) = $2 AND session_expires_at > NOW()`,
      [ua, mac]
    );
  } catch { /* non-critical */ }
  res.set('Content-Type', 'text/plain');
  res.send('OK');
});

// ── Gateway health check ──
// The EG105G-P sends this every ~2 minutes to verify the auth server is alive
// GET /ping/?gw_sn=<serial>&gw_id=<mac>&dev_model=<model>&dev_softversion=<fw>&sys_uptime=<seconds>
// Exported because the firmware actually calls it under /connectAuth/ping/ —
// see connectAuthRouter at the bottom of this file.
export async function handleGatewayPing(req: Request, res: Response): Promise<void> {
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
}

gatewayRouter.get('/ping', handleGatewayPing);

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

// ── /connectAuth — the prefix the firmware actually uses ────────────────────
// The EG105G-P's auth-server base path is `/connectAuth` (WiFiDog-style), so it
// calls `/connectAuth/ping/`, `/connectAuth`, and — presumably once a client
// asks for internet — `/connectAuth/auth`, `/connectAuth/login`, etc. None of
// that existed here: every request fell through to the SPA catch-all and
// received index.html (plus a 502 whenever pm2 restarted). That is why
// gateway_heartbeats stayed empty and no client was ever redirected to the
// portal, and therefore why voucher_redemptions / voucher_devices never filled.
//
// This router is deliberately observational:
//   * it logs every path and query so the real protocol can be wired up to
//     what the firmware expects rather than guessed;
//   * it serves the heartbeat, which already existed under /api/gateway/ping;
//   * it never answers an auth question — unmatched paths fall through
//     unchanged, so no client's session state can be altered from here.
export const connectAuthRouter = Router();

// Session material must never reach the log; serials and MACs are the point of
// the log, so they are kept.
const SENSITIVE_QUERY_KEY = /^(password|pass|secret|jwt|token|pin|otp|access_?token|refresh_?token)$/i;

function logConnectAuth(req: Request): void {
  const query = Object.entries(req.query)
    .map(([key, value]) => {
      const rendered = Array.isArray(value) ? value.join(',') : String(value ?? '');
      return `${key}=${SENSITIVE_QUERY_KEY.test(key) ? '[redacted]' : rendered}`;
    })
    .join('&');
  console.info(
    `[connectAuth] ${req.method} ${req.originalUrl.split('?')[0]}` +
    `${query ? '?' + query : ''} from ${req.ip} ua=${req.get('user-agent') || '-'}`
  );
}

connectAuthRouter.use((req, _res, next) => {
  logConnectAuth(req);
  next();
});

// express leaves strict routing off, so '/ping' also matches '/connectAuth/ping/'.
connectAuthRouter.get('/ping', handleGatewayPing);
