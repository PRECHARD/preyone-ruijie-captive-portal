import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth, requireRole } from '../middleware/adminAuth';
import { moduleAccess, requireCompany } from '../middleware/company';
import { invoiceBlock, subscriptionBlock } from '../plans/entitlements';
import { requireDeviceAuth } from '../middleware/deviceAuth';
import { checkRate, clearFailures, isLocked, recordFailure, securityAudit } from '../services/authRateLimit';
import { enforceSubscriptionGuard } from '../middleware/subscriptionGuard';
import { markStockApplied, syncSaleToLedgerAndStock } from '../db/accounting';
import { INVOICE_DOCUMENT_TYPES, ALL_DOCUMENT_TYPES } from '../services/pesepay';
import { POS_THEMES, CURRENCIES, type PosTheme } from '../catalog/ecosystem';
import { themeCssVariables, themeCssBlock } from '../utils/themeVars';
import {
  sendPasswordResetEmail,
  sendShiftCloseEmail,
  sendStaffWelcomeEmail,
  sendTransactionalEmail,
} from '../services/notificationService';
import { generateDocumentVerifyCode } from '../utils/documentVerifyCode';
import { withCompanyBranding } from '../utils/companyBranding';
import {
  initiatePesepayPayment,
  isPesepayRail,
  normalizeGatewayCurrency,
} from '../services/pesepayService';
import { reconcilePesepayIntentById, signPesepayStatusToken } from './payments';

/**
 * Preyone POS module — additive only.
 * Never modifies portal / voucher / gateway flows (see AGENTS.md).
 */

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';

const STAFF_ROLES = ['CEO', 'Manager', 'Staff', 'Cashier'];
const MANAGER_ROLES = ['CEO', 'Manager'];

interface StaffUser {
  id: string;
  email: string;
  role: string;
  fullName: string;
  company_id?: string | null;
}

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function signToken(user: StaffUser, sid?: string): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      company_id: user.company_id ?? null,
      ...(sid ? { sid } : {}),
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function isStaff(user?: StaffUser): boolean {
  return !!user && STAFF_ROLES.includes(user.role);
}

// ── Auth: PIN login (for till tablets) ─────────────────────────────

const pinLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: { error: 'Too many PIN attempts, try again shortly' },
});

// Till operator picker — only approved, admin-registered staff with a PIN
const operatorLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: { error: 'Too many requests, try again shortly' },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve the tenant for an operator-roster request.
 *
 * The picker is pre-auth, so it cannot rely on req.company. Accepted proofs,
 * in order of trust:
 *   1. a valid admin Bearer token (already signed in / switching cashier);
 *   2. a paired-device token header (x-device-token);
 *   3. the tenant's own UUID as the till setup code (?company=);
 *   4. a legacy single-tenant deployment, where only one company exists.
 * With two or more companies and no proof, the caller gets TENANT_REQUIRED
 * instead of every tenant's staff list.
 */
async function resolveOperatorTenant(req: Request): Promise<string | null> {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(auth.slice(7).trim(), JWT_SECRET) as { id?: string };
      if (decoded?.id) {
        const { rows } = await pool.query(
          'SELECT portal_company_id FROM admin_users WHERE id = $1',
          [decoded.id]
        );
        if (rows[0]?.portal_company_id) return rows[0].portal_company_id as string;
      }
    } catch {
      /* invalid/expired bearer: fall through to the other proofs */
    }
  }

  const deviceToken = str(req.headers['x-device-token']);
  if (deviceToken) {
    const { rows } = await pool.query(
      `SELECT company_id FROM pos_devices WHERE device_token = $1 AND status = 'active'`,
      [deviceToken]
    );
    if (rows[0]?.company_id) return rows[0].company_id as string;
  }

  const code = str(req.query.company) || str(req.query.code);
  if (code && UUID_RE.test(code)) {
    const { rows } = await pool.query('SELECT id FROM companies WHERE id = $1', [code]);
    if (rows[0]?.id) return rows[0].id as string;
  }

  const { rows } = await pool.query('SELECT id FROM companies ORDER BY created_at ASC LIMIT 2');
  return rows.length === 1 ? (rows[0].id as string) : null;
}

async function loadOperatorRoster(
  req: Request,
  res: Response
): Promise<{ companyId: string; operators: unknown[] } | null> {
  const companyId = await resolveOperatorTenant(req);
  if (!companyId) {
    res.status(400).json({
      error:
        'This till is not linked to a company. Enter the till code from Invoice → Settings → Client Tenants.',
      code: 'TENANT_REQUIRED',
    });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT id, full_name, email, role
       FROM admin_users
      WHERE pin_hash IS NOT NULL AND approved = TRUE AND portal_company_id = $1
      ORDER BY full_name`,
    [companyId]
  );
  return { companyId, operators: rows };
}

/**
 * Legacy operator shape: a plain array.
 *
 * POS shells are long-lived, so a cached bundle that predates the tenant hint
 * must not receive an object and crash on `.map`. It still gets only its own
 * tenant's roster (or TENANT_REQUIRED), just in the old JSON shape.
 */
router.get('/auth/operators', operatorLimiter, async (req, res) => {
  const roster = await loadOperatorRoster(req, res);
  if (!roster) return;
  res.json(roster.operators);
});

/** Current shape: the tenant id lets the till remember its company. */
router.get('/auth/operator-roster', operatorLimiter, async (req, res) => {
  const roster = await loadOperatorRoster(req, res);
  if (!roster) return;
  res.json(roster);
});

router.post('/auth/pin', pinLimiter, async (req, res) => {
  const userId = str(req.body?.userId);
  const pin = str(req.body?.pin);
  if (!/^\d{4,8}$/.test(pin)) {
    res.status(400).json({ error: 'PIN must be 4–8 digits' });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: 'Select your till operator name' });
    return;
  }

  // A PIN is only valid inside the tenant whose roster the till loaded. This
  // closes the pre-auth gap where a leaked operator id could be tried from any
  // company's login screen.
  const requestedCompany = str(req.body?.companyId);
  const companyId =
    requestedCompany && UUID_RE.test(requestedCompany)
      ? requestedCompany
      : await resolveOperatorTenant(req);
  if (!companyId) {
    res.status(400).json({
      error: 'This till is not linked to a company. Enter the till code first.',
      code: 'TENANT_REQUIRED',
    });
    return;
  }

  const lockKey = `pos:pin:${companyId}:${userId}`;
  const lock = await isLocked(lockKey);
  if (lock.locked) {
    securityAudit('pos_pin_locked', { companyId, userId, retryAfterMs: lock.retryAfterMs });
    res.status(423).json({
      error: 'This till is locked after too many failed PIN attempts. Try again later.',
      code: 'PIN_LOCKED',
      retryAfterMs: lock.retryAfterMs,
    });
    return;
  }
  const rl = await checkRate(lockKey, 60_000, 10);
  if (!rl.allowed) {
    res.status(429).json({ error: 'Too many attempts. Please slow down.', retryAfterMs: rl.retryAfterMs });
    return;
  }
  const { rows } = await pool.query(
    `SELECT id, email, full_name, role, pin_hash, company_id
       FROM admin_users
      WHERE id = $1 AND portal_company_id = $2
        AND pin_hash IS NOT NULL AND approved = TRUE`,
    [userId, companyId]
  );
  const row = rows[0];
  if (row && (await bcrypt.compare(pin, row.pin_hash))) {
    await clearFailures(lockKey);
    const user: StaffUser = {
      id: row.id,
      email: row.email,
      role: row.role,
      fullName: row.full_name,
      company_id: row.company_id ?? null,
    };
    // A PIN sign-in is a real per-device session, not just a signed payload.
    // The session row gives /refresh a clock to slide, so an active till never
    // locks mid-sale, while an abandoned tablet can still be cleaned up.
    const sid = crypto.randomUUID();
    await pool.query(
      `INSERT INTO admin_user_sessions (sid, admin_user_id, auth_time, last_activity)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (sid) DO NOTHING`,
      [sid, user.id]
    );
    res.json({ token: signToken(user, sid), user });
    return;
  }
  const failure = await recordFailure(lockKey);
  if (failure.locked) {
    securityAudit('pos_pin_locked', { companyId, userId, attempts: failure.attempts });
  }
  res.status(401).json({ error: 'Invalid PIN for this operator' });
});

// Set own PIN, or a cashier's PIN (Manager+). Tenant-scoped: a manager can
// never rewrite a PIN on another company's account.
router.post('/auth/set-pin', requireAdminAuth, requireCompany, async (req, res) => {
  const me = req.adminUser!;
  const targetId = str(req.body?.userId) || me.id;
  const pin = str(req.body?.pin);
  if (!/^\d{4,8}$/.test(pin)) {
    res.status(400).json({ error: 'PIN must be 4–8 digits' });
    return;
  }
  if (targetId !== me.id && !MANAGER_ROLES.includes(me.role)) {
    res.status(403).json({ error: 'Only Managers/CEO can set other users PINs' });
    return;
  }
  const hash = await bcrypt.hash(pin, 10);
  const { rows } = await pool.query(
    `UPDATE admin_users SET pin_hash = $1
      WHERE id = $2
        AND (portal_company_id = $3 OR portal_company_id IS NULL)
      RETURNING id, full_name`,
    [hash, targetId, req.company!.id]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await pool.query(
    `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
     VALUES ($1,$2,'pos.set_pin','admin_user',$3,$4)`,
    [me.id, me.fullName ?? null, targetId, 'POS PIN updated']
  );
  res.json({ ok: true, user: rows[0] });
});

router.get(
  '/cashiers',
  requireAdminAuth,
  requireRole(...MANAGER_ROLES),
  requireCompany,
  async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, role, approved, pin_hash IS NOT NULL AS has_pin
         FROM admin_users
        WHERE portal_company_id = $1
          AND role IN ('Cashier','Staff','Manager','CEO')
        ORDER BY full_name`,
      [req.company!.id]
    );
    res.json(rows);
  }
);

