import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import {
  requireStarlinkAuth,
  requireStarlinkRoles,
  canAccessStarlinkKit,
  scopeStarlinkKits,
  type StarlinkRole,
} from '../middleware/starlinkAuth';
import {
  sendStarlinkEmail,
  sendStarlinkPasswordReset,
  sendStarlinkVerificationEmail,
} from '../services/notificationService';
import { buildMemberInviteEmail, starlinkBaseUrl } from '../services/starlinkEmailTemplates';
import { formatZimPhone } from '../utils/phone';
import { STARLINK_PLANS } from '../plans/starlinkPlans';
import { submitPlanApplication, PlanApplicationError } from '../services/starlinkPlanApplications';
import {
  createStarlinkCustomer,
  findStarlinkCustomerByIdentifier,
  getStarlinkCustomerById,
  updateStarlinkProfile,
  updateStarlinkPassword,
  setStarlinkResetToken,
  consumeStarlinkResetToken,
  setStarlinkVerificationToken,
  consumeStarlinkVerificationToken,
  listStarlinkKits,
  getStarlinkKit,
  registerStarlinkKit,
  updateStarlinkKit,
  getKitUsageHistory,
  listStarlinkInvoices,
  getStarlinkInvoice,
  listPlanApplications,
  getBalanceDue,
  listPendingStarlinkIntents,
  listStarlinkNotifications,
  getUnreadStarlinkNotificationCount,
  markStarlinkNotificationsRead,
  updateStarlinkAlertPreferences,
  applyScheduledStarlinkServiceStates,
  transferStarlinkKitCredit,
  requestStarlinkKitServiceState,
  listStarlinkCreditTransfers,
  createStarlinkAccountMember,
  listStarlinkAccountMembers,
  getStarlinkAccountMemberById,
  findAcceptedMemberByEmail,
  acceptStarlinkAccountMember,
  rotateStarlinkAccountMemberInvite,
  updateStarlinkAccountMemberAccess,
  deleteStarlinkAccountMember,
  type StarlinkAccountMember,
  type StarlinkAccountMemberRole,
  type StarlinkCustomer,
  type StarlinkKit,
} from '../db/starlink';
import {
  verifyStarlinkPaymentIntent,
  StarlinkIntentError,
} from '../services/starlinkPaymentReconcile';
import {
  getStarlinkTelemetryBundle,
  StarlinkTelemetryError,
} from '../services/starlinkTelemetry';

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

/** Distinct token type: a member never impersonates the owner's customer JWT. */
function signMemberToken(member: StarlinkAccountMember): string {
  return jwt.sign({
    id: member.id,
    memberId: member.id,
    ownerCustomerId: member.owner_customer_id,
    role: member.role,
    type: 'starlink-member',
  }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d' });
}

function roleOf(req: Request): StarlinkRole {
  return req.starlinkRole ?? 'owner';
}

function publicMember(member: StarlinkAccountMember) {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    assignedKitIds: member.assigned_kit_ids,
    acceptedAt: member.accepted_at,
  };
}

/** Members see their own identity in the header; billing/admin keep owner money. */
function visibleCustomer(req: Request) {
  const owner = req.starlinkCustomer!;
  const base = publicCustomer(owner);
  if (!req.starlinkMember) return base;
  const member = req.starlinkMember;
  const canBill = roleOf(req) !== 'viewer';
  return {
    ...base,
    id: owner.id,
    fullName: member.name,
    email: member.email,
    phone: canBill ? owner.phone : '',
    walletBalance: canBill ? Number(owner.wallet_balance ?? 0) : 0,
    planCode: canBill ? owner.plan_code ?? null : null,
    planRenewsAt: canBill && owner.plan_renews_at ? String(owner.plan_renews_at).slice(0, 10) : null,
    emailVerified: canBill ? Boolean(owner.email_verified_at) : false,
    createdAt: member.accepted_at ?? member.created_at,
  };
}

function sessionPayload(req: Request) {
  return {
    customer: visibleCustomer(req),
    role: roleOf(req),
    ...(req.starlinkMember ? { member: publicMember(req.starlinkMember) } : {}),
  };
}

function authPayload(req: Request, token: string) {
  return { token, ...sessionPayload(req) };
}

