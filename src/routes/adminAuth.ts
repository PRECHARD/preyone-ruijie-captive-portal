import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';

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

    // Enforce role limits: only 1 CEO, only 1 Manager
    if (normalizedRole === 'CEO' || normalizedRole === 'Manager') {
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

    // Staff accounts require approval; CEO/Manager are auto-approved
    const approved = normalizedRole !== 'Staff';

    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await client.query(
      `INSERT INTO admin_users (full_name, email, phone, role, password_hash, approved)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, full_name, email, role, approved`,
      [fullName, email, phone, normalizedRole, passwordHash, approved]
    );

    await client.query('COMMIT');

    // Record audit log
    await recordAuditLog(rows[0].id, fullName, 'signup', 'admin_user', rows[0].id, `Signed up as ${normalizedRole}`);

    if (approved) {
      res.status(201).json({ user: rows[0] });
    } else {
      res.status(201).json({ user: rows[0], pendingApproval: true, message: 'Account created. A Manager or CEO must approve your account before you can sign in.' });
    }
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
    'SELECT id, full_name, email, phone, role, approved, password_hash FROM admin_users WHERE email = $1',
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

  // Record audit log
  await recordAuditLog(user.id, user.full_name, 'login', 'admin_user', user.id);

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, fullName: user.full_name },
    getJwtSecret(),
    { expiresIn: '24h' }
  );

  res.json({
    token,
    user: { id: user.id, fullName: user.full_name, email: user.email, phone: user.phone, role: user.role },
  });
});

adminAuthRouter.get('/me', async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const decoded = jwt.verify(auth.slice(7), getJwtSecret()) as any;
    const { rows } = await pool.query(
      'SELECT id, full_name, email, phone, role, created_at FROM admin_users WHERE id = $1',
      [decoded.id]
    );
    if (rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    res.json(rows[0]);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});
