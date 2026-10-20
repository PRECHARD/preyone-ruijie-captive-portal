import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth, requireRole } from '../middleware/adminAuth';
import { INACTIVITY_TIMEOUT_SEC } from '../sessionPolicy';
import { requireCompany } from '../middleware/company';
import { requireDeviceAuth } from '../middleware/deviceAuth';

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

function signToken(user: StaffUser, sid: string): string {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, fullName: user.fullName, company_id: user.company_id ?? null, sid },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

/**
 * Slides THIS till device's inactivity clock forward, keyed by the token's sid.
 * requireAdminAuth only reads the clock, so without this an in-use till would
 * lock after the inactivity window even while a cashier is actively ringing up
 * sales. Only the till's own row moves — other devices are untouched.
 */
async function slideActivityClock(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const sid = req.adminSession?.sid;
    const userId = req.adminUser?.id;
    if (sid && userId) {
      await pool.query(
        `UPDATE admin_user_sessions
            SET last_activity = NOW()
          WHERE sid = $1 AND admin_user_id = $2`,
        [sid, userId]
      );
    }
  } catch (err) {
    console.error('POS activity slide error:', err);
  }
  next();
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

router.get('/auth/operators', operatorLimiter, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, role, company_id
       FROM admin_users
      WHERE pin_hash IS NOT NULL AND approved = TRUE
      ORDER BY full_name`
  );
  res.json(rows);
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
  const { rows } = await pool.query(
    `SELECT id, email, full_name, role, pin_hash, company_id
       FROM admin_users
      WHERE id = $1 AND pin_hash IS NOT NULL AND approved = TRUE`,
    [userId]
  );
  const row = rows[0];
  if (row && (await bcrypt.compare(pin, row.pin_hash))) {
    const user: StaffUser = {
      id: row.id,
      email: row.email,
      role: row.role,
      fullName: row.full_name,
      company_id: row.company_id ?? null,
    };

    // Bind this till sign-in to a per-device session, exactly like the admin
    // console's startAdminSession. requireAdminAuth validates the JWT's sid
    // against an admin_user_sessions row; a token without one falls back to the
    // active_sid mirror, where any other sign-in (console or another till)
    // rotates the sentinel and instantly revokes it — that is what made every
    // POS call 401 with "Session expired". Writing the row + sid makes this
    // device's session authoritative and independent of other devices.
    const sid = crypto.randomUUID();
    const { rows: sessionRows } = await pool.query(
      `UPDATE admin_users
          SET auth_time          = NOW(),
              last_activity      = NOW(),
              session_expires_at = NOW() + make_interval(secs => $1),
              active_sid         = $2
        WHERE id = $3
        RETURNING auth_time`,
      [INACTIVITY_TIMEOUT_SEC, sid, user.id]
    );
    const authTime: Date = sessionRows[0]?.auth_time ?? new Date();
    await pool.query(
      `INSERT INTO admin_user_sessions (sid, admin_user_id, auth_time, last_activity, created_ip)
       VALUES ($1, $2, $3, $3, $4)
       ON CONFLICT (sid) DO UPDATE
         SET auth_time     = EXCLUDED.auth_time,
             last_activity = EXCLUDED.last_activity`,
      [sid, user.id, authTime, req.ip ?? null]
    );

    res.json({ token: signToken(user, sid), user });
    return;
  }
  res.status(401).json({ error: 'Invalid PIN for this operator' });
});

// Set own PIN, or a cashier's PIN (Manager+)
router.post('/auth/set-pin', requireAdminAuth, async (req, res) => {
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
    `UPDATE admin_users SET pin_hash = $1 WHERE id = $2 RETURNING id, full_name`,
    [hash, targetId]
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

router.get('/cashiers', requireAdminAuth, requireRole(...MANAGER_ROLES), async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, role, approved, pin_hash IS NOT NULL AS has_pin
       FROM admin_users
      WHERE role IN ('Cashier','Staff','Manager','CEO')
      ORDER BY full_name`
  );
  res.json(rows);
});

// ── Middleware guard for all POS data endpoints ────────────────────

function requireStaff(req: Request, res: Response, next: NextFunction): void {
  if (!isStaff(req.adminUser)) {
    res.status(403).json({ error: 'POS access required' });
    return;
  }
  next();
}
router.use(requireAdminAuth, requireStaff, requireCompany, slideActivityClock);

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

// ── SaaS subscription guard (3-tier engine) ───────────────────────────
// Shared by /devices/register and /devices/auto-register. Reads the tier off
// the companies row that requireCompany already loaded, then enforces in this
// order (per the subscription spec):
//   1. active device count vs the plan's max_devices, for a device that is
//      not registered yet        -> 403 DEVICE_LIMIT_EXCEEDED
//   2. subscription expiration   -> 403 SUBSCRIPTION_EXPIRED
//      (manual suspension        -> 403 SUBSCRIPTION_SUSPENDED)
// A device that already has a registration row re-registers without counting
// against the cap (it is already one of the counted rows), but a lapsed
// subscription still blocks it. Companies with no plan row yet — or a NULL
// max_devices — are grandfathered: there is nothing to enforce against.
// Returns true when the caller may proceed; false once a response was sent.
async function enforceSubscriptionGuard(
  res: Response,
  companyId: string,
  existingDevice: boolean
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT max_devices, subscription_status, subscription_expires_at
       FROM companies WHERE id = $1`,
    [companyId]
  );
  const plan = rows[0];
  if (!plan) return true;

  if (!existingDevice && plan.max_devices !== null && plan.max_devices !== undefined) {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pos_devices
        WHERE company_id = $1 AND status = 'active'`,
      [companyId]
    );
    const active = Number(countRows[0]?.n ?? 0);
    const max = Number(plan.max_devices);
    if (active >= max) {
      res.status(403).json({
        error: `Device limit reached: your subscription allows ${max} active device(s). Upgrade your plan to register more devices.`,
        code: 'DEVICE_LIMIT_EXCEEDED',
        max_devices: max,
        active_devices: active,
      });
      return false;
    }
  }

  const expiresAt = plan.subscription_expires_at ? new Date(plan.subscription_expires_at) : null;
  if ((expiresAt && expiresAt.getTime() <= Date.now()) || plan.subscription_status === 'expired') {
    res.status(403).json({
      error: 'Subscription expired. Renew your plan to continue registering devices.',
      code: 'SUBSCRIPTION_EXPIRED',
      subscription_expires_at: expiresAt ? expiresAt.toISOString() : null,
    });
    return false;
  }

  if (plan.subscription_status === 'suspended') {
    res.status(403).json({
      error: 'Subscription suspended. Renew your plan to re-enable device registration.',
      code: 'SUBSCRIPTION_SUSPENDED',
    });
    return false;
  }

  return true;
}