/** Create a team member bound to the signed-in tenant. */
router.post(
  '/cashiers',
  requireAdminAuth,
  requireRole(...MANAGER_ROLES),
  requireCompany,
  async (req, res) => {
    const me = req.adminUser!;
    const fullName = str(req.body?.fullName);
    const email = str(req.body?.email).toLowerCase();
    const phone = str(req.body?.phone);
    const role = str(req.body?.role) || 'Cashier';
    const password = String(req.body?.password ?? '');
    const pin = str(req.body?.pin);

    if (!fullName || !email || !phone || !password) {
      res.status(422).json({ error: 'Name, email, phone and temporary password are required.' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(422).json({ error: 'Enter a valid email address.' });
      return;
    }
    if (password.length < 8) {
      res.status(422).json({ error: 'Temporary password must be at least 8 characters.' });
      return;
    }
    if (!['Manager', 'Staff', 'Cashier'].includes(role)) {
      res.status(422).json({ error: 'Role must be Manager, Staff or Cashier.' });
      return;
    }
    if (role === 'Manager' && me.role !== 'CEO') {
      res.status(403).json({ error: 'Only the CEO can create a Manager account.' });
      return;
    }
    if (pin && !/^\d{4,8}$/.test(pin)) {
      res.status(422).json({ error: 'PIN must be 4–8 digits.' });
      return;
    }

    const duplicate = await pool.query(
      'SELECT 1 FROM admin_users WHERE lower(email) = lower($1) LIMIT 1',
      [email]
    );
    if (duplicate.rows.length > 0) {
      res.status(409).json({
        error: 'An account with that email already exists.',
        code: 'EMAIL_IN_USE',
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
    const { rows } = await pool.query(
      `INSERT INTO admin_users
         (full_name, email, phone, role, password_hash, pin_hash,
          approved, email_verified, status, portal_company_id)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,TRUE,'active',$7)
       RETURNING id, full_name, email, phone, role, approved, pin_hash IS NOT NULL AS has_pin`,
      [fullName, email, phone, role, passwordHash, pinHash, req.company!.id]
    );
    const user = rows[0];

    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
       VALUES ($1,$2,'pos.staff_create','admin_user',$3,$4)`,
      [me.id, me.fullName ?? null, user.id, `${role} account created (${email})`]
    ).catch(() => undefined);

    const emailSent = await sendStaffWelcomeEmail({
      to: email,
      fullName,
      companyName: req.company!.name,
      role,
      tempPassword: password,
      pin: pin || null,
    }).catch(() => false);

    res.status(201).json({ user, email_sent: emailSent });
  }
);

/** Tenant-scoped password recovery for a team member. */
router.post(
  '/cashiers/:id/password-reset',
  requireAdminAuth,
  requireRole(...MANAGER_ROLES),
  requireCompany,
  async (req, res) => {
    const me = req.adminUser!;
    const { rows } = await pool.query(
      `SELECT id, full_name, email, role
         FROM admin_users
        WHERE id = $1 AND portal_company_id = $2
        LIMIT 1`,
      [req.params.id, req.company!.id]
    );
    const user = rows[0];
    if (!user) {
      res.status(404).json({ error: 'Team member not found.' });
      return;
    }
    if (user.role === 'CEO' && user.id !== me.id) {
      res.status(403).json({ error: 'Only the CEO can reset the CEO password.' });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `UPDATE admin_users
          SET reset_token = $1, reset_token_expires_at = $2
        WHERE id = $3`,
      [token, new Date(Date.now() + 60 * 60 * 1000), user.id]
    );
    const sent = await sendPasswordResetEmail(
      user.email,
      token,
      user.full_name,
      'invoice'
    ).catch(() => false);

    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
       VALUES ($1,$2,'pos.staff_password_reset','admin_user',$3,$4)`,
      [me.id, me.fullName ?? null, user.id, `Reset link for ${user.email}`]
    ).catch(() => undefined);

    res.json({ ok: true, sent, email: user.email });
  }
);

// ── Middleware guard for all POS data endpoints ────────────────────

function requireStaff(req: Request, res: Response, next: NextFunction): void {
  if (!isStaff(req.adminUser)) {
    res.status(403).json({ error: 'POS access required' });
    return;
  }
  next();
}
router.use(requireAdminAuth, requireStaff, requireCompany, moduleAccess('pos'));

// Invoice and receipt payloads are private to the workspace. Never let a
// shared browser or proxy keep a copy in its HTTP cache.
router.use('/documents', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

// ── Tenant scoping ─────────────────────────────────────────────────
//
// requireCompany has populated req.company, and it is the ONLY trustworthy
// source of the tenant: req.adminUser.company_id is nullable and its foreign
// key points at transit_companies rather than companies, so it must never be
// used to filter POS rows.
//
// Every shift/document query below is constrained with company_id = this value,
// which is what closes the cross-tenant IDOR: an admin of another company now
// gets 404 for a document that exists but is not theirs.
function tenantId(req: Request): string {
  return req.company!.id;
}

/** Human labels for the e-mail subject/body. */
const DOCUMENT_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  tax_invoice: 'Tax Invoice',
  quote: 'Quotation',
  quotation: 'Quotation',
  estimate: 'Estimate',
  proforma: 'Proforma Invoice',
  receipt: 'Receipt',
  sales_receipt: 'Sales Receipt',
  cash_receipt: 'Cash Receipt',
  credit_memo: 'Credit Memo',
  credit_note: 'Credit Note',
  purchase_order: 'Purchase Order',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  );
}

const documentEmailLimiter = rateLimit({
  windowMs: 60_000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many e-mails. Please wait a minute and try again.' },
});

// ── Payment methods accepted on documents ──────────────────────────
// Mirrors the pos_document_payments_method_check constraint.
// Mobile-money rails are the ones Pesepay actually enables for this merchant
// (verified against /v1/payment-methods/for-currency). Zimswitch, Visa and
// Mastercard are NOT listed: Pesepay rejects them for this merchant, and
// offering an unusable rail at the till is worse than not offering it.
const PAYMENT_METHODS = [
  'cash', 'card', 'ecocash', 'innbucks', 'paygo', 'omari', 'bank', 'pesepay', 'other',
];

// ── Company profile (read-only for staff clients) ───────────────────
// Single source of truth for receipts / invoices / support phone. Scoped to
// req.company (requireCompany above), never to the first-created row: a second
// tenant must see its own identity on every receipt.
router.get('/company', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM companies WHERE id = $1', [req.company!.id]);
  res.json(
    withCompanyBranding(
      rows[0] || {
        id: req.company!.id,
        name: req.company!.name || 'Preyone',
        currency: 'USD',
        tax_pct: 0,
        support_phone: '',
      }
    )
  );
});

// ── Company subscriptions (tenancy) — which modules this company owns ─
// ── Company profile (tenant settings) ─────────────────────────────────────
//
// Read is open to every signed-in operator (the till shows the store name on
// receipts); writes are Manager/CEO only and always scoped to the session's
// company. Field-by-field COALESCE keeps a partial save from wiping anything.
router.patch('/company', requireRole(...MANAGER_ROLES), async (req, res) => {
  const b = req.body || {};
  const cid = tenantId(req);
  const text = (key: string, max = 500): string | null | undefined => {
    if (!(key in b)) return undefined;
    if (b[key] === null) return null;
    return str(b[key]).slice(0, max);
  };

  const name = text('name', 160);
  if (name !== undefined && !name) {
    res.status(422).json({ error: 'Company name cannot be empty' });
    return;
  }
  const taxRaw = b.tax_pct ?? b.taxPct;
  const taxPct = taxRaw === undefined ? undefined : num(taxRaw);
  if (taxPct !== undefined && (taxPct < 0 || taxPct > 100)) {
    res.status(422).json({ error: 'VAT % must be between 0 and 100' });
    return;
  }
  const currency = text('currency', 8);
  if (currency !== undefined && currency && !/^[A-Z]{3}$/.test(currency.toUpperCase())) {
    res.status(422).json({ error: 'Currency must be a 3-letter code' });
    return;
  }

  const { rows } = await pool.query(
    `UPDATE companies
        SET name            = COALESCE($2, name),
            tagline         = COALESCE($3, tagline),
            address         = COALESCE($4, address),
            email           = COALESCE($5, email),
            support_phone   = COALESCE($6, support_phone),
            website         = COALESCE($7, website),
            currency        = COALESCE($8, currency),
            tax_pct         = COALESCE($9, tax_pct),
            invoice_prefix  = COALESCE($10, invoice_prefix),
            quote_prefix    = COALESCE($11, quote_prefix),
            receipt_footer  = COALESCE($12, receipt_footer),
            terms_text      = COALESCE($13, terms_text),
            updated_at      = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      cid,
      name,
      text('tagline', 240),
      text('address', 400),
      text('email', 240),
      text('support_phone', 60),
      text('website', 240),
      currency ? currency.toUpperCase() : currency,
      taxPct,
      text('invoice_prefix', 12),
      text('quote_prefix', 12),
      text('receipt_footer', 500),
      text('terms_text', 4000),
    ]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }
  res.json(withCompanyBranding(rows[0]));
});

// ── POS payment intents (mobile-money status tracking) ────────────────────
//
// A till sale is only finalised once the provider confirms. The intent is
// created first (target_id NULL), polled by the till, and then consumed
// atomically by /checkout. That ordering is what prevents "premature
// completion" and duplicate charges: a second request for the same
// shift/amount/rail while one is live is refused, and a confirmed intent can
// be attached to exactly one sale.

const POS_PAYMENT_METHODS = ['ecocash', 'innbucks', 'omari'] as const;

router.post('/payments/intent', async (req, res) => {
  const me = req.adminUser!;
  const b = req.body || {};
  const amount = round2(num(b.amount));
  const method = str(b.method).toLowerCase();
  if (!POS_PAYMENT_METHODS.includes(method as (typeof POS_PAYMENT_METHODS)[number])) {
    res.status(422).json({ error: 'method must be ecocash, innbucks or omari' });
    return;
  }
  if (!isPesepayRail(method)) {
    res.status(422).json({ error: 'Unsupported payment method' });
    return;
  }
  if (amount <= 0) {
    res.status(422).json({ error: 'A positive amount is required' });
    return;
  }
  const currencyRow = await pool.query('SELECT currency FROM companies WHERE id = $1', [tenantId(req)]);
  const currency = normalizeGatewayCurrency(currencyRow.rows[0]?.currency || 'USD') || 'USD';
  const phone = str(b.phone);
  if ((method === 'ecocash' || method === 'omari') && !/^\+?\d{9,15}$/.test(phone.replace(/[\s-]/g, ''))) {
    res.status(422).json({ error: `A valid ${method === 'ecocash' ? 'EcoCash' : 'O’mari'} number is required` });
    return;
  }

  // Bind the intent to the cashier's open shift so the money can only ever be
  // consumed by a sale in the same shift/tenant.
  let shiftId: string | null = str(b.shiftId) || null;
  if (shiftId) {
    const owned = await pool.query(
      `SELECT id FROM pos_shifts WHERE id = $1 AND company_id = $2 AND status = 'open'`,
      [shiftId, tenantId(req)]
    );
    if (owned.rows.length === 0) {
      res.status(422).json({ error: 'Shift not found or already closed' });
      return;
    }
  } else {
    const open = await pool.query(
      `SELECT id FROM pos_shifts WHERE company_id = $2 AND cashier_id = $1 AND status = 'open' LIMIT 1`,
      [me.id, tenantId(req)]
    );
    shiftId = open.rows[0]?.id ?? null;
  }

  // Duplicate-charge guard.
  const live = await pool.query(
    `SELECT id, reference FROM pesepay_intents
      WHERE tenant_id = $1 AND purpose = 'pos_sale' AND payment_method = $2
        AND ABS(amount - $3) < 0.01 AND status = 'pending'
        AND created_at > NOW() - interval '5 minutes'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId(req), method, amount]
  );
  if (live.rows.length > 0) {
    const row = live.rows[0];
    res.status(409).json({
      error: 'A payment request for this amount is already waiting for approval.',
      code: 'PAYMENT_PENDING',
      intentId: row.id,
      referenceNumber: row.reference,
      statusToken: signPesepayStatusToken(row.id, row.reference),
    });
    return;
  }

  const reference = `PREYONE-POS-${crypto.randomUUID().substring(0, 8).toUpperCase()}-${Date.now()}`;
  const reason = `POS sale · ${req.company?.name || 'Preyone'} · ${reference}`;

  const intentRes = await pool.query(
    `INSERT INTO pesepay_intents
       (reference, tenant_id, amount, currency, payment_method, purpose, reason_for_payment,
        target_type, shift_id, client_name, client_phone)
     VALUES ($1,$2,$3,$4,$5,'pos_sale',$6,'shift',$7,$8,$9)
     RETURNING id`,
    [reference, tenantId(req), amount, currency, method, reason, shiftId, str(b.customerName) || null, phone || null]
  );
  const intentId = intentRes.rows[0].id as string;

  const gateway = await initiatePesepayPayment({
    amount,
    currencyCode: currency,
    paymentMethod: method,
    reasonForPayment: reason,
    reference,
    phone: phone || undefined,
    email: str(req.adminUser?.email) || undefined,
    fullName: str(b.customerName) || req.adminUser?.fullName,
  });

  if (!gateway.success) {
    await pool.query(
      `UPDATE pesepay_intents SET status = 'failed', failure_reason = $2 WHERE id = $1`,
      [intentId, gateway.error || 'The payment provider declined the request']
    );
    res.status(400).json({ error: gateway.error || 'Could not start the payment request', referenceNumber: reference });
    return;
  }

  await pool.query(
    `UPDATE pesepay_intents SET provider_reference = $2, redirect_url = $3, poll_url = $4 WHERE id = $1`,
    [intentId, gateway.referenceNumber || null, gateway.redirectUrl || null, gateway.pollUrl || null]
  );

  res.status(201).json({
    success: true,
    intentId,
    statusToken: signPesepayStatusToken(intentId, reference),
    referenceNumber: reference,
    providerReference: gateway.referenceNumber || reference,
    amount,
    currency,
    method,
    instructions: gateway.instructions,
    shiftId,
  });
});

router.get('/payments/:intentId/status', async (req, res) => {
  const intentId = req.params.intentId;
  if (!UUID_RE.test(intentId)) {
    res.status(400).json({ error: 'Invalid payment id' });
    return;
  }
  const load = () =>
    pool.query(
      `SELECT id, reference, provider_reference, amount, currency, payment_method, purpose,
              status, created_at, completed_at, failure_reason, last_checked_at, check_count,
              target_id, shift_id
         FROM pesepay_intents
        WHERE id = $1 AND tenant_id = $2`,
      [intentId, tenantId(req)]
    );

  let { rows } = await load();
  if (rows.length === 0) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  let intent = rows[0];

  if (intent.status === 'pending') {
    const last = intent.last_checked_at ? new Date(intent.last_checked_at).getTime() : 0;
    if (Date.now() - last >= 3_500) {
      await reconcilePesepayIntentById(intentId);
      ({ rows } = await load());
      intent = rows[0];
    }
  }

  res.json({
    intentId: intent.id,
    status:
      intent.status === 'completed' ? 'SUCCESS' : intent.status === 'failed' ? 'FAILED' : 'PENDING',
    state:
      intent.status === 'completed'
        ? 'SUCCESS'
        : intent.status === 'failed'
          ? 'FAILED'
          : intent.check_count > 0
            ? 'PROCESSING'
            : 'PENDING',
    label:
      intent.status === 'completed'
        ? 'Payment confirmed'
        : intent.status === 'failed'
          ? 'Payment not completed'
          : intent.check_count > 0
            ? 'Waiting for the payer to approve'
            : 'Payment request sent',
    failureReason: intent.failure_reason || null,
    referenceNumber: intent.provider_reference || intent.reference,
    amount: Number(intent.amount),
    currency: intent.currency,
    method: intent.payment_method,
    createdAt: intent.created_at,
    completedAt: intent.completed_at,
    attachedDocumentId: intent.target_id,
    shiftId: intent.shift_id,
  });
});

router.post('/payments/:intentId/cancel', async (req, res) => {
  const intentId = req.params.intentId;
  if (!UUID_RE.test(intentId)) {
    res.status(400).json({ error: 'Invalid payment id' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT id, status FROM pesepay_intents WHERE id = $1 AND tenant_id = $2`,
    [intentId, tenantId(req)]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  if (rows[0].status === 'completed') {
    res.json({ status: 'SUCCESS' });
    return;
  }
  await pool.query(
    `UPDATE pesepay_intents
        SET status = 'failed', failure_reason = 'Cancelled at the till'
      WHERE id = $1 AND status = 'pending'`,
    [intentId]
  );
  res.json({ status: 'FAILED' });
});

// Confirmed mobile-money payments that were never attached to a sale (the
// browser/till closed before "Complete sale"). Manager/CEO can recover them.
router.get('/payments/credits', requireRole(...MANAGER_ROLES), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, reference, provider_reference, amount, currency, payment_method,
            client_name, client_phone, completed_at, shift_id
       FROM pesepay_intents
      WHERE tenant_id = $1 AND purpose = 'pos_sale' AND status = 'completed'
        AND target_id IS NULL
        AND completed_at > NOW() - interval '7 days'
      ORDER BY completed_at DESC
      LIMIT 50`,
    [tenantId(req)]
  );
  res.json(
    rows.map((r) => ({
      intentId: r.id,
      reference: r.provider_reference || r.reference,
      amount: Number(r.amount),
      currency: r.currency,
      method: r.payment_method,
      customerName: r.client_name,
      customerPhone: r.client_phone,
      completedAt: r.completed_at,
      shiftId: r.shift_id,
    }))
  );
});

router.get('/company/subscriptions', (req, res) => {
  res.json({
    company: { id: req.company!.id, name: req.company!.name },
    plan_type: req.company!.plan_type ?? null,
    plan_name: req.company!.plan_name ?? null,
    plan_tier: req.company!.plan_name ?? req.company!.plan_tier ?? null,
    modules: req.company!.modules,
    subscription_status: req.company!.subscription_status ?? null,
  });
});

// ── Theme + catalogue (invoicing workspace & POS theming) ────────────
//
// The merchant picks one of the 20 seeded palettes; every surface derives its
// surfaces, borders and readable ink from it. Returning the variables (not just
// the hex values) is what lets the POS, invoice and IoT SPAs share one contract.
//
// Document-number prefixes. Declared before DOC_TYPE_CATALOGUE: that catalogue
// is a top-level initializer, so referencing this const from further down the
// module hit the temporal dead zone and took the whole POS router down at import.
const DOC_PREFIX: Record<string, string> = {
  sale: 'RCP',
  invoice: 'INV',
  tax_invoice: 'TAX',
  proforma: 'PRO',
  receipt: 'REC',
  sales_receipt: 'SR',
  cash_receipt: 'CR',
  quote: 'QUO',
  quotation: 'QUO',
  estimate: 'EST',
  credit_memo: 'CM',
  credit_note: 'CN',
  purchase_order: 'PO',
  delivery_note: 'DN',
};

const DOC_TYPE_CATALOGUE = INVOICE_DOCUMENT_TYPES.map((t) => ({
  type: t.type,
  label: t.label,
  prefix: DOC_PREFIX[t.type] ?? t.prefix,
  ar: t.ar,
  credit: t.credit,
}));

/**
 * pos_themes stores the palette as `*_color` columns. `primary` is a reserved
 * word in PostgreSQL, so selecting it unquoted (or aliasing it unquoted) is a
 * syntax error — which is exactly how `GET /api/pos/theme` 500'd in production
 * and blocked the invoice workspace from booting. Always map the real columns.
 */
function mapThemeRow(row: any): PosTheme {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    primary: row.primary_color,
    secondary: row.secondary_color,
    accent: row.accent_color,
    bg: row.bg_color,
    text: row.text_color,
  };
}

const THEME_COLUMNS =
  'id, name, description, primary_color, secondary_color, accent_color, bg_color, text_color';

async function loadThemeRow(_companyId: string, themeId?: number | null): Promise<PosTheme> {
  try {
    const { rows } = await pool.query(
      `SELECT ${THEME_COLUMNS}
         FROM pos_themes
        WHERE is_active AND ($1::int IS NULL OR id = $1)
        ORDER BY id
        LIMIT 1`,
      [themeId ?? null]
    );
    if (rows.length > 0) return mapThemeRow(rows[0]);
  } catch {
    // Pre-v3.2 database: pos_themes does not exist yet. Fall through to the
    // static mirror so the till still renders the house palette.
  }
  return POS_THEMES.find((t) => t.id === themeId) ?? POS_THEMES[0];
}

async function resolveCompanyTheme(companyId: string) {
  let themeId = 1;
  try {
    const { rows } = await pool.query(
      `SELECT pos_theme_id FROM companies WHERE id = $1`,
      [companyId]
    );
    themeId = Number(rows[0]?.pos_theme_id) || 1;
  } catch {
    /* companies.pos_theme_id not migrated yet */
  }
  return loadThemeRow(companyId, themeId);
}

router.get('/theme', async (req, res) => {
  // The palette is cosmetic: a theme lookup must never take the whole workspace
  // down (the invoice SPA and the till both boot through this endpoint).
  let theme: PosTheme;
  try {
    theme = await resolveCompanyTheme(tenantId(req));
  } catch {
    theme = POS_THEMES[0];
  }
  res.json({ theme, css: themeCssVariables(theme), cssBlock: themeCssBlock(theme) });
});

router.patch('/theme', requireRole(...MANAGER_ROLES), async (req, res) => {
  const themeId = num(req.body?.themeId);
  if (!Number.isInteger(themeId) || themeId < 1 || themeId > 20) {
    res.status(422).json({ error: 'themeId must be between 1 and 20' });
    return;
  }
  await pool.query(
    `UPDATE companies SET pos_theme_id = $1, updated_at = NOW() WHERE id = $2`,
    [themeId, tenantId(req)]
  );
  const theme = await loadThemeRow(tenantId(req), themeId);
  res.json({ theme, css: themeCssVariables(theme as any), cssBlock: themeCssBlock(theme as any) });
});

/**
 * Historical currency totals imported from spreadsheets (currently ZAR).
 * Intentionally separate from accounting_ledger: summing mixed currencies in
 * one P&L figure would be wrong. The invoice workspace shows these on their own
 * currency tab and USD documents remain the source of the USD ledger.
 */
router.get('/legacy-totals', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT currency, sales_total, funds_total, balance_total, source, as_of, metadata, updated_at
       FROM legacy_currency_totals
      WHERE company_id = $1
      ORDER BY currency`,
    [tenantId(req)]
  );
  res.json(rows);
});

router.get('/catalog', async (req, res) => {
  const cid = tenantId(req);
  const [companyRes, templatesRes, themesRes, houseRes] = await Promise.all([
    pool.query(
      // Contact + terms fields feed the A4 document sheet's bill-to block and
      // footer band, so they travel with the catalogue.
      `SELECT id, name, tagline, address, email, support_phone, website, terms_text,
              receipt_footer, logo_url, logo_path, currency, tax_pct, business_profile,
              kds_enabled, table_service_enabled, invoice_template_id, pos_theme_id,
              invoice_prefix, quote_prefix, invoice_settings
         FROM companies WHERE id = $1`,
      [cid]
    ).catch(() =>
      // Pre-v3.2 database: the presentation columns do not exist yet. Return a
      // minimal company so the workspace still opens with house defaults.
      pool.query(
        `SELECT id, name, tagline, logo_path, currency, tax_pct FROM companies WHERE id = $1`,
        [cid]
      )
    ),
    pool.query(
      `SELECT id, name, description, layout, accent_color, show_logo, is_house_only
         FROM invoice_templates WHERE is_active ORDER BY id`
    ).catch(() => ({ rows: [] as any[] })),
    pool.query(
      `SELECT ${THEME_COLUMNS} FROM pos_themes WHERE is_active ORDER BY id`
    ).catch(() => ({ rows: [] as any[] })),
    pool.query('SELECT id FROM companies ORDER BY created_at ASC LIMIT 1').catch(() => ({
      rows: [] as any[],
    })),
  ]);
  const company = withCompanyBranding(companyRes.rows[0] ?? {});
  const isHouseTenant = Boolean(
    houseRes.rows[0]?.id && companyRes.rows[0]?.id === houseRes.rows[0].id
  );
  const allTemplates = templatesRes.rows.length
    ? templatesRes.rows.map((t: any) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        layout: t.layout,
        accentColor: t.accent_color,
        showLogo: t.show_logo,
        houseOnly: Boolean(t.is_house_only),
      }))
    : (await import('../catalog/ecosystem')).INVOICE_TEMPLATES.map((t) => ({
        ...t,
        houseOnly: t.id === 1 || t.id === 20,
      }));
  const templates = allTemplates.filter((t: any) => isHouseTenant || !t.houseOnly);
  const themes = themesRes.rows.length ? themesRes.rows.map(mapThemeRow) : POS_THEMES;
  res.json({
    company,
    templates,
    themes,
    currencies: CURRENCIES,
    documentTypes: DOC_TYPE_CATALOGUE,
    modules: {
      kds: Boolean(company.kds_enabled) || company.business_profile === 'fast_food_qsr',
      tables:
        Boolean(company.table_service_enabled) || company.business_profile === 'restaurant_dine_in',
    },
  });
});

// Merchant-level module switches (QSR KDS routing, dine-in floor plan). Kept
// separate from business_profile so a restaurant can run the till without the
// floor plan (or enable the kitchen screen without re-profiling the business).
router.patch('/company/modules', requireRole(...MANAGER_ROLES), async (req, res) => {
  const cid = tenantId(req);
  const kds = typeof req.body?.kds === 'boolean' ? req.body.kds : null;
  const tables = typeof req.body?.tables === 'boolean' ? req.body.tables : null;
  if (kds === null && tables === null) {
    res.status(422).json({ error: 'Provide kds and/or tables as booleans' });
    return;
  }
  const { rows } = await pool.query(
    `UPDATE companies
        SET kds_enabled = COALESCE($1, kds_enabled),
            table_service_enabled = COALESCE($2, table_service_enabled),
            updated_at = NOW()
      WHERE id = $3
      RETURNING kds_enabled, table_service_enabled`,
    [kds, tables, cid]
  );
  res.json(rows[0]);
});

// Invoicing workspace defaults: which of the 20 PDF templates a tenant's
// documents render with, plus the copy that appears on them. This is separate
// from the admin Global Settings Hub so the invoice SPA can save a template
// without needing a CEO-only `/api/admin/company` PUT.
router.patch('/invoice-settings', requireRole(...MANAGER_ROLES), async (req, res) => {
  const cid = tenantId(req);
  const b = req.body || {};
  const templateId =
    b.templateId === undefined || b.templateId === null ? null : Number(b.templateId);
  if (templateId !== null && (!Number.isInteger(templateId) || templateId < 1 || templateId > 20)) {
    res.status(422).json({ error: 'templateId must be between 1 and 20' });
    return;
  }
  if (templateId !== null) {
    const [tpl, house] = await Promise.all([
      pool.query('SELECT is_house_only FROM invoice_templates WHERE id = $1', [templateId]).catch(() => ({
        rows: [] as any[],
      })),
      pool.query('SELECT id FROM companies ORDER BY created_at ASC LIMIT 1').catch(() => ({
        rows: [] as any[],
      })),
    ]);
    if (tpl.rows[0]?.is_house_only && house.rows[0]?.id !== cid) {
      res.status(422).json({
        error: 'Preyone Classic is the house template and cannot be used by a client company.',
        code: 'HOUSE_TEMPLATE_ONLY',
      });
      return;
    }
  }
  const currency = str(b.currency) ? str(b.currency).toUpperCase() : null;
  const taxPct = b.taxPct === undefined || b.taxPct === null ? null : round2(num(b.taxPct));
  // Motto / tagline is branding copy: managers may edit it even though the
  // legal identity fields stay CEO-only. `undefined` means "leave unchanged";
  // an empty string clears it.
  const tagline = b.tagline === undefined ? null : str(b.tagline).slice(0, 120);
  // Receipt branding lives beside the other invoice settings, under the
  // `receipt` key, so the existing admin configuration is preserved.
  const receiptSettings =
    b.receiptSettings === undefined
      ? null
      : b.receiptSettings && typeof b.receiptSettings === 'object'
        ? (b.receiptSettings as Record<string, unknown>)
        : {};
  const { rows } = await pool.query(
    `UPDATE companies
        SET invoice_template_id = COALESCE($1, invoice_template_id),
            currency            = COALESCE($2, currency),
            tax_pct             = COALESCE($3, tax_pct),
            terms_text          = COALESCE($4, terms_text),
            receipt_footer      = COALESCE($5, receipt_footer),
            invoice_settings    = CASE
              WHEN $6::jsonb IS NULL AND $9::jsonb IS NULL THEN invoice_settings
              ELSE COALESCE(invoice_settings, '{}'::jsonb)
                   || COALESCE($6::jsonb, '{}'::jsonb)
                   || CASE WHEN $9::jsonb IS NULL THEN '{}'::jsonb
                           ELSE jsonb_build_object('receipt', $9::jsonb) END
            END,
            tagline             = COALESCE($7, tagline),
            updated_at          = NOW()
      WHERE id = $8
      RETURNING *`,
    [
      templateId,
      currency,
      taxPct,
      str(b.termsText) || null,
      str(b.footer) || null,
      b.settings === undefined ? null : JSON.stringify(b.settings),
      tagline,
      cid,
      receiptSettings === null ? null : JSON.stringify(receiptSettings),
    ]
  );
  res.json(withCompanyBranding(rows[0] ?? {}));
});

// ── Office-created documents (invoicing workspace) ───────────────────
//
// The till creates documents through /checkout (stock, serials, payments).
// Office work is different: a draft invoice or quote has no shift, no stock
// movement and no money yet. This endpoint persists any of the 12 document
// types with line items, FX and template, and never touches inventory.
router.post('/documents', async (req, res) => {
  const blocked = invoiceBlock(req.company!);
  if (blocked) {
    res.status(403).json(blocked);
    return;
  }
  const b = req.body || {};
  const cid = tenantId(req);
  const docType = str(b.docType);
  if (!(ALL_DOCUMENT_TYPES as readonly string[]).includes(docType) || docType === 'sale') {
    res.status(422).json({
      error: `docType must be one of: ${INVOICE_DOCUMENT_TYPES.map((t) => t.type).join(', ')}`,
    });
    return;
  }

  const requestedNumber = normalizeDocNumber(b.docNumber);
  if (requestedNumber.error) {
    res.status(422).json({ error: requestedNumber.error });
    return;
  }

  const rawItems = Array.isArray(b.items) ? b.items : [];
  const items = rawItems
    .map((it: any) => ({
      description: str(it?.description),
      details: normalizeDetails(it?.details),
      price: round2(num(it?.price)),
      qty: round2(num(it?.qty)) || 1,
      productId: str(it?.productId) || null,
    }))
    .filter((it: any) => it.description.length > 0);
  if (items.length === 0) {
    res.status(422).json({ error: 'At least one line item with a description is required' });
    return;
  }

  const { rows: compRows } = await pool.query(
    `SELECT currency, tax_pct, invoice_template_id, name FROM companies WHERE id = $1`,
    [cid]
  );
  const company = compRows[0] ?? {};
  const currency = (str(b.currency) || str(company.currency) || 'USD').toUpperCase();
  const exchangeRate = num(b.exchangeRate) > 0 ? num(b.exchangeRate) : 1;
  const discountPct = num(b.discountPct);
  const taxPct = b.taxPct === undefined || b.taxPct === null ? num(company.tax_pct) : num(b.taxPct);

  const { lines, subtotal, taxAmount, total } = computeTotals(items as any, discountPct, taxPct);
  const credit = docType === 'credit_memo' || docType === 'credit_note';
  const signedTotal = credit ? -Math.abs(total) : total;

  const status = ['draft', 'sent'].includes(str(b.status))
    ? str(b.status)
    : ['quote', 'estimate', 'proforma'].includes(docType)
      ? 'sent'
      : 'draft';

  const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(str(b.issueDate)) ? str(b.issueDate) : null;
  const dueDate =
    /^\d{4}-\d{2}-\d{2}$/.test(str(b.dueDate))
      ? str(b.dueDate)
      : issueDate && ['invoice', 'tax_invoice', 'proforma', 'sales_receipt'].includes(docType)
        ? null // computed in SQL as issue + net days
        : null;
  const netDays = Number.isFinite(Number(b.netDays)) ? Math.max(0, Math.min(365, Number(b.netDays))) : 30;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let customerId = str(b.customerId) || null;
    if (!customerId && b.customer && typeof b.customer === 'object') {
      customerId = await upsertCustomer(client, cid, b.customer);
    }
    if (customerId) {
      const owned = await client.query(
        'SELECT 1 FROM pos_customers WHERE id = $1 AND company_id = $2',
        [customerId, cid]
      );
      if (owned.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'Customer not found for this company.' });
        return;
      }
    }

    if (requestedNumber.number) {
      const duplicate = await client.query(
        'SELECT 1 FROM pos_documents WHERE doc_number = $1',
        [requestedNumber.number]
      );
      if (duplicate.rows.length > 0) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: `Document number ${requestedNumber.number} is already in use. Choose another number.`,
          code: 'DOC_NUMBER_TAKEN',
        });
        return;
      }
    }

    const seq = await client.query(`SELECT nextval('pos_doc_number_seq') AS v`);
    const docNumber =
      requestedNumber.number ?? `${DOC_PREFIX[docType]}-${String(seq.rows[0].v).padStart(4, '0')}`;
    const templateId = num(b.templateId) || num(company.invoice_template_id) || null;

    const inserted = await client.query(
      `INSERT INTO pos_documents
         (doc_number, doc_type, channel, status, customer_id, cashier_id, issue_date, due_date,
          subtotal, discount_pct, tax_pct, total, amount_paid, notes, company_id,
          currency, exchange_rate, template_id, doc_meta)
       VALUES ($1,$2,'office',$3,$4,$5,
               COALESCE($6::date, CURRENT_DATE),
               COALESCE($7::date, COALESCE($6::date, CURRENT_DATE) + ($8::int * INTERVAL '1 day')),
               $9,$10,$11,$12,0,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        docNumber,
        docType,
        status,
        customerId,
        req.adminUser!.id,
        issueDate,
        dueDate,
        netDays,
        subtotal,
        round2(discountPct),
        round2(taxPct),
        signedTotal,
        str(b.notes) || null,
        cid,
        currency,
        exchangeRate,
        templateId,
        JSON.stringify({
          taxAmount,
          netDays,
          credit,
          poNumber: str(b.poNumber) || null,
          reference: str(b.reference) || null,
        }),
      ]
    );
    const verified = await client.query(
      `UPDATE pos_documents SET verify_code = $1 WHERE id = $2 RETURNING *`,
      [generateDocumentVerifyCode(), inserted.rows[0].id]
    );
    const doc = verified.rows[0];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.productId) {
        const owned = await client.query(
          'SELECT 1 FROM pos_products WHERE id = $1 AND company_id = $2',
          [line.productId, cid]
        );
        if (owned.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(422).json({ error: 'One of the selected products does not belong to this company.' });
          return;
        }
      }
      await client.query(
        `INSERT INTO pos_document_items (document_id, product_id, description, details, price, qty, line_total, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          doc.id,
          line.productId ?? null,
          line.description,
          line.details ?? [],
          line.price,
          line.qty,
          line.lineTotal,
          line.position,
        ]
      );
    }

    await client.query(
      `INSERT INTO pos_document_events (document_id, company_id, event, detail, actor_id)
       VALUES ($1,$2,'created',$3,$4)`,
      [doc.id, cid, JSON.stringify({ docType, total: signedTotal, currency }), req.adminUser!.id]
    ).catch(() => undefined); // pre-migration databases simply skip the audit row

    await client.query('COMMIT');
    res.status(201).json({ ...doc, items: lines });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((err as { code?: string })?.code === '23505') {
      res.status(409).json({
        error: 'That document number was just taken. Choose another number.',
        code: 'DOC_NUMBER_TAKEN',
      });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
});

/**
 * Edit a document's identity and office metadata. Line items, totals, payments
 * and stock stay untouched: those are financial facts and must go through
 * checkout/payment/void flows so the ledger and inventory stay reconcilable.
 */
router.put('/documents/:id', requireRole(...MANAGER_ROLES), async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT * FROM pos_documents WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, tenantId(req)]
    );
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    const current = found.rows[0];
    if (current.status === 'void') {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'A voided document cannot be edited.' });
      return;
    }

    // Payments are financial facts. Their amount and COGS are already in the
    // ledger, so line items/totals are locked once money has been recorded.
    const paidRow = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS paid
         FROM pos_document_payments WHERE document_id = $1`,
      [current.id]
    );
    const paidTotal = num(paidRow.rows[0]?.paid);
    const editsItems = Array.isArray(b.items);
    if (editsItems && paidTotal > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({
        error:
          'This document has payments recorded, so its items are locked. Issue a credit note or refund instead of changing the items.',
        code: 'DOCUMENT_HAS_PAYMENTS',
      });
      return;
    }

    const patches: string[] = [];
    const values: unknown[] = [];
    const changed: string[] = [];
    const set = (column: string, value: unknown, label: string) => {
      values.push(value);
      patches.push(`${column} = $${values.length}`);
      changed.push(label);
    };

    if ('docNumber' in b) {
      const normalized = normalizeDocNumber(b.docNumber);
      if (normalized.error) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: normalized.error });
        return;
      }
      if (normalized.number && normalized.number !== current.doc_number) {
        const duplicate = await client.query(
          'SELECT 1 FROM pos_documents WHERE doc_number = $1 AND id <> $2',
          [normalized.number, current.id]
        );
        if (duplicate.rows.length > 0) {
          await client.query('ROLLBACK');
          res.status(409).json({
            error: `Document number ${normalized.number} is already in use. Choose another number.`,
            code: 'DOC_NUMBER_TAKEN',
          });
          return;
        }
        set('doc_number', normalized.number, 'docNumber');
      }
    }

    for (const [key, column] of [
      ['issueDate', 'issue_date'],
      ['dueDate', 'due_date'],
    ] as const) {
      if (!(key in b)) continue;
      const value = str(b[key]);
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: `${key} must be YYYY-MM-DD.` });
        return;
      }
      set(column, value || null, key);
    }

    if ('notes' in b) set('notes', str(b.notes) || null, 'notes');

    if ('customerId' in b) {
      const customerId = str(b.customerId) || null;
      if (customerId) {
        const customer = await client.query(
          'SELECT 1 FROM pos_customers WHERE id = $1 AND company_id = $2',
          [customerId, tenantId(req)]
        );
        if (customer.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(422).json({ error: 'Customer not found.' });
          return;
        }
      }
      set('customer_id', customerId, 'customerId');
    } else if (b.customer && typeof b.customer === 'object') {
      // The edit form sends name/email/address/phone directly. A blank name is
      // a walk-in document, not an error: the rest of the document must still
      // save. Existing customer data is only replaced when a name is supplied.
      const customerName = str((b.customer as Record<string, unknown>).name);
      if (customerName) {
        const customerId = await upsertCustomer(
          client,
          tenantId(req),
          b.customer as Record<string, unknown>,
          { replace: true }
        );
        if (!customerId) {
          await client.query('ROLLBACK');
          res.status(422).json({ error: 'Could not save the client details.' });
          return;
        }
        set('customer_id', customerId, 'customer');
      }
    }

    let editedItems = 0;
    let itemTaxAmount: number | null = null;
    if (editsItems) {
      const rawItems = b.items as any[];
      const items = rawItems
        .map((it: any) => ({
          description: str(it?.description),
          details: normalizeDetails(it?.details),
          price: round2(num(it?.price)),
          qty: round2(num(it?.qty)) || 1,
          productId: str(it?.productId) || undefined,
        }))
        .filter((it) => it.description.length > 0);
      if (items.length === 0) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'At least one line item with a description is required.' });
        return;
      }

      const taxPct = 'taxPct' in b ? num(b.taxPct) : num(current.tax_pct);
      const discountPct = 'discountPct' in b ? num(b.discountPct) : num(current.discount_pct);
      const totals = computeTotals(items, discountPct, taxPct);
      itemTaxAmount = totals.taxAmount;
      editedItems = items.length;

      // If this document already moved stock, reverse the old quantities and
      // apply the edited quantities in the same transaction.
      if (current.stock_applied === true) {
        const oldItems = await client.query(
          `SELECT product_id, qty FROM pos_document_items
            WHERE document_id = $1 AND product_id IS NOT NULL`,
          [current.id]
        );
        for (const old of oldItems.rows) {
          await client.query(
            `UPDATE pos_products
                SET stock_qty = stock_qty + $1, updated_at = NOW()
              WHERE id = $2 AND company_id = $3 AND track_stock = TRUE`,
            [num(old.qty), old.product_id, tenantId(req)]
          );
        }
        for (const item of items) {
          if (!item.productId) continue;
          const product = await client.query(
            `SELECT name, track_stock, stock_qty
               FROM pos_products
              WHERE id = $1 AND company_id = $2
              FOR UPDATE`,
            [item.productId, tenantId(req)]
          );
          if (product.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(422).json({ error: 'One of the selected stock items no longer exists.' });
            return;
          }
          if (product.rows[0].track_stock && Number(product.rows[0].stock_qty) < item.qty) {
            await client.query('ROLLBACK');
            res.status(409).json({
              error: `Insufficient stock for ${product.rows[0].name}: have ${Number(product.rows[0].stock_qty)}, need ${item.qty}.`,
              code: 'INSUFFICIENT_STOCK',
            });
            return;
          }
          await client.query(
            `UPDATE pos_products
                SET stock_qty = stock_qty - $1, updated_at = NOW()
              WHERE id = $2 AND company_id = $3 AND track_stock = TRUE`,
            [item.qty, item.productId, tenantId(req)]
          );
        }
      }

      const nextStatus =
        current.status === 'draft'
          ? 'draft'
          : current.status === 'sent'
            ? 'sent'
            : statusForPaid(current.doc_type, totals.total, 0);

      set('subtotal', totals.subtotal, 'items');
      set('discount_pct', round2(discountPct), 'items');
      set('tax_pct', round2(taxPct), 'items');
      set('total', totals.total, 'items');
      set('amount_paid', 0, 'items');
      set('status', nextStatus, 'items');
      if (current.stock_applied === true) {
        set('stock_applied', items.some((item) => !!item.productId), 'stock');
      }

      await client.query('DELETE FROM pos_document_items WHERE document_id = $1', [current.id]);
      for (let index = 0; index < totals.lines.length; index += 1) {
        const line = totals.lines[index] as any;
        if (line.productId) {
          const owned = await client.query(
            'SELECT 1 FROM pos_products WHERE id = $1 AND company_id = $2',
            [line.productId, tenantId(req)]
          );
          if (owned.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(422).json({ error: 'One of the selected products does not belong to this company.' });
            return;
          }
        }
        await client.query(
          `INSERT INTO pos_document_items
             (document_id, product_id, description, details, price, qty, line_total, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            current.id,
            line.productId ?? null,
            line.description,
            line.details ?? [],
            line.price,
            line.qty,
            line.lineTotal,
            index,
          ]
        );
      }
    }

    const metaPatch: Record<string, unknown> = {};
    for (const key of ['poNumber', 'reference', 'netDays'] as const) {
      if (key in b) metaPatch[key] = key === 'netDays' ? num(b[key]) : str(b[key]) || null;
    }
    if (editsItems) {
      metaPatch.taxAmount = itemTaxAmount;
      metaPatch.lastEditedAt = new Date().toISOString();
      metaPatch.lastEditedBy = req.adminUser!.fullName ?? req.adminUser!.email ?? null;
    }
    if (Object.keys(metaPatch).length > 0) {
      values.push(JSON.stringify(metaPatch));
      patches.push(`doc_meta = COALESCE(doc_meta, '{}'::jsonb) || $${values.length}::jsonb`);
      changed.push(...Object.keys(metaPatch));
    }

    if (patches.length === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Nothing to update' });
      return;
    }

    values.push(current.id);
    const updated = await client.query(
      `UPDATE pos_documents SET ${patches.join(', ')}, updated_at = NOW()
        WHERE id = $${values.length} RETURNING *`,
      values
    );

    await client.query(
      `INSERT INTO pos_document_events (document_id, company_id, event, detail, actor_id)
       VALUES ($1,$2,'updated',$3,$4)`,
      [
        current.id,
        tenantId(req),
        JSON.stringify({
          fields: changed,
          from: current.doc_number,
          to: updated.rows[0].doc_number,
          items: editedItems || undefined,
          total: editedItems ? num(updated.rows[0].total) : undefined,
        }),
        req.adminUser!.id,
      ]
    ).catch(() => undefined);

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((err as { code?: string })?.code === '23505') {
      res.status(409).json({
        error: 'That document number was just taken. Choose another number.',
        code: 'DOC_NUMBER_TAKEN',
      });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
});

/**
 * Delete an unused draft. Issued documents keep a permanent audit trail, so
 * anything sent, paid or voided must be voided/credited instead of erased.
 */
router.delete('/documents/:id', requireRole(...MANAGER_ROLES), async (req, res) => {
  const found = await pool.query(
    'SELECT id, doc_number, status, amount_paid FROM pos_documents WHERE id = $1 AND company_id = $2',
    [req.params.id, tenantId(req)]
  );
  if (found.rows.length === 0) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const doc = found.rows[0];
  if (doc.status !== 'draft' || Number(doc.amount_paid) > 0) {
    res.status(409).json({
      error: 'Only drafts with no payments can be deleted. Void the document to preserve the audit trail.',
      code: 'DOC_NOT_DELETABLE',
    });
    return;
  }
  await pool.query('DELETE FROM pos_documents WHERE id = $1 AND company_id = $2', [doc.id, tenantId(req)]);
  await pool
    .query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
       VALUES ($1,$2,'pos.document_delete','document',$3,$4)`,
      [req.adminUser!.id, req.adminUser!.fullName ?? null, doc.id, `Deleted draft ${doc.doc_number}`]
    )
    .catch(() => undefined);
  res.json({ ok: true, deleted: doc.id });
});

