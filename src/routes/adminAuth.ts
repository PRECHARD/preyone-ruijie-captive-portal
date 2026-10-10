import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { loadPermissions } from '../middleware/rbac';
import {
  requireAdminAuth,
  requireAdminAuthAllowLocked,
  INACTIVITY_TIMEOUT_SEC,
  SESSION_EXPIRED_CODE,
  SESSION_LOCKED_CODE,
  SESSION_REVOKED_CODE,
} from '../middleware/adminAuth';
import { sendAdminSignupConfirmation, sendAdminSignupNotification, sendPasswordResetEmail, sendAdminLoginCode } from '../services/notificationService';
import { setPreyoneCookie, clearPreyoneCookie, resolveAuthToken } from '../utils/ssoCookie';
import { SESSION_POLICY } from '../sessionPolicy';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';
let _jwtSecretWarned = false;
function getJwtSecret(): string {
  if (!_jwtSecretWarned && JWT_SECRET === 'preyone-jwt-secret-change-in-production') {
    console.warn('WARNING: JWT_SECRET is not set. Using insecure default. Set JWT_SECRET in .env for production.');
    _jwtSecretWarned = true;
  }
  return JWT_SECRET;
}

export async function recordAuditLog(adminId: string | null, adminName: string | null, action: string, targetType?: string, targetId?: string, detail?: string) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, adminName, action, targetType || null, targetId || null, detail || null]
    );
  } catch { /* skip audit log failures */ }
}

// Rate limiter: max 10 login/signup attempts per IP per 15min
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

/** SHA-256 of the 6-digit code, peppered with the JWT secret. Cheap by design:
 *  brute force is bounded by 5 attempts per challenge + the rate limiters. */
function hashTwoFaCode(code: string): string {
  return crypto.createHash('sha256').update(`${code}:${getJwtSecret()}`).digest('hex');
}

/** a***@domain.com — enough for the user to recognise their inbox. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local[0]}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

function newTwoFaCode(): string {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

/** Sentinel stored in active_sid on logout. No JWT can present it as its `sid`
 *  claim (a real sid is always a UUID), so every outstanding bearer token dies. */
const REVOKED_SID = '__revoked__';

/**
 * Issue the access token and arm BOTH session clocks:
 *   auth_time      — immutable, stamped now, anchors the 10-hour absolute cap.
 *   last_activity  — slides on user interaction, anchors the 15-minute lock.
 * active_sid is rotated so a later logout can revoke this specific token.
 */
async function startAdminSession(req: Request, res: Response, user: any): Promise<{ token: string; authTime: Date }> {
  const sid = crypto.randomUUID();

  // Detect a live session being replaced: single-session-per-user means the
  // previous token dies here, and without an audit trail the victim cannot
  // tell their own second login apart from a stolen token being used.
  const { rows: prevRows } = await pool.query(
    'SELECT active_sid, last_activity FROM admin_users WHERE id = $1',
    [user.id]
  );
  const prevSid: string | null = prevRows[0]?.active_sid ?? null;
  if (prevSid && prevSid !== REVOKED_SID) {
    await recordAuditLog(
      user.id,
      user.full_name,
      'session_superseded',
      'admin_user',
      user.id,
      `New sign-in from ${req.ip ?? 'unknown'} replaced a session last active ${prevRows[0]?.last_activity ?? 'at an unknown time'}`
    );
  }

  const { rows } = await pool.query(
    `UPDATE admin_users
        SET auth_time         = NOW(),
            last_activity     = NOW(),
            session_expires_at = NOW() + make_interval(secs => $1),
            active_sid        = $2
      WHERE id = $3
      RETURNING auth_time, last_activity`,
    [INACTIVITY_TIMEOUT_SEC, sid, user.id]
  );
  const authTime: Date = rows[0]?.auth_time ?? new Date();
  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      fullName: user.full_name,
      company_id: user.company_id ?? null,
      sid,
    },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
  // Cross-subdomain SSO: expose the session to every *.preyone.com app via a
  // wildcard HTTP-Only cookie (read by /me, never by client JS).
  setPreyoneCookie(res, token);
  res.json({
    token,
    user: { id: user.id, fullName: user.full_name, email: user.email, phone: user.phone, role: user.role, company_id: user.company_id ?? null },
    sessionPolicy: SESSION_POLICY,
    authTime,
  });
  return { token, authTime };
}

export const adminAuthRouter = Router();