// ── Payment methods accepted on documents ──────────────────────────
// Mirrors the pos_document_payments_method_check constraint.
// Mobile-money rails are the ones Pesepay actually enables for this merchant
// (verified against /v1/payment-methods/for-currency). Zimswitch, Visa and
// Mastercard are NOT listed: Pesepay rejects them for this merchant, and
// offering an unusable rail at the till is worse than not offering it.
const PAYMENT_METHODS = [
  'cash', 'card', 'ecocash', 'innbucks', 'paygo', 'omari', 'bank', 'pesepay', 'other', 'on_account',
];

// ── Company profile (read-only for staff clients) ───────────────────
// Single source of truth for receipts / invoices / support phone.
router.get('/company', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM companies ORDER BY created_at LIMIT 1');
  res.json(rows[0] || { name: 'Preyone', currency: 'USD', tax_pct: 0, support_phone: '' });
});

// ── Company subscriptions (tenancy) — which modules this company owns ─
router.get('/company/subscriptions', (req, res) => {
  res.json({
    company: { id: req.company!.id, name: req.company!.name },
    plan_tier: req.company!.plan_tier ?? null,
    modules: req.company!.modules,
  });
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
    `SELECT id FROM pos_devices WHERE device_id = $1`,
    [hardwareSerial]
  );
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
// scoping (req.company, the portal tenant). Enforces 3-device quota: 1 phone
// + 1 tablet + 1 desktop, plus the subscription plan's device cap.
// Body: { device_uuid, device_public_key, device_type, device_name, app_version }
// Returns: { device_token, company_id, shop_id, device_name, quota }
const ALLOWED_AUTO_TYPES = ['phone', 'tablet', 'desktop'] as const;
const DEVICE_TYPE_QUOTA: Record<string, number> = { phone: 1, tablet: 1, desktop: 1 };

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
    `SELECT id, device_id, device_type, status FROM pos_devices WHERE device_uuid = $1 OR device_id = $2`,
    [deviceUuid, deviceUuid]
  );

  // If device exists and is suspended, reject
  if (existingDevice.rows[0]?.status === 'suspended') {
    res.status(403).json({ error: 'This device has been suspended. Contact your administrator.' }); return;
  }

  // Subscription engine: plan cap and expiry outrank the per-type quota below.
  if (!(await enforceSubscriptionGuard(res, companyId, existingDevice.rows.length > 0))) return;

  // Enforce quota: max N devices per type per company (only for NEW devices)
  const isNewDevice = existingDevice.rows.length === 0;
  if (isNewDevice && companyId) {
    const quota = DEVICE_TYPE_QUOTA[deviceType];
    if (quota) {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM pos_devices
          WHERE company_id = $1 AND device_type = $2 AND status = 'active'
            AND device_uuid IS DISTINCT FROM $3`,
        [companyId, deviceType, deviceUuid]
      );
      const activeCount = countResult.rows[0].cnt;
      if (activeCount >= quota) {
        res.status(409).json({
          error: `Device quota exceeded: maximum ${quota} ${deviceType}(s) allowed per company. Deactivate an existing ${deviceType} first.`,
          code: 'DEVICE_QUOTA_EXCEEDED',
          quota: { type: deviceType, max: quota, current: activeCount },
        });
        return;
      }
    }
  }

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

  // Return quota summary so client knows its limits
  const quotaSummary = await pool.query(
    `SELECT device_type, COUNT(*)::int AS cnt FROM pos_devices
      WHERE company_id = $1 AND status = 'active' AND device_type IN ('phone','tablet','desktop')
      GROUP BY device_type`,
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
      limits: DEVICE_TYPE_QUOTA,
      current: Object.fromEntries(quotaSummary.rows.map((r: { device_type: string; cnt: number }) => [r.device_type, r.cnt])),
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
  const quotaSummary = await pool.query(
    `SELECT device_type, COUNT(*)::int AS cnt FROM pos_devices
      WHERE company_id = $1 AND status = 'active' AND device_type IN ('phone','tablet','desktop')
      GROUP BY device_type`,
    [device.company_id]
  );
  res.json({
    device: rows[0],
    quota: {
      limits: DEVICE_TYPE_QUOTA,
      current: Object.fromEntries(quotaSummary.rows.map((r: { device_type: string; cnt: number }) => [r.device_type, r.cnt])),
    },
  });
});

// ── Products ────────────────────────────────────────────────────────

router.get('/products', async (req, res) => {
  const q = str(req.query.q);
  const includeInactive = str(req.query.includeInactive) === '1';
  const oem = str(req.query.oem);
  const make = str(req.query.make);
  const model = str(req.query.model);
  const year = num(req.query.year);
  const brand = str(req.query.brand);
  const bin = str(req.query.bin);
  const params: unknown[] = [];
  let where = includeInactive ? '' : 'AND active = TRUE';
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (lower(name) LIKE $${params.length} OR lower(coalesce(sku,'')) LIKE $${params.length} OR lower(coalesce(barcode,'')) LIKE $${params.length} OR lower(coalesce(oem_part_number,'')) LIKE $${params.length} OR lower(coalesce(make,'')) LIKE $${params.length} OR lower(coalesce(model,'')) LIKE $${params.length} OR lower(coalesce(brand,'')) LIKE $${params.length})`;
  }
  if (oem) { params.push(`%${oem.toLowerCase()}%`); where += ` AND lower(coalesce(oem_part_number,'')) LIKE $${params.length}`; }
  if (make) { params.push(`%${make.toLowerCase()}%`); where += ` AND lower(coalesce(make,'')) LIKE $${params.length}`; }
  if (model) { params.push(`%${model.toLowerCase()}%`); where += ` AND lower(coalesce(model,'')) LIKE $${params.length}`; }
  if (brand) { params.push(`%${brand.toLowerCase()}%`); where += ` AND lower(coalesce(brand,'')) LIKE $${params.length}`; }
  if (bin) { params.push(`%${bin.toLowerCase()}%`); where += ` AND lower(coalesce(bin_location,'')) LIKE $${params.length}`; }
  if (year) { params.push(year); where += ` AND (year_from IS NULL OR year_from <= $${params.length}) AND (year_to IS NULL OR year_to >= $${params.length})`; }
  const { rows } = await pool.query(
    `SELECT * FROM pos_products WHERE TRUE ${where} ORDER BY name LIMIT 500`,
    params
  );
  res.json(rows);
});