// Mark a document as sent (quote/invoice handed to the customer). Idempotent.
router.post('/documents/:id/send', async (req, res) => {
  const blocked = invoiceBlock(req.company!);
  if (blocked) {
    res.status(403).json(blocked);
    return;
  }
  const cid = tenantId(req);
  const { rows } = await pool.query(
    `UPDATE pos_documents
        SET status = CASE WHEN status IN ('draft') THEN 'unpaid' ELSE status END,
            sent_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND status <> 'void'
      RETURNING *`,
    [req.params.id, cid]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  await pool.query(
    `INSERT INTO pos_document_events (document_id, company_id, event, detail, actor_id)
     VALUES ($1,$2,'sent',$3,$4)`,
    [rows[0].id, cid, JSON.stringify({ to: str(req.body?.to) || null }), req.adminUser!.id]
  ).catch(() => undefined);
  res.json(rows[0]);
});

/**
 * E-mail a document PDF to the customer (or any address staff choose).
 *
 * The browser renders the exact preview PDF and posts it as base64; this
 * endpoint only validates the message, attaches the PDF and sends it through
 * the configured SMTP transport. Auth, tenant scoping, a per-minute rate limit,
 * strict address/PDF validation and a size cap keep it safe.
 */
router.post('/documents/:id/email', documentEmailLimiter, async (req, res) => {
  const blocked = invoiceBlock(req.company!);
  if (blocked) {
    res.status(403).json(blocked);
    return;
  }
  const cid = tenantId(req);

  const to = str(req.body?.to).toLowerCase();
  if (!to || to.length > 254 || !/^[^\s@\r\n]+@[^\s@\r\n]+\.[A-Za-z]{2,}$/.test(to)) {
    res.status(422).json({ error: 'Enter a valid recipient e-mail address.' });
    return;
  }

  const rawPdf = typeof req.body?.pdfBase64 === 'string' ? req.body.pdfBase64 : '';
  const base64 = rawPdf.replace(/^data:application\/pdf;base64,/i, '').replace(/\s+/g, '');
  if (!base64) {
    res.status(422).json({ error: 'The document PDF is missing.' });
    return;
  }
  const pdf = Buffer.from(base64, 'base64');
  if (pdf.length === 0) {
    res.status(422).json({ error: 'The document PDF is empty.' });
    return;
  }
  if (pdf.length > 3.5 * 1024 * 1024) {
    res.status(413).json({ error: 'This PDF is too large to e-mail. Download it and share it directly.' });
    return;
  }
  if (pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
    res.status(422).json({ error: 'The attachment is not a valid PDF.' });
    return;
  }

  const message = str(req.body?.message).slice(0, 2000);

  const { rows } = await pool.query(
    `SELECT d.id, d.doc_number, d.doc_type, d.status, d.total, d.amount_paid, d.currency,
            c.name AS company_name, c.email AS company_email,
            c.support_phone AS company_phone, c.website AS company_website,
            cu.name AS customer_name, cu.email AS customer_email
       FROM pos_documents d
       LEFT JOIN companies c ON c.id = d.company_id
       LEFT JOIN pos_customers cu ON cu.id = d.customer_id
      WHERE d.id = $1 AND d.company_id = $2`,
    [req.params.id, cid]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const doc = rows[0];
  if (String(doc.status) === 'void') {
    res.status(409).json({ error: 'Void documents cannot be sent.' });
    return;
  }

  const companyName = str(doc.company_name) || 'Preyone';
  const label = DOCUMENT_LABELS[String(doc.doc_type)] || 'Document';
  const currency = String(doc.currency || 'USD').toUpperCase();
  const fmt = (value: unknown) => `${currency} ${(Number(value) || 0).toFixed(2)}`;
  const total = fmt(doc.total);
  const balance = Math.max((Number(doc.total) || 0) - (Number(doc.amount_paid) || 0), 0);
  const customerName = str(doc.customer_name) || str(doc.customer_email) || 'Customer';
  const subject = `${label} ${doc.doc_number} from ${companyName}`.replace(/[\r\n]+/g, ' ').slice(0, 180);

  const bodyText =
    message ||
    `Dear ${customerName},\n\nPlease find attached ${label} ${doc.doc_number} for ${total}.` +
      (balance > 0 ? ` Balance due: ${fmt(balance)}.` : '') +
      `\n\nKind regards,\n${companyName}`;
  const bodyHtml = escapeHtml(bodyText).replace(/\r?\n/g, '<br/>');
  const contact = [doc.company_phone, doc.company_email, doc.company_website]
    .map((v) => str(v))
    .filter(Boolean)
    .map(escapeHtml)
    .join(' &middot; ');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#eef7f2;font-family:'Segoe UI',Arial,sans-serif;color:#10241c">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #d3e5dc">
    <div style="background:linear-gradient(100deg,#04231a,#047857 55%,#10b981);padding:24px 26px;color:#fff">
      <div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;opacity:.85">${escapeHtml(companyName)}</div>
      <div style="font-size:22px;font-weight:700;margin-top:6px">${escapeHtml(label)} ${escapeHtml(doc.doc_number)}</div>
    </div>
    <div style="padding:24px 26px">
      <div style="font-size:14px;line-height:1.65">${bodyHtml}</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:18px 0">
        <tr><td style="padding:6px 0;color:#536b60">Total</td><td align="right" style="padding:6px 0;font-weight:700">${escapeHtml(total)}</td></tr>
        ${
          balance > 0
            ? `<tr><td style="padding:6px 0;color:#536b60">Balance due</td><td align="right" style="padding:6px 0;font-weight:700;color:#047857">${escapeHtml(fmt(balance))}</td></tr>`
            : ''
        }
      </table>
      <p style="margin:0;color:#536b60;font-size:13px">The ${escapeHtml(label.toLowerCase())} PDF is attached.</p>
    </div>
    <div style="padding:16px 26px;background:#f3faf6;font-size:12px;color:#536b60">
      ${escapeHtml(companyName)}${contact ? ` &middot; ${contact}` : ''}
    </div>
  </div>
</body></html>`;

  const filename = `${String(doc.doc_number || 'document').replace(/[^A-Za-z0-9._-]+/g, '-') || 'document'}.pdf`;
  const rawFrom = String(process.env.SMTP_FROM || '').trim();
  const fromEmail = /<([^>]+)>/.exec(rawFrom)?.[1] || rawFrom || undefined;
  const sent = await sendTransactionalEmail({
    to,
    subject,
    html,
    fromName: companyName,
    fromEmail,
    attachments: [{ filename, content: pdf }],
  }).catch(() => false);

  if (!sent) {
    res.status(502).json({ error: 'The mail service could not send this message. Check SMTP configuration and try again.' });
    return;
  }

  await pool.query(
    `UPDATE pos_documents
        SET status = CASE WHEN status = 'draft' THEN 'unpaid' ELSE status END,
            sent_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND company_id = $2`,
    [doc.id, cid]
  );
  await pool.query(
    `INSERT INTO pos_document_events (document_id, company_id, event, detail, actor_id)
     VALUES ($1,$2,'sent',$3,$4)`,
    [doc.id, cid, JSON.stringify({ to, channel: 'email', label }), req.adminUser!.id]
  ).catch(() => undefined);

  res.json({ ok: true, to, sentAt: new Date().toISOString() });
});

// Append-only document timeline (audit trail for the workspace drawer).
router.get('/documents/:id/events', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.*, u.full_name AS actor_name
       FROM pos_document_events e
       JOIN pos_documents d ON d.id = e.document_id
       LEFT JOIN admin_users u ON u.id = e.actor_id
      WHERE e.document_id = $1 AND d.company_id = $2
      ORDER BY e.created_at DESC`,
    [req.params.id, tenantId(req)]
  );
  res.json(rows);
});

// ── Device registration (Admin only) ─────────────────────────────────
// POST /api/pos/devices/register
// Body: { hardware_serial, device_name, device_type, shop_id }
// Generates 64-char random hardware token; upserts on device_id conflict.
// Tenant-scoped to req.company and gated by the subscription guard
// (plan device cap first, then subscription expiry).
router.post('/devices/register', requireAdminAuth, async (req, res) => {
  const hardwareSerial = str(req.body?.hardware_serial);
  const deviceName = str(req.body?.device_name) || 'Unknown Device';
  const deviceType = str(req.body?.device_type) || 'tablet';
  const shopId = num(req.body?.shop_id) || null;
  if (!hardwareSerial) {
    res.status(422).json({ error: 'hardware_serial is required' }); return;
  }
  if (!['android', 'electron', 'web', 'phone', 'tablet', 'desktop'].includes(deviceType)) {
    res.status(422).json({ error: 'device_type must be android|electron|web|phone|tablet|desktop' }); return;
  }
  // Subscription engine: plan cap, then expiry, before any new registration.
  const companyId = tenantId(req);
  const { rows: existingRows } = await pool.query(
    `SELECT id, company_id FROM pos_devices WHERE device_id = $1`,
    [hardwareSerial]
  );
  // A hardware serial is globally unique. Never hand a tenant a token for a
  // device another tenant already paired: that would let them inherit the
  // other till's identity and skip their own plan cap.
  if (existingRows[0]?.company_id && existingRows[0].company_id !== companyId) {
    res.status(409).json({
      error: 'This device is already paired to another company. Unpair it there first.',
      code: 'DEVICE_ALREADY_PAIRED',
    });
    return;
  }
  if (!(await enforceSubscriptionGuard(res, companyId, existingRows.length > 0))) return;

  const deviceToken = crypto.randomBytes(32).toString('hex'); // 64-char token
  const { rows } = await pool.query(
    `INSERT INTO pos_devices (device_id, device_type, name, shop_id, device_token, status, company_id, paired_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,'active',$6,NOW(),NOW())
     ON CONFLICT (device_id) DO UPDATE SET
       device_type = EXCLUDED.device_type,
       name = EXCLUDED.name,
       shop_id = EXCLUDED.shop_id,
       device_token = EXCLUDED.device_token,
       status = EXCLUDED.status,
       company_id = COALESCE(pos_devices.company_id, EXCLUDED.company_id),
       last_seen = NOW(),
       last_seen_at = NOW(),
       updated_at = NOW()
     RETURNING id, device_id, device_type, name, shop_id, device_token, status, company_id, paired_at`,
    [hardwareSerial, deviceType, deviceName, shopId, deviceToken, companyId]
  );
  const device = rows[0];
  res.json({
    status: 'success',
    device_token: device.device_token,
    company_id: device.company_id,
    shop_id: device.shop_id,
    device_name: device.name,
  });
});

// ── Auto-registration (world-class, Preyone Transit technology) ─────
// POST /api/pos/devices/auto-register
// Called by desktop/Android on first launch. Uses admin JWT for company
// scoping (req.company, the portal tenant). The only cap is the plan's
// max_devices (enforced below). electron is a desktop shell.
// Body: { device_uuid, device_public_key, device_type, device_name, app_version }
// Returns: { device_token, company_id, shop_id, device_name, quota }
const ALLOWED_AUTO_TYPES = ['phone', 'tablet', 'desktop', 'electron'] as const;

function isValidEd25519PublicKey(key: string): boolean {
  // Ed25519 public keys are 32 bytes, base64 or hex encoded (44 or 64 chars)
  if (!key || key.length < 40 || key.length > 128) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(key);
}

router.post('/devices/auto-register', requireAdminAuth, async (req, res) => {
  const deviceUuid = str(req.body?.device_uuid);
  const devicePublicKey = str(req.body?.device_public_key);
  const deviceType = str(req.body?.device_type);
  const deviceName = str(req.body?.device_name) || 'Unknown Device';
  const appVersion = str(req.body?.app_version) || null;
  const shopId = num(req.body?.shop_id) || null;

  // Validate inputs
  if (!deviceUuid || deviceUuid.length < 8 || deviceUuid.length > 64) {
    res.status(422).json({ error: 'device_uuid required (8-64 chars)' }); return;
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(deviceUuid)) {
    res.status(422).json({ error: 'device_uuid must be alphanumeric with . _ : -' }); return;
  }
  if (devicePublicKey && !isValidEd25519PublicKey(devicePublicKey)) {
    res.status(422).json({ error: 'Invalid device_public_key (expected Ed25519, 32 bytes)' }); return;
  }
  if (!ALLOWED_AUTO_TYPES.includes(deviceType as typeof ALLOWED_AUTO_TYPES[number])) {
    res.status(422).json({ error: `device_type must be one of: ${ALLOWED_AUTO_TYPES.join(', ')}` }); return;
  }

  const companyId = tenantId(req);

  // Check if this device_uuid already registered (idempotent re-register)
  const existingDevice = await pool.query(
    `SELECT id, device_id, device_type, status, company_id
       FROM pos_devices WHERE device_uuid = $1 OR device_id = $2`,
    [deviceUuid, deviceUuid]
  );

  // A device identity is owned by exactly one tenant. Reject a re-pair attempt
  // from a different company instead of returning the existing device token.
  const foreignDevice = existingDevice.rows.find(
    (row: { company_id?: string | null }) => row.company_id && row.company_id !== companyId
  );
  if (foreignDevice) {
    res.status(409).json({
      error: 'This device is already paired to another company. Unpair it there first.',
      code: 'DEVICE_ALREADY_PAIRED',
    });
    return;
  }

  // If device exists and is suspended, reject
  if (existingDevice.rows[0]?.status === 'suspended') {
    res.status(403).json({ error: 'This device has been suspended. Contact your administrator.' }); return;
  }

  // Subscription engine: the plan's device cap is the only registration limit.
  if (!(await enforceSubscriptionGuard(res, companyId, existingDevice.rows.length > 0))) return;

  const deviceToken = crypto.randomBytes(32).toString('hex'); // 64-char token

  // Upsert: use device_uuid as the stable identity
  const { rows } = await pool.query(
    `INSERT INTO pos_devices (device_id, device_uuid, device_public_key, device_type, name, shop_id, device_token, status, company_id, app_version, paired_at, last_seen, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,NOW(),NOW(),NOW())
     ON CONFLICT (device_id) DO UPDATE SET
       device_uuid = EXCLUDED.device_uuid,
       device_public_key = COALESCE(EXCLUDED.device_public_key, pos_devices.device_public_key),
       device_type = EXCLUDED.device_type,
       name = EXCLUDED.name,
       shop_id = EXCLUDED.shop_id,
       device_token = EXCLUDED.device_token,
       status = 'active',
       app_version = EXCLUDED.app_version,
       company_id = COALESCE(pos_devices.company_id, EXCLUDED.company_id),
       last_seen = NOW(),
       last_seen_at = NOW(),
       updated_at = NOW()
     RETURNING id, device_id, device_uuid, device_type, name, shop_id, device_token, status, company_id, app_version, paired_at`,
    [deviceUuid, deviceUuid, devicePublicKey || null, deviceType, deviceName, shopId, deviceToken, companyId, appVersion]
  );

  const device = rows[0];

  const cap = await pool.query(
    `SELECT max_devices,
            (SELECT COUNT(*)::int FROM pos_devices WHERE company_id = $1 AND status = 'active') AS active
       FROM companies WHERE id = $1`,
    [companyId]
  );

  res.status(201).json({
    status: 'success',
    device_token: device.device_token,
    company_id: device.company_id,
    shop_id: device.shop_id,
    device_name: device.name,
    device_uuid: device.device_uuid,
    device_type: device.device_type,
    quota: {
      max_devices: Number(cap.rows[0]?.max_devices ?? 0),
      active_devices: Number(cap.rows[0]?.active ?? 0),
    },
  });
});

// ── Device status (authenticated by device token) ───────────────────
// GET /api/pos/devices/mine
// Returns this device's registration status and quota info.
router.get('/devices/mine', requireDeviceAuth, async (req, res) => {
  const device = req.device!;
  const { rows } = await pool.query(
    `SELECT id, device_id, device_uuid, device_type, name, shop_id, status, last_seen_at, paired_at, app_version
       FROM pos_devices WHERE device_token = $1`,
    [device.device_id]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Device not found' }); return;
  }
  const cap = await pool.query(
    `SELECT max_devices,
            (SELECT COUNT(*)::int FROM pos_devices WHERE company_id = $1 AND status = 'active') AS active
       FROM companies WHERE id = $1`,
    [device.company_id]
  );
  res.json({
    device: rows[0],
    quota: {
      max_devices: Number(cap.rows[0]?.max_devices ?? 0),
      active_devices: Number(cap.rows[0]?.active ?? 0),
    },
  });
});

// ── Products ────────────────────────────────────────────────────────

router.get('/products', async (req, res) => {
  const q = str(req.query.q);
  const includeInactive = str(req.query.includeInactive) === '1';
  const params: unknown[] = [tenantId(req)];
  let where = `company_id = $1 ${includeInactive ? '' : 'AND active = TRUE'}`;
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (lower(name) LIKE $${params.length} OR lower(coalesce(description,'')) LIKE $${params.length} OR lower(coalesce(sku,'')) LIKE $${params.length} OR lower(coalesce(barcode,'')) LIKE $${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM pos_products WHERE ${where} ORDER BY name LIMIT 500`,
    params
  );
  res.json(rows);
});

/**
 * Product photo upload.
 *
 * The till sends a browser-resized data URL, so no multipart parser is needed.
 * Files are written under public/images and the returned same-origin path is
 * saved on the product. Each tenant's images are independent; the filename
 * carries the company prefix so support can trace an image back to its shop.
 */
router.post('/products/image', async (req, res) => {
  const dataUrl = typeof req.body?.dataUrl === 'string' ? req.body.dataUrl : '';
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) {
    res.status(422).json({ error: 'Product photo must be a PNG, JPEG or WebP data URL' });
    return;
  }
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (bytes.length === 0) {
    res.status(422).json({ error: 'Product photo is empty' });
    return;
  }
  if (bytes.length > 2 * 1024 * 1024) {
    res.status(413).json({ error: 'Product photo too large — keep it under 2 MB' });
    return;
  }
  const magicOk =
    (ext === 'png' && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (ext === 'jpg' && bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (ext === 'webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!magicOk) {
    res.status(422).json({ error: 'Product photo content does not match its declared image type' });
    return;
  }

  const companyId = tenantId(req);
  const filename = `product-${companyId.slice(0, 8)}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString('hex')}.${ext}`;
  const imagesDir = path.join(__dirname, '..', '..', 'public', 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(path.join(imagesDir, filename), bytes);
  res.json({ imageUrl: `/images/${filename}`, filename, bytes: bytes.length });
});

router.post('/products', async (req, res) => {
  const b = req.body || {};
  const name = str(b.name);
  if (!name) {
    res.status(400).json({ error: 'Product name is required' });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO pos_products (company_id, name, description, sku, barcode, category, price, cost_price, stock_qty, track_stock, low_stock_threshold, image_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      tenantId(req),
      name,
      str(b.description) || null,
      str(b.sku) || null,
      str(b.barcode) || null,
      str(b.category) || null,
      round2(num(b.price)),
      round2(num(b.costPrice)),
      round2(num(b.stockQty)),
      b.trackStock !== false,
      round2(num(b.lowStockThreshold)),
      str(b.imageUrl) || null,
    ]
  );
  await pool
    .query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
       VALUES ($1,$2,'pos.product_create','product',$3,$4)`,
      [req.adminUser!.id, req.adminUser!.fullName ?? null, rows[0].id, `${rows[0].name} · ${rows[0].price}`]
    )
    .catch(() => undefined);
  res.status(201).json(rows[0]);
});

router.put('/products/:id', async (req, res) => {
  const b = req.body || {};
  const fields: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    name: 'name',
    description: 'description',
    sku: 'sku',
    barcode: 'barcode',
    category: 'category',
    price: 'price',
    costPrice: 'cost_price',
    stockQty: 'stock_qty',
    trackStock: 'track_stock',
    lowStockThreshold: 'low_stock_threshold',
    active: 'active',
    imageUrl: 'image_url',
  };
  for (const [key, col] of Object.entries(map)) {
    if (key in b) {
      values.push(key === 'name' ? str(b[key]) || null : key === 'price' || key === 'costPrice' || key === 'stockQty' || key === 'lowStockThreshold' ? round2(num(b[key])) : key === 'trackStock' || key === 'active' ? !!b[key] : str(b[key]) || null);
      fields.push(`${col} = $${values.length}`);
    }
  }
  if (fields.length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }
  values.push(req.params.id, tenantId(req));
  const idIndex = values.length - 1;
  const { rows } = await pool.query(
    `UPDATE pos_products SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${idIndex} AND company_id = $${values.length}
      RETURNING *`,
    values
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  await pool
    .query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
       VALUES ($1,$2,'pos.product_update','product',$3,$4)`,
      [req.adminUser!.id, req.adminUser!.fullName ?? null, rows[0].id, Object.keys(b).join(', ')]
    )
    .catch(() => undefined);
  res.json(rows[0]);
});

router.delete('/products/:id', requireRole(...MANAGER_ROLES), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE pos_products SET active = FALSE, updated_at = NOW()
      WHERE id = $1 AND company_id = $2 RETURNING id, name`,
    [req.params.id, tenantId(req)]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  await pool
    .query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
       VALUES ($1,$2,'pos.product_archive','product',$3,$4)`,
      [req.adminUser!.id, req.adminUser!.fullName ?? null, rows[0].id, `Archived ${rows[0].name}`]
    )
    .catch(() => undefined);
  res.json({ ok: true, archived: rows[0].id });
});

// Stock adjustment (receive goods, corrections)
router.post('/products/:id/stock', async (req, res) => {
  const delta = round2(num(req.body?.delta));
  const reason = str(req.body?.reason) || 'adjustment';
  if (!delta) {
    res.status(400).json({ error: 'Non-zero delta required' });
    return;
  }
  const { rows } = await pool.query(
    `UPDATE pos_products
        SET stock_qty = stock_qty + $1, updated_at = NOW()
      WHERE id = $2 AND company_id = $3
      RETURNING id, name, stock_qty`,
    [delta, req.params.id, tenantId(req)]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  await pool.query(
    `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
     VALUES ($1,$2,'pos.stock_adjust','product',$3,$4)`,
    [req.adminUser!.id, req.adminUser!.fullName ?? null, req.params.id, `${delta > 0 ? '+' : ''}${delta} (${reason})`]
  );
  res.json(rows[0]);
});

// ── Customers ───────────────────────────────────────────────────────

router.get('/customers', async (req, res) => {
  const q = str(req.query.q);
  const params: unknown[] = [tenantId(req)];
  let where = `company_id = $1`;
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (lower(name) LIKE $${params.length} OR lower(coalesce(phone,'')) LIKE $${params.length} OR lower(coalesce(email,'')) LIKE $${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM pos_customers WHERE ${where} ORDER BY name LIMIT 500`,
    params
  );
  res.json(rows);
});

