import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { loadPermissions } from '../middleware/rbac';
import { sendAdminSignupConfirmation, sendAdminSignupNotification, sendPasswordResetEmail } from '../services/notificationService';
import { setPreyoneCookie, clearPreyoneCookie, resolveAuthToken } from '../utils/ssoCookie';
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

  // Record audit log
  await recordAuditLog(user.id, user.full_name, 'login', 'admin_user', user.id);

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, fullName: user.full_name, company_id: user.company_id ?? null },
    getJwtSecret(),
    { expiresIn: '7d' }
  );

  // Cross-subdomain SSO: expose the session to every *.preyone.com app via a
  // wildcard HTTP-Only cookie (read by /me, never by client JS).
  setPreyoneCookie(res, token);

  res.json({
    token,
    user: { id: user.id, fullName: user.full_name, email: user.email, phone: user.phone, role: user.role, company_id: user.company_id ?? null },
  });
});

// ── Logout ───────────────────────────────────────────────────────────
// Clears the wildcard SSO cookie. JWT is stateless so this only drops the cookie.
adminAuthRouter.post('/logout', (_req: Request, res: Response) => {
  clearPreyoneCookie(res);
  res.json({ message: 'Signed out' });
});

adminAuthRouter.get('/me', async (req: Request, res: Response) => {
  const token = resolveAuthToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as any;
    const { rows } = await pool.query(
      'SELECT id, full_name, email, phone, role, company_id, portal_company_id, created_at, email_verified FROM admin_users WHERE id = $1',
      [decoded.id]
    );
    if (rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    const user = rows[0];

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

res.json({ ...user, tenant_id: tenantId, subscribed_modules, permissions });
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