router.post('/products', async (req, res) => {
  const b = req.body || {};
  const name = str(b.name);
  if (!name) {
    res.status(400).json({ error: 'Product name is required' });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO pos_products (name, sku, barcode, category, price, cost_price, stock_qty, track_stock, low_stock_threshold, track_serial, unit, allow_fractional, oem_part_number, make, model, year_from, year_to, brand, bin_location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      name,
      str(b.sku) || null,
      str(b.barcode) || null,
      str(b.category) || null,
      round2(num(b.price)),
      round2(num(b.costPrice)),
      round2(num(b.stockQty)),
      b.trackStock !== false,
      round2(num(b.lowStockThreshold)),
      b.trackSerial === true,
      str(b.unit) || 'each',
      b.allowFractional === true,
      str(b.oemPartNumber) || null,
      str(b.make) || null,
      str(b.model) || null,
      b.yearFrom ? num(b.yearFrom) : null,
      b.yearTo ? num(b.yearTo) : null,
      str(b.brand) || null,
      str(b.binLocation) || null,
    ]
  );
  res.status(201).json(rows[0]);
});

router.put('/products/:id', async (req, res) => {
  const b = req.body || {};
  const fields: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    name: 'name',
    sku: 'sku',
    barcode: 'barcode',
    category: 'category',
    price: 'price',
    costPrice: 'cost_price',
    stockQty: 'stock_qty',
    trackStock: 'track_stock',
    lowStockThreshold: 'low_stock_threshold',
    active: 'active',
    trackSerial: 'track_serial',
    unit: 'unit',
    allowFractional: 'allow_fractional',
    oemPartNumber: 'oem_part_number',
    make: 'make',
    model: 'model',
    yearFrom: 'year_from',
    yearTo: 'year_to',
    brand: 'brand',
    binLocation: 'bin_location',
  };
  for (const [key, col] of Object.entries(map)) {
    if (key in b) {
       values.push(key === 'name' ? str(b[key]) || null : key === 'price' || key === 'costPrice' || key === 'stockQty' || key === 'lowStockThreshold' ? round2(num(b[key])) : key === 'yearFrom' || key === 'yearTo' ? (b[key] ? num(b[key]) : null) : key === 'trackStock' || key === 'active' || key === 'trackSerial' || key === 'allowFractional' ? !!b[key] : str(b[key]) || null);
      fields.push(`${col} = $${values.length}`);
    }
  }
  if (fields.length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }
  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE pos_products SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  res.json(rows[0]);
});

router.delete('/products/:id', requireRole(...MANAGER_ROLES), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE pos_products SET active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
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
      WHERE id = $2
      RETURNING id, name, stock_qty`,
    [delta, req.params.id]
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
  const params: unknown[] = [];
  let where = '';
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where = `WHERE lower(name) LIKE $${params.length} OR lower(coalesce(phone,'')) LIKE $${params.length} OR lower(coalesce(email,'')) LIKE $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM pos_customers ${where} ORDER BY name LIMIT 500`,
    params
  );
  res.json(rows);
});

async function upsertCustomer(client: import('pg').PoolClient, c: Record<string, unknown>): Promise<string | null> {
  const name = str(c?.name);
  if (!name) return null;
  const existing = await client.query(
    `SELECT id FROM pos_customers WHERE lower(name) = lower($1) LIMIT 1`,
    [name]
  );
  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE pos_customers
          SET phone = COALESCE(NULLIF($2,''), phone),
              email = COALESCE(NULLIF($3,''), email),
              address = COALESCE(NULLIF($4,''), address),
              updated_at = NOW()
        WHERE id = $1`,
      [existing.rows[0].id, str(c.phone), str(c.email), str(c.address)]
    );
    return existing.rows[0].id as string;
  }
  const inserted = await client.query(
    `INSERT INTO pos_customers (name, phone, email, address) VALUES ($1,$2,$3,$4) RETURNING id`,
    [name, str(c.phone) || null, str(c.email) || null, str(c.address) || null]
  );
  return inserted.rows[0].id as string;
}

router.post('/customers', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await upsertCustomer(client, req.body || {});
    await client.query('COMMIT');
    if (!id) {
      res.status(400).json({ error: 'Customer name is required' });
      return;
    }
    const { rows } = await client.query(`SELECT * FROM pos_customers WHERE id = $1`, [id]);
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
  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE pos_customers SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  res.json(rows[0]);
});

// Credit statement: documents + payments for one customer (admin console)
router.get('/customers/:id/statement', async (req, res) => {
  const cust = await pool.query(
    `SELECT id, name, phone, email, address, created_at FROM pos_customers WHERE id = $1`,
    [req.params.id]
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
  const shift = await getOpenShift(req.adminUser!.id, tenantId(req));
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
      GROUP BY method`,
    [shift.id]
  );
  const cashRow = sums.rows.find((r: Record<string, unknown>) => r.method === 'cash');
  const expectedCash = round2(num(shift.opening_float) + num(cashRow ? cashRow.total : 0));
  const variance = round2(counted - expectedCash);
  const { rows } = await pool.query(
    `UPDATE pos_shifts
        SET closed_at = NOW(), status = 'closed',
            expected_cash = $3, counted_cash = $4, variance = $5, notes = $6
      WHERE id = $1 AND company_id = $2
      RETURNING *`,
    [shift.id, tenantId(req), expectedCash, counted, variance, notes]
  );
  res.json({ shift: rows[0], totalsByMethod: sums.rows });
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
  price?: number | string;
  qty?: number | string;
}

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

export function statusForPaid(docType: string, total: number, paid: number): string {
  if (total > 0 && paid >= total - 0.005) return 'paid';
  if (paid > 0) return 'partial';
  return (docType === 'quotation' || docType === 'quote' || docType === 'estimate' || docType === 'proforma') ? 'sent' : 'unpaid';
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
    params.push(type);
    where.push(`d.doc_type = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`d.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(lower(d.doc_number) LIKE $${params.length} OR lower(coalesce(c.name,'')) LIKE $${params.length})`);
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
    `SELECT * FROM pos_documents WHERE id = $1 AND company_id = $2`,
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
    ? await pool.query(`SELECT * FROM pos_customers WHERE id = $1`, [doc.rows[0].customer_id])
    : { rows: [] };
  res.json({ ...doc.rows[0], items: items.rows, payments: pays.rows, customer: customer.rows[0] || null });
});

