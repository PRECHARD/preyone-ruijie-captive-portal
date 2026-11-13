import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { buildRuijieSuccessUrl, WISPrSessionConfig } from '../utils/redirect';
import { transformToWISPrProfile } from '../utils/wisprTransformer';
import {
  buildVoucherActivation,
  classifyLocalVoucher,
  findVoucherForRedemption,
  markVoucherRedeemed,
  normalizeVoucherCode,
} from '../models/voucher';

/**
 * Local captive-portal redemption API.
 *
 * WHY THIS EXISTS
 * ---------------
 * The PWA redemption path used to be the account signup handler, which:
 *   - is gated by a 10-requests-per-15-minutes per-IP limiter. Every guest behind
 *     one hotspot NAT shares that IP, so the 11th customer of the day was told
 *     "Too many requests, please try again later" — the "voucher rejected" bug;
 *   - carries account-creation requirements (password, email, ToS) that a
 *     walk-up voucher customer does not have.
 *
 * `POST /api/portal/redeem` is the fast path: it resolves the PIN against the
 * local `vouchers` table inside one transaction, activates the session and
 * answers 200 with everything the client needs to hand off to the gateway.
 *
 * The redemption itself performs **no outbound HTTP at all** — no Ruijie Cloud
 * call, no OCS, no RADIUS request. `tests/portalRedeem.test.ts` fails the build
 * if this module eagerly imports a Ruijie client, and asserts the only Ruijie
 * touch point runs AFTER the response is written. The gateway authorises the MAC
 * afterwards via ext_login/RADIUS, which is the existing, working flow; a
 * best-effort "authorise this MAC in the cloud now" hook fires post-commit and
 * can never delay or fail a redemption (`src/services/ruijieAuthorize.ts`).
 *
 * Strictly additive: `/api/auth/signup` and its handler are untouched, and the
 * portal JS falls back to it if this route is unavailable.
 */

export const portalRouter = Router();

/**
 * Failure-only limiter.
 *
 * `skipSuccessfulRequests` means a successful redemption never consumes budget,
 * so a hotspot NAT with a queue of paying customers cannot lock itself out —
 * only invalid/exhausted PIN attempts count. Raise with
 * `PORTAL_REDEEM_FAIL_LIMIT_PER_MIN` if a busy site ever trips it.
 */
const intFromEnv = (raw: string | undefined, fallback: number, min: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.trunc(n) : fallback;
};

export const PORTAL_REDEEM_RATE_LIMIT_OPTIONS = {
  windowMs: 60 * 1000,
  max: intFromEnv(process.env.PORTAL_REDEEM_FAIL_LIMIT_PER_MIN, 60, 10),
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many voucher attempts. Please check your PIN and try again.', retryable: true },
} as const;

const redeemLimiter = rateLimit(PORTAL_REDEEM_RATE_LIMIT_OPTIONS as any);

export interface GatewayContext {
  macAddress: string | null;
  ipAddress: string | null;
  nasip: string | null;
  loginUrl: string | null;
  nasMac: string | null;
  ssid: string | null;
  originalUrl: string | null;
}

/**
 * Gateway parameters travel in the query string because a POST whose params are
 * in the body silently loses them (AGENTS.md gotcha: `client_mac`, `login_url`,
 * `ssid`, `nas_ip`, `nas_mac`, `url` are read from `req.query`).
 */
export function readGatewayContext(req: Request): GatewayContext {
  const q = req.query as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const body = (req.body ?? {}) as Record<string, unknown>;
  return {
    macAddress:
      s(q.client_mac) || s(q.mac) || s(q.clientMac) || s(q.client_mac_address) ||
      s(req.headers['x-client-mac']) || s(body.clientMac) || s(body.client_mac) || s(body.mac),
    // `nas_ip` is the gateway, never the client, so it is deliberately absent
    // here. `wlanuserip` is the WISPr name for the station address.
    ipAddress:
      s(q.client_ip) || s(q.clientIp) || s(q.ip) || s(q.wlanuserip) || s(q.userip) ||
      s(body.clientIp) || s(body.client_ip) || s(body.ip) || req.ip || null,
    nasip: s(q.nas_ip) || s(q.nasip) || s(q.wlanacname),
    loginUrl: s(q.login_url),
    nasMac: s(q.nas_mac),
    ssid: s(q.ssid),
    originalUrl: s(q.url) || s(q.redirect),
  };
}

/** Client-controlled strings that must never leak into a session record. */
function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return value === '' ? null : value.slice(0, max);
}

const ZW_PHONE_RE = /^(\+263\d{9}|0\d{9})$/;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * POST /api/portal/redeem
 *
 * Body: { voucherCode, fullName?, phone?, email?, acceptedTos? }
 * Query: client_mac / login_url / ssid / nas_ip / nas_mac / url (gateway params)
 *
 * 200 → { success, source: 'local', sessionToken, sessionExpiresAt, redirectUrl, … }
 * 400 → { error, reason: 'invalid' | 'exhausted' | 'expired' | 'disabled' }
 */