function inviteKitLabels(kits: Array<{ id: string; site_name?: string | null; nickname?: string; kit_number: string }>, ids: string[]): string[] {
  if (!ids.length) return [];
  return ids.map((id) => {
    const kit = kits.find((k) => k.id === id);
    if (!kit) return id;
    return [kit.site_name || kit.nickname, kit.kit_number].filter(Boolean).join(' · ');
  });
}

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Issues a fresh 24-hour verification token and emails the link. Only the hash is stored. */
async function issueEmailVerification(customer: { id: string; email: string; full_name: string }): Promise<void> {
  const raw = crypto.randomBytes(32).toString('hex');
  await setStarlinkVerificationToken(customer.id, hashToken(raw), new Date(Date.now() + VERIFY_TTL_MS));
  const verifyUrl = `${starlinkBaseUrl()}/api/starlink/auth/verify-email?token=${raw}`;
  const sent = await sendStarlinkVerificationEmail(customer.email, customer.full_name, verifyUrl);
  if (!sent) console.error('Starlink verification email not delivered to', customer.email);
}

function publicCustomer(c: { id: string; full_name: string; email: string; phone: string; wallet_balance: unknown; plan_code?: string | null; plan_renews_at?: string | null; email_verified_at?: unknown; created_at: unknown }) {
  return {
    id: c.id,
    fullName: c.full_name,
    email: c.email,
    phone: c.phone,
    walletBalance: Number(c.wallet_balance ?? 0),
    planCode: c.plan_code ?? null,
    planRenewsAt: c.plan_renews_at ? String(c.plan_renews_at).slice(0, 10) : null,
    emailVerified: Boolean(c.email_verified_at),
    createdAt: c.created_at,
  };
}

const PHONE_LIKE = /^[+0-9()\s-]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// GET /api/starlink/plans — public catalog (USD / month)
// ---------------------------------------------------------------------------
starlinkRouter.get('/plans', (_req: Request, res: Response) => {
  res.json({ plans: STARLINK_PLANS });
});

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
    if (!phone || !PHONE_LIKE.test(phone)) { res.status(400).json({ error: 'A valid phone number is required for payment alerts' }); return; }
    if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }

    const existing = await findStarlinkCustomerByIdentifier(email);
    if (existing) { res.status(409).json({ error: 'An account with this email already exists' }); return; }

    const passwordHash = await bcrypt.hash(password, 10);
    const customer = await createStarlinkCustomer({ fullName, email, phone, passwordHash, kitSerial });
    issueEmailVerification(customer).catch((err) => console.error('Starlink verification issue failed:', err));
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
    if (customer && await bcrypt.compare(password, customer.password_hash)) {
      res.json({ token: signCustomerToken(customer.id), customer: publicCustomer(customer), role: 'owner' });
      return;
    }

    // Sub-accounts sign in with the same form, but receive a distinct member JWT.
    const member = await findAcceptedMemberByEmail(identifier);
    if (member && member.password_hash && await bcrypt.compare(password, member.password_hash)) {
      const owner = await getStarlinkCustomerById(member.owner_customer_id);
      if (owner) {
        req.starlinkCustomer = owner;
        req.starlinkMember = member;
        req.starlinkRole = member.role;
        req.starlinkPrincipal = {
          kind: 'member', id: member.id, role: member.role, ownerCustomerId: owner.id,
          memberId: member.id, kitIds: member.assigned_kit_ids,
        };
        res.json(authPayload(req, signMemberToken(member)));
        return;
      }
    }

    // Uniform error for unknown account and wrong password (no enumeration).
    res.status(401).json({ error: 'Incorrect email/phone or password' });
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
// GET /api/starlink/auth/verify-email?token=…  (link from the welcome email)
// ---------------------------------------------------------------------------
starlinkRouter.get('/auth/verify-email', async (req: Request, res: Response) => {
  const raw = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const base = starlinkBaseUrl();
  if (!/^[a-f0-9]{64}$/.test(raw)) { res.redirect(`${base}/starlink/auth?mode=verify-error`); return; }
  try {
    const customer = await consumeStarlinkVerificationToken(hashToken(raw));
    if (!customer) { res.redirect(`${base}/starlink/auth?mode=verify-error`); return; }
    res.redirect(`${base}/starlink/auth?mode=verified`);
  } catch (err) {
    console.error('Starlink verify-email error:', err);
    res.redirect(`${base}/starlink/auth?mode=verify-error`);
  }
});

