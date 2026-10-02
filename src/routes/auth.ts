import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { buildRuijieSuccessUrl, WISPrSessionConfig } from '../utils/redirect';
import { transformToWISPrProfile } from '../utils/wisprTransformer';
import { sendPortalAccountCreated, sendPortalSignupConfirmation, sendPortalEmailVerification, sendPortalForgotPassword } from '../services/notificationService';
import { listDevices, unbindDevice, getDeviceLimit, normalizeMac } from '../services/deviceBinding';

const JWT_SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';
function getJwtSecret(): string {
  return JWT_SECRET;
}

export const authRouter = Router();

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Zimbabwean phone: +263 X XX XXX XX or 0XX XXX XXXX
const ZW_PHONE_RE = /^(\+263\d{9}|0\d{9})$/;
// Strong password: min 8, uppercase, lowercase, digit, special
const STRONG_PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]).{8,}$/;

const signupValidators = [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  body('phone').trim().optional({ values: 'falsy' }),
  body('email').trim().optional({ values: 'falsy' }),
  body('voucherCode').trim().notEmpty().withMessage('Voucher code is required'),
  body('acceptedTos').custom((value) => value === true || value === 'true').withMessage('You must accept the terms'),
  body('password').optional({ values: 'falsy' }).matches(STRONG_PASSWORD_RE).withMessage('Password must be at least 8 characters with uppercase, lowercase, number, and special character'),
];