async function upsertCustomer(
  client: import('pg').PoolClient,
  companyId: string,
  c: Record<string, unknown>,
  options: { replace?: boolean } = {}
): Promise<string | null> {
  const name = str(c?.name);
  if (!name) return null;
  const existing = await client.query(
    `SELECT id FROM pos_customers
      WHERE company_id = $1 AND lower(name) = lower($2)
      LIMIT 1`,
    [companyId, name]
  );
  if (existing.rows.length > 0) {
    const replace = options.replace === true;
    // The document editor sends the complete client record, including empty
    // strings for fields the user deliberately cleared. Other callers keep the
    // old COALESCE behaviour so a partial update never wipes data.
    const phoneValue = replace ? `NULLIF($2,'')` : `COALESCE(NULLIF($2,''), phone)`;
    const emailValue = replace ? `NULLIF($3,'')` : `COALESCE(NULLIF($3,''), email)`;
    const addressValue = replace ? `NULLIF($4,'')` : `COALESCE(NULLIF($4,''), address)`;
    await client.query(
      `UPDATE pos_customers
          SET name = $5,
              phone = ${phoneValue},
              email = ${emailValue},
              address = ${addressValue},
              updated_at = NOW()
        WHERE id = $1 AND company_id = $6`,
      [existing.rows[0].id, str(c.phone), str(c.email), str(c.address), name, companyId]
    );
    return existing.rows[0].id as string;
  }
  const inserted = await client.query(
    `INSERT INTO pos_customers (company_id, name, phone, email, address)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [companyId, name, str(c.phone) || null, str(c.email) || null, str(c.address) || null]
  );
  return inserted.rows[0].id as string;
}

router.post('/customers', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const companyId = tenantId(req);
    const id = await upsertCustomer(client, companyId, req.body || {});
    await client.query('COMMIT');
    if (!id) {
      res.status(400).json({ error: 'Customer name is required' });
      return;
    }
    const { rows } = await client.query(
      `SELECT * FROM pos_customers WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );
    await pool
      .query(
        `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
         VALUES ($1,$2,'pos.customer_create','customer',$3,$4)`,
        [req.adminUser!.id, req.adminUser!.fullName ?? null, id, rows[0]?.name ?? '']
      )
      .catch(() => undefined);
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.put('/customers/:id', async (req, res) => {
  const b = req.body || {};
  const fields: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    name: 'name',
    phone: 'phone',
    email: 'email',
    address: 'address',
    notes: 'notes',
  };
  for (const [key, col] of Object.entries(map)) {
    if (key in b) {
      values.push(str(b[key]) || null);
      fields.push(`${col} = $${values.length}`);
    }
  }
  if (fields.length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }
  values.push(req.params.id, tenantId(req));
  const idIndex = values.length - 1;
  const { rows } = await pool.query(
    `UPDATE pos_customers SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${idIndex} AND company_id = $${values.length}
      RETURNING *`,
    values
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  await pool
    .query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
       VALUES ($1,$2,'pos.customer_update','customer',$3,$4)`,
      [req.adminUser!.id, req.adminUser!.fullName ?? null, rows[0].id, Object.keys(b).join(', ')]
    )
    .catch(() => undefined);
  res.json(rows[0]);
});

router.delete('/customers/:id', requireRole(...MANAGER_ROLES), async (req, res) => {
  const cid = tenantId(req);
  const customer = await pool.query(
    'SELECT id, name FROM pos_customers WHERE id = $1 AND company_id = $2',
    [req.params.id, cid]
  );
  if (customer.rows.length === 0) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  // Deleting a referenced customer would null the link on issued documents and
  // erase who they were billed to. Refuse and let the user correct the record.
  const used = await pool.query(
    'SELECT COUNT(*)::int AS n FROM pos_documents WHERE customer_id = $1 AND company_id = $2',
    [req.params.id, cid]
  );
  if (Number(used.rows[0]?.n) > 0) {
    res.status(409).json({
      error: `This customer is attached to ${used.rows[0].n} document(s) and cannot be deleted. Edit the record instead.`,
      code: 'CUSTOMER_IN_USE',
    });
    return;
  }
  await pool.query('DELETE FROM pos_customers WHERE id = $1 AND company_id = $2', [
    req.params.id,
    cid,
  ]);
  await pool
    .query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
       VALUES ($1,$2,'pos.customer_delete','customer',$3,$4)`,
      [req.adminUser!.id, req.adminUser!.fullName ?? null, req.params.id, `Deleted client ${customer.rows[0].name}`]
    )
    .catch(() => undefined);
  res.json({ ok: true, deleted: req.params.id });
});