portalRouter.post('/redeem', redeemLimiter, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const code = normalizeVoucherCode(body.voucherCode ?? body.code ?? body.pin);
  if (!code) {
    res.status(400).json({ error: 'Voucher code is required.', reason: 'invalid' });
    return;
  }

  const ctx = readGatewayContext(req);
  const fullName = cleanText(body.fullName, 120) || 'Voucher Guest';
  const phoneRaw = cleanText(body.phone, 40);
  const emailRaw = cleanText(body.email, 160);
  const phone = phoneRaw && ZW_PHONE_RE.test(phoneRaw) ? phoneRaw : phoneRaw || null;
  const email = emailRaw && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw.toLowerCase() : null;
  // Quick-connect clients omit this; the portal displays the ToS link next to
  // the PIN box, so an explicit `false` is the only thing that blocks.
  const acceptedTos = body.acceptedTos !== false && body.acceptedTos !== 'false';

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('[portal/redeem] database unavailable', err);
    res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
    return;
  }

  try {
    await client.query('BEGIN');

    const row = await findVoucherForRedemption(client, code);
    const verdict = classifyLocalVoucher(row);
    if (!verdict.ok) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: verdict.message, reason: verdict.reason });
      return;
    }

    const voucher = verdict.voucher;
    const activation = buildVoucherActivation(voucher);
    // Vendor-issued casing (Ruijie mints lowercase) — never re-case before the
    // gateway receives it.
    const canonicalCode = voucher.code;

    const usedCount = await markVoucherRedeemed(client, voucher.id, {
      clientMac: ctx.macAddress,
      clientIp: ctx.ipAddress,
    });
    if (usedCount == null) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Invalid Voucher code.', reason: 'invalid' });
      return;
    }

    // "Used" is derived from used_count/max_uses (never a stored status column),
    // so a single-use code is already `used` at this point.
    const voucherStatus: 'used' | 'available' =
      Number(voucher.max_uses) > 0 && usedCount >= Number(voucher.max_uses) ? 'used' : 'available';

    const sessionToken = crypto.randomUUID();
    const sessionExpires = new Date(Date.now() + activation.durationMin * 60 * 1000);

    // Same partial-index conflict predicate as the signup handler. A bare
    // `ON CONFLICT (email)` cannot be inferred against
    // `idx_users_email_unique` and makes every insert fail with 42P10.
    let { rows: userRows } = await client.query<{ id: string }>(
      `INSERT INTO users (full_name, phone, email, voucher_code, accepted_tos, mac_address, ip_address, session_token, session_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8, $9)
       ON CONFLICT (email) WHERE email IS NOT NULL AND email != '' DO NOTHING
       RETURNING id`,
      [fullName, phone || 'N/A', email, canonicalCode, acceptedTos, ctx.macAddress, ctx.ipAddress, sessionToken, sessionExpires]
    );
    if (userRows.length === 0 && email) {
      ({ rows: userRows } = await client.query<{ id: string }>(
        `INSERT INTO users (full_name, phone, email, voucher_code, accepted_tos, mac_address, ip_address, session_token, session_expires_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6::inet, $7, $8)
         RETURNING id`,
        [fullName, phone || 'N/A', canonicalCode, acceptedTos, ctx.macAddress, ctx.ipAddress, sessionToken, sessionExpires]
      ));
    }
    if (userRows.length === 0) {
      // Only reachable for a duplicate e-mail on the retry path.
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'This email is already registered. Please log in instead.', reason: 'email_taken' });
      return;
    }
    const userId = userRows[0].id;

    await client.query(
      `INSERT INTO voucher_redemptions (voucher_id, voucher_code, user_id, full_name, mac_address, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6::inet)`,
      [voucher.id, canonicalCode, userId, fullName, ctx.macAddress, ctx.ipAddress]
    );

    // WISPr profile is what FreeRADIUS reads back when the gateway authorises
    // the MAC, so it must exist before the client is redirected to ext_login.
    if (ctx.macAddress) {
      const wisprProfile = transformToWISPrProfile({
        macAddress: ctx.macAddress,
        packageData: {
          data_limit_gb: activation.dataLimitGb,
          is_uncapped: activation.isUncapped,
          bandwidth_mbps_up: activation.bandwidthMbpsUp,
          bandwidth_mbps_down: activation.bandwidthMbpsDown,
          duration_min: activation.durationMin,
        },
      });
      await client.query(
        `INSERT INTO wispr_profiles (user_id, mac_address, bandwidth_up_kbps, bandwidth_down_kbps, data_quota_bytes, is_uncapped, session_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, wisprProfile.macAddress, wisprProfile.bandwidthUpKbps, wisprProfile.bandwidthDownKbps,
          wisprProfile.dataQuotaBytes, wisprProfile.isUncapped, sessionExpires]
      );
    }

    // Per-device session ledger. `users.session_expires_at` remains the account
    // view (unchanged); this row is the gateway-facing one: which MAC, which
    // voucher, which bandwidth, and when access ends. Upsert on the token so a
    // retried redemption for the same token refreshes instead of duplicating.
    await client.query(
      `INSERT INTO active_sessions
         (session_token, user_id, voucher_id, voucher_code, client_mac, client_ip,
          package_tier, duration_min, bandwidth_mbps_up, bandwidth_mbps_down,
          data_limit_gb, is_uncapped, started_at, expires_at, last_seen_at, status)
       VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8, $9, $10, $11, $12, NOW(), $13, NOW(), 'active')
       ON CONFLICT (session_token) DO UPDATE SET
         client_mac   = COALESCE(EXCLUDED.client_mac, active_sessions.client_mac),
         client_ip    = COALESCE(EXCLUDED.client_ip, active_sessions.client_ip),
         expires_at   = EXCLUDED.expires_at,
         last_seen_at = NOW(),
         status       = 'active',
         updated_at   = NOW()`,
      [
        sessionToken, userId, voucher.id, canonicalCode, ctx.macAddress, ctx.ipAddress,
        activation.packageTier, activation.durationMin, activation.bandwidthMbpsUp,
        activation.bandwidthMbpsDown, activation.dataLimitGb, activation.isUncapped, sessionExpires,
      ]
    );

    await client.query(
      `INSERT INTO access_log (user_id, event, mac_address, ip_address, detail, request_method, http_status)
       VALUES ($1, 'login', $2, $3::inet, $4, 'POST', 200)`,
      [userId, ctx.macAddress, ctx.ipAddress, `local_redeem session=${activation.durationMin}min voucher=${canonicalCode}`]
    );

    await client.query('COMMIT');

    const redirectConfig: WISPrSessionConfig = {
      sessionToken,
      macAddress: ctx.macAddress || undefined,
      originalUrl: ctx.originalUrl || undefined,
      nasip: ctx.nasip || undefined,
      loginUrl: ctx.loginUrl || undefined,
      nasMac: ctx.nasMac || undefined,
      ssid: ctx.ssid || undefined,
      voucherCode: canonicalCode,
      packageData: {
        data_limit_gb: activation.dataLimitGb,
        is_uncapped: activation.isUncapped,
        bandwidth_mbps_up: activation.bandwidthMbpsUp,
        bandwidth_mbps_down: activation.bandwidthMbpsDown,
        duration_min: activation.durationMin,
      },
    };
    // Owned by src/utils/redirect.ts — it carries the ORIGINAL url in
    // url/redirect/next_url, which the gateway requires. Do not rebuild it here.
    const redirectUrl = buildRuijieSuccessUrl(req, redirectConfig);

    res.status(200).json({
      success: true,
      source: 'local',
      sessionToken,
      sessionExpiresAt: sessionExpires.toISOString(),
      redirectUrl,
      // Fallback destination only. `redirectUrl` deliberately stays the gateway
      // ext_login URL (src/utils/redirect.ts) — sending the client to
      // success.html instead is what breaks internet access.
      successUrl: '/success.html',
      bandwidthMbpsUp: activation.bandwidthMbpsUp,
      bandwidthMbpsDown: activation.bandwidthMbpsDown,
      dataLimitGb: activation.dataLimitGb,
      isUncapped: activation.isUncapped,
      durationMin: activation.durationMin,
      macAddress: ctx.macAddress,
      ipAddress: ctx.ipAddress,
      voucherCode: canonicalCode,
      voucherStatus,
      packageTier: activation.packageTier,
      loginUrl: ctx.loginUrl,
      // Never expose the session token hash; this is only for support tickets.
      sessionRef: sha256(sessionToken).slice(0, 12),
    });

    // ── Post-commit, fire-and-forget MAC authorisation ──────────────────────
    // The response above is already written, so a slow or throttled Ruijie
    // tenant can never delay or fail a redemption. The module is imported
    // lazily (not at boot) to keep this route free of an eager Ruijie client
    // dependency; `authorizeClientAfterRedeem` swallows every error.
    void (async () => {
      try {
        const { authorizeClientAfterRedeem } = await import('../services/ruijieAuthorize');
        await authorizeClientAfterRedeem({
          macAddress: ctx.macAddress,
          ipAddress: ctx.ipAddress,
          voucherCode: canonicalCode,
        });
      } catch (err) {
        // Only reachable if the module itself fails to load.
        console.warn('[portal/redeem] cloud authorize hook unavailable:', err);
      }
    })();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[portal/redeem] failed', err);
    res.status(500).json({ error: 'Could not activate your voucher. Please try again.' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/portal/redeem/health
 *
 * Lets the PWA decide up-front whether the fast local path is available (a
 * cached older bundle would otherwise have to discover it via a failed POST).
 * Deliberately cheap: no database read, no upstream call.
 */
portalRouter.get('/redeem/health', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, localRedemption: true, upstream: 'none' });
});