authRouter.post('/signup', signupLimiter, signupValidators, async (req: Request, res: Response) => {
  const isForm = req.is('application/x-www-form-urlencoded') || req.is('multipart/form-data');

  // Redirect back to the portal page preserving gateway params, with an error message
  const formErrorRedirect = (msg: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k !== 'error' && typeof v === 'string') params.set(k, v);
    }
    params.set('error', msg);
    res.redirect(303, '/?' + params.toString());
  };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    if (isForm) {
      const msg = errors.array().map(e => e.msg).join('. ');
      formErrorRedirect(msg);
    } else {
      res.status(422).json({ errors: errors.array() });
    }
    return;
  }

  const { fullName, phone, email, voucherCode, password } = req.body as {
    fullName: string; phone?: string; email?: string; voucherCode: string; password?: string;
  };
  // Normalize acceptedTos — form submissions send string "true", JSON sends boolean true
  const acceptedTos = req.body.acceptedTos === true || req.body.acceptedTos === 'true';
  const signupPhone = phone || 'N/A';
  const signupEmail = email?.trim() || null;
  const macAddress = (req.query.client_mac as string) ?? (req.query.mac as string) ?? (req.query.clientMac as string) ?? (req.headers['x-client-mac'] as string) ?? null;
  const ipAddress  = (req.query.ip  as string) ?? req.ip ?? null;
  const nasip      = (req.query.nas_ip as string) ?? (req.query.nasip as string) ?? (req.query.wlanacname as string) ?? null;
  const loginUrl   = (req.query.login_url as string) ?? null;
  const nasMac     = (req.query.nas_mac as string) ?? null;
  const ssid       = (req.query.ssid as string) ?? null;

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    await client.query('BEGIN');

    const { rows } = await client.query<{
      id: string; code: string; duration_min: number; max_uses: number; used_count: number; expires_at: string | null;
      data_limit_gb: number | null; is_uncapped: boolean; bandwidth_mbps_up: number; bandwidth_mbps_down: number;
      package_tier: string;
    // Match case-insensitively: Ruijie mints lowercase codes ('e7wj7w') while legacy
    // Preyone codes are uppercase. The canonical stored casing is read back from
    // the row and used downstream, because Ruijie's gateway must receive the exact
    // code it issued.
    }>('SELECT id, code, duration_min, max_uses, used_count, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, package_tier FROM vouchers WHERE UPPER(code) = $1 FOR UPDATE', [voucherCode.trim().toUpperCase()]);

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      if (isForm) { formErrorRedirect('Invalid Voucher code.'); return; }
      res.status(400).json({ error: 'Invalid Voucher code.' });
      return;
    }
    const v = rows[0];
    // Authoritative, vendor-issued casing. Never re-case this before handing it
    // to the Ruijie gateway.
    const canonicalCode = v.code;
    if (v.used_count >= v.max_uses) {
      await client.query('ROLLBACK');
      if (isForm) { formErrorRedirect('Voucher has already reached maximum allocations.'); return; }
      res.status(400).json({ error: 'Voucher has already reached maximum allocations.' });
      return;
    }
    if (v.expires_at && new Date(v.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      if (isForm) { formErrorRedirect('Voucher has expired.'); return; }
      res.status(400).json({ error: 'Voucher has expired.' });
      return;
    }
    await client.query('UPDATE vouchers SET used_count = used_count + 1 WHERE id = $1', [v.id]);
    const sessionDurationMin = v.duration_min;

    const sessionToken   = uuidv4();
    const sessionExpires = new Date(Date.now() + sessionDurationMin * 60 * 1000);

    const emailVerificationToken = password ? uuidv4() : null;

    let { rows: userRows } = await client.query<{ id: string }>(
      `INSERT INTO users (full_name, phone, email, voucher_code, accepted_tos, mac_address, ip_address, session_token, session_expires_at, password_hash, email_verification_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8, $9, $10, $11)
       ON CONFLICT (email) WHERE email IS NOT NULL AND email != '' DO NOTHING
       RETURNING id`,
      [fullName, signupPhone, signupEmail, canonicalCode, acceptedTos, macAddress, ipAddress, sessionToken, sessionExpires, passwordHash, emailVerificationToken]
    );
    if (userRows.length === 0 && signupEmail) {
      ({ rows: userRows } = await client.query<{ id: string }>(
        `INSERT INTO users (full_name, phone, email, voucher_code, accepted_tos, mac_address, ip_address, session_token, session_expires_at, password_hash, email_verification_token)
         VALUES ($1, $2, NULL, $3, $4, $5, $6::inet, $7, $8, $9, $10)
         RETURNING id`,
        [fullName, signupPhone, canonicalCode, acceptedTos, macAddress, ipAddress, sessionToken, sessionExpires, passwordHash, emailVerificationToken]
      ));
    }

    await client.query(
      `INSERT INTO voucher_redemptions (voucher_id, voucher_code, user_id, full_name, mac_address, ip_address) VALUES ($1, $2, $3, $4, $5, $6::inet)`,
      [v.id, canonicalCode, userRows[0].id, fullName, macAddress, ipAddress]
    );

    // Create WISPr profile for data tracking
    if (macAddress) {
      const wisprProfile = transformToWISPrProfile({
        macAddress,
        packageData: {
          data_limit_gb: v.data_limit_gb,
          is_uncapped: v.is_uncapped,
          bandwidth_mbps_up: v.bandwidth_mbps_up,
          bandwidth_mbps_down: v.bandwidth_mbps_down,
          duration_min: sessionDurationMin,
        },
      });
      await client.query(
        `INSERT INTO wispr_profiles (user_id, mac_address, bandwidth_up_kbps, bandwidth_down_kbps, data_quota_bytes, is_uncapped, session_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userRows[0].id, wisprProfile.macAddress, wisprProfile.bandwidthUpKbps, wisprProfile.bandwidthDownKbps,
         wisprProfile.dataQuotaBytes, wisprProfile.isUncapped, sessionExpires]
      );
    }

    await client.query(
      `INSERT INTO access_log (user_id, event, mac_address, ip_address, detail) VALUES ($1, 'login', $2, $3::inet, $4)`,
      [userRows[0].id, macAddress, ipAddress, `session=${sessionDurationMin}min`]
    );

    await client.query('COMMIT');

    // Send confirmation email (non-blocking)
    if (signupEmail) {
      sendPortalSignupConfirmation(signupEmail, fullName, canonicalCode);
    }

    // Send email verification if password was set (non-blocking)
    if (signupEmail && emailVerificationToken) {
      sendPortalEmailVerification(signupEmail, emailVerificationToken, fullName);
    }

    const redirectConfig: WISPrSessionConfig = {
      sessionToken,
      macAddress: macAddress || undefined,
      originalUrl: (req.query.url as string) || undefined,
      nasip: nasip || undefined,
      loginUrl: loginUrl || undefined,
      nasMac: nasMac || undefined,
      ssid: ssid || undefined,
      voucherCode: canonicalCode,
      packageData: {
        data_limit_gb: v.data_limit_gb,
        is_uncapped: v.is_uncapped,
        bandwidth_mbps_up: v.bandwidth_mbps_up,
        bandwidth_mbps_down: v.bandwidth_mbps_down,
        duration_min: sessionDurationMin,
      },
    };

    // Direct gateway hand-off. The ext_login url/redirect must carry the
    // ORIGINAL url the client was trying to reach (AGENTS.md gotcha #4), so
    // buildRuijieSuccessUrl() owns this URL. Do not rebuild it by hand here and
    // do not route it through success.html: that was tried, broke the captive
    // portal, and was reverted (c826e8e -> 7657296).
    const ruijieSuccessUrl = buildRuijieSuccessUrl(req, redirectConfig);

    // A plain form submission cannot read a JSON body, so it gets a 303. Both
    // paths still land on the same ext_login URL.
    if (isForm) {
      res.redirect(303, ruijieSuccessUrl);
    } else {
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
        voucherCode: canonicalCode,
        packageTier: v.package_tier,
        loginUrl: loginUrl,
      });
    }
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Signup error:', err);
    if (isForm) { formErrorRedirect('Authentication failed.'); return; }
    res.status(500).json({ error: 'Authentication failed.' });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// ── Gateway Auth (POST redirect to AP's ext_login) ────────────────────
// Serves an auto-submitting form so MAC authorization happens as top-level POST
// (iOS CNA blocks JS background requests but handles top-level navigation)
authRouter.get('/extauth', (req: Request, res: Response) => {
  const loginUrl   = req.query.loginUrl as string;
  const clientMac  = req.query.client_mac as string;
  const nasIp      = req.query.nas_ip as string;
  const nasMac     = req.query.nas_mac as string;
  const ssid       = req.query.ssid as string;
  const username   = req.query.username as string;
  const password   = req.query.password as string;
  const successUrl = req.query.success as string;
  const origUrl    = req.query.origUrl as string;

  if (!loginUrl) {
    return res.redirect(successUrl || '/success.html');
  }

  // The AP's ext_login expects url/redirect to be the ORIGINAL url the user
  // was trying to visit (short, plain). NOT our long success.html URL.
  const gwRedirect = origUrl || 'http://preyone.com';

  const fields: { name: string; value: string }[] = [
    { name: 'client_mac', value: clientMac || '' },
    { name: 'mac', value: (clientMac || '').replace(/[:-]/g, '').toUpperCase() },
    { name: 'nas_ip', value: nasIp || '' },
    { name: 'nas_mac', value: nasMac || '' },
    { name: 'ssid', value: ssid || '' },
    { name: 'username', value: username || '' },
    { name: 'password', value: password || '' },
    { name: 'url', value: gwRedirect },
    { name: 'redirect', value: gwRedirect },
  ];

  const fieldsHtml = fields.map(f =>
    `<input type="hidden" name="${escHtml(f.name)}" value="${escHtml(f.value)}" />`
  ).join('\n      ');

  const formAction = escHtml(loginUrl);
  const successHref = escHtml(successUrl || '/');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="refresh" content="0; url=${formAction}" />
<title>Authorizing...</title>
<style>
body{margin:0;background:#0b0e14;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#121620;border:1px solid #2a2f3a;border-radius:12px;padding:2rem;max-width:400px;width:90%;text-align:center}
.spinner{width:40px;height:40px;margin:0 auto 1rem;border:3px solid #2a2f3a;border-top-color:#71ff2f;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h2{margin:0 0 .5rem;font-size:1.25rem;color:#fff}
p{margin:0 0 1.5rem;color:#999;font-size:.9rem}
.btn{display:inline-block;padding:.6rem 1.5rem;background:#71ff2f;color:#000;border-radius:6px;text-decoration:none;font-weight:600;font-size:.9rem}
</style>
</head>
<body onload="document.forms[0].submit()">
<div class="card">
  <div class="spinner"></div>
  <h2>Authorizing your device...</h2>
  <p>Please wait while we connect you to Preyone UltraNet.</p>
  <form method="POST" action="${formAction}">
      ${fieldsHtml}
    <noscript>
      <button type="submit" class="btn">Continue</button>
    </noscript>
  </form>
  <p style="margin-top:1rem;font-size:.8rem;color:#666">Redirecting to gateway...</p>
</div>
</body>
</html>`);
});

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Register (pure account creation, no voucher) ──────────────────────
const registerValidators = [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  body('phone').trim().matches(ZW_PHONE_RE).withMessage('Valid Zimbabwean phone number required (+263 7XX XXX XXX)'),
  body('email').trim().isEmail().withMessage('Valid email address is required'),
  body('password').matches(STRONG_PASSWORD_RE).withMessage('Password must be at least 8 characters with uppercase, lowercase, number, and special character'),
  body('acceptedTos').custom((value) => value === true).withMessage('You must accept the terms'),
];