// Credit statement: documents + payments for one customer (admin console)
router.get('/customers/:id/statement', async (req, res) => {
  const cust = await pool.query(
    `SELECT id, name, phone, email, address, created_at
       FROM pos_customers WHERE id = $1 AND company_id = $2`,
    [req.params.id, tenantId(req)]
  );
  if (cust.rows.length === 0) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  const docs = await pool.query(
    `SELECT id, doc_number, doc_type, status, issue_date, due_date, total, amount_paid,
            ROUND(total - amount_paid, 2) AS balance, created_at
       FROM pos_documents
      WHERE company_id = $2 AND customer_id = $1
      ORDER BY created_at DESC`,
    [req.params.id, tenantId(req)]
  );
  const payments = await pool.query(
    `SELECT p.paid_at, p.amount, p.method, p.reference, d.doc_number
       FROM pos_document_payments p
       JOIN pos_documents d ON d.id = p.document_id
      WHERE d.company_id = $2 AND d.customer_id = $1 AND p.paid_at IS NOT NULL
      ORDER BY p.paid_at DESC LIMIT 200`,
    [req.params.id, tenantId(req)]
  );
  const totalBalance = docs.rows
    .filter((r) => r.status !== 'void')
    .reduce((s, r) => s + Number(r.balance), 0);
  res.json({
    customer: cust.rows[0],
    documents: docs.rows,
    payments: payments.rows,
    totalBalance: Math.round(totalBalance * 100) / 100,
  });
});

// ── Shifts ──────────────────────────────────────────────────────────

async function getOpenShift(cashierId: string, companyId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM pos_shifts WHERE company_id = $2 AND cashier_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1`,
    [cashierId, companyId]
  );
  return rows[0] || null;
}

router.get('/shifts/current', async (req, res) => {
  const shift = await getOpenShift(req.adminUser!.id, tenantId(req));
  if (!shift) {
    res.json(null);
    return;
  }
  const sums = await pool.query(
    `SELECT method, SUM(amount) AS total, COUNT(*) AS count
       FROM pos_document_payments
      WHERE shift_id = $1
      GROUP BY method`,
    [shift.id]
  );
  res.json({ shift, totalsByMethod: sums.rows });
});

router.post('/shifts/open', async (req, res) => {
  const existing = await getOpenShift(req.adminUser!.id, tenantId(req));
  if (existing) {
    res.status(409).json({ error: 'You already have an open shift', shift: existing });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO pos_shifts (cashier_id, opening_float, company_id) VALUES ($1,$2,$3) RETURNING *`,
    [req.adminUser!.id, round2(num(req.body?.openingFloat)), tenantId(req)]
  );
  res.status(201).json(rows[0]);
});