// ── Admin verify email ─────────────────────────────────────────────────
adminAuthRouter.get('/verify-email', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) {
      res.redirect(`${process.env.BASE_URL || 'http://localhost:3000'}/verify-email.html?status=failed`);
      return;
    }
    const { rows } = await pool.query(
      `UPDATE admin_users SET email_verified = TRUE, email_verification_token = NULL
       WHERE email_verification_token = $1 RETURNING full_name`,
      [token]
    );
    if (rows.length === 0) {
      res.redirect(`${process.env.BASE_URL || 'http://localhost:3000'}/verify-email.html?status=failed`);
      return;
    }
    res.redirect(`${process.env.BASE_URL || 'http://localhost:3000'}/verify-email.html?status=verified`);
  } catch (err) {
    console.error('Admin verify email error:', err);
    res.redirect(`${process.env.BASE_URL || 'http://localhost:3000'}/verify-email.html?status=failed`);
  }
});

// Recovery path for the email_verified gate on /login. Deliberately its own
// limiter: resends are far more frequent than signups but must still be
// capped, and unlike login it counts every attempt so probing for registered
// addresses is not a cheaper way past the cap.
const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again in 15 minutes.' },
});

// Always answers 200 with the same body, so the endpoint cannot be used to
// discover which addresses are registered.
adminAuthRouter.post('/resend-verification', resendLimiter, async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };
  const generic = { message: 'If that address is registered and unverified, a new verification email has been sent.' };
  if (!email) { res.json(generic); return; }

  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, approved, role, email_verified
         FROM admin_users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    // Unknown addresses, already-verified accounts and unapproved Staff all
    // fall through: only an approved + unverified account receives an email.
    if (user && user.email_verified !== true && (user.role !== 'Staff' || user.approved)) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        'UPDATE admin_users SET email_verification_token = $1 WHERE id = $2',
        [token, user.id]
      );
      await recordAuditLog(user.id, user.full_name, 'verification_resent', 'admin_user', user.id, 'Verification email resent');
      sendAdminSignupConfirmation(user.email, user.full_name, user.role, user.approved === true, token);
    }
    res.json(generic);
  } catch (err) {
    console.error('Resend verification error:', err);
    res.json(generic);
  }
});

adminAuthRouter.post('/signup', authLimiter, async (req: Request, res: Response) => {
  const { fullName, email, phone, role = 'Staff', password } = req.body as {
    fullName: string; email: string; phone: string; role?: string; password: string;
  };

  if (!fullName || !email || !phone || !password) {
    res.status(422).json({ error: 'fullName, email, phone, and password are required' });
    return;
  }

  // Block disposable / throwaway email domains
  const disposableDomains = new Set([
    'aol.com', 'mailinator.com', 'tempmail.com', 'guerrillamail.com',
    '10minutemail.com', 'yopmail.com', 'throwaway.email', 'trashmail.com',
    'sharklasers.com', 'mail.tm', 'temp-mail.org', 'temp-mail.io',
    'getairmail.com', 'emailfake.com', 'mailnator.com', 'dispostable.com',
  ]);
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (emailDomain && disposableDomains.has(emailDomain)) {
    res.status(422).json({ error: 'Disposable email domains are not allowed. Use a real email address.' });
    return;
  }

  const validRoles = ['CEO', 'Manager', 'Staff'];
  const normalizedRole = validRoles.find(r => r.toLowerCase() === role.toLowerCase()) || '';
  if (!normalizedRole) {
    res.status(422).json({ error: 'Role must be CEO, Manager, or Staff' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Enforce role limits: only 1 CEO, up to 2 Managers
    if (normalizedRole === 'CEO') {
      const { rows: existing } = await client.query(
        'SELECT COUNT(*)::int AS cnt FROM admin_users WHERE role = $1',
        [normalizedRole]
      );
      if (existing[0].cnt >= 1) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: `Only one ${normalizedRole} account is allowed` });
        return;
      }
    }
    if (normalizedRole === 'Manager') {
      const { rows: existing } = await client.query(
        'SELECT COUNT(*)::int AS cnt FROM admin_users WHERE role = $1',
        [normalizedRole]
      );
      if (existing[0].cnt >= 2) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: `Only two ${normalizedRole} accounts are allowed` });
        return;
      }
    }

    // Staff accounts require approval; CEO/Manager are auto-approved
    const approved = normalizedRole !== 'Staff';

    // Bind the new account to a tenant server-side. This is deliberately NOT
    // read from req.body: letting a signup request choose its own company_id
    // would let anyone self-assign into an arbitrary tenant's data. The same
    // rule as requireCompany applies -- only an unambiguous singleton is used,
    // otherwise the account stays unassigned until an existing admin assigns it.
    const { rows: companyRows } = await client.query(
      'SELECT id FROM companies ORDER BY created_at ASC LIMIT 2'
    );
    // Portal realm only. Written to portal_company_id, never to company_id,
    // which is a transit_companies FK and would reject a portal UUID.
    const companyId = companyRows.length === 1 ? companyRows[0].id : null;

    const passwordHash = await bcrypt.hash(password, 12);
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const { rows } = await client.query(
      `INSERT INTO admin_users (full_name, email, phone, role, password_hash, approved, email_verification_token, portal_company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, full_name, email, role, approved`,
      [fullName, email, phone, normalizedRole, passwordHash, approved, emailVerificationToken, companyId]
    );

    await client.query('COMMIT');

    // Record audit log
    await recordAuditLog(rows[0].id, fullName, 'signup', 'admin_user', rows[0].id, `Signed up as ${normalizedRole}`);

    // Send notifications (non-blocking — don't await)
    sendAdminSignupConfirmation(email, fullName, normalizedRole, approved, emailVerificationToken);
    if (!approved) {
      sendAdminSignupNotification(fullName, email);
    }

    if (approved) {
      res.status(201).json({ user: rows[0] });
    } else {
      res.status(201).json({ user: rows[0], pendingApproval: true, message: 'Account created. A Manager or CEO must approve your account before you can sign in.' });
    }
    return;
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
});