// ---------------------------------------------------------------------------
// POST /api/starlink/auth/resend-verification
// ---------------------------------------------------------------------------
starlinkRouter.post('/auth/resend-verification', authLimiter, requireStarlinkAuth, requireStarlinkRoles('owner'), async (req: Request, res: Response) => {
  try {
    const customer = req.starlinkCustomer!;
    if (customer.email_verified_at) { res.status(400).json({ error: 'Your email is already verified' }); return; }
    await issueEmailVerification(customer);
    res.json({ message: `A new verification link was sent to ${customer.email}.` });
  } catch (err) {
    console.error('Starlink resend-verification error:', err);
    res.status(500).json({ error: 'Could not send the verification email' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/starlink/auth/me
// ---------------------------------------------------------------------------
starlinkRouter.get('/auth/me', requireStarlinkAuth, async (req: Request, res: Response) => {
  res.json(sessionPayload(req));
});

// ---------------------------------------------------------------------------
// PATCH /api/starlink/auth/profile
// ---------------------------------------------------------------------------
starlinkRouter.patch('/auth/profile', requireStarlinkAuth, requireStarlinkRoles('owner'), async (req: Request, res: Response) => {
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
starlinkRouter.post('/auth/change-password', requireStarlinkAuth, requireStarlinkRoles('owner'), async (req: Request, res: Response) => {
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
    await applyScheduledStarlinkServiceStates();
    const customer = req.starlinkCustomer!;
    const role = roleOf(req);
    const [allKits, allInvoices, balanceDue, pendingIntents, unreadCount] = await Promise.all([
      listStarlinkKits(customer.id),
      listStarlinkInvoices(customer.id),
      getBalanceDue(customer.id),
      listPendingStarlinkIntents(customer.id),
      getUnreadStarlinkNotificationCount(customer.id),
    ]);

    const kits = scopeStarlinkKits(req, allKits);
    const kitsWithUsage = await Promise.all(
      kits.map(async (k) => ({ ...k, usage: await getKitUsageHistory(k.id, 4) }))
    );

    // A technician sees telemetry only — no wallet, invoices or notifications.
    const billingVisible = role !== 'viewer';
    const invoices = billingVisible ? allInvoices : [];
    const paidThisMonth = invoices
      .filter((i) => i.status === 'PAID' && new Date(i.paid_at ?? i.created_at).toISOString().slice(0, 7) === new Date().toISOString().slice(0, 7))
      .reduce((sum, i) => sum + Number(i.amount), 0);

    res.json({
      customer: visibleCustomer(req),
      role,
      member: req.starlinkMember ? publicMember(req.starlinkMember) : null,
      balanceDue: billingVisible ? balanceDue : 0,
      paidThisMonth,
      kits: kitsWithUsage,
      invoices: invoices.slice(0, 20),
      pendingIntents: billingVisible ? pendingIntents : [],
      unreadCount: billingVisible ? unreadCount : 0,
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
// Plan switch applications
// ---------------------------------------------------------------------------
starlinkRouter.get('/plan-applications', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin', 'billing'), async (req: Request, res: Response) => {
  const applications = await listPlanApplications(req.starlinkCustomer!.id);
  res.json({ applications });
});

starlinkRouter.post('/plan-applications', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin'), async (req: Request, res: Response) => {
  try {
    const application = await submitPlanApplication(req.starlinkCustomer!, String(req.body?.planCode ?? ''));
    res.status(201).json({ application });
  } catch (err) {
    if (err instanceof PlanApplicationError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('Starlink plan application error:', err);
    res.status(500).json({ error: 'Could not submit your application' });
  }
});

// ---------------------------------------------------------------------------
// Kits
// ---------------------------------------------------------------------------
starlinkRouter.get('/kits', requireStarlinkAuth, async (req: Request, res: Response) => {
  await applyScheduledStarlinkServiceStates();
  const kits = scopeStarlinkKits(req, await listStarlinkKits(req.starlinkCustomer!.id));
  const withUsage = await Promise.all(kits.map(async (k) => ({ ...k, usage: await getKitUsageHistory(k.id, 4) })));
  res.json({ kits: withUsage });
});

starlinkRouter.post('/kits', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin'), async (req: Request, res: Response) => {
  try {
    const kitNumber = String(req.body?.kitNumber ?? '').trim();
    const nickname = String(req.body?.nickname ?? '').trim();
    if (!kitNumber || kitNumber.length < 4) { res.status(400).json({ error: 'Enter the kit serial number' }); return; }
    const kit = await registerStarlinkKit(req.starlinkCustomer!.id, kitNumber, nickname, {
      siteName: req.body?.siteName,
      city: req.body?.city,
      gpsLat: req.body?.gpsLat,
      gpsLng: req.body?.gpsLng,
      hardwareModel: req.body?.hardwareModel ?? req.body?.model,
    });
    res.status(201).json({ kit });
  } catch (err: any) {
    if (err?.code === '23505') { res.status(409).json({ error: 'This kit is already registered to your account' }); return; }
    console.error('Starlink kit register error:', err);
    res.status(500).json({ error: 'Could not register kit' });
  }
});

starlinkRouter.patch('/kits/:id', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin'), async (req: Request, res: Response) => {
  try {
    const updated = await updateStarlinkKit(req.params.id, req.starlinkCustomer!.id, {
      nickname: req.body?.nickname,
      status: ['active', 'paused'].includes(String(req.body?.status)) ? String(req.body.status) : undefined,
      siteName: req.body?.siteName,
      city: req.body?.city,
      gpsLat: req.body?.gpsLat,
      gpsLng: req.body?.gpsLng,
      hardwareModel: req.body?.hardwareModel ?? req.body?.model,
    });
    if (!updated) { res.status(404).json({ error: 'Kit not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('Starlink kit update error:', err);
    res.status(500).json({ error: 'Could not update kit' });
  }
});

starlinkRouter.get('/kits/:id/usage', requireStarlinkAuth, async (req: Request, res: Response) => {
  if (!canAccessStarlinkKit(req, req.params.id)) { res.status(403).json({ error: 'This kit is not assigned to your role' }); return; }
  const kit = await getStarlinkKit(req.params.id, req.starlinkCustomer!.id);
  if (!kit) { res.status(404).json({ error: 'Kit not found' }); return; }
  const usage = await getKitUsageHistory(kit.id, 4);
  res.json({ kit, usage });
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
starlinkRouter.get('/invoices', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin', 'billing'), async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const invoices = await listStarlinkInvoices(req.starlinkCustomer!.id, status);
  res.json({ invoices });
});

starlinkRouter.get('/invoices/:id', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin', 'billing'), async (req: Request, res: Response) => {
  const invoice = await getStarlinkInvoice(req.params.id, req.starlinkCustomer!.id);
  if (!invoice) { res.status(404).json({ error: 'Invoice not found' }); return; }
  res.json({ invoice });
});

// ---------------------------------------------------------------------------
// Payment recovery + notifications
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const paymentVerifyLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please wait a minute.' },
});

/** Customer-initiated re-check after a missed webhook or closed checkout tab. */
starlinkRouter.post(
  '/payments/verify/:intentId',
  requireStarlinkAuth,
  requireStarlinkRoles('owner', 'admin', 'billing'),
  paymentVerifyLimiter,
  async (req: Request, res: Response) => {
    try {
      const result = await verifyStarlinkPaymentIntent(req.params.intentId, {
        customerId: req.starlinkCustomer!.id,
        actor: 'customer',
      });
      res.json(result);
    } catch (err) {
      if (err instanceof StarlinkIntentError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('Starlink payment verify error:', err);
      res.status(500).json({ error: 'Could not verify this payment right now' });
    }
  }
);

// ---------------------------------------------------------------------------
// Telemetry, forecast and alert preferences
// ---------------------------------------------------------------------------
starlinkRouter.get('/telemetry', requireStarlinkAuth, async (req: Request, res: Response) => {
  const kitId = String(req.query.kitId ?? '');
  if (!UUID_RE.test(kitId)) { res.status(400).json({ error: 'Choose a valid kit' }); return; }
  if (!canAccessStarlinkKit(req, kitId)) { res.status(403).json({ error: 'This kit is not assigned to your role' }); return; }
  try {
    const bundle = await getStarlinkTelemetryBundle(req.starlinkCustomer!.id, kitId);
    res.json(bundle);
  } catch (err) {
    if (err instanceof StarlinkTelemetryError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('Starlink telemetry error:', err);
    res.status(500).json({ error: 'Could not load telemetry' });
  }
});

const PREF_BOOLEAN_FIELDS = [
  'alert_75_email_enabled', 'alert_75_portal_enabled',
  'alert_90_email_enabled', 'alert_90_portal_enabled',
  'alert_100_email_enabled', 'alert_100_portal_enabled',
  'email_alerts_enabled', 'portal_alerts_enabled', 'offline_alerts_enabled',
  'auto_topup_enabled',
] as const;

starlinkRouter.patch('/telemetry/preferences', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin'), async (req: Request, res: Response) => {
  const kitId = String(req.body?.kitId ?? req.query.kitId ?? '');
  if (!UUID_RE.test(kitId)) { res.status(400).json({ error: 'Choose a valid kit' }); return; }
  const kit = await getStarlinkKit(kitId, req.starlinkCustomer!.id);
  if (!kit) { res.status(404).json({ error: 'Kit not found' }); return; }

  const patch: Record<string, boolean | number> = {};
  for (const field of PREF_BOOLEAN_FIELDS) {
    if (typeof req.body?.[field] === 'boolean') patch[field] = req.body[field];
  }
  const gb = Number(req.body?.auto_topup_gb);
  if (Number.isFinite(gb)) patch.auto_topup_gb = Math.min(1000, Math.max(1, Math.round(gb * 100) / 100));
  const minGb = Number(req.body?.auto_topup_min_gb);
  if (Number.isFinite(minGb)) patch.auto_topup_min_gb = Math.min(100, Math.max(0.5, Math.round(minGb * 100) / 100));

  try {
    const preferences = await updateStarlinkAlertPreferences(req.starlinkCustomer!.id, kitId, patch);
    res.json({ ok: true, preferences });
  } catch (err) {
    console.error('Starlink telemetry preferences error:', err);
    res.status(500).json({ error: 'Could not update alert preferences' });
  }
});

// ---------------------------------------------------------------------------
// Fleet grouping, kit transfers, scheduled service state and sub-accounts
// ---------------------------------------------------------------------------

starlinkRouter.get('/fleet', requireStarlinkAuth, async (req: Request, res: Response) => {
  try {
    await applyScheduledStarlinkServiceStates();
    const owner = req.starlinkCustomer!;
    const role = roleOf(req);
    const billingVisible = role !== 'viewer';
    const [allKits, invoices, balanceDue] = await Promise.all([
      listStarlinkKits(owner.id),
      listStarlinkInvoices(owner.id).catch(() => []),
      billingVisible ? getBalanceDue(owner.id) : Promise.resolve(0),
    ]);
    const kits = await Promise.all(
      scopeStarlinkKits(req, allKits).map(async (k) => ({ ...k, usage: await getKitUsageHistory(k.id, 4) }))
    );
    const transfers = billingVisible ? await listStarlinkCreditTransfers(owner.id) : [];
    const members = role === 'owner' || role === 'admin'
      ? (await listStarlinkAccountMembers(owner.id)).map(publicMember)
      : [];

    res.json({
      role,
      member: req.starlinkMember ? publicMember(req.starlinkMember) : null,
      kits,
      invoices: billingVisible ? invoices.slice(0, 100) : [],
      transfers,
      members,
      permissions: {
        canBill: billingVisible,
        canManage: role === 'owner' || role === 'admin',
        canInvite: role === 'owner',
      },
      summary: {
        kitCount: kits.length,
        activeKits: kits.filter((k) => k.status === 'active').length,
        pausedKits: kits.filter((k) => k.status === 'paused').length,
        totalDataUsedGb: Math.round(kits.reduce((sum, k) => sum + Number(k.data_usage_gb ?? 0), 0) * 100) / 100,
        totalDataCreditGb: Math.round(kits.reduce((sum, k) => sum + Number(k.data_credit_gb ?? 0), 0) * 100) / 100,
        walletBalance: billingVisible ? Number(owner.wallet_balance ?? 0) : 0,
        balanceDue,
        nextRenewalDate: billingVisible && owner.plan_renews_at ? String(owner.plan_renews_at).slice(0, 10) : null,
      },
    });
  } catch (err) {
    console.error('Starlink fleet error:', err);
    res.status(500).json({ error: 'Could not load fleet overview' });
  }
});

/** Internal kit-to-kit data credit move. No wallet debit, no gateway payment. */
starlinkRouter.post('/kits/transfer-data', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin', 'billing'), async (req: Request, res: Response) => {
  try {
    const fromKitId = String(req.body?.fromKitId ?? '').trim();
    const toKitId = String(req.body?.toKitId ?? '').trim();
    const gb = Math.round(Number(req.body?.gb) * 100) / 100;
    if (!UUID_RE.test(fromKitId) || !UUID_RE.test(toKitId)) {
      res.status(400).json({ error: 'Choose a valid source and destination kit' });
      return;
    }
    if (!Number.isFinite(gb) || gb < 0.01 || gb > 1000) {
      res.status(400).json({ error: 'Enter an amount between 0.01 and 1000 GB' });
      return;
    }
    const customerId = req.starlinkCustomer!.id;
    const [fromKit, toKit] = await Promise.all([
      getStarlinkKit(fromKitId, customerId),
      getStarlinkKit(toKitId, customerId),
    ]);
    if (!fromKit || !toKit) { res.status(404).json({ error: 'Both kits must belong to your account' }); return; }

    // A client-supplied key makes double submits safe; a generated key still
    // covers older callers that do not send one.
    const suppliedKey = String(req.body?.idempotencyKey ?? '').trim();
    const eventKey = /^[A-Za-z0-9._:-]{8,120}$/.test(suppliedKey)
      ? `starlink-transfer:${customerId}:${suppliedKey}`
      : crypto.randomUUID();
    const result = await transferStarlinkKitCredit({
      customerId,
      fromKitId,
      toKitId,
      gb,
      eventKey,
      actorMemberId: req.starlinkMember?.id ?? null,
      meta: { from_site: fromKit.site_name, to_site: toKit.site_name },
    });
    res.json({
      ok: true,
      transfer: result.transfer,
      fromBalance: result.fromBalance,
      toBalance: result.toBalance,
      notificationCreated: result.notificationCreated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const expected = /not enough|different kits|belong|amount/i.test(message);
    if (expected) {
      res.status(400).json({ error: message });
      return;
    }
    console.error('Starlink transfer error:', err);
    res.status(500).json({ error: 'Could not transfer data credit' });
  }
});

/** Immediate or scheduled pause / reactivation request for one kit. */
starlinkRouter.post('/kits/:kitId/service-state', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin'), async (req: Request, res: Response) => {
  try {
    const kitId = String(req.params.kitId ?? '');
    const state = String(req.body?.state ?? '').trim().toLowerCase();
    if (!UUID_RE.test(kitId)) { res.status(400).json({ error: 'Choose a valid kit' }); return; }
    if (state !== 'active' && state !== 'paused') { res.status(400).json({ error: 'State must be active or paused' }); return; }

    const rawWhen = String(req.body?.effectiveAt ?? '').trim();
    let effectiveAt: Date | null = null;
    if (rawWhen) {
      effectiveAt = new Date(rawWhen);
      if (Number.isNaN(effectiveAt.getTime())) { res.status(400).json({ error: 'Invalid schedule date' }); return; }
      if (effectiveAt.getTime() <= Date.now() + 60_000) effectiveAt = null;
    }
    const customerId = req.starlinkCustomer!.id;
    const kit = await getStarlinkKit(kitId, customerId);
    if (!kit) { res.status(404).json({ error: 'Kit not found' }); return; }

    const result = await requestStarlinkKitServiceState({
      customerId,
      kitId,
      state,
      effectiveAt,
      note: String(req.body?.note ?? ''),
      actorMemberId: req.starlinkMember?.id ?? null,
      // Unique per request so instant changes can be repeated (pause →
      // reactivate → pause) without replaying the first decision.
      eventKey: `starlink-service-request:${customerId}:${kitId}:${state}:${crypto.randomUUID()}`,
    });
    res.json({
      ok: true,
      request: result.request,
      applied: result.applied,
      notificationCreated: result.notificationCreated,
    });
  } catch (err) {
    console.error('Starlink service state error:', err);
    res.status(500).json({ error: 'Could not update service state' });
  }
});

starlinkRouter.get('/members', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin'), async (req: Request, res: Response) => {
  const members = (await listStarlinkAccountMembers(req.starlinkCustomer!.id)).map(publicMember);
  res.json({ members });
});

const MEMBER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseMemberRole(value: unknown): StarlinkAccountMemberRole | null {
  const role = String(value ?? '').trim();
  return ['admin', 'billing', 'viewer'].includes(role) ? role as StarlinkAccountMemberRole : null;
}

function parseAssignedKitIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))
    : [];
}

async function validateMemberAccess(
  ownerCustomerId: string,
  role: StarlinkAccountMemberRole,
  requestedIds: string[]
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  if (role === 'viewer' && requestedIds.length === 0) {
    return { ok: false, error: 'Assign at least one kit to a site technician' };
  }
  const allKits = await listStarlinkKits(ownerCustomerId);
  const scopedIds = requestedIds.filter((id) => allKits.some((k) => k.id === id));
  if (scopedIds.length !== requestedIds.length) {
    return { ok: false, error: 'One or more assigned kits are not on your account' };
  }
  // Only viewers are kit-scoped; admin/billing are fleet-wide by design.
  return { ok: true, ids: role === 'viewer' ? scopedIds : [] };
}

function memberInviteTemplate(
  owner: StarlinkCustomer,
  member: StarlinkAccountMember,
  allKits: StarlinkKit[],
  rawToken: string
) {
  const inviteUrl = `${starlinkBaseUrl()}/starlink/auth?mode=member-invite&token=${rawToken}`;
  const expiresAt = member.invite_expires_at
    ? new Date(member.invite_expires_at)
    : new Date(Date.now() + MEMBER_INVITE_TTL_MS);
  return {
    inviteUrl,
    template: buildMemberInviteEmail({
      fullName: member.name,
      email: member.email,
      ownerName: owner.full_name,
      role: member.role,
      kitLabels: inviteKitLabels(allKits, member.assigned_kit_ids),
      inviteUrl,
      expiresLabel: expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    }),
  };
}

/** Owner-only invitation. The raw token is emailed; only its hash is stored. */
starlinkRouter.post('/members/invite', requireStarlinkAuth, requireStarlinkRoles('owner'), async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email ?? '').trim();
    const name = String(req.body?.name ?? '').trim();
    const role = parseMemberRole(req.body?.role);
    if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'Enter a valid email address' }); return; }
    if (name.length < 2) { res.status(400).json({ error: 'Enter the invitee name' }); return; }
    if (!role) { res.status(400).json({ error: 'Choose a valid role' }); return; }

    const owner = req.starlinkCustomer!;
    if (email.toLowerCase() === owner.email.toLowerCase()) {
      res.status(400).json({ error: 'The account owner already has full access' });
      return;
    }
    const access = await validateMemberAccess(owner.id, role, parseAssignedKitIds(req.body?.assignedKitIds));
    if (!access.ok) { res.status(400).json({ error: access.error }); return; }

    const allKits = await listStarlinkKits(owner.id);
    const raw = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + MEMBER_INVITE_TTL_MS);
    const existing = await pool.query(
      `SELECT id, accepted_at FROM starlink_account_members WHERE lower(email) = lower($1)`, [email]
    );
    const member = existing.rows[0]
      ? existing.rows[0].accepted_at
        ? null
        : await rotateStarlinkAccountMemberInvite({
          ownerCustomerId: owner.id,
          memberId: existing.rows[0].id,
          inviteTokenHash: hashToken(raw),
          inviteExpiresAt: expiresAt,
          name,
          role,
          assignedKitIds: access.ids,
        })
      : await createStarlinkAccountMember({
        ownerCustomerId: owner.id,
        email,
        name,
        role,
        assignedKitIds: access.ids,
        inviteTokenHash: hashToken(raw),
        inviteExpiresAt: expiresAt,
      });
    if (!member) {
      res.status(409).json({ error: 'This email already has fleet access — resend the invite or remove the member first' });
      return;
    }

    const { inviteUrl, template } = memberInviteTemplate(owner, member, allKits, raw);
    const emailSent = await sendStarlinkEmail(member.email, template).catch(() => false);
    res.status(existing.rows[0] ? 200 : 201).json({ member: publicMember(member), inviteUrl, emailSent });
  } catch (err: any) {
    if (err?.code === '23505') { res.status(409).json({ error: 'This email already has fleet access' }); return; }
    console.error('Starlink member invite error:', err);
    res.status(500).json({ error: 'Could not send the invitation' });
  }
});