router.post('/shifts/close', async (req, res) => {
  const cid = tenantId(req);
  const me = req.adminUser!;
  const shift = await getOpenShift(me.id, cid);
  if (!shift) {
    res.status(400).json({ error: 'No open shift to close' });
    return;
  }
  const counted = round2(num(req.body?.countedCash));
  const notes = str(req.body?.notes);
  const sums = await pool.query(
    `SELECT method, SUM(amount) AS total, COUNT(*) AS count
       FROM pos_document_payments
      WHERE shift_id = $1
      GROUP BY method ORDER BY method`,
    [shift.id]
  );
  const cashRow = sums.rows.find((r: Record<string, unknown>) => r.method === 'cash');
  const expectedCash = round2(num(shift.opening_float) + num(cashRow ? cashRow.total : 0));
  const variance = round2(counted - expectedCash);
  const closedAt = new Date();
  const companyRow = await pool.query('SELECT name, currency FROM companies WHERE id = $1', [cid]);
  const currency = String(companyRow.rows[0]?.currency || 'USD').toUpperCase();

  const snapshot = {
    shift_id: shift.id,
    cashier_id: me.id,
    cashier_name: me.fullName || me.email,
    opened_at: shift.opened_at,
    closed_at: closedAt.toISOString(),
    opening_float: round2(num(shift.opening_float)),
    expected_cash: expectedCash,
    counted_cash: counted,
    variance,
    notes: notes || null,
    currency,
    totals_by_method: sums.rows.map((row: Record<string, unknown>) => ({
      method: String(row.method ?? 'other'),
      total: round2(num(row.total)),
      count: Number(row.count) || 0,
    })),
  };

  const { rows } = await pool.query(
    `UPDATE pos_shifts
        SET closed_at = $7, status = 'closed',
            expected_cash = $3, counted_cash = $4, variance = $5, notes = $6,
            close_snapshot = $8::jsonb
      WHERE id = $1 AND company_id = $2
      RETURNING *`,
    [shift.id, cid, expectedCash, counted, variance, notes, closedAt, JSON.stringify(snapshot)]
  );

  // Proof of tender goes to the cashier who closed and to every tenant
  // CEO/Manager. These are the only people allowed to reconcile the drawer;
  // the house tenant is never copied into a client's cash-up.
  const recipients = await pool.query(
    `SELECT DISTINCT email, full_name, role
       FROM admin_users
      WHERE portal_company_id = $1
        AND approved = TRUE
        AND email IS NOT NULL AND email <> ''
        AND (id = $2 OR role IN ('CEO', 'Manager'))
      ORDER BY role, full_name`,
    [cid, me.id]
  );
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const row of recipients.rows) {
    const email = String(row.email).toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    emails.push(String(row.email));
  }

  let sentCount = 0;
  for (const email of emails) {
    const sent = await sendShiftCloseEmail({
      to: email,
      storeName: String(companyRow.rows[0]?.name || req.company!.name || 'Preyone'),
      cashierName: me.fullName || me.email,
      openedAt: shift.opened_at,
      closedAt,
      openingFloat: round2(num(shift.opening_float)),
      expectedCash,
      countedCash: counted,
      variance,
      currency,
      totalsByMethod: snapshot.totals_by_method,
      notes: notes || null,
      shiftId: shift.id,
    }).catch(() => false);
    if (sent) sentCount += 1;
  }

  if (sentCount > 0) {
    await pool.query(
      `UPDATE pos_shifts
          SET close_receipt_recipients = $3::text[], close_receipt_sent_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [shift.id, cid, emails]
    );
  }

  await pool.query(
    `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
     VALUES ($1,$2,'pos.shift_close','shift',$3,$4)`,
    [
      me.id,
      me.fullName ?? null,
      shift.id,
      `Counted ${currency} ${counted.toFixed(2)} · expected ${currency} ${expectedCash.toFixed(
        2
      )} · variance ${currency} ${variance.toFixed(2)} · proof emails ${sentCount}/${emails.length}`,
    ]
  ).catch(() => undefined);

  res.json({
    shift: {
      ...rows[0],
      close_snapshot: snapshot,
      close_receipt_recipients: sentCount > 0 ? emails : rows[0].close_receipt_recipients,
      close_receipt_sent_at: sentCount > 0 ? new Date().toISOString() : rows[0].close_receipt_sent_at,
    },
    totalsByMethod: sums.rows,
    receipt_email_sent: sentCount > 0,
    receipt_recipients: emails,
  });
});

/** A single closed-shift record with its immutable cash-up snapshot. */
router.get('/shifts/:id/report', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, u.full_name AS cashier_name, u.email AS cashier_email
       FROM pos_shifts s
       LEFT JOIN admin_users u ON u.id = s.cashier_id
      WHERE s.id = $1 AND s.company_id = $2`,
    [req.params.id, tenantId(req)]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Shift not found' });
    return;
  }
  res.json(rows[0]);
});

// Cash drawer audit: every drawer-kick event is recorded against the shift
// with the exact ESC/POS command bytes that open the drawer, so an auditor can
// reconcile drawer events with shift records. The PIN-session admin (loaded by
// requireAdminAuth at router level) is the author.
router.post('/shifts/drawer-audit', async (req, res) => {
  const rawEvent = str(req.body?.event);
  const event = ['open', 'close', 'test'].includes(rawEvent) ? rawEvent : 'close';
  const shiftId = str(req.body?.shiftId) || null;
  await pool.query(
    `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
     VALUES ($1,$2,'pos.drawer_kick','shift',$3,$4)`,
    [
      req.adminUser!.id,
      req.adminUser!.fullName ?? null,
      shiftId,
      `ESC/POS drawer kick \\x1B\\x70\\x00\\x19\\xFA (${event})`,
    ]
  );
  res.json({ ok: true, event, command: '\\x1B\\x70\\x00\\x19\\xFA' });
});

router.get('/shifts', async (req, res) => {
  const all = str(req.query.all) === '1' && MANAGER_ROLES.includes(req.adminUser!.role);
  // Managers still only see their own company's shifts: "all" widens from
  // this cashier to every cashier, never to another tenant.
  const { rows } = await pool.query(
    `SELECT s.*, u.full_name AS cashier_name
       FROM pos_shifts s LEFT JOIN admin_users u ON u.id = s.cashier_id
      WHERE s.company_id = $1 ${all ? '' : 'AND s.cashier_id = $2'}
      ORDER BY s.opened_at DESC LIMIT 100`,
    all ? [tenantId(req)] : [tenantId(req), req.adminUser!.id]
  );
  res.json(rows);
});

// ── Checkout / documents ────────────────────────────────────────────

interface CartItemInput {
  productId?: string;
  description?: string;
  details?: string[] | string;
  price?: number | string;
  qty?: number | string;
}

export function computeTotals(items: CartItemInput[], discountPct: number, taxPct: number) {
  let subtotal = 0;
  const lines = items.map((it, index) => {
    const price = round2(num(it.price));
    const qty = round2(num(it.qty)) || 1;
    const lineTotal = round2(price * qty);
    subtotal += lineTotal;
    return { ...it, price, qty, lineTotal, position: index };
  });
  subtotal = round2(subtotal);
  const discountAmount = round2((subtotal * round2(discountPct)) / 100);
  const taxAmount = round2(((subtotal - discountAmount) * round2(taxPct)) / (100 + round2(taxPct)));
  const total = round2(subtotal - discountAmount);
  return { lines, subtotal, discountAmount, taxAmount, total };
}

const DOC_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;

/**
 * A document number is optional: blank means "use the next sequence value".
 * Anything supplied must stay URL/file-safe because it becomes the PDF and
 * UBL XML filename on the client.
 */
/**
 * Normalise a line's detail bullets from either a string (one per line / bullet
 * separated) or an array. Order is preserved, duplicates are dropped and the
 * list is capped so a pathological payload cannot push a document off the A4.
 */
function normalizeDetails(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n|\u2022|\u00b7|\u25aa|\u25e6/)
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const text = String(entry ?? '')
      .replace(/^\s*(?:[-\u2013\u2014*]|\d+[.)])\s*/, '')
      .trim()
      .slice(0, 1000);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    // Long product specs routinely exceed 20 bullets. Do not silently drop
    // the user's edits beyond the old arbitrary cap.
    if (out.length >= 100) break;
  }
  return out;
}

function normalizeDocNumber(value: unknown): { number?: string; error?: string } {
  const raw = str(value);
  if (!raw) return {};
  if (!DOC_NUMBER_RE.test(raw)) {
    return {
      error:
        'Document number must start with a letter or digit and may only contain letters, digits, dots, dashes, underscores or slashes (max 40 characters).',
    };
  }
  return { number: raw };
}

export function statusForPaid(docType: string, total: number, paid: number): string {
  if (total > 0 && paid >= total - 0.005) return 'paid';
  if (paid > 0) return 'partial';
  return docType === 'quotation' ? 'sent' : 'unpaid';
}

router.get('/documents', async (req, res) => {
  const params: unknown[] = [];
  const where: string[] = [];
  // Tenant predicate is always the first condition, so it cannot be dropped by
  // any of the optional filters below.
  params.push(tenantId(req));
  where.push(`d.company_id = $${params.length}`);
  const type = str(req.query.type);
  const status = str(req.query.status);
  const q = str(req.query.q);
  if (type) {
    // The till has always called a quote "quotation"; the office workspace
    // stores it as "quote". Treat the two names as one family so a document
    // never disappears from the history just because of its label.
    const family: Record<string, string[]> = {
      quote: ['quote', 'quotation'],
      quotation: ['quotation', 'quote'],
      receipt: ['receipt', 'sales_receipt', 'cash_receipt'],
      credit: ['credit_note', 'credit_memo'],
    };
    params.push(family[type] ?? [type]);
    where.push(`d.doc_type = ANY($${params.length}::text[])`);
  }
  if (status) {
    params.push(status);
    where.push(`d.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(
      `(lower(d.doc_number) LIKE $${params.length}
        OR lower(coalesce(d.verify_code,'')) LIKE $${params.length}
        OR lower(coalesce(c.name,'')) LIKE $${params.length})`
    );
  }
  const from = str(req.query.from);
  const to = str(req.query.to);
  if (from) {
    params.push(from);
    where.push(`d.created_at >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`d.created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  const cashier = str(req.query.cashier);
  if (cashier) {
    params.push(cashier);
    where.push(`d.cashier_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(parseInt(str(req.query.limit) || '100', 10) || 100, 1), 500));
  const limitIdx = params.length;
  const { rows } = await pool.query(
    `SELECT d.*, c.name AS customer_name, u.full_name AS cashier_name,
            (SELECT COUNT(*) FROM pos_document_items i WHERE i.document_id = d.id) AS item_count
       FROM pos_documents d
       LEFT JOIN pos_customers c ON c.id = d.customer_id
       LEFT JOIN admin_users u ON u.id = d.cashier_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.created_at DESC
      LIMIT $${limitIdx}`,
    params
  );
  res.json(rows);
});

router.get('/documents/:id', async (req, res) => {
  // Scoped by company: a document belonging to another tenant is reported as
  // missing rather than forbidden, so the endpoint cannot be used to probe
  // which document UUIDs exist.
  const doc = await pool.query(
    `SELECT d.*, c.name AS customer_name
       FROM pos_documents d
       LEFT JOIN pos_customers c ON c.id = d.customer_id AND c.company_id = d.company_id
      WHERE d.id = $1 AND d.company_id = $2`,
    [req.params.id, tenantId(req)]
  );
  if (doc.rows.length === 0) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const items = await pool.query(
    `SELECT i.*, p.name AS product_name FROM pos_document_items i
      LEFT JOIN pos_products p ON p.id = i.product_id
     WHERE i.document_id = $1 ORDER BY i.position`,
    [req.params.id]
  );
  const pays = await pool.query(
    `SELECT * FROM pos_document_payments WHERE document_id = $1 ORDER BY paid_at`,
    [req.params.id]
  );
  const customer = doc.rows[0].customer_id
    ? await pool.query(
        `SELECT * FROM pos_customers WHERE id = $1 AND company_id = $2`,
        [doc.rows[0].customer_id, tenantId(req)]
      )
    : { rows: [] };
  res.json({ ...doc.rows[0], items: items.rows, payments: pays.rows, customer: customer.rows[0] || null });
});

/**
 * Normalise a company-configured document prefix for the shared numbering
 * series. The Settings hub stores `INV` (no trailing dash), but legacy rows may
 * still carry `INV-`. Both must resolve to a single, clean `INV`.
 */
function normaliseDocPrefix(value: unknown, fallback: string): string {
  const cleaned = str(value)
    .replace(/[^A-Za-z0-9._/-]+/g, '')
    .replace(/[-/._]+$/, '');
  return cleaned || fallback;
}

// One-click quotation/sale → invoice conversion. Only a non-voided quotation
// or sale owned by this tenant can be converted; the doc_number is re-issued
// from the shared sequence so the UNIQUE constraint keeps holding.
router.post('/documents/:id/convert-to-invoice', async (req, res) => {
  const blocked = invoiceBlock(req.company!);
  if (blocked) {
    res.status(403).json(blocked);
    return;
  }
  const doc = await pool.query(
    `SELECT id, doc_type, status FROM pos_documents
      WHERE id = $1 AND company_id = $2
        AND doc_type IN ('quotation', 'quote', 'estimate', 'proforma', 'sale')
        AND status <> 'void'`,
    [req.params.id, tenantId(req)]
  );
  if (doc.rows.length === 0) {
    res.status(404).json({ error: 'Quotation or sale not found' });
    return;
  }
  const seq = await pool.query(`SELECT nextval('pos_doc_number_seq') AS v`);
  const docNumber = `INV-${String(seq.rows[0].v).padStart(4, '0')}`;
  const updated = await pool.query(
    `UPDATE pos_documents
        SET doc_type = 'invoice',
            doc_number = $1,
            status = CASE WHEN status IN ('sent','draft') THEN 'unpaid' ELSE status END
      WHERE id = $2 RETURNING *`,
    [docNumber, req.params.id]
  );
  res.json(updated.rows[0]);
});

/**
 * Issue a brand-new invoice from a quotation without destroying the source.
 *
 * World-class conversion model:
 *  - the quotation remains readable and is stamped with `doc_meta.conversion`;
 *  - a new invoice is created in the same tenant, with the next number from the
 *    live invoice series (company prefix + `pos_doc_number_seq`);
 *  - customer, currency, template, tax/discount, notes and every line + detail
 *    bullet are copied across;
 *  - no payments are copied (an invoice issues a fresh receivable) and stock is
 *    only carried over when the source already consumed it, so a payment on the
 *    invoice can never decrement inventory twice;
 *  - the operation is idempotent: repeating it returns the invoice already
 *    linked to that quotation instead of minting a duplicate.
 */