adminAuthRouter.post('/login', authLimiter, async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  if (!email || !password) {
    res.status(422).json({ error: 'Email and password are required' });
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, role, approved, password_hash,
            company_id, portal_company_id, email_verified
       FROM admin_users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );

  if (rows.length === 0) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const user = rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // Staff accounts must be approved by Manager/CEO
  if (user.role === 'Staff' && !user.approved) {
    res.status(403).json({ error: 'Your account is pending approval. Contact a Manager or CEO.' });
    return;
  }

  // Unverified accounts cannot sign in. The response carries a stable `code`
  // and the resend endpoint so the SPA can offer a recovery path -- enforcement
  // without one is a permanent lockout (there is no other way back in).
  if (!user.email_verified) {
    res.status(403).json({
      error: 'Your email address has not been verified. Check your inbox for the link, or request a new one.',
      code: 'EMAIL_NOT_VERIFIED',
      resendEndpoint: '/api/admin/auth/resend-verification',
    });
    return;
  }

  // Email OTP step-up: a valid password alone no longer signs the session in.
  // The challenge lives 5 minutes; the code itself allows 5 wrong attempts.
  if (user.email) {
    const code = newTwoFaCode();
    await pool.query('DELETE FROM admin_2fa_challenges WHERE admin_user_id = $1', [user.id]);
    await pool.query(
      `INSERT INTO admin_2fa_challenges (admin_user_id, code_hash, expires_at)
       VALUES ($1, $2, NOW() + interval '5 minutes')`,
      [user.id, hashTwoFaCode(code)]
    );
    const challengeToken = jwt.sign({ id: user.id, purpose: '2fa' }, getJwtSecret(), { expiresIn: '10m' });
    await recordAuditLog(user.id, user.full_name, 'login_challenge', 'admin_user', user.id, '2FA code emailed');
    sendAdminLoginCode(user.email, user.full_name, code);
    if (process.env.NODE_ENV !== 'production') console.log(`[2FA] code for ${user.email}: ${code}`);
    res.json({ requires2fa: true, challengeToken, maskedEmail: maskEmail(user.email) });
    return;
  }

  // No email on file: fall back to password-only sign-in (cannot receive a code).
  await recordAuditLog(user.id, user.full_name, 'login', 'admin_user', user.id);
  await startAdminSession(req, res, user);
});