/** Resend (or recover) a member invite; resets the password and session. */
starlinkRouter.post('/members/:id/resend-invite', requireStarlinkAuth, requireStarlinkRoles('owner'), async (req: Request, res: Response) => {
  try {
    const memberId = String(req.params.id ?? '');
    if (!UUID_RE.test(memberId)) { res.status(400).json({ error: 'Choose a valid member' }); return; }
    const owner = req.starlinkCustomer!;
    const current = await getStarlinkAccountMemberById(memberId);
    if (!current || current.owner_customer_id !== owner.id) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    const raw = crypto.randomBytes(32).toString('hex');
    const member = await rotateStarlinkAccountMemberInvite({
      ownerCustomerId: owner.id,
      memberId,
      inviteTokenHash: hashToken(raw),
      inviteExpiresAt: new Date(Date.now() + MEMBER_INVITE_TTL_MS),
    });
    if (!member) { res.status(404).json({ error: 'Member not found' }); return; }
    const { inviteUrl, template } = memberInviteTemplate(owner, member, await listStarlinkKits(owner.id), raw);
    const emailSent = await sendStarlinkEmail(member.email, template).catch(() => false);
    res.json({ member: publicMember(member), inviteUrl, emailSent });
  } catch (err) {
    console.error('Starlink member resend error:', err);
    res.status(500).json({ error: 'Could not resend the invitation' });
  }
});