router.post('/documents/:id/issue-invoice', async (req, res) => {
  const blocked = invoiceBlock(req.company!);
  if (blocked) {
    res.status(403).json(blocked);
    return;
  }

  const cid = tenantId(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sourceRes = await client.query(
      `SELECT * FROM pos_documents
        WHERE id = $1 AND company_id = $2
          AND doc_type IN ('quotation', 'quote', 'estimate', 'proforma')
          AND status <> 'void'
        FOR UPDATE`,
      [req.params.id, cid]
    );
    if (sourceRes.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Quotation not found or it is not convertible.' });
      return;
    }
    const source = sourceRes.rows[0] as any;
    const sourceMeta =
      source.doc_meta && typeof source.doc_meta === 'object' && !Array.isArray(source.doc_meta)
        ? (source.doc_meta as Record<string, any>)
        : {};
    const existingId = sourceMeta?.conversion?.invoiceId;

    // Idempotent replay: if this quote already produced a live invoice, hand it
    // back instead of allocating another number.
    if (typeof existingId === 'string' && existingId) {
      const existing = await client.query(
        `SELECT * FROM pos_documents
          WHERE id = $1 AND company_id = $2 AND doc_type = 'invoice' AND status <> 'void'`,
        [existingId, cid]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        res.json({
          ...existing.rows[0],
          alreadyConverted: true,
          sourceDocumentId: source.id,
          sourceDocumentNumber: source.doc_number,
        });
        return;
      }
    }

    const itemRes = await client.query(
      `SELECT product_id, description, details, price, qty, line_total, position
         FROM pos_document_items
        WHERE document_id = $1
        ORDER BY position, id`,
      [source.id]
    );
    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(409).json({
        error: 'This quotation has no line items. Add at least one item before issuing an invoice.',
        code: 'DOCUMENT_EMPTY',
      });
      return;
    }

    const companyRes = await client.query(
      `SELECT invoice_prefix FROM companies WHERE id = $1`,
      [cid]
    );
    const prefix = normaliseDocPrefix(companyRes.rows[0]?.invoice_prefix, DOC_PREFIX.invoice);
    const seq = await client.query(`SELECT nextval('pos_doc_number_seq') AS v`);
    const docNumber = `${prefix}-${String(seq.rows[0].v).padStart(4, '0')}`;

    const total = round2(num(source.total));
    const netDays = Number.isFinite(Number(req.body?.netDays))
      ? Math.max(0, Math.min(365, Math.floor(Number(req.body.netDays))))
      : 30;
    const status = total <= 0 ? 'paid' : 'unpaid';

    // Carry commercial metadata forward, but never the source's conversion or
    // historical-import markers: an invoice is a new commercial document.
    const carried: Record<string, unknown> = {};
    for (const key of ['poNumber', 'reference', 'terms', 'paymentTerms', 'taxAmount', 'credit']) {
      if (sourceMeta[key] !== undefined && sourceMeta[key] !== null) carried[key] = sourceMeta[key];
    }
    const convertedAt = new Date().toISOString();
    const invoiceMeta = {
      ...carried,
      source: {
        documentId: source.id,
        documentNumber: source.doc_number,
        docType: source.doc_type,
      },
      netDays,
      conversion: { convertedAt },
    };

    const inserted = await client.query(
      `INSERT INTO pos_documents
         (doc_number, doc_type, channel, status, customer_id, cashier_id, issue_date, due_date,
          subtotal, discount_pct, tax_pct, total, amount_paid, notes, company_id,
          currency, exchange_rate, template_id, doc_meta, stock_applied)
       VALUES ($1,'invoice','office',$2,$3,$4,CURRENT_DATE,
               CURRENT_DATE + ($5::int * INTERVAL '1 day'),
               $6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        docNumber,
        status,
        source.customer_id,
        req.adminUser?.id ?? null,
        netDays,
        source.subtotal,
        source.discount_pct,
        source.tax_pct,
        total,
        source.notes,
        cid,
        source.currency || 'USD',
        source.exchange_rate || 1,
        source.template_id,
        JSON.stringify(invoiceMeta),
        Boolean(source.stock_applied),
      ]
    );

    const verified = await client.query(
      `UPDATE pos_documents SET verify_code = $1 WHERE id = $2 RETURNING *`,
      [generateDocumentVerifyCode(), inserted.rows[0].id]
    );
    const invoice = verified.rows[0] as any;

    for (let i = 0; i < itemRes.rows.length; i++) {
      const item = itemRes.rows[i] as any;
      await client.query(
        `INSERT INTO pos_document_items
           (document_id, product_id, description, details, price, qty, line_total, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          invoice.id,
          item.product_id ?? null,
          str(item.description) || 'Item',
          Array.isArray(item.details) ? item.details : [],
          item.price,
          item.qty,
          item.line_total,
          i,
        ]
      );
    }

    await client.query(
      `UPDATE pos_documents
          SET doc_meta = COALESCE(doc_meta, '{}'::jsonb)
                         || jsonb_build_object('conversion', $1::jsonb),
              updated_at = NOW()
        WHERE id = $2`,
      [
        JSON.stringify({
          invoiceId: invoice.id,
          invoiceNumber: invoice.doc_number,
          convertedAt,
        }),
        source.id,
      ]
    );

    await client.query(
      `INSERT INTO pos_document_events (document_id, company_id, event, detail, actor_id)
       VALUES ($1,$2,'created',$3,$4)`,
      [
        invoice.id,
        cid,
        JSON.stringify({
          docType: 'invoice',
          total,
          currency: invoice.currency,
          sourceDocumentNumber: source.doc_number,
        }),
        req.adminUser?.id ?? null,
      ]
    ).catch(() => undefined);

    await client.query(
      `INSERT INTO pos_document_events (document_id, company_id, event, detail, actor_id)
       VALUES ($1,$2,'converted',$3,$4)`,
      [
        source.id,
        cid,
        JSON.stringify({ invoiceId: invoice.id, invoiceNumber: invoice.doc_number }),
        req.adminUser?.id ?? null,
      ]
    ).catch(() => undefined);

    await client.query('COMMIT');
    res.status(201).json({
      ...invoice,
      items: itemRes.rows,
      alreadyConverted: false,
      sourceDocumentId: source.id,
      sourceDocumentNumber: source.doc_number,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((err as { code?: string })?.code === '23505') {
      res.status(409).json({
        error: `Document number ${'allocation'} collided. Try again.`,
        code: 'DOC_NUMBER_TAKEN',
      });
      return;
    }
    console.error('Issue invoice from quotation error:', (err as Error).message);
    res.status(500).json({ error: 'Could not issue an invoice from this quotation.' });
  } finally {
    client.release();
  }
});

// Atomic checkout: creates document + items + payments, decrements stock
router.post('/checkout', async (req, res) => {
  const me = req.adminUser!;
  const b = req.body || {};
  const docType = ['sale', 'invoice', 'quotation'].includes(str(b.docType)) ? str(b.docType) : 'sale';
  const blocked = docType === 'sale' ? subscriptionBlock(req.company!) : invoiceBlock(req.company!);
  if (blocked) {
    res.status(403).json(blocked);
    return;
  }
  const channel = ['till', 'online', 'office'].includes(str(b.channel)) ? str(b.channel) : 'till';
  const rawItems: CartItemInput[] = Array.isArray(b.items) ? b.items : [];
  if (rawItems.length === 0) {
    res.status(400).json({ error: 'At least one item is required' });
    return;
  }
  const rawPayments: Array<{ amount?: number | string; method?: string; reference?: string; intentId?: string }> =
    Array.isArray(b.payments) ? b.payments : [];
  const discountPct = Math.max(0, Math.min(100, num(b.discountPct)));
  const taxPct = Math.max(0, num(b.taxPct));
  const totals = computeTotals(rawItems, discountPct, taxPct);
  const lines = totals.lines.map((line) => ({ ...line, details: normalizeDetails(line.details) }));
  const { subtotal, discountAmount, taxAmount, total } = totals;
  const paidTotal = round2(rawPayments.reduce((s, p) => s + num(p?.amount), 0));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Refuse overselling tracked stock (row-locked to prevent race conditions)
    for (const line of lines) {
      const pid = str(line.productId);
      if (!pid) continue;
      const prod = await client.query(
        `SELECT name, track_stock, stock_qty
           FROM pos_products
          WHERE id = $1 AND company_id = $2
          FOR UPDATE`,
        [pid, tenantId(req)]
      );
      if (
        prod.rows.length > 0 &&
        prod.rows[0].track_stock &&
        Number(prod.rows[0].stock_qty) < line.qty
      ) {
        await client.query('ROLLBACK');
        res.status(400).json({
          error: `Insufficient stock for ${prod.rows[0].name}: have ${Number(prod.rows[0].stock_qty)}, need ${line.qty}`,
        });
        return;
      }
    }

    // Resolve customer (create/update by name if inline object given)
    let customerId: string | null = str(b.customerId) || null;
    if (!customerId && b.customer && typeof b.customer === 'object') {
      customerId = await upsertCustomer(client, tenantId(req), b.customer);
    }
    if (customerId) {
      const owned = await client.query(
        'SELECT 1 FROM pos_customers WHERE id = $1 AND company_id = $2',
        [customerId, tenantId(req)]
      );
      if (owned.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'Customer not found for this company.' });
        return;
      }
    }

    // Till sales must belong to a shift (auto-open a zero-float shift if needed)
    let shiftId: string | null = str(b.shiftId) || null;
    if (channel === 'till') {
      if (!shiftId) {
        const open = await client.query(
          `SELECT id FROM pos_shifts WHERE company_id = $2 AND cashier_id = $1 AND status = 'open' LIMIT 1`,
          [me.id, tenantId(req)]
        );
        if (open.rows.length > 0) {
          shiftId = open.rows[0].id;
        } else {
          const created = await client.query(
            `INSERT INTO pos_shifts (cashier_id, opening_float, company_id) VALUES ($1, 0, $2) RETURNING id`,
            [me.id, tenantId(req)]
          );
          shiftId = created.rows[0].id;
        }
      }
    }

    const seq = await client.query(`SELECT nextval('pos_doc_number_seq') AS v`);
    const docNumber = `${DOC_PREFIX[docType]}-${String(seq.rows[0].v).padStart(4, '0')}`;
    const status = statusForPaid(docType, total, paidTotal);

    const docInsert = await client.query(
      `INSERT INTO pos_documents
         (doc_number, doc_type, channel, status, customer_id, cashier_id, shift_id,
          issue_date, due_date, subtotal, discount_pct, tax_pct, total, amount_paid, notes, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        docNumber,
        docType,
        channel,
        status,
        customerId,
        me.id,
        shiftId,
        str(b.dueDate) || null,
        subtotal,
        round2(discountPct),
        round2(taxPct),
        total,
        Math.min(paidTotal, total),
        str(b.notes) || null,
        tenantId(req),
      ]
    );
    const verified = await client.query(
      `UPDATE pos_documents SET verify_code = $1 WHERE id = $2 RETURNING *`,
      [generateDocumentVerifyCode(), docInsert.rows[0].id]
    );
    const doc = verified.rows[0];

    for (const line of lines) {
      const description = str(line.description) || 'Item';
      await client.query(
        `INSERT INTO pos_document_items (document_id, product_id, description, details, price, qty, line_total, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          doc.id,
          str(line.productId) || null,
          description,
          line.details ?? [],
          line.price,
          line.qty,
          line.lineTotal,
          line.position,
        ]
      );
      if (line.productId) {
        await client.query(
          `UPDATE pos_products
              SET stock_qty = stock_qty - $1, updated_at = NOW()
            WHERE id = $2 AND company_id = $3 AND track_stock = TRUE`,
          [line.qty, line.productId, tenantId(req)]
        );
      }
    }

    for (const p of rawPayments) {
      const amount = round2(num(p?.amount));
      if (amount <= 0) continue;
      const method = PAYMENT_METHODS.includes(str(p?.method))
        ? str(p.method)
        : 'cash';

      // A mobile-money part must carry a provider-confirmed intent. Verify it
      // inside the transaction and consume it (target_id) in the same step, so
      // one confirmed payment can never settle two sales and an unconfirmed
      // one can never be recorded as paid.
      const intentId = str(p?.intentId);
      if (intentId) {
        if (!UUID_RE.test(intentId)) {
          await client.query('ROLLBACK');
          res.status(422).json({ error: 'Invalid payment reference' });
          return;
        }
        const intentRes = await client.query(
          `SELECT id, tenant_id, amount, payment_method, purpose, status, target_id, shift_id
             FROM pesepay_intents
            WHERE id = $1
            FOR UPDATE`,
          [intentId]
        );
        const intent = intentRes.rows[0];
        if (!intent || intent.tenant_id !== tenantId(req)) {
          await client.query('ROLLBACK');
          res.status(422).json({ error: 'Payment reference not found for this company' });
          return;
        }
        // Only an unattached POS credit may settle a till sale. Refuse invoice
        // intents and rail swaps even when their amount happens to match.
        if (intent.purpose !== 'pos_sale' || intent.payment_method !== method) {
          await client.query('ROLLBACK');
          res.status(422).json({ error: 'Payment reference does not match this payment' });
          return;
        }
        if (intent.status !== 'completed') {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'This payment has not been confirmed yet' });
          return;
        }
        if (intent.target_id) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'This payment has already been applied to another sale' });
          return;
        }
        if (Math.abs(Number(intent.amount) - amount) > 0.01) {
          await client.query('ROLLBACK');
          res.status(422).json({ error: 'Payment amount does not match the confirmed amount' });
          return;
        }
        if (shiftId && intent.shift_id && intent.shift_id !== shiftId) {
          await client.query('ROLLBACK');
          res.status(422).json({ error: 'Payment belongs to a different shift' });
          return;
        }
      }

      const payIns = await client.query(
        `INSERT INTO pos_document_payments (document_id, amount, method, reference, recorded_by, shift_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [doc.id, amount, method, str(p?.reference) || null, me.id, shiftId]
      );

      if (intentId) {
        const consumed = await client.query(
          `UPDATE pesepay_intents SET target_id = $2
            WHERE id = $1 AND target_id IS NULL AND status = 'completed'`,
          [intentId, doc.id]
        );
        if (!consumed.rowCount) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'This payment was already applied to another sale' });
          return;
        }
      }

      // Checkout already decremented stock above — mark applied and post GL.
      await syncSaleToLedgerAndStock(client, {
        companyId: tenantId(req),
        documentId: doc.id,
        paymentId: Number(payIns.rows[0].id),
        amount,
        method,
        docType,
        docNumber,
        reference: str(p?.reference) || null,
        taxPct,
        alreadyDecrementedStock: true,
      });
    }

    // Quotations / unpaid invoices with no payment still need the stock flag
    // set so a later Pesepay settle does not double-decrement.
    if (rawPayments.length === 0 || lines.some((l) => l.productId)) {
      await markStockApplied(client, doc.id);
    }

    await client.query('COMMIT');
    res.status(201).json({
      ...doc,
      balanceDue: round2(total - paidTotal),
      items: lines.map((l) => ({
        description: str(l.description) || 'Item',
        details: l.details ?? [],
        price: l.price,
        qty: l.qty,
        lineTotal: l.lineTotal,
      })),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// Record an installment payment against an existing document
router.post('/documents/:id/payments', async (req, res) => {
  const me = req.adminUser!;
  const amount = round2(num(req.body?.amount));
  if (amount <= 0) {
    res.status(400).json({ error: 'Payment amount must be positive' });
    return;
  }
  const method = PAYMENT_METHODS.includes(str(req.body?.method))
    ? str(req.body.method)
    : 'cash';
  const reference = str(req.body?.reference) || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const docs = await client.query(
      `SELECT * FROM pos_documents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, tenantId(req)]
    );
    if (docs.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    const doc = docs.rows[0];
    if (doc.status === 'void') {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Document is void' });
      return;
    }
    let shiftId: string | null = doc.shift_id;
    if (method === 'cash') {
      const open = await client.query(
        `SELECT id FROM pos_shifts WHERE company_id = $2 AND cashier_id = $1 AND status = 'open' LIMIT 1`,
        [me.id, tenantId(req)]
      );
      shiftId = open.rows.length > 0 ? open.rows[0].id : shiftId;
    }

    // Mobile-money installments must reference a provider-confirmed intent and
    // may only be consumed once.
    const intentId = str(req.body?.intentId);
    if (intentId) {
      if (!UUID_RE.test(intentId)) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'Invalid payment reference' });
        return;
      }
      const intentRes = await client.query(
        `SELECT id, tenant_id, amount, payment_method, purpose, status, target_id
           FROM pesepay_intents WHERE id = $1 FOR UPDATE`,
        [intentId]
      );
      const intent = intentRes.rows[0];
      if (!intent || intent.tenant_id !== tenantId(req)) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'Payment reference not found for this company' });
        return;
      }
      if (intent.purpose !== 'pos_sale' || intent.payment_method !== method) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'Payment reference does not match this payment' });
        return;
      }
      if (intent.status !== 'completed') {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'This payment has not been confirmed yet' });
        return;
      }
      if (intent.target_id) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'This payment has already been applied' });
        return;
      }
      if (Math.abs(Number(intent.amount) - amount) > 0.01) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'Payment amount does not match the confirmed amount' });
        return;
      }
    }

    const payIns = await client.query(
      `INSERT INTO pos_document_payments (document_id, amount, method, reference, recorded_by, shift_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [doc.id, amount, method, reference, me.id, shiftId]
    );

    if (intentId) {
      const consumed = await client.query(
        `UPDATE pesepay_intents SET target_id = $2
          WHERE id = $1 AND target_id IS NULL AND status = 'completed'`,
        [intentId, doc.id]
      );
      if (!consumed.rowCount) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'This payment was already applied to another document' });
        return;
      }
    }
    const sums = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS paid FROM pos_document_payments WHERE document_id = $1`,
      [doc.id]
    );
    const paid = round2(num(sums.rows[0].paid));
    const newStatus = doc.doc_type === 'void' ? doc.status : statusForPaid(doc.doc_type, num(doc.total), paid);
    const updated = await client.query(
      `UPDATE pos_documents SET amount_paid = LEAST($3,total), status = $4, updated_at = NOW()
        WHERE id = $1 AND company_id = $2 RETURNING *`,
      [doc.id, tenantId(req), paid, newStatus]
    );
    await syncSaleToLedgerAndStock(client, {
      companyId: tenantId(req),
      documentId: doc.id,
      paymentId: Number(payIns.rows[0].id),
      amount,
      method,
      docType: doc.doc_type,
      docNumber: doc.doc_number,
      reference,
      taxPct: num(doc.tax_pct),
      currency: doc.currency,
    });
    await client.query('COMMIT');
    res.json({ ...updated.rows[0], balanceDue: round2(Math.max(num(updated.rows[0].total) - paid, 0)) });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// Void a document (Manager+) — restocks tracked products