// Verify the emailed OTP and complete sign-in.
adminAuthRouter.post('/verify-2fa', authLimiter, async (req: Request, res: Response) => {
  const { challengeToken, code } = req.body as { challengeToken?: string; code?: string };
  if (!challengeToken || !code) {
    res.status(422).json({ error: 'challengeToken and code are required' });
    return;
  }

  let decoded: any;
  try {
    decoded = jwt.verify(challengeToken, getJwtSecret(), { algorithms: ['HS256'] });
  } catch {
    res.status(401).json({ error: 'Verification code expired. Please sign in again.' });
    return;
  }
  if (decoded.purpose !== '2fa') {
    res.status(401).json({ error: 'Invalid verification challenge' });
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, code_hash, attempts FROM admin_2fa_challenges
      WHERE admin_user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`,
    [decoded.id]
  );
  const challenge = rows[0];
  if (!challenge) {
    res.status(401).json({ error: 'Verification code expired. Please sign in again.' });
    return;
  }

  if (hashTwoFaCode(String(code).trim()) !== challenge.code_hash) {
    const attempts = (challenge.attempts || 0) + 1;
    if (attempts >= 5) {
      await pool.query('DELETE FROM admin_2fa_challenges WHERE id = $1', [challenge.id]);
      res.status(401).json({ error: 'Too many incorrect attempts. Please sign in again.' });
      return;
    }
    await pool.query('UPDATE admin_2fa_challenges SET attempts = $1 WHERE id = $2', [attempts, challenge.id]);
    res.status(401).json({ error: `Incorrect code. ${5 - attempts} attempt(s) remaining.` });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, full_name, email, phone, role, approved, company_id
       FROM admin_users WHERE id = $1`,
    [decoded.id]
  );
  const user = userRows[0];
  if (!user || !user.approved) {
    await pool.query('DELETE FROM admin_2fa_challenges WHERE admin_user_id = $1', [decoded.id]);
    res.status(401).json({ error: 'Account is no longer active' });
    return;
  }

  await pool.query('UPDATE admin_2fa_challenges SET consumed_at = NOW() WHERE id = $1', [challenge.id]);
  await recordAuditLog(user.id, user.full_name, 'login', 'admin_user', user.id, '2FA verified');
  await startAdminSession(req, res, user);
});

// Issue a fresh OTP for an in-progress challenge (user didn't receive the mail).
adminAuthRouter.post('/resend-2fa', resendLimiter, async (req: Request, res: Response) => {
  const { challengeToken } = req.body as { challengeToken?: string };
  if (!challengeToken) {
    res.status(422).json({ error: 'challengeToken is required' });
    return;
  }

  let decoded: any;
  try {
    decoded = jwt.verify(challengeToken, getJwtSecret(), { algorithms: ['HS256'] });
  } catch {
    res.status(401).json({ error: 'Verification session expired. Please sign in again.' });
    return;
  }
  if (decoded.purpose !== '2fa') {
    res.status(401).json({ error: 'Invalid verification challenge' });
    return;
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, full_name, email FROM admin_users WHERE id = $1',
      [decoded.id]
    );
    const user = rows[0];
    if (!user?.email) {
      res.json({ message: 'If that sign-in is still in progress, a new code has been sent.' });
      return;
    }
    const code = newTwoFaCode();
    await pool.query('DELETE FROM admin_2fa_challenges WHERE admin_user_id = $1', [user.id]);
    await pool.query(
      `INSERT INTO admin_2fa_challenges (admin_user_id, code_hash, expires_at)
       VALUES ($1, $2, NOW() + interval '5 minutes')`,
      [user.id, hashTwoFaCode(code)]
    );
    sendAdminLoginCode(user.email, user.full_name, code);
    if (process.env.NODE_ENV !== 'production') console.log(`[2FA] code for ${user.email}: ${code}`);
    res.json({ message: 'A new code has been sent.', maskedEmail: maskEmail(user.email) });
  } catch (err) {
    console.error('Resend 2FA error:', err);
    res.json({ message: 'If that sign-in is still in progress, a new code has been sent.' });
  }
});

// Sliding-window refresh: called by the SPA only on real user activity events.
// requireAdminAuth already rejects a locked (423) or absolutely-expired (401)
// session, so an abandoned session cannot be revived here. Deliberately writes
// ONLY last_activity — auth_time is the 10-hour anchor and must never move.
adminAuthRouter.post('/refresh', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `UPDATE admin_users
          SET last_activity      = NOW(),
              session_expires_at = NOW() + make_interval(secs => $1)
        WHERE id = $2
        RETURNING last_activity, auth_time, session_expires_at`,
      [INACTIVITY_TIMEOUT_SEC, req.adminUser!.id]
    );
    const row = rows[0] ?? null;
    res.json({
      ok: true,
      lastActivity: row?.last_activity ?? null,
      authTime: row?.auth_time ?? null,
      expiresAt: row?.session_expires_at ?? null,
      sessionPolicy: SESSION_POLICY,
    });
  } catch (err) {
    console.error('Session refresh error:', err);
    res.status(500).json({ error: 'Failed to refresh session' });
  }
});

