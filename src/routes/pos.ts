import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth, requireRole } from '../middleware/adminAuth';
import { moduleAccess, requireCompany } from '../middleware/company';
import { invoiceBlock, subscriptionBlock } from '../plans/entitlements';
import { requireDeviceAuth } from '../middleware/deviceAuth';
import { enforceSubscriptionGuard } from '../middleware/subscriptionGuard';
import { markStockApplied, syncSaleToLedgerAndStock } from '../db/accounting';
import { INVOICE_DOCUMENT_TYPES, ALL_DOCUMENT_TYPES } from '../services/pesepay';
import { POS_THEMES, CURRENCIES, type PosTheme } from '../catalog/ecosystem';
import { themeCssVariables, themeCssBlock } from '../utils/themeVars';

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
router.use(requireAdminAuth, requireStaff, requireCompany, moduleAccess('pos'));

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

router.get('/catalog', async (req, res) => {
  const cid = tenantId(req);
  const [companyRes, templatesRes, themesRes] = await Promise.all([
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
      `SELECT id, name, description, layout, accent_color, show_logo
         FROM invoice_templates WHERE is_active ORDER BY id`
    ).catch(() => ({ rows: [] as any[] })),
    pool.query(
      `SELECT ${THEME_COLUMNS} FROM pos_themes WHERE is_active ORDER BY id`
    ).catch(() => ({ rows: [] as any[] })),
  ]);
  const company = companyRes.rows[0] ?? {};
  const templates = templatesRes.rows.length
    ? templatesRes.rows.map((t: any) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        layout: t.layout,
        accentColor: t.accent_color,
        showLogo: t.show_logo,
      }))
    : (await import('../catalog/ecosystem')).INVOICE_TEMPLATES;
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
  const currency = str(b.currency) ? str(b.currency).toUpperCase() : null;
  const taxPct = b.taxPct === undefined || b.taxPct === null ? null : round2(num(b.taxPct));
  const { rows } = await pool.query(
    `UPDATE companies
        SET invoice_template_id = COALESCE($1, invoice_template_id),
            currency            = COALESCE($2, currency),
            tax_pct             = COALESCE($3, tax_pct),
            terms_text          = COALESCE($4, terms_text),
            receipt_footer      = COALESCE($5, receipt_footer),
            invoice_settings    = COALESCE($6::jsonb, invoice_settings),
            updated_at          = NOW()
      WHERE id = $7
      RETURNING id, name, logo_url, currency, tax_pct, invoice_template_id,
                terms_text, receipt_footer, invoice_settings`,
    [
      templateId,
      currency,
      taxPct,
      str(b.termsText) || null,
      str(b.footer) || null,
      b.settings === undefined ? null : JSON.stringify(b.settings),
      cid,
    ]
  );
  res.json(rows[0] ?? {});
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

  const rawItems = Array.isArray(b.items) ? b.items : [];
  const items = rawItems
    .map((it: any) => ({
      description: str(it?.description),
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
      customerId = await upsertCustomer(client, b.customer);
    }

    const seq = await client.query(`SELECT nextval('pos_doc_number_seq') AS v`);
    const docNumber = `${DOC_PREFIX[docType]}-${String(seq.rows[0].v).padStart(4, '0')}`;
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
    const doc = inserted.rows[0];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      await client.query(
        `INSERT INTO pos_document_items (document_id, product_id, description, price, qty, line_total, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [doc.id, line.productId ?? null, line.description, line.price, line.qty, line.lineTotal, line.position]
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
    throw err;
  } finally {
    client.release();
  }
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
    `SELECT id, device_id, device_type, status FROM pos_devices WHERE device_uuid = $1 OR device_id = $2`,
    [deviceUuid, deviceUuid]
  );

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
      const payIns = await client.query(
        `INSERT INTO pos_document_payments (document_id, amount, method, reference, recorded_by, shift_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [doc.id, amount, method, str(p?.reference) || null, me.id, shiftId]
      );
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
    const payIns = await client.query(
      `INSERT INTO pos_document_payments (document_id, amount, method, reference, recorded_by, shift_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
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

// ── International invoicing: UBL/Peppol export ──────────────────────

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
