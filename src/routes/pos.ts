import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth, requireRole } from '../middleware/adminAuth';
import { requireCompany } from '../middleware/company';

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

function signToken(user: StaffUser): string {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, fullName: user.fullName, company_id: user.company_id ?? null },
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
    res.json({ token: signToken(user), user });
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
router.use(requireAdminAuth, requireStaff, requireCompany);

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

// ── Device self-register / heartbeat (desktop, web, android) ────────
// Called by clients on login; keeps Devices & Endpoints console current.
router.post('/devices/register', async (req, res) => {
  const deviceId = str(req.body?.deviceId);
  const deviceType = str(req.body?.deviceType) || 'android';
  const name = str(req.body?.name) || req.adminUser!.fullName;
  const branch = str(req.body?.branch) || null;
  const appVersion = str(req.body?.appVersion) || null;
  const serverUrl = str(req.body?.serverUrl) || null;
  if (!/^[A-Za-z0-9._:-]{3,64}$/.test(deviceId)) {
    res.status(422).json({ error: 'deviceId required (3-64 chars, letters/digits/._:-)' }); return;
  }
  if (!['desktop', 'web', 'android'].includes(deviceType)) {
    res.status(422).json({ error: 'deviceType must be desktop|web|android' }); return;
  }
  const existing = await pool.query('SELECT id, status FROM pos_devices WHERE device_id = $1', [deviceId]);
  if (existing.rows[0]?.status === 'suspended') {
    res.status(403).json({ error: 'This device has been suspended. Contact your administrator.' }); return;
  }
  const { rows } = await pool.query(
    `INSERT INTO pos_devices (device_id, device_type, name, branch, app_version, server_url, status, last_seen, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,'active',NOW(),$7)
     ON CONFLICT (device_id) DO UPDATE SET
       device_type = EXCLUDED.device_type,
       name = EXCLUDED.name,
       branch = EXCLUDED.branch,
       app_version = EXCLUDED.app_version,
       server_url = EXCLUDED.server_url,
       company_id = COALESCE(pos_devices.company_id, EXCLUDED.company_id),
       last_seen = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [deviceId, deviceType, name, branch, appVersion, serverUrl, (req.adminUser as { company_id?: string | null })?.company_id ?? null]
  );
  res.json({ ok: true, device: rows[0] });
});

// ── Products ────────────────────────────────────────────────────────

router.get('/products', async (req, res) => {
  const q = str(req.query.q);
  const includeInactive = str(req.query.includeInactive) === '1';
  const params: unknown[] = [];
  let where = includeInactive ? '' : 'AND active = TRUE';
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (lower(name) LIKE $${params.length} OR lower(coalesce(sku,'')) LIKE $${params.length} OR lower(coalesce(barcode,'')) LIKE $${params.length})`;
  }
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
    `INSERT INTO pos_products (name, sku, barcode, category, price, cost_price, stock_qty, track_stock, low_stock_threshold)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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

const DOC_PREFIX: Record<string, string> = { sale: 'RCP', invoice: 'INV', quotation: 'QUO' };

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

// One-click quote → invoice conversion. Only a non-voided quotation owned by
// this tenant can be converted; the doc_number is re-issued from the shared
// sequence so the UNIQUE constraint keeps holding.
router.post('/documents/:id/convert-to-invoice', async (req, res) => {
  const doc = await pool.query(
    `SELECT id, doc_type, status FROM pos_documents
      WHERE id = $1 AND company_id = $2 AND doc_type = 'quotation' AND status <> 'void'`,
    [req.params.id, tenantId(req)]
  );
  if (doc.rows.length === 0) {
    res.status(404).json({ error: 'Quotation not found' });
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
  const docType = ['sale', 'invoice', 'quotation'].includes(str(b.docType)) ? str(b.docType) : 'sale';
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
    for (const line of lines) {
      const pid = str(line.productId);
      if (!pid) continue;
      const prod = await client.query(
        `SELECT name, track_stock, stock_qty FROM pos_products WHERE id = $1 FOR UPDATE`,
        [pid]
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

    for (const line of lines) {
      const description = str(line.description) || 'Item';
      await client.query(
        `INSERT INTO pos_document_items (document_id, product_id, description, price, qty, line_total, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [doc.id, str(line.productId) || null, description, line.price, line.qty, line.lineTotal, line.position]
      );
      if (line.productId) {
        await client.query(
          `UPDATE pos_products
              SET stock_qty = stock_qty - $1, updated_at = NOW()
            WHERE id = $2 AND track_stock = TRUE`,
          [line.qty, line.productId]
        );
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
    }

    await client.query('COMMIT');
    res.status(201).json({
      ...doc,
      balanceDue: round2(total - paidTotal),
      items: lines.map((l) => ({
        description: str(l.description) || 'Item',
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
    await client.query(
      `INSERT INTO pos_document_payments (document_id, amount, method, reference, recorded_by, shift_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [doc.id, amount, method, reference, me.id, shiftId]
    );
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