/**
 * State A recovery: password-only unlock of an inactivity-locked console.
 * Session context is preserved (no new sid, no new auth_time) so 2FA is not
 * re-triggered — but only while the 10-hour absolute cap still has budget,
 * which requireAdminAuthAllowLocked already enforced (401 SESSION_EXPIRED).
 */
adminAuthRouter.post('/unlock', authLimiter, requireAdminAuthAllowLocked, async (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
  if (!password || typeof password !== 'string') {
    res.status(422).json({ error: 'Password is required' });
    return;
  }

  const { rows } = await pool.query(
    'SELECT id, full_name, email, password_hash FROM admin_users WHERE id = $1',
    [req.adminUser!.id]
  );
  const user = rows[0];
  if (!user) {
    res.status(401).json({ error: 'Account deactivated or removed' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    // Same generic message on purpose: the endpoint must not confirm that the
    // session exists, or it becomes an oracle for the 7-day bearer token.
    res.status(401).json({ error: 'Incorrect password.', code: 'UNLOCK_FAILED' });
    return;
  }

  const { rows: updated } = await pool.query(
    `UPDATE admin_users
        SET last_activity      = NOW(),
            session_expires_at = NOW() + make_interval(secs => $1)
      WHERE id = $2
      RETURNING last_activity, auth_time`,
    [INACTIVITY_TIMEOUT_SEC, req.adminUser!.id]
  );
  await recordAuditLog(user.id, user.full_name, 'session_unlock', 'admin_user', user.id, 'Console unlocked after inactivity lock');
  const row = updated[0] ?? null;
  res.json({
    ok: true,
    lastActivity: row?.last_activity ?? null,
    authTime: row?.auth_time ?? null,
    sessionPolicy: SESSION_POLICY,
  });
});

/**
 * Public, unauthenticated policy readout so both SPAs drive their timers from
 * the same constants the server enforces (no duplicated 900/36000 literals).
 */
adminAuthRouter.get('/policy', (_req: Request, res: Response) => {
  res.json(SESSION_POLICY);
});

// ── Logout ───────────────────────────────────────────────────────────
// Clears the wildcard SSO cookie AND revokes the session server-side. JWTs are
// stateless, so the real revocation is rotating active_sid to a sentinel value
// that no token can present as its `sid` claim — every outstanding bearer token
// (this browser, other tabs, other devices, any SSO copy) dies at once.
adminAuthRouter.post('/logout', async (req: Request, res: Response) => {
  try {
    const token = resolveAuthToken(req);
    if (token) {
      const decoded = jwt.verify(token, getJwtSecret()) as any;
      if (decoded?.id) {
        await pool.query(
          `UPDATE admin_users
              SET active_sid        = $1,
                  last_activity     = NOW(),
                  session_expires_at = NOW()
            WHERE id = $2`,
          [REVOKED_SID, decoded.id]
        );
      }
    }
  } catch { /* invalid/expired tokens have nothing to revoke */ }
  clearPreyoneCookie(res);
  res.json({ message: 'Signed out' });
});

/**
 * Session bootstrap for both SPAs. Enforces BOTH clocks — this closes the old
 * gap where /me only checked the JWT signature, so a browser that had been idle
 * past the limit still rendered as authenticated on reload.
 *   401 SESSION_EXPIRED  → State B: full re-auth (password + email OTP).
 *   423 SESSION_LOCKED   → State A: offer the password unlock screen.
 */
adminAuthRouter.get('/me', async (req: Request, res: Response) => {
  const token = resolveAuthToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as any;
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, role, company_id, portal_company_id, created_at,
              email_verified, approved, last_activity, auth_time, active_sid
         FROM admin_users WHERE id = $1`,
      [decoded.id]
    );
    if (rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    const user = rows[0];

    // ── Session clock enforcement (mirrors requireAdminAuth) ────────────
    if (user.active_sid != null && user.active_sid !== decoded.sid) {
      res.status(401).json({ error: 'Session revoked. Please sign in again.', code: SESSION_REVOKED_CODE, sessionPolicy: SESSION_POLICY });
      return;
    }
    if (!user.approved) {
      res.status(401).json({ error: 'Account deactivated or removed' });
      return;
    }
    const now = Date.now();
    const authTimeMs = user.auth_time ? new Date(user.auth_time).getTime() : null;
    const lastActivityMs = user.last_activity ? new Date(user.last_activity).getTime() : null;
    const sessionState = {
      authTime: user.auth_time ?? null,
      lastActivity: user.last_activity ?? null,
      locked: false,
    };
    if (authTimeMs !== null && authTimeMs + SESSION_POLICY.maxSessionLifetimeSec * 1000 <= now) {
      res.status(401).json({
        error: 'Your session reached its maximum duration. Please sign in again.',
        code: SESSION_EXPIRED_CODE,
        session: sessionState,
        sessionPolicy: SESSION_POLICY,
      });
      return;
    }
    if (lastActivityMs !== null && lastActivityMs + SESSION_POLICY.inactivityTimeoutSec * 1000 <= now) {
      sessionState.locked = true;
      res.status(423).json({
        error: 'Session locked after inactivity. Enter your password to continue.',
        code: SESSION_LOCKED_CODE,
        // Minimal identity so the lock screen can greet the user after a
        // reload straight into the locked state (no token in JS, but the
        // SSO cookie still resolved the account).
        user: user.id ? { id: user.id, fullName: user.full_name, email: user.email, role: user.role } : null,
        session: sessionState,
        sessionPolicy: SESSION_POLICY,
      });
      return;
    }

    // Tenant + subscribed modules (SSO session payload)
    // Company is either the user's assigned company or the singleton profile company.
    let tenantId: string | null = user.portal_company_id ?? null; // portal realm
    const companyId = user.portal_company_id ?? null;
    if (!companyId) {
      const { rows: companyRows } = await pool.query('SELECT id FROM companies ORDER BY created_at LIMIT 1');
      tenantId = companyRows[0]?.id ?? null;
    }
    const { rows: moduleRows } = await pool.query(
      `SELECT module FROM subscriptions WHERE company_id = $1 AND status = 'active' ORDER BY module`,
      [companyId ?? tenantId]
    );
    const subscribed_modules = moduleRows.map((r) => r.module);

    // The admin console gates navigation on this array, so it must be the SAME
// effective set requireAdminAuth builds (role_permissions + user_permissions
// + company_permissions), keyed by company_id -- the transit company, which is
// what company_permissions is scoped to. Omitting it left the browser with an
// empty list, and its gate then hid every page except Overview for any admin
// whose companyId was set.
const permissions = await loadPermissions(user.role, user.id, user.company_id ?? null);

const { active_sid: _activeSid, approved: _approved, ...publicUser } = user;
void _activeSid;
void _approved;
res.json({
  ...publicUser,
  tenant_id: tenantId,
  subscribed_modules,
  permissions,
  session: sessionState,
  sessionPolicy: SESSION_POLICY,
});
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ── Forgot password: generate token, send email ──────────────────────
adminAuthRouter.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  if (!email) {
    res.status(422).json({ error: 'Email is required' });
    return;
  }

  // Always return 200 to avoid email enumeration
  try {
    const { rows } = await pool.query('SELECT id, full_name, email FROM admin_users WHERE email = $1', [email.toLowerCase().trim()]);
    if (rows.length > 0) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await pool.query(
        'UPDATE admin_users SET reset_token = $1, reset_token_expires_at = $2 WHERE email = $3',
        [resetToken, expiresAt, email.toLowerCase().trim()]
      );
      sendPasswordResetEmail(rows[0].email, resetToken, rows[0].full_name);
    }
    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  }
});

// ── Reset password: validate token, update password ───────────────────
adminAuthRouter.post('/reset-password', async (req: Request, res: Response) => {
  const { token, password } = req.body as { token: string; password: string };
  if (!token || !password) {
    res.status(422).json({ error: 'Token and password are required' });
    return;
  }
  if (password.length < 6) {
    res.status(422).json({ error: 'Password must be at least 6 characters' });
    return;
  }

  try {
    const { rows } = await pool.query(
      `SELECT id FROM admin_users
       WHERE reset_token = $1 AND reset_token_expires_at > NOW()`,
      [token]
    );
    if (rows.length === 0) {
      res.status(400).json({ error: 'Invalid or expired reset token' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(
      `UPDATE admin_users SET password_hash = $1, reset_token = NULL, reset_token_expires_at = NULL WHERE id = $2`,
      [passwordHash, rows[0].id]
    );

    await recordAuditLog(rows[0].id, null, 'password_reset', 'admin_user', rows[0].id, 'Password reset via email');

    res.json({ message: 'Password has been reset. You can now sign in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});