// One-click quotation/sale → invoice conversion. Only a non-voided quotation
// or sale owned by this tenant can be converted; the doc_number is re-issued
// from the shared sequence so the UNIQUE constraint keeps holding.
router.post('/documents/:id/convert-to-invoice', async (req, res) => {
  const doc = await pool.query(
    `SELECT id, doc_type, status FROM pos_documents
      WHERE id = $1 AND company_id = $2 AND doc_type IN ('quotation', 'sale') AND status <> 'void'`,
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

// Atomic checkout: creates document + items + payments, decrements stock
router.post('/checkout', async (req, res) => {
  const me = req.adminUser!;
  const b = req.body || {};
  const DOC_TYPES = ['sale', 'invoice', 'tax_invoice', 'proforma', 'receipt', 'sales_receipt', 'cash_receipt', 'quote', 'estimate', 'credit_memo', 'credit_note', 'purchase_order', 'delivery_note'];
  const docType = DOC_TYPES.includes(str(b.docType)) ? str(b.docType) : 'sale';
  const channel = ['till', 'online', 'office'].includes(str(b.channel)) ? str(b.channel) : 'till';
  const rawItems: CartItemInput[] = Array.isArray(b.items) ? b.items : [];
  if (rawItems.length === 0) {
    res.status(400).json({ error: 'At least one item is required' });
    return;
  }
  const rawPayments: Array<{ amount?: number | string; method?: string; reference?: string }> =
    Array.isArray(b.payments) ? b.payments : [];
  const discountPct = Math.max(0, Math.min(100, num(b.discountPct)));
  const taxPct = Math.max(0, num(b.taxPct));
  const { lines, subtotal, discountAmount, taxAmount, total } = computeTotals(rawItems, discountPct, taxPct);
  const paidTotal = round2(rawPayments.reduce((s, p) => s + num(p?.amount), 0));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Refuse overselling tracked stock (row-locked to prevent race conditions)
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const pid = str(line.productId);
      if (!pid) continue;
      const prod = await client.query(
        `SELECT name, track_stock, stock_qty, allow_fractional, track_serial FROM pos_products WHERE id = $1 FOR UPDATE`,
        [pid]
      );
      if (prod.rows.length === 0) continue;
      const p = prod.rows[0];
      if (p.track_stock && Number(p.stock_qty) < line.qty) {
        await client.query('ROLLBACK');
        res.status(400).json({
          error: `Insufficient stock for ${p.name}: have ${Number(p.stock_qty)}, need ${line.qty}`,
        });
        return;
      }
      // Fractional quantity guard (small trader module)
      if (!p.allow_fractional && line.qty !== Math.trunc(line.qty)) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: `${p.name} does not allow fractional quantities` });
        return;
      }
      // Serial / IMEI tracking guard (mobile & computer module)
      if (p.track_serial) {
        const rawLine = rawItems[li] || {};
        const serials = Array.isArray((rawLine as any).serialNumbers) ? (rawLine as any).serialNumbers : [];
        if (serials.length !== line.qty) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: `${p.name} requires ${line.qty} serial number(s), got ${serials.length}` });
          return;
        }
        // verify availability
        const { rows: avail } = await client.query(
          `SELECT serial_number FROM pos_serial_numbers
            WHERE company_id = $1 AND product_id = $2 AND status = 'in_stock' AND serial_number = ANY($3::text[])`,
          [tenantId(req), pid, serials]
        );
        if (avail.length !== serials.length) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: `One or more serials for ${p.name} are not in stock` });
          return;
        }
      }
    }

    // Resolve customer (create/update by name if inline object given)
    let customerId: string | null = str(b.customerId) || null;
    if (!customerId && b.customer && typeof b.customer === 'object') {
      customerId = await upsertCustomer(client, b.customer);
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
    const doc = docInsert.rows[0];

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const description = str(line.description) || 'Item';
      const rawLine = (rawItems[li] || {}) as any;
      const serials: string[] = Array.isArray(rawLine.serialNumbers) ? rawLine.serialNumbers.map((s: unknown) => str(s)).filter(Boolean) : [];
      const serialText = serials.length ? serials.join(',') : null;
      const itemRes = await client.query(
        `INSERT INTO pos_document_items (document_id, product_id, description, price, qty, line_total, position, serial_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [doc.id, str(line.productId) || null, description, line.price, line.qty, line.lineTotal, line.position, serialText]
      );
      const itemId = itemRes.rows[0]?.id;
      if (line.productId) {
        await client.query(
          `UPDATE pos_products
              SET stock_qty = stock_qty - $1, updated_at = NOW()
            WHERE id = $2 AND track_stock = TRUE`,
          [line.qty, line.productId]
        );
        // Mark serials sold (mobile & computer module)
        if (serials.length) {
          await client.query(
            `UPDATE pos_serial_numbers
                SET status = 'sold', document_id = $1, sold_at = NOW()
              WHERE company_id = $2 AND product_id = $3 AND serial_number = ANY($4::text[])`,
            [doc.id, tenantId(req), str(line.productId), serials]
          );
        }
      }
      // kitchen item flag stored on raw line (no schema change); KDS created below if profile demands
      (line as any)._itemId = itemId;
    }

    // on_account credit validation (small trader module)
    const onAccountTotal = round2(rawPayments.filter((p) => str(p?.method) === 'on_account').reduce((s, p) => s + num(p?.amount), 0));
    if (onAccountTotal > 0) {
      if (!customerId) { await client.query('ROLLBACK'); res.status(400).json({ error: 'Customer required for on-account payment' }); return; }
      const { rows: crows } = await client.query(
        `SELECT credit_limit, credit_balance, on_account_allowed FROM pos_customers WHERE id = $1 FOR UPDATE`,
        [customerId]
      );
      if (crows.length === 0) { await client.query('ROLLBACK'); res.status(404).json({ error: 'Customer not found' }); return; }
      const cust = crows[0];
      if (!cust.on_account_allowed) { await client.query('ROLLBACK'); res.status(403).json({ error: 'Customer not allowed on account' }); return; }
      if (Number(cust.credit_balance) + onAccountTotal > Number(cust.credit_limit)) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: `Credit limit exceeded: balance ${cust.credit_balance}, limit ${cust.credit_limit}` });
        return;
      }
    }

    for (const p of rawPayments) {
      const amount = round2(num(p?.amount));
      if (amount <= 0) continue;
      const method = PAYMENT_METHODS.includes(str(p?.method))
        ? str(p.method)
        : 'cash';
      await client.query(
        `INSERT INTO pos_document_payments (document_id, amount, method, reference, recorded_by, shift_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [doc.id, amount, method, str(p?.reference) || null, me.id, shiftId]
      );
      if (method === 'on_account') {
        await client.query(
          `UPDATE pos_customers SET credit_balance = credit_balance + $1, updated_at = NOW() WHERE id = $2`,
          [amount, customerId]
        );
      }
    }

    // Auto-create KDS ticket for QSR/restaurant profiles (or explicit flag)
    let kdsTicketId: string | null = null;
    const wantsKds = b.createKds === true || !!b.kdsStation;
    const { rows: compRows } = await client.query(`SELECT business_profile FROM companies WHERE id = $1`, [tenantId(req)]);
    const profile = compRows[0]?.business_profile;
    const isFood = profile === 'fast_food_qsr' || profile === 'restaurant_dine_in';
    if ((wantsKds || isFood) && lines.length > 0) {
      const station = str(b.kdsStation) || 'main';
      const { rows: kt } = await client.query(
        `INSERT INTO pos_kds_tickets (company_id, document_id, station, status) VALUES ($1,$2,$3,'pending') RETURNING id`,
        [tenantId(req), doc.id, station]
      );
      kdsTicketId = kt[0].id;
      for (const line of lines) {
        await client.query(
          `INSERT INTO pos_kds_items (kds_ticket_id, document_item_id, description, qty, kds_status)
           VALUES ($1,$2,$3,$4,'pending')`,
          [kdsTicketId, (line as any)._itemId || null, str(line.description) || 'Item', line.qty]
        );
      }
    }
    // Table assign for dine-in
    if (b.tableId) {
      await client.query(
        `UPDATE pos_tables SET status = 'occupied', current_document_id = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
        [doc.id, str(b.tableId), tenantId(req)]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      ...doc,
      balanceDue: round2(total - paidTotal),
      items: lines.map((l, idx) => ({
        description: str(l.description) || 'Item',
        price: l.price,
        qty: l.qty,
        lineTotal: l.lineTotal,
        serialNumber: Array.isArray((rawItems[idx] as any)?.serialNumbers) ? (rawItems[idx] as any).serialNumbers.join(',') : null,
      })),
       kdsTicketId,
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
    if (method === 'on_account') {
      if (!doc.customer_id) { await client.query('ROLLBACK'); res.status(400).json({ error: 'Customer required for on-account payment' }); return; }
      const { rows: crows } = await client.query(
        `SELECT credit_limit, credit_balance, on_account_allowed FROM pos_customers WHERE id = $1 FOR UPDATE`,
        [doc.customer_id]
      );
      if (crows.length === 0) { await client.query('ROLLBACK'); res.status(404).json({ error: 'Customer not found' }); return; }
      const cust = crows[0];
      if (!cust.on_account_allowed) { await client.query('ROLLBACK'); res.status(403).json({ error: 'Customer not allowed on account' }); return; }
      if (Number(cust.credit_balance) + amount > Number(cust.credit_limit)) {
        await client.query('ROLLBACK'); res.status(400).json({ error: 'Credit limit exceeded' }); return;
      }
    }
    let shiftId: string | null = doc.shift_id;
    if (method === 'cash') {
      const open = await client.query(
        `SELECT id FROM pos_shifts WHERE company_id = $2 AND cashier_id = $1 AND status = 'open' LIMIT 1`,
        [me.id, tenantId(req)]
      );
      shiftId = open.rows.length > 0 ? open.rows[0].id : shiftId;
    }
    await client.query(
      `INSERT INTO pos_document_payments (document_id, amount, method, reference, recorded_by, shift_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [doc.id, amount, method, reference, me.id, shiftId]
    );
    if (method === 'on_account' && doc.customer_id) {
      await client.query(
        `UPDATE pos_customers SET credit_balance = credit_balance + $1, updated_at = NOW() WHERE id = $2`,
        [amount, doc.customer_id]
      );
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
    if (docs.rows[0].status === 'void') {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Already void' });
      return;
    }
    const items = await client.query(
      `SELECT product_id, qty FROM pos_document_items WHERE document_id = $1 AND product_id IS NOT NULL`,
      [req.params.id]
    );
    for (const it of items.rows) {
      await client.query(
        `UPDATE pos_products SET stock_qty = stock_qty + $1, updated_at = NOW() WHERE id = $2 AND track_stock = TRUE`,
        [num(it.qty), it.product_id]
      );
    }
    const updated = await client.query(
      `UPDATE pos_documents SET status = 'void', updated_at = NOW()
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

// ── POS Industry Profile Engine: Serial / IMEI tracking ───────────────

router.post('/products/:id/serials', async (req, res) => {
  const cid = tenantId(req);
  const productId = req.params.id;
  const serials = Array.isArray(req.body?.serials) ? req.body.serials : (req.body?.serial ? [req.body.serial] : []);
  const cleaned = serials.map((s: unknown) => str(s)).filter(Boolean);
  if (cleaned.length === 0) { res.status(400).json({ error: 'serials required' }); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: prod } = await client.query('SELECT id FROM pos_products WHERE id = $1', [productId]);
    if (prod.length === 0) { await client.query('ROLLBACK'); res.status(404).json({ error: 'Product not found' }); return; }
    const inserted: string[] = [];
    for (const sn of cleaned) {
      const { rows } = await client.query(
        `INSERT INTO pos_serial_numbers (company_id, product_id, serial_number, status)
         VALUES ($1,$2,$3,'in_stock')
         ON CONFLICT (company_id, serial_number) DO NOTHING
         RETURNING serial_number`,
        [cid, productId, sn]
      );
      if (rows.length) inserted.push(rows[0].serial_number);
    }
    await client.query('COMMIT');
    res.status(201).json({ inserted, count: inserted.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: (e as Error).message });
  } finally {
    client.release();
  }
});

router.get('/products/:id/serials', async (req, res) => {
  const cid = tenantId(req);
  const status = str(req.query.status) || 'in_stock';
  const { rows } = await pool.query(
    `SELECT id, serial_number, status, document_id, sold_at, created_at
       FROM pos_serial_numbers
      WHERE company_id = $1 AND product_id = $2 AND ($3 = 'all' OR status = $3)
      ORDER BY created_at DESC`,
    [cid, req.params.id, status]
  );
  res.json(rows);
});

// ── POS Industry Profile Engine: Repair tickets ───────────────────────

router.get('/repairs', async (req, res) => {
  const cid = tenantId(req);
  const status = str(req.query.status);
  const params: unknown[] = [cid];
  let where = 'WHERE company_id = $1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT r.*, c.name AS customer_name, c.phone AS customer_phone
       FROM pos_repair_tickets r
       LEFT JOIN pos_customers c ON c.id = r.customer_id
       ${where} ORDER BY r.created_at DESC LIMIT 500`,
    params
  );
  res.json(rows);
});

router.post('/repairs', async (req, res) => {
  const cid = tenantId(req);
  const b = req.body || {};
  const issue = str(b.issueDescription || b.issue);
  if (!issue) { res.status(400).json({ error: 'issueDescription is required' }); return; }
  const { rows } = await pool.query(
    `INSERT INTO pos_repair_tickets
       (company_id, customer_id, device_type, brand, model, serial_number, issue_description, status, estimated_cost, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'received',$8,$9)
     RETURNING *`,
    [
      cid,
      b.customerId || null,
      str(b.deviceType) || null,
      str(b.brand) || null,
      str(b.model) || null,
      str(b.serialNumber) || null,
      issue,
      round2(num(b.estimatedCost)),
      req.adminUser!.id,
    ]
  );
  res.status(201).json(rows[0]);
});

router.get('/repairs/:id', async (req, res) => {
  const cid = tenantId(req);
  const { rows } = await pool.query(
    `SELECT r.*, c.name AS customer_name, c.phone AS customer_phone
       FROM pos_repair_tickets r
       LEFT JOIN pos_customers c ON c.id = r.customer_id
      WHERE r.id = $1 AND r.company_id = $2`,
    [req.params.id, cid]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Repair ticket not found' }); return; }
  res.json(rows[0]);
});

router.patch('/repairs/:id/status', async (req, res) => {
  const cid = tenantId(req);
  const status = str(req.body?.status);
  const allowed = ['received', 'diagnosed', 'in_progress', 'ready', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) { res.status(400).json({ error: 'invalid status' }); return; }
  const finalCost = req.body?.finalCost != null ? round2(num(req.body.finalCost)) : null;
  const { rows } = await pool.query(
    `UPDATE pos_repair_tickets
        SET status = $1, final_cost = COALESCE($2, final_cost), updated_at = NOW()
      WHERE id = $3 AND company_id = $4
      RETURNING *`,
    [status, finalCost, req.params.id, cid]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Repair ticket not found' }); return; }
  res.json(rows[0]);
});

router.post('/repairs/:id/convert', async (req, res) => {
  const cid = tenantId(req);
  const { rows: trows } = await pool.query(
    `SELECT * FROM pos_repair_tickets WHERE id = $1 AND company_id = $2`,
    [req.params.id, cid]
  );
  if (trows.length === 0) { res.status(404).json({ error: 'Repair ticket not found' }); return; }
  const t = trows[0];
  if (t.invoice_document_id) { res.status(409).json({ error: 'Already converted', documentId: t.invoice_document_id }); return; }
  const amount = round2(num(t.final_cost != null ? t.final_cost : t.estimated_cost));
  const docNumber = `INV-${Date.now()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: docs } = await client.query(
      `INSERT INTO pos_documents (doc_number, doc_type, channel, status, customer_id, cashier_id, company_id, subtotal, total, amount_paid, notes)
       VALUES ($1,'invoice','office','unpaid',$2,$3,$4,$5,$5,0,$6) RETURNING *`,
      [docNumber, t.customer_id, req.adminUser!.id, cid, amount, `Repair ticket ${t.id}: ${t.issue_description}`]
    );
    const doc = docs[0];
    await client.query(
      `INSERT INTO pos_document_items (document_id, description, price, qty, line_total, position)
       VALUES ($1,$2,$3,1,$3,0)`,
      [doc.id, `Repair: ${t.issue_description}`, amount]
    );
    await client.query(
      `UPDATE pos_repair_tickets SET invoice_document_id = $1, status = 'delivered', updated_at = NOW() WHERE id = $2`,
      [doc.id, t.id]
    );
    await client.query('COMMIT');
    res.status(201).json({ document: doc, repairId: t.id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: (e as Error).message });
  } finally {
    client.release();
  }
});

// ── POS Industry Profile Engine: Tables (dine-in) ─────────────────────

router.get('/tables', async (req, res) => {
  const cid = tenantId(req);
  const { rows } = await pool.query(
    `SELECT * FROM pos_tables WHERE company_id = $1 ORDER BY name`,
    [cid]
  );
  res.json(rows);
});

router.post('/tables', async (req, res) => {
  const cid = tenantId(req);
  const b = req.body || {};
  const name = str(b.name);
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  const { rows } = await pool.query(
    `INSERT INTO pos_tables (company_id, name, capacity, status)
     VALUES ($1,$2,$3,'available') RETURNING *`,
    [cid, name, b.capacity ? num(b.capacity) : 2]
  );
  res.status(201).json(rows[0]);
});

router.patch('/tables/:id', async (req, res) => {
  const cid = tenantId(req);
  const b = req.body || {};
  const fields: string[] = [];
  const values: unknown[] = [];
  if ('status' in b) { values.push(str(b.status)); fields.push(`status = $${values.length}`); }
  if ('name' in b) { values.push(str(b.name)); fields.push(`name = $${values.length}`); }
  if ('capacity' in b) { values.push(num(b.capacity)); fields.push(`capacity = $${values.length}`); }
  if ('currentDocumentId' in b) { values.push(b.currentDocumentId || null); fields.push(`current_document_id = $${values.length}`); }
  if (fields.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
  values.push(req.params.id, cid);
  const { rows } = await pool.query(
    `UPDATE pos_tables SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${values.length - 1} AND company_id = $${values.length} RETURNING *`,
    values
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Table not found' }); return; }
  res.json(rows[0]);
});

router.post('/tables/:id/assign', async (req, res) => {
  const cid = tenantId(req);
  const documentId = str(req.body?.documentId);
  if (!documentId) { res.status(400).json({ error: 'documentId required' }); return; }
  const { rows } = await pool.query(
    `UPDATE pos_tables SET status = 'occupied', current_document_id = $1, updated_at = NOW()
      WHERE id = $2 AND company_id = $3 RETURNING *`,
    [documentId, req.params.id, cid]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Table not found' }); return; }
  res.json(rows[0]);
});

// ── POS Industry Profile Engine: KDS ──────────────────────────────────

router.get('/kds/tickets', async (req, res) => {
  const cid = tenantId(req);
  const status = str(req.query.status) || 'open';
  const where = status === 'open'
    ? "AND t.status IN ('pending','preparing','ready')"
    : (status === 'all' ? '' : 'AND t.status = $2');
  const params: unknown[] = [cid];
  if (status !== 'open' && status !== 'all') params.push(status);
  const { rows: tickets } = await pool.query(
    `SELECT t.*, d.doc_number, d.total, d.created_at AS doc_created
       FROM pos_kds_tickets t
       JOIN pos_documents d ON d.id = t.document_id
      WHERE t.company_id = $1 ${where}
      ORDER BY t.created_at ASC`,
    params
  );
  for (const t of tickets) {
    const { rows: items } = await pool.query(
      `SELECT * FROM pos_kds_items WHERE kds_ticket_id = $1 ORDER BY id`,
      [t.id]
    );
    t.items = items;
  }
  res.json(tickets);
});

router.post('/kds/tickets/:id/bump', async (req, res) => {
  const cid = tenantId(req);
  const next = str(req.body?.status) || 'bumped';
  const allowed = ['pending', 'preparing', 'ready', 'bumped'];
  if (!allowed.includes(next)) { res.status(400).json({ error: 'invalid status' }); return; }
  const { rows } = await pool.query(
    `UPDATE pos_kds_tickets
        SET status = $1, bumped_at = ${next === 'bumped' ? 'NOW()' : 'bumped_at'}, bumped_by = $2
      WHERE id = $3 AND company_id = $4
      RETURNING *`,
    [next, req.adminUser!.id, req.params.id, cid]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'KDS ticket not found' }); return; }
  res.json(rows[0]);
});

// ── POS Industry Profile Engine: Customer credit (small trader) ───────

router.get('/customers/:id/credit', async (req, res) => {
  const cid = tenantId(req);
  const { rows } = await pool.query(
    `SELECT id, name, credit_limit, credit_balance, on_account_allowed
       FROM pos_customers WHERE id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Customer not found' }); return; }
  res.json(rows[0]);
});

router.patch('/customers/:id/credit', async (req, res) => {
  const b = req.body || {};
  const fields: string[] = [];
  const values: unknown[] = [];
  if ('creditLimit' in b) { values.push(round2(num(b.creditLimit))); fields.push(`credit_limit = $${values.length}`); }
  if ('creditBalance' in b) { values.push(round2(num(b.creditBalance))); fields.push(`credit_balance = $${values.length}`); }
  if ('onAccountAllowed' in b) { values.push(!!b.onAccountAllowed); fields.push(`on_account_allowed = $${values.length}`); }
  if (fields.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE pos_customers SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING id, name, credit_limit, credit_balance, on_account_allowed`,
    values
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Customer not found' }); return; }
  res.json(rows[0]);
});

// ── International invoicing: UBL/Peppol export ────────────────────────

router.get('/documents/:id/ubl', async (req, res) => {
  const cid = tenantId(req);
  const { rows } = await pool.query(
    `SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.address AS customer_address
       FROM pos_documents d
       LEFT JOIN pos_customers c ON c.id = d.customer_id
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
    <cac:Item><cbc:Name>${esc(it.description)}</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${esc(d.currency || 'USD')}">${Number(it.price).toFixed(2)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`).join('\n')}
</Invoice>`;
  res.type('application/xml').send(xml);
});

// ── Accounts Receivable aging ─────────────────────────────────────────

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

// ── Blind shift reconciliation ────────────────────────────────────────

router.post('/shifts/:id/reconcile', async (req, res) => {
  const cid = tenantId(req);
  const me = req.adminUser!;
  const counted = round2(num(req.body?.countedCash));
  const { rows } = await pool.query(
    `SELECT * FROM pos_shifts WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [req.params.id, cid]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Shift not found' }); return; }
  const shift = rows[0];
  if (shift.status !== 'open') { res.status(400).json({ error: 'Shift already closed' }); return; }
  // expected cash = opening float + cash payments - (we don't track payouts here) ; compute from payments
  const { rows: pay } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS cash_paid FROM pos_document_payments
      WHERE shift_id = $1 AND method = 'cash'`,
    [shift.id]
  );
  const expected = round2(Number(shift.opening_float) + Number(pay[0].cash_paid));
  const variance = round2(counted - expected);
  const { rows: upd } = await pool.query(
    `UPDATE pos_shifts
        SET counted_cash = $1, expected_cash = $2, variance = $3,
            blind_reconciled = TRUE, reconciled_at = NOW(), reconciled_by = $4,
            closed_at = NOW(), status = 'closed'
      WHERE id = $5 RETURNING *`,
    [counted, expected, variance, me.id, shift.id]
  );
  // cashier never sees expected until after submit; response includes it for record
  res.json({ ...upd[0], expectedCash: expected, variance });
});

// ── No-sale / drawer audit ────────────────────────────────────────────

router.post('/drawer/no-sale', async (req, res) => {
  const cid = tenantId(req);
  const me = req.adminUser!;
  const reason = str(req.body?.reason) || 'no-sale';
  const shiftId = str(req.body?.shiftId) || null;
  await pool.query(
    `INSERT INTO pos_no_sale_events (company_id, shift_id, cashier_id, reason) VALUES ($1,$2,$3,$4)`,
    [cid, shiftId, me.id, reason]
  );
  await pool.query(
    `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, detail)
     VALUES ($1,$2,'pos.drawer_no_sale','shift',$3,$4)`,
    [me.id, me.fullName ?? null, shiftId, reason]
  );
  res.json({ ok: true });
});

router.get('/drawer/no-sale', async (req, res) => {
  const cid = tenantId(req);
  const { rows } = await pool.query(
    `SELECT * FROM pos_no_sale_events WHERE company_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [cid]
  );
  res.json(rows);
});

// ── Fast 4-digit PIN cashier switching ────────────────────────────────

router.post('/auth/quick-switch', async (req, res) => {
  const pin = str(req.body?.pin);
  if (!/^\d{4}$/.test(pin)) { res.status(400).json({ error: 'PIN must be 4 digits' }); return; }
  const cid = tenantId(req);
  // find staff in same company with matching pin
  const { rows } = await pool.query(
    `SELECT id, email, full_name, role, pin_hash, portal_company_id
       FROM admin_users
      WHERE portal_company_id = $1 AND pin_hash IS NOT NULL AND role IN ('Staff','Manager','CEO','Cashier')`,
    [cid]
  );
  const bcrypt = await import('bcryptjs');
  for (const u of rows) {
    if (u.pin_hash && (await bcrypt.compare(pin, u.pin_hash))) {
      const sid = (await import('crypto')).randomUUID();
      await pool.query(
        `UPDATE admin_users SET active_sid = $1, auth_time = NOW(), last_activity = NOW(), session_expires_at = NOW() + INTERVAL '12 hours' WHERE id = $2`,
        [sid, u.id]
      );
      await pool.query(
        `INSERT INTO admin_user_sessions (sid, admin_user_id, auth_time, last_activity, created_ip) VALUES ($1,$2,NOW(),NOW(),$3)`,
        [sid, u.id, req.ip || null]
      );
      const jwt = await import('jsonwebtoken');
      const token = jwt.sign(
        { id: u.id, email: u.email, role: u.role, fullName: u.full_name, portalCompanyId: u.portal_company_id, sid },
        process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production',
        { algorithm: 'HS256', expiresIn: '12h' }
      );
      res.json({ token, user: { id: u.id, email: u.email, role: u.role, fullName: u.full_name } });
      return;
    }
  }
  res.status(401).json({ error: 'Invalid PIN' });
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
            WHERE d.company_id = $1 AND d.doc_type IN ('sale','invoice') AND d.status <> 'void'
              AND d.created_at >= date_trunc('day', NOW())`,
          [cid]
        ),
        pool.query(
          `SELECT COALESCE(SUM(i.line_total - i.qty * COALESCE(p.cost_price,0)),0)::numeric AS profit
             FROM pos_document_items i
             JOIN pos_documents d ON d.id = i.document_id
             LEFT JOIN pos_products p ON p.id = i.product_id
            WHERE d.company_id = $1 AND d.doc_type IN ('sale','invoice') AND d.status <> 'void'
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
            WHERE d.company_id = $1 AND d.status <> 'void'
            GROUP BY i.description ORDER BY revenue DESC LIMIT 10`,
          [cid]
        ),
        pool.query(
          `SELECT id, name, stock_qty, low_stock_threshold
             FROM pos_products
            WHERE active = TRUE AND track_stock = TRUE AND stock_qty <= low_stock_threshold
            ORDER BY stock_qty ASC LIMIT 30`
        ),
        pool.query(
          `SELECT u.full_name AS cashier, COUNT(*)::int AS count, COALESCE(SUM(d.total),0)::numeric AS gross
             FROM pos_documents d
             LEFT JOIN admin_users u ON u.id = d.cashier_id
            WHERE d.company_id = $1 AND d.status <> 'void' AND d.created_at >= date_trunc('day', NOW())
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
            WHERE d.company_id = $1 AND d.doc_type = 'invoice'
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
      WHERE d.company_id = $3 AND d.status <> 'void' AND d.created_at BETWEEN $1::date AND ($2::date + INTERVAL '1 day')
      GROUP BY DATE(d.created_at) ORDER BY day DESC LIMIT 90`,
    [from, to, me2]
  );
  const bestSellers = await pool.query(
    `SELECT i.description, SUM(i.qty) AS qty_sold, SUM(i.line_total) AS revenue
       FROM pos_document_items i
       JOIN pos_documents d ON d.id = i.document_id
      WHERE d.company_id = $3 AND d.status <> 'void' AND d.created_at BETWEEN $1::date AND ($2::date + INTERVAL '1 day')
      GROUP BY i.description ORDER BY revenue DESC LIMIT 10`,
    [from, to, me2]
  );
  const lowStock = await pool.query(
    `SELECT id, name, stock_qty, low_stock_threshold
       FROM pos_products
      WHERE active = TRUE AND track_stock = TRUE AND stock_qty <= low_stock_threshold
      ORDER BY stock_qty ASC LIMIT 50`
  );
  res.json({ byMethod: byMethod.rows, daily: daily.rows, bestSellers: bestSellers.rows, lowStock: lowStock.rows });
});

// Deep sales report: revenue/profit/VAT over a date range (admin console)
async function salesReport(from: string, to: string, companyId: string) {
  const range = `d.company_id = $3 AND d.created_at >= $1::date AND d.created_at < ($2::date + INTERVAL '1 day') AND d.status <> 'void'`;
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
       FROM pos_products WHERE active = TRUE AND track_stock = TRUE AND stock_qty <= low_stock_threshold
       ORDER BY stock_qty ASC LIMIT 50`
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