router.post('/documents/:id/void', requireRole(...MANAGER_ROLES), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const docs = await client.query(
      `SELECT * FROM pos_documents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, tenantId(req)]
    );
    if (docs.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    const current = docs.rows[0];
    if (current.status === 'void') {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Already void' });
      return;
    }
    // Money already collected is a financial fact. Voiding it would leave the
    // ledger holding revenue for a document marked void, so paid documents must
    // be corrected with a credit note/refund instead of erased.
    if (Number(current.amount_paid) > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({
        error:
          'This document has payments recorded. Issue a credit note or refund instead of voiding it, so the ledger stays balanced.',
        code: 'DOCUMENT_HAS_PAYMENTS',
      });
      return;
    }
    // Only reverse stock that was actually decremented. Office drafts and
    // quotes never touch inventory; restocking them would invent stock.
    if (current.stock_applied === true) {
      const items = await client.query(
        `SELECT product_id, qty FROM pos_document_items WHERE document_id = $1 AND product_id IS NOT NULL`,
        [req.params.id]
      );
      for (const it of items.rows) {
        await client.query(
          `UPDATE pos_products
              SET stock_qty = stock_qty + $1, updated_at = NOW()
            WHERE id = $2 AND company_id = $3 AND track_stock = TRUE`,
          [num(it.qty), it.product_id, tenantId(req)]
        );
      }
    }
    const updated = await client.query(
      `UPDATE pos_documents SET status = 'void', stock_applied = FALSE, updated_at = NOW()
        WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, tenantId(req)]
    );
    await client.query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
       VALUES ($1,$2,'pos.void_document','pos_document',$3,$4)`,
      [req.adminUser!.id, req.adminUser!.fullName ?? null, req.params.id, str(req.body?.reason) || '']
    );
    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ── International invoicing: UBL/Peppol export ──────────────────────

router.get('/documents/:id/ubl', async (req, res) => {
  const cid = tenantId(req);
  const { rows } = await pool.query(
    `SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.address AS customer_address
       FROM pos_documents d
       LEFT JOIN pos_customers c ON c.id = d.customer_id AND c.company_id = d.company_id
      WHERE d.id = $1 AND d.company_id = $2`,
    [req.params.id, cid]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Document not found' }); return; }
  const d = rows[0];
  const { rows: items } = await pool.query(
    `SELECT * FROM pos_document_items WHERE document_id = $1 ORDER BY position`,
    [d.id]
  );
  const { rows: comp } = await pool.query(`SELECT * FROM companies WHERE id = $1`, [cid]);
  const co = comp[0] || {};
  const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${esc(d.doc_number)}</cbc:ID>
  <cbc:UUID schemeID="PREYONE">${esc(d.verify_code || '')}</cbc:UUID>
  <cbc:IssueDate>${esc(d.issue_date)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${esc(d.currency || 'USD')}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${esc(co.name)}</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${esc(d.customer_name || 'Walk-in')}</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${esc(d.currency || 'USD')}">${Number(d.subtotal).toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${esc(d.currency || 'USD')}">${Number(d.subtotal).toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${esc(d.currency || 'USD')}">${Number(d.total).toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${esc(d.currency || 'USD')}">${Number(d.total).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${items.map((it: any, i: number) => `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="EA">${Number(it.qty)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${esc(d.currency || 'USD')}">${Number(it.line_total).toFixed(2)}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>${esc(it.description)}</cbc:Name>${
      Array.isArray(it.details) && it.details.length
        ? `<cbc:Description>${esc(it.details.join('; '))}</cbc:Description>`
        : ''
    }</cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${esc(d.currency || 'USD')}">${Number(it.price).toFixed(2)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`).join('\n')}
</Invoice>`;
  res.type('application/xml').send(xml);
});

// ── Accounts Receivable aging ───────────────────────────────────────

router.get('/reports/ar-aging', async (req, res) => {
  const cid = tenantId(req);
  const { rows } = await pool.query(
    `SELECT d.id, d.doc_number, d.doc_type, d.status, d.total, d.amount_paid, d.issue_date, d.due_date, c.name AS customer_name
       FROM pos_documents d
       LEFT JOIN pos_customers c ON c.id = d.customer_id
      WHERE d.company_id = $1
        AND d.status IN ('unpaid','partial')
        AND d.doc_type IN ('invoice','tax_invoice','proforma','sales_receipt')
      ORDER BY d.issue_date`,
    [cid]
  );
  const now = new Date();
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  const detail = rows.map((r: any) => {
    const due = r.due_date ? new Date(r.due_date) : new Date(r.issue_date);
    const days = Math.floor((now.getTime() - due.getTime()) / 86400000);
    const balance = round2(Number(r.total) - Number(r.amount_paid));
    let bucket = 'current';
    if (days > 90) bucket = 'd90plus';
    else if (days > 60) bucket = 'd61_90';
    else if (days > 30) bucket = 'd31_60';
    else if (days > 0) bucket = 'd1_30';
    (buckets as any)[bucket] += balance;
    return { ...r, balance, daysOverdue: Math.max(0, days), bucket };
  });
  res.json({ buckets, detail, total: round2(Object.values(buckets).reduce((a, b) => a + b, 0)) });
});

// ── POS sector dashboard ───────────────────────────────────────────
// Real-time till counters, best sellers, low-stock alerts, cashier
// performance and the invoice/quotation ledger for THIS tenant only.
router.get('/dashboard', async (req, res) => {
  const cid = tenantId(req);
  try {
    const [tillRes, profitRes, methodRes, sellerRes, stockRes, staffRes, ledgerRes, overdueRes, recentRes, shiftRes] =
      await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS docs,
                  COALESCE(SUM(d.total),0)::numeric AS gross,
                  COALESCE(SUM(d.amount_paid),0)::numeric AS collected,
                  COALESCE(SUM(d.total - d.subtotal),0)::numeric AS vat
             FROM pos_documents d
            WHERE d.company_id = $1
              AND d.doc_type IN ('sale','invoice','tax_invoice','sales_receipt','receipt','cash_receipt')
              AND d.status <> 'void'
              AND d.created_at >= date_trunc('day', NOW())`,
          [cid]
        ),
        pool.query(
          `SELECT COALESCE(SUM(i.line_total - i.qty * COALESCE(p.cost_price,0)),0)::numeric AS profit
             FROM pos_document_items i
             JOIN pos_documents d ON d.id = i.document_id
             LEFT JOIN pos_products p ON p.id = i.product_id
            WHERE d.company_id = $1
              AND d.doc_type IN ('sale','invoice','tax_invoice','sales_receipt','receipt','cash_receipt')
              AND d.status <> 'void'
              AND d.created_at >= date_trunc('day', NOW())`,
          [cid]
        ),
        pool.query(
          `SELECT p.method, COUNT(*)::int AS count, COALESCE(SUM(p.amount),0)::numeric AS total
             FROM pos_document_payments p
             JOIN pos_documents d ON d.id = p.document_id
            WHERE d.company_id = $1 AND d.status <> 'void' AND p.paid_at >= date_trunc('day', NOW())
            GROUP BY p.method ORDER BY total DESC`,
          [cid]
        ),
        pool.query(
          `SELECT i.description, COALESCE(SUM(i.qty),0)::numeric AS qty_sold,
                  COALESCE(SUM(i.line_total),0)::numeric AS revenue
             FROM pos_document_items i
             JOIN pos_documents d ON d.id = i.document_id
            WHERE d.company_id = $1 AND d.status NOT IN ('draft','void')
              AND d.doc_type IN ('sale','invoice','tax_invoice','sales_receipt','receipt','cash_receipt')
            GROUP BY i.description ORDER BY revenue DESC LIMIT 10`,
          [cid]
        ),
        pool.query(
          `SELECT id, name, stock_qty, low_stock_threshold
             FROM pos_products
            WHERE company_id = $1
              AND active = TRUE AND track_stock = TRUE AND stock_qty <= low_stock_threshold
            ORDER BY stock_qty ASC LIMIT 30`,
          [cid]
        ),
        pool.query(
          `SELECT u.full_name AS cashier, COUNT(*)::int AS count, COALESCE(SUM(d.total),0)::numeric AS gross
             FROM pos_documents d
             LEFT JOIN admin_users u ON u.id = d.cashier_id
            WHERE d.company_id = $1 AND d.status NOT IN ('draft','void')
              AND d.doc_type IN ('sale','invoice','tax_invoice','sales_receipt','receipt','cash_receipt')
              AND d.created_at >= date_trunc('day', NOW())
            GROUP BY u.full_name ORDER BY gross DESC LIMIT 20`,
          [cid]
        ),
        pool.query(
          `SELECT d.doc_type, d.status, COUNT(*)::int AS count,
                  COALESCE(SUM(d.total),0)::numeric AS amount,
                  COALESCE(SUM(d.total - d.amount_paid),0)::numeric AS outstanding
             FROM pos_documents d
            WHERE d.company_id = $1 AND d.status <> 'void'
            GROUP BY d.doc_type, d.status`,
          [cid]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS count, COALESCE(SUM(d.total - d.amount_paid),0)::numeric AS outstanding
             FROM pos_documents d
            WHERE d.company_id = $1
              AND d.doc_type IN ('invoice','tax_invoice','proforma','sales_receipt')
              AND d.status IN ('unpaid','partial') AND d.due_date IS NOT NULL AND d.due_date < CURRENT_DATE`,
          [cid]
        ),
        pool.query(
          `SELECT d.id, d.doc_number, d.doc_type, d.status, d.total, d.amount_paid,
                  d.issue_date, d.due_date, c.name AS customer_name, u.full_name AS cashier_name
             FROM pos_documents d
             LEFT JOIN pos_customers c ON c.id = d.customer_id
             LEFT JOIN admin_users u ON u.id = d.cashier_id
            WHERE d.company_id = $1 AND d.status <> 'void'
            ORDER BY d.created_at DESC LIMIT 12`,
          [cid]
        ),
        pool.query(
          `SELECT COUNT(*) FILTER (WHERE s.status = 'open')::int AS open, COUNT(*)::int AS total
             FROM pos_shifts s WHERE s.company_id = $1`,
          [cid]
        ),
      ]);

    const ledgerRows = ledgerRes.rows as any[];
    const cell = (t: string, s: string) =>
      ledgerRows.find((r: any) => r.doc_type === t && r.status === s);

    res.json({
      till: {
        docs: tillRes.rows[0].docs,
        gross: tillRes.rows[0].gross,
        collected: tillRes.rows[0].collected,
        vat: tillRes.rows[0].vat,
        profit: profitRes.rows[0].profit,
        byMethod: methodRes.rows,
      },
      bestSellers: sellerRes.rows,
      lowStock: stockRes.rows,
      staff: staffRes.rows,
      ledger: {
        invoices: {
          issued: (cell('invoice', 'paid')?.count || 0) + (cell('invoice', 'unpaid')?.count || 0) + (cell('invoice', 'partial')?.count || 0) + (cell('invoice', 'sent')?.count || 0),
          paid: cell('invoice', 'paid')?.count || 0,
          unpaid: cell('invoice', 'unpaid')?.count || 0,
          partial: cell('invoice', 'partial')?.count || 0,
          amountDue: (cell('invoice', 'unpaid')?.amount || 0) + (cell('invoice', 'partial')?.amount || 0),
          overdue: overdueRes.rows[0],
        },
        quotations: {
          draft: cell('quotation', 'draft')?.count || 0,
          sent: cell('quotation', 'sent')?.count || 0,
          converted: cell('quotation', 'paid')?.count || 0,
        },
        sales: cell('sale', 'paid')?.count || 0,
        recent: recentRes.rows,
      },
      shifts: { open: shiftRes.rows[0].open, total: shiftRes.rows[0].total },
    });
  } catch (err: any) {
    console.error('POS dashboard error:', err.message, err.query);
    res.status(500).json({ error: 'POS dashboard query failed' });
  }
});

// ── Reports ─────────────────────────────────────────────────────────

router.get('/reports/summary', async (req, res) => {
  const from = str(req.query.from) || '1970-01-01';
  const to = str(req.query.to) || '2999-12-31';
  const me2 = tenantId(req);
  // Reports aggregate money, so they are tenant-scoped too: a shared "all
  // companies" revenue figure would leak another tenant's takings.
  const byMethod = await pool.query(
    `SELECT p.method, COUNT(*) AS count, SUM(p.amount) AS total
       FROM pos_document_payments p
       JOIN pos_documents d ON d.id = p.document_id
      WHERE d.company_id = $3 AND d.status <> 'void' AND p.paid_at BETWEEN $1::date AND ($2::date + INTERVAL '1 day')
      GROUP BY p.method ORDER BY total DESC`,
    [from, to, me2]
  );
  const daily = await pool.query(
    `SELECT DATE(d.created_at) AS day, COUNT(*) AS documents, SUM(d.total) AS gross
       FROM pos_documents d
      WHERE d.company_id = $3 AND d.status NOT IN ('draft','void')
        AND d.doc_type IN ('sale','invoice','tax_invoice','sales_receipt','receipt','cash_receipt')
        AND d.created_at BETWEEN $1::date AND ($2::date + INTERVAL '1 day')
      GROUP BY DATE(d.created_at) ORDER BY day DESC LIMIT 90`,
    [from, to, me2]
  );
  const bestSellers = await pool.query(
    `SELECT i.description, SUM(i.qty) AS qty_sold, SUM(i.line_total) AS revenue
       FROM pos_document_items i
       JOIN pos_documents d ON d.id = i.document_id
      WHERE d.company_id = $3 AND d.status NOT IN ('draft','void')
        AND d.doc_type IN ('sale','invoice','tax_invoice','sales_receipt','receipt','cash_receipt')
        AND d.created_at BETWEEN $1::date AND ($2::date + INTERVAL '1 day')
      GROUP BY i.description ORDER BY revenue DESC LIMIT 10`,
    [from, to, me2]
  );
  const lowStock = await pool.query(
    `SELECT id, name, stock_qty, low_stock_threshold
       FROM pos_products
      WHERE company_id = $1
        AND active = TRUE AND track_stock = TRUE AND stock_qty <= low_stock_threshold
      ORDER BY stock_qty ASC LIMIT 50`,
    [me2]
  );
  res.json({ byMethod: byMethod.rows, daily: daily.rows, bestSellers: bestSellers.rows, lowStock: lowStock.rows });
});

// Deep sales report: revenue/profit/VAT over a date range (admin console)
async function salesReport(from: string, to: string, companyId: string) {
  const range = `d.company_id = $3
    AND d.created_at >= $1::date AND d.created_at < ($2::date + INTERVAL '1 day')
    AND d.status NOT IN ('draft','void')
    AND d.doc_type IN ('sale','invoice','tax_invoice','sales_receipt','receipt','cash_receipt')`;
  const [totals, profitRow, byMethod, byDay, byCashier, bestSellers] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS docs,
              COALESCE(SUM(d.total), 0) AS revenue,
              COALESCE(SUM(d.amount_paid), 0) AS collected,
              COALESCE(SUM((d.subtotal - d.subtotal * d.discount_pct / 100) * d.tax_pct / 100), 0) AS vat
         FROM pos_documents d WHERE ${range}`, [from, to, companyId]),
    pool.query(
      `SELECT COALESCE(SUM(i.line_total - i.qty * COALESCE(p.cost_price, 0)), 0) AS profit
         FROM pos_document_items i JOIN pos_documents d ON d.id = i.document_id
         LEFT JOIN pos_products p ON p.id = i.product_id WHERE ${range}`, [from, to, companyId]),
    pool.query(
      `SELECT p.method, COUNT(*) AS count, SUM(p.amount) AS total
         FROM pos_document_payments p JOIN pos_documents d ON d.id = p.document_id
         WHERE ${range} AND p.paid_at IS NOT NULL
         GROUP BY p.method ORDER BY total DESC`, [from, to, companyId]),
    pool.query(
      `SELECT DATE(d.created_at) AS day, COUNT(*) AS docs, SUM(d.total) AS revenue,
              SUM(d.amount_paid) AS collected
         FROM pos_documents d WHERE ${range}
         GROUP BY DATE(d.created_at) ORDER BY day ASC`, [from, to, companyId]),
    pool.query(
      `SELECT COALESCE(u.full_name, 'Unknown') AS cashier,
              COUNT(*) AS docs, SUM(d.total) AS revenue, SUM(d.amount_paid) AS collected
         FROM pos_documents d LEFT JOIN admin_users u ON u.id = d.cashier_id
         WHERE ${range} GROUP BY u.full_name ORDER BY revenue DESC`, [from, to, companyId]),
    pool.query(
      `SELECT i.description, SUM(i.qty) AS qty_sold, SUM(i.line_total) AS revenue,
              SUM(i.line_total - i.qty * COALESCE(p.cost_price, 0)) AS profit
         FROM pos_document_items i JOIN pos_documents d ON d.id = i.document_id
         LEFT JOIN pos_products p ON p.id = i.product_id
         WHERE ${range} GROUP BY i.description ORDER BY revenue DESC LIMIT 15`, [from, to, companyId]),
  ]);
  const lowStock = await pool.query(
    `SELECT id, name, stock_qty, low_stock_threshold
       FROM pos_products
      WHERE company_id = $1
        AND active = TRUE AND track_stock = TRUE AND stock_qty <= low_stock_threshold
      ORDER BY stock_qty ASC LIMIT 50`,
    [companyId]
  );
  return {
    from, to,
    totals: { ...totals.rows[0], profit: profitRow.rows[0].profit },
    byMethod: byMethod.rows,
    byDay: byDay.rows,
    byCashier: byCashier.rows,
    bestSellers: bestSellers.rows,
    lowStock: lowStock.rows,
  };
}

router.get('/reports/sales', async (req, res) => {
  const from = str(req.query.from) || new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const to = str(req.query.to) || new Date().toISOString().slice(0, 10);

  const me3 = tenantId(req);
  const current = await salesReport(from, to, me3);

  let prior: Awaited<ReturnType<typeof salesReport>> | undefined;
  if (req.query.compare === 'true') {
    const ms = new Date(to).getTime() - new Date(from).getTime() + 86_400_000;
    const priorTo = new Date(new Date(from).getTime() - 1).toISOString().slice(0, 10);
    const priorFrom = new Date(new Date(from).getTime() - ms).toISOString().slice(0, 10);
    prior = await salesReport(priorFrom, priorTo, me3);
  }

  res.json({ ...current, prior });
});

export { router as posRouter, DOC_PREFIX };