/** Change a member's role and, for viewers, their assigned sites. */
starlinkRouter.patch('/members/:id', requireStarlinkAuth, requireStarlinkRoles('owner'), async (req: Request, res: Response) => {
  try {
    const memberId = String(req.params.id ?? '');
    const role = parseMemberRole(req.body?.role);
    if (!UUID_RE.test(memberId)) { res.status(400).json({ error: 'Choose a valid member' }); return; }
    if (!role) { res.status(400).json({ error: 'Choose a valid role' }); return; }
    const owner = req.starlinkCustomer!;
    const access = await validateMemberAccess(owner.id, role, parseAssignedKitIds(req.body?.assignedKitIds));
    if (!access.ok) { res.status(400).json({ error: access.error }); return; }
    const member = await updateStarlinkAccountMemberAccess({
      ownerCustomerId: owner.id,
      memberId,
      role,
      assignedKitIds: access.ids,
    });
    if (!member) { res.status(404).json({ error: 'Member not found' }); return; }
    res.json({ member: publicMember(member) });
  } catch (err) {
    console.error('Starlink member update error:', err);
    res.status(500).json({ error: 'Could not update member access' });
  }
});

/** Revoke a sub-account immediately — existing JWTs stop resolving. */
starlinkRouter.delete('/members/:id', requireStarlinkAuth, requireStarlinkRoles('owner'), async (req: Request, res: Response) => {
  try {
    const memberId = String(req.params.id ?? '');
    if (!UUID_RE.test(memberId)) { res.status(400).json({ error: 'Choose a valid member' }); return; }
    const removed = await deleteStarlinkAccountMember(req.starlinkCustomer!.id, memberId);
    if (!removed) { res.status(404).json({ error: 'Member not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('Starlink member removal error:', err);
    res.status(500).json({ error: 'Could not remove member' });
  }
});

/** Public because the invite link is the only credential before acceptance. */
starlinkRouter.post('/members/accept', authLimiter, async (req: Request, res: Response) => {
  try {
    const raw = String(req.body?.token ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!/^[a-f0-9]{64}$/.test(raw)) { res.status(400).json({ error: 'This invitation link is invalid' }); return; }
    if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }

    const member = await acceptStarlinkAccountMember({
      inviteTokenHash: hashToken(raw),
      passwordHash: await bcrypt.hash(password, 10),
      name: String(req.body?.name ?? ''),
    });
    if (!member) { res.status(400).json({ error: 'This invitation is invalid or has expired' }); return; }
    const owner = await getStarlinkCustomerById(member.owner_customer_id);
    if (!owner) { res.status(404).json({ error: 'Fleet account not found' }); return; }

    req.starlinkCustomer = owner;
    req.starlinkMember = member;
    req.starlinkRole = member.role;
    req.starlinkPrincipal = {
      kind: 'member', id: member.id, role: member.role, ownerCustomerId: owner.id,
      memberId: member.id, kitIds: member.assigned_kit_ids,
    };
    res.json(authPayload(req, signMemberToken(member)));
  } catch (err) {
    console.error('Starlink member accept error:', err);
    res.status(500).json({ error: 'Could not accept the invitation' });
  }
});

starlinkRouter.get('/notifications', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin', 'billing'), async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const [notifications, unreadCount] = await Promise.all([
      listStarlinkNotifications(req.starlinkCustomer!.id, limit),
      getUnreadStarlinkNotificationCount(req.starlinkCustomer!.id),
    ]);
    res.json({ notifications, unreadCount });
  } catch (err) {
    console.error('Starlink notifications error:', err);
    res.status(500).json({ error: 'Could not load notifications' });
  }
});

starlinkRouter.post('/notifications/mark-read', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin', 'billing'), async (req: Request, res: Response) => {
  try {
    const raw = req.body?.ids;
    const ids = Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))
      : undefined;
    const changed = await markStarlinkNotificationsRead(req.starlinkCustomer!.id, ids);
    const unreadCount = await getUnreadStarlinkNotificationCount(req.starlinkCustomer!.id);
    res.json({ ok: true, changed, unreadCount });
  } catch (err) {
    console.error('Starlink mark-read error:', err);
    res.status(500).json({ error: 'Could not update notifications' });
  }
});