authRouter.post('/register', signupLimiter, registerValidators, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
    return;
  }

  const { fullName, phone, email, password } = req.body as {
    fullName: string; phone: string; email: string; password: string;
  };

  // Check if email already registered
  const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length > 0) {
    res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const emailVerificationToken = uuidv4();

  try {
    const { rowCount } = await pool.query(
      `INSERT INTO users (full_name, phone, email, accepted_tos, password_hash, email_verification_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) WHERE email IS NOT NULL AND email != '' DO NOTHING`,
      [fullName, phone, email, true, passwordHash, emailVerificationToken]
    );

    if (rowCount === 0) {
      res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });
      return;
    }

    // Send verification email (non-blocking)
    sendPortalAccountCreated(email, fullName, emailVerificationToken);

    res.status(201).json({
      success: true,
      email: email,
      message: 'Your account has been created successfully. Please check your email to verify your account before signing in.',
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Account creation failed. Please try again.' });
  }
});

// ── Portal Login ──────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});

authRouter.post('/portal-login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { email, phone, password } = req.body as { email?: string; phone?: string; password: string };
    if ((!email && !phone) || !password) {
      res.status(422).json({ error: 'Email or phone, and password are required' });
      return;
    }

    const lookupField = email ? 'email' : 'phone';
    const lookupValue = email || phone;

    const { rows } = await pool.query(
      `SELECT id, full_name, phone, email, password_hash, session_token, session_expires_at
       FROM users WHERE ${lookupField} = $1`,
      [lookupValue]
    );

    if (rows.length === 0 || !rows[0].password_hash) {
      res.status(401).json({ error: 'Invalid credentials or account not registered. Please sign up first.' });
      return;
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    const portalToken = jwt.sign(
      { id: user.id, phone: user.phone, role: 'portal' },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.json({
      token: portalToken,
      user: {
        id: user.id,
        fullName: user.full_name,
        phone: user.phone,
        email: user.email,
        hasActiveSession: !!(user.session_token && new Date(user.session_expires_at) > new Date()),
      },
    });
  } catch (err) {
    console.error('Portal login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// ── Portal Me (authenticated) ─────────────────────────────────────────
authRouter.get('/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid token.' });
      return;
    }
    const token = authHeader.slice(7);
    let payload: any;
    try {
      payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    } catch {
      res.status(401).json({ error: 'Invalid or expired token.' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT id, full_name, phone, email, email_verified, created_at FROM users WHERE id = $1`,
      [payload.id]
    );
    if (rows.length === 0) {
      res.status(401).json({ error: 'User not found.' });
      return;
    }
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('/me error:', err);
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

// ── Portal Active Sessions ────────────────────────────────────────────
authRouter.get('/portal-sessions', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid token.' });
      return;
    }
    const token = authHeader.slice(7);
    let payload: any;
    try {
      payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    } catch {
      res.status(401).json({ error: 'Invalid or expired token.' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT u.session_token, u.session_expires_at, u.voucher_code, u.mac_address, u.ip_address,
              v.data_limit_gb, v.is_uncapped, v.bandwidth_mbps_up, v.bandwidth_mbps_down, v.package_tier,
              wp.data_used_bytes, wp.data_quota_bytes
       FROM users u
       LEFT JOIN vouchers v ON UPPER(u.voucher_code) = UPPER(v.code)
       LEFT JOIN wispr_profiles wp ON wp.user_id = u.id
       WHERE u.id = $1 AND u.session_expires_at > NOW()
       ORDER BY u.session_expires_at DESC`,
      [payload.id]
    );

    res.json({ sessions: rows });
  } catch (err) {
    console.error('/portal-sessions error:', err);
    res.status(500).json({ error: 'Failed to fetch sessions.' });
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
       LEFT JOIN vouchers v ON UPPER(u.voucher_code) = UPPER(v.code)
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

// ── Send Email Verification ──────────────────────────────────────────
authRouter.post('/send-verification', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid token.' }); return;
    }
    const token = authHeader.slice(7);
    let payload: any;
    try { payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }); } catch { res.status(401).json({ error: 'Invalid token.' }); return; }

    const { rows } = await pool.query('SELECT id, full_name, email, email_verified FROM users WHERE id = $1', [payload.id]);
    if (rows.length === 0) { res.status(404).json({ error: 'User not found.' }); return; }
    const user = rows[0];
    if (user.email_verified) { res.json({ message: 'Email already verified.' }); return; }

    const vToken = uuidv4();
    await pool.query('UPDATE users SET email_verification_token = $1 WHERE id = $2', [vToken, user.id]);
    sendPortalEmailVerification(user.email, vToken, user.full_name);
    res.json({ message: 'Verification email sent.' });
  } catch (err) {
    console.error('Send verification error:', err);
    res.status(500).json({ error: 'Failed to send verification.' });
  }
});

