import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireStarlinkAuth } from '../middleware/starlinkAuth';
import { sendStarlinkPasswordReset } from '../services/notificationService';
import { formatZimPhone } from '../utils/phone';
import {
  createStarlinkCustomer,
  findStarlinkCustomerByIdentifier,
  getStarlinkCustomerById,
  updateStarlinkProfile,
  updateStarlinkPassword,
  setStarlinkResetToken,
  consumeStarlinkResetToken,
  listStarlinkKits,
  getStarlinkKit,
  registerStarlinkKit,
  updateStarlinkKit,
  getKitUsageHistory,
  listStarlinkInvoices,
  getStarlinkInvoice,
  getBalanceDue,
} from '../db/starlink';

const JWT_SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';

export const starlinkRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

function signCustomerToken(id: string): string {
  return jwt.sign({ id, type: 'starlink-customer' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d' });
}

function publicCustomer(c: { id: string; full_name: string; email: string; phone: string; wallet_balance: unknown; created_at: unknown }) {
  return {
    id: c.id,
    fullName: c.full_name,
    email: c.email,
    phone: c.phone,
    walletBalance: Number(c.wallet_balance ?? 0),
    createdAt: c.created_at,
  };
}

const PHONE_LIKE = /^[+0-9()\s-]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// POST /api/starlink/auth/signup
// ---------------------------------------------------------------------------
starlinkRouter.post('/auth/signup', authLimiter, async (req: Request, res: Response) => {
  try {
    const fullName = String(req.body?.fullName ?? '').trim();
    const email = String(req.body?.email ?? '').trim();
    const phoneRaw = String(req.body?.phone ?? '').trim();
    const password = String(req.body?.password ?? '');
    const kitSerial = String(req.body?.kitSerial ?? '').trim() || null;

    if (!fullName || fullName.length < 2) { res.status(400).json({ error: 'Full name is required' }); return; }
    if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'A valid email address is required' }); return; }
    const phone = formatZimPhone(phoneRaw);
    if (!phone || !PHONE_LIKE.test(phone)) { res.status(400).json({ error: 'A valid phone number is required for Pese billing alerts' }); return; }
    if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }

    const existing = await findStarlinkCustomerByIdentifier(email);
    if (existing) { res.status(409).json({ error: 'An account with this email already exists' }); return; }

    const passwordHash = await bcrypt.hash(password, 10);
    const customer = await createStarlinkCustomer({ fullName, email, phone, passwordHash, kitSerial });
    res.status(201).json({ token: signCustomerToken(customer.id), customer: publicCustomer(customer) });
  } catch (err: any) {
    if (err?.code === '23505') { res.status(409).json({ error: 'An account with this email already exists' }); return; }
    console.error('Starlink signup error:', err);
    res.status(500).json({ error: 'Could not create your account' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/starlink/auth/login  — Email OR Phone + Password
// ---------------------------------------------------------------------------
starlinkRouter.post('/auth/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const identifier = String(req.body?.identifier ?? req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!identifier || !password) { res.status(400).json({ error: 'Email/phone and password are required' }); return; }

    const customer = await findStarlinkCustomerByIdentifier(identifier);
    // Uniform error for unknown account and wrong password (no enumeration).
    if (!customer || !(await bcrypt.compare(password, customer.password_hash))) {
      res.status(401).json({ error: 'Incorrect email/phone or password' });
      return;
    }
    res.json({ token: signCustomerToken(customer.id), customer: publicCustomer(customer) });
  } catch (err) {
    console.error('Starlink login error:', err);
    res.status(500).json({ error: 'Sign in failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/starlink/auth/forgot-password
// ---------------------------------------------------------------------------
starlinkRouter.post('/auth/forgot-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email ?? '').trim();
    if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'Enter a valid email address' }); return; }

    const token = crypto.randomBytes(32).toString('hex');
    const customer = await setStarlinkResetToken(email, token, new Date(Date.now() + 60 * 60 * 1000));
    // Always 200 so the endpoint cannot be used to probe which emails exist.
    if (customer) {
      await sendStarlinkPasswordReset(customer.email, token, customer.full_name).catch(() => false);
    }
    res.json({ message: 'If that email is registered, a reset link is on its way.' });
  } catch (err) {
    console.error('Starlink forgot-password error:', err);
    res.status(500).json({ error: 'Could not process the request' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/starlink/auth/reset-password
// ---------------------------------------------------------------------------
starlinkRouter.post('/auth/reset-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const token = String(req.body?.token ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!token || token.length < 32) { res.status(400).json({ error: 'Invalid reset link' }); return; }
    if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }

    const passwordHash = await bcrypt.hash(password, 10);
    const ok = await consumeStarlinkResetToken(token, passwordHash);
    if (!ok) { res.status(400).json({ error: 'This reset link is invalid or has expired' }); return; }
    res.json({ message: 'Password updated. You can sign in now.' });
  } catch (err) {
    console.error('Starlink reset-password error:', err);
    res.status(500).json({ error: 'Could not reset the password' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/starlink/auth/me
// ---------------------------------------------------------------------------
starlinkRouter.get('/auth/me', requireStarlinkAuth, async (req: Request, res: Response) => {
  res.json({ customer: publicCustomer(req.starlinkCustomer!) });
});

// ---------------------------------------------------------------------------
// PATCH /api/starlink/auth/profile
// ---------------------------------------------------------------------------
starlinkRouter.patch('/auth/profile', requireStarlinkAuth, async (req: Request, res: Response) => {
  try {
    const fullName = req.body?.fullName != null ? String(req.body.fullName).trim() : undefined;
    const phone = req.body?.phone != null ? formatZimPhone(String(req.body.phone)) : undefined;
    if (phone && !PHONE_LIKE.test(phone)) { res.status(400).json({ error: 'Invalid phone number' }); return; }
    await updateStarlinkProfile(req.starlinkCustomer!.id, { fullName, phone });
    const fresh = await getStarlinkCustomerById(req.starlinkCustomer!.id);
    res.json({ customer: fresh ? publicCustomer(fresh) : publicCustomer(req.starlinkCustomer!) });
  } catch (err) {
    console.error('Starlink profile error:', err);
    res.status(500).json({ error: 'Could not update profile' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/starlink/auth/change-password
// ---------------------------------------------------------------------------
starlinkRouter.post('/auth/change-password', requireStarlinkAuth, async (req: Request, res: Response) => {
  try {
    const current = String(req.body?.currentPassword ?? '');
    const next = String(req.body?.newPassword ?? '');
    if (next.length < 8) { res.status(400).json({ error: 'New password must be at least 8 characters' }); return; }
    const customer = req.starlinkCustomer!;
    if (!(await bcrypt.compare(current, customer.password_hash))) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    await updateStarlinkPassword(customer.id, await bcrypt.hash(next, 10));
    res.json({ message: 'Password changed.' });
  } catch (err) {
    console.error('Starlink change-password error:', err);
    res.status(500).json({ error: 'Could not change password' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/starlink/dashboard — everything the Home tab needs in one call
// ---------------------------------------------------------------------------
starlinkRouter.get('/dashboard', requireStarlinkAuth, async (req: Request, res: Response) => {
  try {
    const customer = req.starlinkCustomer!;
    const [kits, invoices, balanceDue] = await Promise.all([
      listStarlinkKits(customer.id),
      listStarlinkInvoices(customer.id),
      getBalanceDue(customer.id),
    ]);

    const kitsWithUsage = await Promise.all(
      kits.map(async (k) => ({ ...k, usage: await getKitUsageHistory(k.id, 4) }))
    );

    const paidThisMonth = invoices
      .filter((i) => i.status === 'PAID' && new Date(i.paid_at ?? i.created_at).toISOString().slice(0, 7) === new Date().toISOString().slice(0, 7))
      .reduce((sum, i) => sum + Number(i.amount), 0);

    res.json({
      customer: publicCustomer(customer),
      balanceDue,
      paidThisMonth,
      kits: kitsWithUsage,
      invoices: invoices.slice(0, 20),
      totals: {
        kits: kits.length,
        pending: invoices.filter((i) => i.status === 'PENDING').length,
        paid: invoices.filter((i) => i.status === 'PAID').length,
      },
    });
  } catch (err) {
    console.error('Starlink dashboard error:', err);
    res.status(500).json({ error: 'Could not load dashboard' });
  }
});

// ---------------------------------------------------------------------------
// Kits
// ---------------------------------------------------------------------------
starlinkRouter.get('/kits', requireStarlinkAuth, async (req: Request, res: Response) => {
  const kits = await listStarlinkKits(req.starlinkCustomer!.id);
  const withUsage = await Promise.all(kits.map(async (k) => ({ ...k, usage: await getKitUsageHistory(k.id, 4) })));
  res.json({ kits: withUsage });
});

starlinkRouter.post('/kits', requireStarlinkAuth, async (req: Request, res: Response) => {
  try {
    const kitNumber = String(req.body?.kitNumber ?? '').trim();
    const nickname = String(req.body?.nickname ?? '').trim();
    if (!kitNumber || kitNumber.length < 4) { res.status(400).json({ error: 'Enter the kit serial number' }); return; }
    const kit = await registerStarlinkKit(req.starlinkCustomer!.id, kitNumber, nickname);
    res.status(201).json({ kit });
  } catch (err: any) {
    if (err?.code === '23505') { res.status(409).json({ error: 'This kit is already registered to your account' }); return; }
    console.error('Starlink kit register error:', err);
    res.status(500).json({ error: 'Could not register kit' });
  }
});

starlinkRouter.patch('/kits/:id', requireStarlinkAuth, async (req: Request, res: Response) => {
  try {
    await updateStarlinkKit(req.params.id, req.starlinkCustomer!.id, {
      nickname: req.body?.nickname,
      status: req.body?.status,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Starlink kit update error:', err);
    res.status(500).json({ error: 'Could not update kit' });
  }
});

starlinkRouter.get('/kits/:id/usage', requireStarlinkAuth, async (req: Request, res: Response) => {
  const kit = await getStarlinkKit(req.params.id, req.starlinkCustomer!.id);
  if (!kit) { res.status(404).json({ error: 'Kit not found' }); return; }
  const usage = await getKitUsageHistory(kit.id, 4);
  res.json({ kit, usage });
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
starlinkRouter.get('/invoices', requireStarlinkAuth, async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const invoices = await listStarlinkInvoices(req.starlinkCustomer!.id, status);
  res.json({ invoices });
});

starlinkRouter.get('/invoices/:id', requireStarlinkAuth, async (req: Request, res: Response) => {
  const invoice = await getStarlinkInvoice(req.params.id, req.starlinkCustomer!.id);
  if (!invoice) { res.status(404).json({ error: 'Invoice not found' }); return; }
  res.json({ invoice });
});