// ── Verify Email ─────────────────────────────────────────────────────
authRouter.get('/verify-email', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) { res.status(400).json({ error: 'Missing verification token.' }); return; }

    const { rows } = await pool.query(
      'UPDATE users SET email_verified = TRUE, email_verification_token = NULL WHERE email_verification_token = $1 RETURNING full_name',
      [token]
    );
    if (rows.length === 0) { res.redirect('/verify-email.html?status=failed'); return; }

    res.redirect('/verify-email.html?status=verified');
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// ── Forgot Password ──────────────────────────────────────────────────
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many requests.' } });

authRouter.post('/forgot-password', forgotLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = req.body as { email: string };
    if (!email) { res.status(422).json({ error: 'Email is required.' }); return; }

    const { rows } = await pool.query('SELECT id, full_name, email, password_hash FROM users WHERE email = $1', [email]);
    if (rows.length === 0 || !rows[0].password_hash) {
      // Don't reveal whether the email exists
      res.json({ message: 'If that email is registered, a reset link has been sent.' });
      return;
    }

    const user = rows[0];
    const resetToken = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      'UPDATE users SET reset_password_token = $1, reset_password_expires_at = $2 WHERE id = $3',
      [resetToken, expiresAt, user.id]
    );

    sendPortalForgotPassword(user.email, resetToken, user.full_name);
    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

// ── Request Password Reset (Brevo email, mobile + portal) ─────────────
const requestResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many requests.' },
});

/**
 * Request a password reset for a registered portal account. Accepts either an
 * email or a phone number so the mobile login screen can offer the same link
 * for both login identifiers. Sends the preyone.com-branded HTML reset email
 * via Brevo SMTP. Always answers the same non-revealing message.
 */
authRouter.post('/request-password-reset', requestResetLimiter, async (req: Request, res: Response) => {
  try {
    const { email, phone } = req.body as { email?: string; phone?: string };
    const identifier = (email || phone || '').trim();
    if (!identifier) {
      res.status(422).json({ error: 'Email or phone is required.' });
      return;
    }
    const lookupField = email ? 'email' : 'phone';
    const lookupValue = email ? email.trim() : phone!.trim();

    const { rows } = await pool.query(
      `SELECT id, full_name, email, password_hash FROM users WHERE ${lookupField} = $1`,
      [lookupValue]
    );
    if (rows.length === 0 || !rows[0].password_hash) {
      // Don't reveal whether the account exists
      res.json({ message: 'If that account is registered, a reset link has been sent.' });
      return;
    }

    const user = rows[0];
    const resetToken = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      'UPDATE users SET reset_password_token = $1, reset_password_expires_at = $2 WHERE id = $3',
      [resetToken, expiresAt, user.id]
    );

    sendPortalForgotPassword(user.email, resetToken, user.full_name);
    res.json({ message: 'If that account is registered, a reset link has been sent.' });
  } catch (err) {
    console.error('Request password reset error:', err);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

// ── Verify Reset Token ───────────────────────────────────────────────
authRouter.get('/verify-reset-token', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) { res.status(400).json({ error: 'Missing token.' }); return; }

    const { rows } = await pool.query(
      'SELECT id, full_name FROM users WHERE reset_password_token = $1 AND reset_password_expires_at > NOW()',
      [token]
    );
    if (rows.length === 0) { res.status(400).json({ error: 'Invalid or expired reset token.' }); return; }

    res.json({ valid: true, fullName: rows[0].full_name });
  } catch (err) {
    console.error('Verify reset token error:', err);
    res.status(500).json({ error: 'Token verification failed.' });
  }
});

// ── Reset Password ───────────────────────────────────────────────────
authRouter.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body as { token: string; password: string };
    if (!token || !password) { res.status(422).json({ error: 'Token and password are required.' }); return; }
    if (!STRONG_PASSWORD_RE.test(password)) {
      res.status(422).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character.' });
      return;
    }

    const { rows } = await pool.query(
      'SELECT id FROM users WHERE reset_password_token = $1 AND reset_password_expires_at > NOW()',
      [token]
    );
    if (rows.length === 0) { res.status(400).json({ error: 'Invalid or expired reset token.' }); return; }

    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_password_token = NULL, reset_password_expires_at = NULL WHERE id = $2',
      [passwordHash, rows[0].id]
    );

    res.json({ message: 'Password reset successful. You can now sign in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Password reset failed.' });
  }
});

// ── Change Password (authenticated) ─────────────────────────────────
authRouter.post('/change-password', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid token.' });
      return;
    }
    const token = authHeader.slice(7);
    let payload: any;
    try {
      payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    } catch {
      res.status(401).json({ error: 'Invalid or expired token.' });
      return;
    }

    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    if (!currentPassword || !newPassword) {
      res.status(422).json({ error: 'Current password and new password are required.' });
      return;
    }
    if (!STRONG_PASSWORD_RE.test(newPassword)) {
      res.status(422).json({ error: 'New password must be at least 8 characters with uppercase, lowercase, number, and special character.' });
      return;
    }

    const { rows } = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [payload.id]
    );
    if (rows.length === 0) {
      res.status(401).json({ error: 'User not found.' });
      return;
    }

    const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!match) {
      res.status(403).json({ error: 'Current password is incorrect.' });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, payload.id]
    );

    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Password change failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Device management for a redeemed voucher.
//
// One purchase can cover several devices. Devices attach themselves the first
// time they authenticate with the code (see gatewayRouter /api/radius/auth), so
// these endpoints are for *seeing* what is attached and freeing a slot when a
// phone is lost or sold — without spending another max_uses allocation.
//
// Authenticated with the same opaque session token as /api/auth/status, never
// with the voucher code: a code is shareable, a session token is not.
async function resolveVoucherForSession(token: string) {
  const { rows } = await pool.query(
    `SELECT u.voucher_code, v.id AS voucher_id, v.package_tier, v.max_devices, v.expires_at
     FROM users u
     JOIN vouchers v ON UPPER(u.voucher_code) = UPPER(v.code)
     WHERE u.session_token = $1`,
    [token]
  );
  return rows[0] || null;
}

authRouter.get('/devices', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) { res.status(400).json({ error: 'Missing token' }); return; }

    const voucher = await resolveVoucherForSession(token);
    if (!voucher) {
      res.status(404).json({ error: 'No voucher found for this session.' });
      return;
    }

    const devices = await listDevices(voucher.voucher_id);
    const limit = await getDeviceLimit(voucher.package_tier, voucher.max_devices);
    const active = devices.filter((d) => d.isActive);

    res.json({
      voucherCode: voucher.voucher_code,
      deviceLimit: limit,
      devicesActive: active.length,
      slotsRemaining: Math.max(0, limit - active.length),
      devices: devices.map((d) => ({
        id: d.id,
        macAddress: d.macAddress,
        label: d.label,
        isActive: d.isActive,
        boundAt: d.boundAt,
        lastSeenAt: d.lastSeenAt,
      })),
    });
  } catch (err) {
    console.error('Device list error:', err);
    res.status(500).json({ error: 'Failed to fetch devices.' });
  }
});

authRouter.delete('/devices', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    const mac = req.query.mac as string;
    if (!token) { res.status(400).json({ error: 'Missing token' }); return; }
    if (!normalizeMac(mac)) { res.status(400).json({ error: 'Invalid device address.' }); return; }

    const voucher = await resolveVoucherForSession(token);
    if (!voucher) {
      res.status(404).json({ error: 'No voucher found for this session.' });
      return;
    }

    // Scoped to the caller's own voucher, so one customer can never unbind
    // another customer's device by guessing a MAC.
    const removed = await unbindDevice(voucher.voucher_id, mac);
    if (!removed) {
      res.status(404).json({ error: 'Device not found on this voucher.' });
      return;
    }

    const limit = await getDeviceLimit(voucher.package_tier, voucher.max_devices);
    const remaining = await listDevices(voucher.voucher_id);
    const active = remaining.filter((d) => d.isActive).length;

    res.json({
      removed: true,
      deviceLimit: limit,
      devicesActive: active,
      slotsRemaining: Math.max(0, limit - active),
    });
  } catch (err) {
    console.error('Device unbind error:', err);
    res.status(500).json({ error: 'Failed to remove device.' });
  }
});
