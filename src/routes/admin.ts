import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth, requireRole } from '../middleware/adminAuth';
import { PERMISSIONS, requirePermission, scopeUserVoucherCodeCondition, scopeVoucherCondition } from '../middleware/rbac';
import { recordAuditLog } from './adminAuth';
import { sendAdminApprovedNotification, sendAdminRejectedNotification } from '../services/notificationService';
import { isRuijieCloudConfigured, mintRuijieVoucherForTier } from '../services/ruijieMint';
import {
  getStaffDailySalesItemized,
  getPlatformDailySalesItemized,
  getStaffDailyRevenue,
  getPlatformDailyRevenue,
  getPlatformYesterdayRevenue,
  getPlatformWeeklyRevenue,
  getPlatformMonthlyRevenue,
  getPlatformMonthlyTarget,
  getStaffSalesMatrix,
  getHourlySalesVelocity,
  getRecentActivity,
} from '../db/sales';
import { RuijieApiError } from '../services/ruijieCloud';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';

export const adminRouter = Router();

adminRouter.use(requireAdminAuth);

const adminGeneralLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});
adminRouter.use(adminGeneralLimiter);

// When Ruijie Cloud is configured it is the network's single source of access:
// every staff-sold code MUST be minted from Ruijie (never a local placeholder).
// Returns null when Ruijie is not configured so legacy local minting continues.
interface StaffRuijieMint {
  code: string;
  profile: string;
  userGroupId: string;
  expiryTime: number | null;
}
async function staffRuijieMint(packageTier: string, comment: string): Promise<StaffRuijieMint | null> {
  if (!isRuijieCloudConfigured()) return null;
  const minted = await mintRuijieVoucherForTier(packageTier, comment);
  return {
    code: minted.codeNo,
    profile: minted.profile,
    userGroupId: minted.userGroupId,
    expiryTime: minted.expiryTime ?? null,
  };
}

const RUIJIE_VOUCHER_AUDIT_SQL = `INSERT INTO ruijie_vouchers
  (code_no, tier_name, user_group_id, profile_uuid, ruijie_expiry, payment_id, source, comment)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

adminRouter.get('/users', async (req: Request, res: Response) => {
  if (req.adminUser!.role === 'Staff') {
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.phone, u.voucher_code, u.accepted_tos, u.mac_address, u.ip_address, u.created_at, u.session_expires_at
       FROM users u
       WHERE u.voucher_code IN (SELECT code FROM vouchers WHERE sold_by = $1)
       ORDER BY u.created_at DESC LIMIT 500`,
      [req.adminUser!.id]
    );
    res.json(rows);
  } else {
    const { rows } = await pool.query(
      'SELECT id, full_name, phone, voucher_code, accepted_tos, mac_address, ip_address, created_at, session_expires_at FROM users ORDER BY created_at DESC LIMIT 500'
    );
    res.json(rows);
  }
});

adminRouter.get('/access-log', async (req: Request, res: Response) => {
  const params: any[] = [];
  const scope = scopeVoucherCondition(req, params);
  let query = `
    SELECT al.id, al.event, al.mac_address, al.ip_address, al.detail, al.created_at, u.full_name
      FROM access_log al
      LEFT JOIN users u ON u.id = al.user_id
      LEFT JOIN vouchers v ON UPPER(u.voucher_code) = UPPER(v.code)
  `;
  if (scope) query += ` WHERE ${scope}`;
  query += ' ORDER BY al.created_at DESC LIMIT 1000';
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

adminRouter.get('/packages', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    'SELECT * FROM packages WHERE deleted_at IS NULL ORDER BY price_amount ASC'
  );
  res.json(rows);
});

adminRouter.post('/vouchers', async (req: Request, res: Response) => {
  const { code, maxUses = 1, expiresAt, priceAmount, packageTier, paymentMethod, paymentReference, holderName, holderPhone } = req.body as {
    code: string; maxUses?: number; expiresAt?: string; priceAmount?: number | null; packageTier?: string;
    paymentMethod?: string; paymentReference?: string; holderName?: string; holderPhone?: string;
  };

  const saleMethod = paymentMethod && paymentMethod.trim() ? paymentMethod.trim() : 'Cash';
  const saleReference = paymentReference && paymentReference.trim() ? paymentReference.trim() : null;
  const holderNameValue = holderName && holderName.trim() ? holderName.trim().slice(0, 120) : null;
  const holderPhoneValue = holderPhone && holderPhone.trim() ? holderPhone.trim().slice(0, 32) : null;

  let durationMin = 60;
  let dataLimitGb: number | null = null;
  let isUncapped = true;
  let bandwidthUp = 2;
  let bandwidthDown = 5;
  let maxDevices: number | null = null;
  let resolvedPackageTier: string | null = null;

  if (!code) { res.status(422).json({ error: 'code is required' }); return; }

  // Staff and Manager must be clocked in to sell vouchers
  if (req.adminUser!.role !== 'CEO') {
    const clockedIn = await requireClockedIn(req.adminUser!.id);
    if (!clockedIn) {
      res.status(403).json({ error: 'You must clock in before selling vouchers.' });
      return;
    }
  }

  const approvalTiers = ['PreMax', 'PreUltra', 'PreExecutive'];
  if (packageTier && req.adminUser!.role === 'Staff' && approvalTiers.includes(packageTier)) {
    res.status(403).json({
      error: 'Staff cannot sell Restricted packages. Submit an approval request for management authorization.',
      requiresApproval: true
    });
    return;
  }

  if (packageTier) {
    const { rows: pkgs } = await pool.query(
      `SELECT tier_name, display_name, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, max_devices
       FROM packages WHERE tier_name = $1 AND deleted_at IS NULL`,
      [packageTier]
    );
    if (pkgs.length === 0) { res.status(422).json({ error: 'Package not found' }); return; }
    const pkg = pkgs[0];
    durationMin = pkg.duration_min;
    dataLimitGb = pkg.data_limit_gb;
    isUncapped = pkg.is_uncapped;
    bandwidthUp = pkg.bandwidth_mbps_up;
    bandwidthDown = pkg.bandwidth_mbps_down;
    maxDevices = pkg.max_devices;
    resolvedPackageTier = pkg.tier_name;
  }

  const soldBy = req.adminUser!.role === 'Staff' ? req.adminUser!.id : (priceAmount ? req.adminUser!.id : null);

  // Ruijie Cloud: the code shown to the customer comes from the mint, never the
  // staff-typed value. A sale without a resolvable package cannot be minted.
  let ruijieMint: StaffRuijieMint | null = null;
  if (isRuijieCloudConfigured()) {
    if (!resolvedPackageTier) {
      throw new RuijieApiError('missing_tier', 'Ruijie Cloud requires a package tier to mint a voucher');
    }
    ruijieMint = await staffRuijieMint(resolvedPackageTier, `Staff sale by ${req.adminUser!.fullName}`);
  }
  // Canonical stored PIN is lowercase. Authentication is case-insensitive
  // (gateway + portal compare UPPER(code)), and every output path renders the
  // stored code, so one case at the source keeps preview/JPEG/PDF/print/share,
  // admin lists and copy-PIN all presenting the same lowercase PIN.
  const voucherCode = ruijieMint ? ruijieMint.code : String(code).trim().toLowerCase();

  const { rows } = await pool.query(
    `INSERT INTO vouchers (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, sold_by, price_amount, package_tier, max_devices, holder_name, holder_phone, ruijie_sync_status, ruijie_voucher_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
    [voucherCode, durationMin, maxUses, expiresAt ?? null, dataLimitGb, isUncapped, bandwidthUp, bandwidthDown, soldBy, priceAmount ?? null, resolvedPackageTier, maxDevices,
     holderNameValue, holderPhoneValue, ruijieMint ? 'synced' : null, ruijieMint ? ruijieMint.code : null]
  );

  if (ruijieMint) {
    await pool.query(RUIJIE_VOUCHER_AUDIT_SQL, [
      ruijieMint.code, resolvedPackageTier, ruijieMint.userGroupId, ruijieMint.profile,
      ruijieMint.expiryTime ?? null, null, 'staff', null,
    ]);
  }

  // Log sale if price was set
  if (priceAmount && soldBy && rows.length > 0) {
    await pool.query(
      `INSERT INTO sales (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency, payment_method, payment_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [rows[0].id, rows[0].code, soldBy, req.adminUser!.fullName, priceAmount, 'USD', saleMethod, saleReference]
    );
  }

  res.status(201).json({ ...rows[0], package_tier: resolvedPackageTier });
});

// ── Voucher list: server-side search / filter / sort / pagination ──
//
// Status is NOT selected from a stored column. It comes from the voucher_status
// view, which derives it from used_count / expires_at / is_disabled at read time,
// so the table can never claim a voucher is Active while RADIUS is rejecting it.
//
// The subscriber/usage columns are LATERAL lookups rather than plain joins: a
// voucher can have many users, many bound devices and many past sessions, and
// joining them together directly would multiply the row count and make the
// traffic SUM wrong.
const VOUCHER_SORT_COLUMNS: Record<string, string> = {
  created_at: 'v.created_at',
  code: 'v.code',
  price: 'v.price_amount',
  activated_at: 'v.activated_at',
  expires_at: 'v.expires_at',
  duration: 'v.duration_min',
  used: 'v.used_count',
  status: 'vs.status',
};
const VOUCHER_STATUS_VALUES = ['Unused', 'Active', 'Expired', 'Disabled'];

adminRouter.get('/vouchers', async (req: Request, res: Response) => {
  const params: any[] = [];
  const where: string[] = ['v.deleted_at IS NULL'];

  // Staff only ever see the codes they sold themselves.
  if (req.adminUser!.role === 'Staff') {
    params.push(req.adminUser!.id);
    where.push(`v.sold_by = $${params.length}`);
  }

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where.push(`lower(v.code) LIKE $${params.length}`);
  }

  const status = typeof req.query.status === 'string' ? req.query.status : '';
  if (VOUCHER_STATUS_VALUES.includes(status)) {
    params.push(status);
    where.push(`vs.status = $${params.length}`);
  }

  const tier = typeof req.query.tier === 'string' ? req.query.tier : '';
  if (tier) {
    params.push(tier);
    where.push(`v.package_tier = $${params.length}`);
  }

  const sortKey = typeof req.query.sort === 'string' && VOUCHER_SORT_COLUMNS[req.query.sort]
    ? req.query.sort
    : 'created_at';
  const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const parsedSize = parseInt(String(req.query.pageSize ?? ''), 10);
  const pageSize = Number.isFinite(parsedSize) ? Math.min(Math.max(parsedSize, 1), 200) : 25;
  const parsedPage = parseInt(String(req.query.page ?? ''), 10);
  const page = Number.isFinite(parsedPage) ? Math.max(parsedPage, 1) : 1;

  const whereSql = where.join(' AND ');
  // Deliberately excludes the LATERAL joins: counting must not depend on them.
  const countFrom = `FROM vouchers v LEFT JOIN voucher_status vs ON vs.id = v.id WHERE ${whereSql}`;
  // Snapshot the params: `params` is reused and mutated with LIMIT/OFFSET below,
  // so handing the same array to both queries would let the count observe them.
  const countRes = await pool.query(`SELECT count(*)::int AS n ${countFrom}`, [...params]);
  const total: number = countRes.rows[0]?.n ?? 0;

  const dataFrom = `
    FROM vouchers v
    LEFT JOIN voucher_status vs ON vs.id = v.id
    -- Redemption source of truth: every activation writes a row here with the
    -- person's name, the device MAC and the login time, so any redeemed code
    -- (cloud or local) can be accounted for even when no users account exists.
    LEFT JOIN LATERAL (
      SELECT vr.full_name AS redemption_name,
             vr.mac_address AS redemption_mac,
             vr.ip_address AS redemption_ip,
             vr.created_at AS redemption_at
      FROM voucher_redemptions vr
      WHERE vr.voucher_id = v.id
      ORDER BY vr.created_at DESC
      LIMIT 1
    ) sub ON TRUE
    LEFT JOIN LATERAL (
      SELECT u.first_name, u.last_name, u.alias, u.phone, u.mac_address
      FROM users u
      WHERE u.voucher_code = v.code
      ORDER BY u.created_at DESC
      LIMIT 1
    ) usr ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE vd.is_active)::int AS device_count,
             array_agg(vd.mac_address ORDER BY vd.bound_at) FILTER (WHERE vd.is_active) AS bound_macs,
             COALESCE(
               json_agg(json_build_object(
                 'mac_address', vd.mac_address,
                 'label', vd.label,
                 'is_active', vd.is_active,
                 'bound_at', vd.bound_at,
                 'last_seen_at', vd.last_seen_at,
                 'unbound_at', vd.unbound_at
               ) ORDER BY vd.bound_at) FILTER (WHERE vd.is_active),
               '[]'::json
             ) AS devices
      FROM voucher_devices vd
      WHERE vd.voucher_id = v.id
    ) dev ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(
               json_agg(json_build_object(
                 'full_name', vr.full_name,
                 'mac_address', vr.mac_address,
                 'ip_address', vr.ip_address,
                 'redeemed_at', vr.created_at
               ) ORDER BY vr.created_at),
               '[]'::json
             ) AS redemptions
      FROM voucher_redemptions vr
      WHERE vr.voucher_id = v.id
    ) red ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(w.data_used_bytes), 0)::bigint AS used_bytes
      FROM wispr_profiles w
      JOIN users u2 ON u2.id = w.user_id
      WHERE u2.voucher_code = v.code
    ) traffic ON TRUE
    WHERE ${whereSql}`;

  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  params.push(pageSize, (page - 1) * pageSize);

  const { rows } = await pool.query(
    `SELECT v.*,
            vs.status,
            sub.redemption_name, sub.redemption_mac, sub.redemption_ip, sub.redemption_at,
            usr.first_name, usr.last_name, usr.alias, usr.phone, usr.mac_address,
            -- Prefer the stored column (backfilled, and staff-editable) but fall
            -- back to the first redemption row. Deriving it here means codes
            -- redeemed from now on get an activation time WITHOUT adding a write
            -- to auth.ts, which AGENTS.md marks as protected.
            COALESCE(
              v.activated_at,
              (SELECT MIN(vr.created_at) FROM voucher_redemptions vr WHERE vr.voucher_id = v.id)
            ) AS first_redeemed_at,
            COALESCE(dev.device_count, 0) AS device_count,
            dev.bound_macs,
            dev.devices,
            red.redemptions,
            COALESCE(traffic.used_bytes, 0) AS traffic_used_bytes,
            CASE WHEN v.is_uncapped OR v.data_limit_gb IS NULL THEN NULL
                 ELSE (v.data_limit_gb * 1073741824)::bigint END AS traffic_total_bytes
     ${dataFrom}
     ORDER BY ${VOUCHER_SORT_COLUMNS[sortKey]} ${sortDir} NULLS LAST, v.id ASC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  res.json({ vouchers: rows, total, page, pageSize });
});

/**
 * Load a voucher for mutation, enforcing the Staff scope so a staff account can
 * never reach another seller's voucher by guessing its id.
 */
async function loadScopedVoucher(
  adminUserId: string,
  role: string,
  voucherId: string
): Promise<any | null> {
  const params: any[] = [voucherId];
  let sql = `SELECT id, code, package_tier, expires_at, is_disabled, deleted_at, used_count, max_uses
             FROM vouchers v WHERE v.id = $1 AND v.deleted_at IS NULL`;
  if (role === 'Staff') {
    params.push(adminUserId);
    sql += ` AND v.sold_by = $2`;
  }
  const { rows } = await pool.query(sql, params);
  return rows[0] ?? null;
}

adminRouter.post('/vouchers/:id/disable', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const voucher = await loadScopedVoucher(req.adminUser!.id, req.adminUser!.role, req.params.id);
  if (!voucher) { res.status(404).json({ error: 'Voucher not found' }); return; }

  // Default to disabling; an explicit `disabled: false` re-enables.
  const disabled = req.body?.disabled !== false;
  const { rows } = await pool.query(
    `UPDATE vouchers SET is_disabled = $1 WHERE id = $2 RETURNING id, code, is_disabled`,
    [disabled, voucher.id]
  );
  await recordAuditLog(
    req.adminUser!.id,
    req.adminUser!.fullName,
    disabled ? 'voucher_disable' : 'voucher_enable',
    'voucher',
    voucher.id,
    `${disabled ? 'Disabled' : 'Enabled'} voucher ${voucher.code}`
  );
  res.json(rows[0]);
});

// ── Holder edit: customer name/phone ONLY ──
// Strict allowlist — any other field in the body is rejected outright, so this
// route can never alter PIN, price, expiry or any session-state column.
// Scoped via loadScopedVoucher (Staff may fix holders on their own sales).
adminRouter.patch('/vouchers/:id', async (req: Request, res: Response) => {
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const allowed = ['holderName', 'holderPhone'];
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    res.status(422).json({ error: `Field(s) not editable here: ${extra.join(', ')}. Only holderName/holderPhone.` });
    return;
  }
  if (!('holderName' in raw) && !('holderPhone' in raw)) {
    res.status(422).json({ error: 'Nothing to update. Provide holderName and/or holderPhone.' });
    return;
  }

  const voucher = await loadScopedVoucher(req.adminUser!.id, req.adminUser!.role, req.params.id);
  if (!voucher) { res.status(404).json({ error: 'Voucher not found' }); return; }

  const holderName = raw.holderName == null || String(raw.holderName).trim() === '' ? null : String(raw.holderName).trim().slice(0, 120);
  const holderPhone = raw.holderPhone == null || String(raw.holderPhone).trim() === '' ? null : String(raw.holderPhone).trim().slice(0, 32);

  const { rows } = await pool.query(
    `UPDATE vouchers SET holder_name = $2, holder_phone = $3
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, code, holder_name, holder_phone`,
    [voucher.id, holderName, holderPhone]
  );
  if (!rows[0]) { res.status(404).json({ error: 'Voucher not found' }); return; }

  await recordAuditLog(
    req.adminUser!.id,
    req.adminUser!.fullName,
    'voucher_holder_update',
    'voucher',
    voucher.id,
    `Holder for ${voucher.code}: name="${holderName ?? ''}" phone="${holderPhone ?? ''}"`
  );
  res.json(rows[0]);
});

adminRouter.post('/vouchers/:id/extend', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const voucher = await loadScopedVoucher(req.adminUser!.id, req.adminUser!.role, req.params.id);
  if (!voucher) { res.status(404).json({ error: 'Voucher not found' }); return; }

  const minutes = parseInt(String(req.body?.minutes ?? ''), 10);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    res.status(422).json({ error: 'minutes must be a positive integer' }); return;
  }
  // Cap a single call so a fat-fingered value cannot mint a decade of free access.
  if (minutes > 60 * 24 * 365) {
    res.status(422).json({ error: 'minutes cannot exceed 525600 (1 year)' }); return;
  }

  const extendSessions = req.body?.extendSessions === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // expires_at is the CODE's shelf life and is often NULL ("never expires").
    // COALESCE anchors that extension to now instead of failing on the NULL.
    const { rows } = await client.query(
      `UPDATE vouchers
       SET expires_at = COALESCE(expires_at, NOW()) + ($1::text || ' minutes')::interval
       WHERE id = $2
       RETURNING id, code, expires_at`,
      [minutes, voucher.id]
    );

    let sessionsTouched = 0;
    if (extendSessions) {
      // Push live subscriber sessions out by the same amount. Separate from the
      // shelf life because they are different clocks — see the activated_at
      // comment in src/db/migrate.ts for why these three are not merged.
      const sres = await client.query(
        `UPDATE users
         SET session_expires_at = COALESCE(session_expires_at, NOW()) + ($1::text || ' minutes')::interval
         WHERE voucher_code = $2 AND session_expires_at IS NOT NULL
         RETURNING id`,
        [minutes, voucher.code]
      );
      sessionsTouched = sres.rowCount ?? 0;
    }

    await client.query('COMMIT');
    await recordAuditLog(
      req.adminUser!.id,
      req.adminUser!.fullName,
      'voucher_extend',
      'voucher',
      voucher.id,
      `Extended voucher ${voucher.code} by ${minutes} min${extendSessions ? ` (+${sessionsTouched} live sessions)` : ''}`
    );
    res.json({ ...rows[0], sessions_extended: sessionsTouched });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
});

adminRouter.post('/vouchers/:id/reset-mac', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const voucher = await loadScopedVoucher(req.adminUser!.id, req.adminUser!.role, req.params.id);
  if (!voucher) { res.status(404).json({ error: 'Voucher not found' }); return; }

  // Deactivate rather than delete, matching unbindDevice(): the audit trail
  // survives and re-binding the same MAC later stays idempotent.
  const { rows } = await pool.query(
    `UPDATE voucher_devices
     SET is_active = FALSE, unbound_at = NOW()
     WHERE voucher_id = $1 AND is_active
     RETURNING mac_address`,
    [voucher.id]
  );
  await recordAuditLog(
    req.adminUser!.id,
    req.adminUser!.fullName,
    'voucher_reset_mac',
    'voucher',
    voucher.id,
    `Released ${rows.length} device slot(s) on voucher ${voucher.code}`
  );
  res.json({ message: `Released ${rows.length} device slot(s)`, released: rows.length });
});

adminRouter.delete('/vouchers/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const voucher = await loadScopedVoucher(req.adminUser!.id, req.adminUser!.role, req.params.id);
  if (!voucher) { res.status(404).json({ error: 'Voucher not found' }); return; }

  // Soft delete only. A hard DELETE would cascade through voucher_redemptions and
  // voucher_devices and erase the redemption history this table exists to show.
  // is_disabled is set too so a still-referenced code cannot be redeemed.
  const { rows } = await pool.query(
    `UPDATE vouchers SET deleted_at = NOW(), is_disabled = TRUE
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING code`,
    [voucher.id]
  );
  await recordAuditLog(
    req.adminUser!.id,
    req.adminUser!.fullName,
    'voucher_delete',
    'voucher',
    voucher.id,
    `Deleted voucher ${voucher.code}`
  );
  res.json({ message: `Voucher ${rows[0].code} deleted`, code: rows[0].code });
});

// ── Staff Sales (any role — staff see own sales) ──

adminRouter.get('/my-sales', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT v.*, a.full_name AS sold_by_name, s.payment_method, s.payment_reference
     FROM vouchers v
     LEFT JOIN admin_users a ON a.id = v.sold_by AND a.deleted_at IS NULL
     LEFT JOIN sales s ON s.voucher_id = v.id
     WHERE v.sold_by = $1
     ORDER BY v.created_at DESC`,
    [req.adminUser!.id]
  );
  const totalAmount = rows.reduce((sum: number, r: any) => sum + (parseFloat(r.price_amount) || 0), 0);
  const totalSales = rows.length;
  res.json({ sales: rows, totalAmount, totalSales });
});

// ── Shared Sales Excel Builder (neon purple theme) ──

const DPB = 'FF2D1B69';   // dark purple-blue (header bg)
const NP = 'FFA855F7';     // neon purple (accent)
const LP = 'FFF3E8FF';     // light purple (alt rows)
const RD = 'FFB91C1C';     // red (total row bg)
const NV = 'FF000080';     // navy blue (title)
const WH = 'FFFFFFFF';     // white

async function loadCompany(): Promise<any | null> {
  const { rows } = await pool.query('SELECT * FROM companies ORDER BY created_at LIMIT 1');
  return rows[0] || null;
}

async function sendStyledSalesExcel(
  res: Response,
  rows: any[],
  opts: {
    sheetName: string;
    columns: { header: string; width: number }[];
    subtitle: string | null;
    mapRow: (r: any) => (string | number)[];
    fileName: string;
  }
): Promise<void> {
  const { sheetName, columns, subtitle, mapRow, fileName } = opts;
  const colCount = columns.length;
  const lastCol = String.fromCharCode(64 + colCount);
  const company = (await loadCompany()) || {};
  const brandName = (company?.name as string) || 'Preyone';

  const wb = new ExcelJS.Workbook();
  wb.creator = company?.name || 'Preyone Network';
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns;

  // Clear row 1 auto-headers from column defs (we set headers at row ~11-12)
  for (let i = 1; i <= colCount; i++) ws.getRow(1).getCell(i).value = '';

  // White fill on rows 1-11, cols A-E to hide grid lines in the header area
  for (let r = 1; r <= 11; r++) {
    for (let c = 1; c <= 5; c++) {
      ws.getRow(r).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    }
  }

  // Logo — left edge, 16:9 ratio preserved
  let logoFile = 'staff-excel-preyonelogo.png';
  if (company?.logo_path && !/^https?:/.test(company.logo_path)) {
    const cand = path.join(__dirname, '..', '..', 'public', 'images', company.logo_path);
    if (fs.existsSync(cand)) logoFile = company.logo_path;
  }
  const logoPath = path.join(__dirname, '..', '..', 'public', 'images', logoFile);
  if (fs.existsSync(logoPath)) {
    const logoImg = wb.addImage({ filename: logoPath, extension: 'png' });
    ws.addImage(logoImg, { tl: { col: 0, row: 0 }, ext: { width: 320, height: 180 } });
  }

  // Freeze rows 1-12 (logo through header) so they stay visible when scrolling
  ws.views = [{ state: 'frozen', ySplit: 12 }];

  // 3 blank rows between logo and heading
  for (let i = 5; i <= 7; i++) ws.getRow(i).height = 15;

  // Title — Copperplate Gothic, navy blue
  ws.mergeCells(`A8:${lastCol}8`);
  ws.getCell('A8').value = brandName;
  ws.getCell('A8').font = { name: 'Copperplate Gothic', size: 18, bold: true, color: { argb: NV } };

  // Subtitle
  let r = 9;
  const sub = subtitle || (company?.tagline as string) || null;
  if (sub) {
    ws.mergeCells(`A${r}:${lastCol}${r}`);
    ws.getCell(`A${r}`).value = sub;
    ws.getCell(`A${r}`).font = { name: 'Calibri', size: 12, color: { argb: DPB } };
    r++;
  }

  // Date
  ws.mergeCells(`A${r}:${lastCol}${r}`);
  ws.getCell(`A${r}`).value = `Generated: ${new Date().toLocaleString()}`;
  ws.getCell(`A${r}`).font = { name: 'Calibri', size: 10, italic: true, color: { argb: DPB } };
  r++;

  const contact = [company?.support_phone, company?.website, company?.email].filter(Boolean).join('  ·  ');
  if (contact) {
    ws.mergeCells(`A${r}:${lastCol}${r}`);
    ws.getCell(`A${r}`).value = contact;
    ws.getCell(`A${r}`).font = { name: 'Calibri', size: 9, italic: true, color: { argb: NP } };
    r++;
  }
  if (company?.address) {
    ws.mergeCells(`A${r}:${lastCol}${r}`);
    ws.getCell(`A${r}`).value = company.address;
    ws.getCell(`A${r}`).font = { name: 'Calibri', size: 9, italic: true, color: { argb: NP } };
    r++;
  }

  const hrRow = r + 1;
  ws.views = [{ state: 'frozen', ySplit: hrRow }];
  const hr = ws.getRow(hrRow);
  hr.values = columns.map(c => c.header);
  hr.height = 38;
  for (let i = 1; i <= colCount; i++) {
    const c = hr.getCell(i);
    c.font = { name: 'Calibri', size: 13, bold: true, color: { argb: WH } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DPB } };
    c.border = { top: { style: 'thin', color: { argb: DPB } }, bottom: { style: 'medium', color: { argb: NP } }, left: { style: 'thin', color: { argb: DPB } }, right: { style: 'thin', color: { argb: DPB } } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  // Data rows
  const priceIdx = columns.findIndex(c => c.header.startsWith('Price (')) + 1;
  if (priceIdx > 0) hr.getCell(priceIdx).value = `Price (${(company?.currency as string) || 'USD'})`;
  let rowNum = hrRow + 1;
  for (const r of rows) {
    const dRow = ws.getRow(rowNum);
    const isAlt = rowNum % 2 === 0;
    dRow.values = mapRow(r);
    dRow.height = 22;
    for (let i = 1; i <= colCount; i++) {
      const c = dRow.getCell(i);
      c.font = { name: 'Calibri', size: 10, color: { argb: isAlt ? DPB : DPB } };
      if (isAlt) {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LP } };
      }
      c.border = { top: { style: 'thin', color: { argb: 'FFE9D5FF' } }, bottom: { style: 'thin', color: { argb: 'FFE9D5FF' } }, left: { style: 'thin', color: { argb: 'FFE9D5FF' } }, right: { style: 'thin', color: { argb: 'FFE9D5FF' } } };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    }
    dRow.getCell(1).font = { name: 'Consolas', size: 10, color: { argb: NP }, bold: true };
    if (priceIdx > 0) {
      dRow.getCell(priceIdx).font = { name: 'Calibri', size: 10, bold: true, color: { argb: DPB } };
    }
    rowNum++;
  }

  // Total row — red bg, white bold, larger
  const totalAmount = rows.reduce((s: number, r: any) => s + (parseFloat(r.price_amount) || 0), 0);
  const totalRow = ws.getRow(rowNum);
  totalRow.height = 36;
  totalRow.getCell(1).value = '';
  totalRow.getCell(2).value = 'TOTAL';
  if (priceIdx > 0) totalRow.getCell(priceIdx).value = totalAmount.toFixed(2);
  const usesIdx = columns.findIndex(c => c.header === 'Uses') + 1;
  if (usesIdx > 0) totalRow.getCell(usesIdx).value = `${rows.length} sale(s)`;
  for (let i = 1; i <= colCount; i++) {
    if (totalRow.getCell(i).value == null) totalRow.getCell(i).value = '';
    const c = totalRow.getCell(i);
    c.font = { name: 'Calibri', size: 12, bold: true, color: { argb: WH } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RD } };
    c.border = { top: { style: 'medium', color: { argb: 'FF7F1D1D' } }, bottom: { style: 'medium', color: { argb: 'FF7F1D1D' } }, left: { style: 'thin', color: { argb: RD } }, right: { style: 'thin', color: { argb: RD } } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  totalRow.getCell(2).font = { name: 'Calibri', size: 12, bold: true, color: { argb: WH } };
  if (priceIdx > 0) totalRow.getCell(priceIdx).font = { name: 'Calibri', size: 14, bold: true, color: { argb: WH } };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const brandFile = brandName.replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, '_') || 'Preyone';
  const finalName = (fileName as string).replace(/^Preyone/, brandFile);
  res.setHeader('Content-Disposition', `attachment; filename="${finalName}"`);
  await wb.xlsx.write(res);
  res.end();
}

// ── My Sales Export (Excel) ──

adminRouter.get('/my-sales/export', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.*, a.full_name AS sold_by_name
       FROM vouchers v
       LEFT JOIN admin_users a ON a.id = v.sold_by AND a.deleted_at IS NULL
       WHERE v.sold_by = $1
       ORDER BY v.created_at DESC`,
      [req.adminUser!.id]
    );
    await sendStyledSalesExcel(res, rows, {
      sheetName: 'My Sales',
      columns: [
        { header: 'Code', width: 18 },
        { header: 'Package', width: 22 },
        { header: 'Price (USD)', width: 16 },
        { header: 'Uses', width: 12 },
        { header: 'Created', width: 22 },
      ],
      subtitle: `Staff: ${req.adminUser!.fullName}`,
      mapRow: (r: any) => [
        r.code || '',
        r.package_tier || '',
        r.price_amount ? parseFloat(r.price_amount).toFixed(2) : '0.00',
        `${r.used_count || 0}/${r.max_uses || 1}`,
        r.created_at ? new Date(r.created_at).toLocaleString() : '',
      ],
      fileName: `Preyone_Sales_${req.adminUser!.fullName.replace(/\s+/g, '_')}.xlsx`,
    });
  } catch (err: any) {
    console.error('Export error:', err.message, err.stack);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ── Staff Sales Aggregated (CEO/Manager only) ──

adminRouter.get('/staff-sales', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  const { rows: staffSummary } = await pool.query(`
    SELECT a.id, a.full_name, a.role, COUNT(v.id)::int AS total_sales, COALESCE(SUM(v.price_amount), 0)::float AS total_amount
    FROM admin_users a
    INNER JOIN vouchers v ON v.sold_by = a.id
    WHERE a.role IN ('Staff', 'Manager') AND a.deleted_at IS NULL
    GROUP BY a.id, a.full_name, a.role
    ORDER BY total_amount DESC
  `);
  const { rows: allSales } = await pool.query(`
    SELECT v.*, a.full_name AS sold_by_name
    FROM vouchers v
    LEFT JOIN admin_users a ON a.id = v.sold_by AND a.deleted_at IS NULL
    WHERE v.sold_by IS NOT NULL
    ORDER BY v.created_at DESC
  `);
  const { rows: dailyBreakdown } = await pool.query(`
    SELECT DATE(v.created_at) AS sale_date, a.full_name, a.role, COUNT(v.id)::int AS sales_count, COALESCE(SUM(v.price_amount), 0)::float AS total_amount
    FROM vouchers v
    INNER JOIN admin_users a ON a.id = v.sold_by AND a.deleted_at IS NULL
    WHERE a.role IN ('Staff', 'Manager')
    GROUP BY DATE(v.created_at), a.full_name, a.role
    ORDER BY sale_date DESC, a.full_name ASC
  `);
  res.json({ staffSummary, allSales, dailyBreakdown });
});

// ── All Staff Sales Export (Excel, CEO/Manager only) ──

adminRouter.get('/staff-sales/export', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.*, a.full_name AS sold_by_name
       FROM vouchers v
       LEFT JOIN admin_users a ON a.id = v.sold_by AND a.deleted_at IS NULL
       WHERE v.sold_by IS NOT NULL
       ORDER BY v.created_at DESC`
    );
    await sendStyledSalesExcel(res, rows, {
      sheetName: 'Staff Sales',
      columns: [
        { header: 'Code', width: 18 },
        { header: 'Package', width: 22 },
        { header: 'Price (USD)', width: 16 },
        { header: 'Uses', width: 12 },
        { header: 'Sold By', width: 20 },
        { header: 'Created', width: 22 },
      ],
      subtitle: 'All Staff Sales',
      mapRow: (r: any) => [
        r.code || '',
        r.package_tier || '',
        r.price_amount ? parseFloat(r.price_amount).toFixed(2) : '0.00',
        `${r.used_count || 0}/${r.max_uses || 1}`,
        r.sold_by_name || '—',
        r.created_at ? new Date(r.created_at).toLocaleString() : '',
      ],
      fileName: 'Preyone_All_Staff_Sales.xlsx',
    });
  } catch (err: any) {
    console.error('Staff export error:', err.message, err.stack);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ── Per-Staff Sales Export (Excel, CEO/Manager only) ──

adminRouter.get('/staff-sales/export/:staffId', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  try {
    const { staffId } = req.params;
    const { rows: staffRows } = await pool.query(
      'SELECT full_name FROM admin_users WHERE id = $1 AND deleted_at IS NULL', [staffId]
    );
    if (!staffRows.length) {
      res.status(404).json({ error: 'Staff not found' });
      return;
    }
    const staffName = staffRows[0].full_name;
    const { rows } = await pool.query(
      `SELECT v.*, a.full_name AS sold_by_name
       FROM vouchers v
       LEFT JOIN admin_users a ON a.id = v.sold_by AND a.deleted_at IS NULL
       WHERE v.sold_by = $1
       ORDER BY v.created_at DESC`,
      [staffId]
    );
    await sendStyledSalesExcel(res, rows, {
      sheetName: staffName,
      columns: [
        { header: 'Code', width: 18 },
        { header: 'Package', width: 22 },
        { header: 'Price (USD)', width: 16 },
        { header: 'Uses', width: 12 },
        { header: 'Created', width: 22 },
      ],
      subtitle: `Staff: ${staffName}`,
      mapRow: (r: any) => [
        r.code || '',
        r.package_tier || '',
        r.price_amount ? parseFloat(r.price_amount).toFixed(2) : '0.00',
        `${r.used_count || 0}/${r.max_uses || 1}`,
        r.created_at ? new Date(r.created_at).toLocaleString() : '',
      ],
      fileName: `Preyone_Sales_${staffName.replace(/\s+/g, '_')}.xlsx`,
    });
  } catch (err: any) {
    console.error('Per-staff export error:', err.message, err.stack);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

adminRouter.get('/admin-users', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    'SELECT id, full_name, email, phone, role, created_at FROM admin_users WHERE deleted_at IS NULL ORDER BY created_at DESC'
  );
  res.json(rows);
});

// ── Consolidated Dashboard (cached 30s) ──

const dashboardCache: { data: any; expiresAt: number } = { data: null, expiresAt: 0 };

adminRouter.get('/dashboard', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  if (Date.now() < dashboardCache.expiresAt && dashboardCache.data) {
    res.json(dashboardCache.data);
    return;
  }
  try {
    const { rows: totalUsers } = await pool.query(`SELECT COUNT(*)::int AS count FROM users`);
    const { rows: vouchersCreated } = await pool.query(`SELECT COUNT(*)::int AS count FROM vouchers`);
    const { rows: vouchersUsed } = await pool.query(`SELECT COUNT(*)::int AS count FROM vouchers WHERE used_count > 0`);
    const { rows: totalRevenueR } = await pool.query(`SELECT COALESCE(SUM(amount), 0)::float AS total FROM sales`);
    const { rows: pendingPayments } = await pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS total FROM transactions WHERE status = 'pending'`);
    const { rows: activeSessions } = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE session_expires_at > NOW()`);
    const { rows: dailyR } = await pool.query(`SELECT COALESCE(SUM(amount), 0)::float AS amount, COUNT(*)::int AS count FROM sales WHERE sold_at >= CURRENT_DATE`);
    const { rows: weeklyR } = await pool.query(`SELECT COALESCE(SUM(amount), 0)::float AS amount, COUNT(*)::int AS count FROM sales WHERE sold_at >= DATE_TRUNC('week', CURRENT_DATE)`);
    const { rows: monthlyR } = await pool.query(`SELECT COALESCE(SUM(amount), 0)::float AS amount, COUNT(*)::int AS count FROM sales WHERE sold_at >= DATE_TRUNC('month', CURRENT_DATE)`);
    const { rows: dailySales } = await pool.query(`SELECT DATE(sold_at) AS day, COALESCE(SUM(amount),0)::float AS revenue, COUNT(*)::int AS count FROM sales WHERE sold_at >= NOW() - INTERVAL '14 days' GROUP BY DATE(sold_at) ORDER BY day`);
    const { rows: dailySignups } = await pool.query(`SELECT DATE(created_at) AS day, COUNT(*)::int AS count FROM users WHERE created_at >= NOW() - INTERVAL '14 days' GROUP BY DATE(created_at) ORDER BY day`);
    const { rows: byTier } = await pool.query(`SELECT v.package_tier, COUNT(*)::int AS count, COALESCE(SUM(v.price_amount),0)::float AS total FROM vouchers v WHERE v.package_tier IS NOT NULL AND v.price_amount > 0 GROUP BY v.package_tier ORDER BY total DESC`);
    const { rows: recentSales } = await pool.query(`SELECT s.voucher_code, s.amount, s.currency, s.sold_by_name, s.sold_at FROM sales s ORDER BY s.sold_at DESC LIMIT 10`);
    const { rows: [activeVouchers] } = await pool.query(`SELECT COUNT(*)::int AS count FROM vouchers WHERE expires_at > NOW() AND used_count > 0`);
    const { rows: [dataToday] } = await pool.query(`SELECT COALESCE(SUM(data_used_bytes), 0)::bigint AS total_bytes FROM wispr_profiles WHERE session_start >= CURRENT_DATE`);
    const { rows: [fupCount] } = await pool.query(`SELECT COUNT(*)::int AS count FROM wispr_profiles WHERE data_quota_bytes > 0 AND data_used_bytes >= data_quota_bytes AND session_end IS NULL`);
    const { rows: sales24h } = await pool.query(`SELECT h.hour, COALESCE(s.count, 0)::int AS count, COALESCE(s.revenue, 0)::float AS revenue FROM (SELECT generate_series(DATE_TRUNC('hour', NOW() - INTERVAL '23 hours'), DATE_TRUNC('hour', NOW()), INTERVAL '1 hour') AS hour) h LEFT JOIN (SELECT DATE_TRUNC('hour', sold_at) AS hour, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::float AS revenue FROM sales WHERE sold_at >= NOW() - INTERVAL '24 hours' GROUP BY DATE_TRUNC('hour', sold_at)) s ON h.hour = s.hour ORDER BY h.hour`);
    const { rows: [apStatus] } = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'online')::int AS online FROM ap_devices`);

    const daily = dailyR[0] || { amount: 0, count: 0 };
    const weekly = weeklyR[0] || { amount: 0, count: 0 };
    const monthly = monthlyR[0] || { amount: 0, count: 0 };

    const result = {
      metrics: {
        totalUsers: totalUsers[0]?.count ?? 0,
        vouchersCreated: vouchersCreated[0]?.count ?? 0,
        vouchersUsed: vouchersUsed[0]?.count ?? 0,
        totalRevenue: totalRevenueR[0]?.total ?? 0,
        activeSessions: activeSessions[0]?.count ?? 0,
        pendingPayments: { count: pendingPayments[0]?.count ?? 0, total: pendingPayments[0]?.total ?? 0 },
        activeVouchers: activeVouchers?.count ?? 0,
        dataConsumedToday: dataToday?.total_bytes ?? 0,
        fupTriggered: fupCount?.count ?? 0,
        apOnline: apStatus?.online ?? 0,
        apTotal: apStatus?.total ?? 0,
      },
      sales: { daily, weekly, monthly },
      charts: { dailySales, dailySignups },
      sales24h,
      byTier,
      recentSales,
    };
    dashboardCache.data = result;
    dashboardCache.expiresAt = Date.now() + 30000;
    res.json(result);
  } catch (err: any) {
    console.error('Dashboard endpoint error:', err.message, err.query);
    if (dashboardCache.data) {
      res.json(dashboardCache.data);
      return;
    }
    res.status(500).json({ error: 'Dashboard query failed' });
  }
});

// ── UltraNet WiFi sector dashboard ─────────────────────────────────
// Aggregates ACCESS-POINT / gateway / captive-portal session state ONLY.
// No transit or POS tables are read here (sector isolation).
adminRouter.get('/dashboard/wifi', async (_req: Request, res: Response) => {
  try {
    const [apRes, gwRes, clientRes, voucherRes, logRes, redemptionRes] = await Promise.all([
      pool.query(
        `SELECT name, model, mac_address, ip_address, location, status,
                firmware_version, uptime_seconds, clients_count, last_seen
         FROM ap_devices ORDER BY name`
      ),
      pool.query(
        `SELECT dev_model,
                COUNT(*) FILTER (WHERE last_seen >= NOW() - interval '3 minutes')::int AS online,
                COUNT(*)::int AS total
         FROM gateway_heartbeats GROUP BY dev_model ORDER BY total DESC`
      ),
      pool.query(
        `SELECT u.id AS user_id, u.full_name, u.mac_address, u.ip_address,
                u.created_at AS connected_at, u.session_expires_at,
                u.voucher_code, u.user_agent, v.package_tier,
                wp.bandwidth_up_kbps, wp.bandwidth_down_kbps,
                wp.data_used_bytes, wp.data_quota_bytes, wp.session_start
         FROM users u
         LEFT JOIN vouchers v ON UPPER(u.voucher_code) = UPPER(v.code)
         LEFT JOIN LATERAL (
           SELECT bandwidth_up_kbps, bandwidth_down_kbps, data_used_bytes,
                  data_quota_bytes, session_start
           FROM wispr_profiles wp2
           WHERE wp2.user_id = u.id AND wp2.session_end IS NULL
           ORDER BY wp2.session_start DESC LIMIT 1
         ) wp ON TRUE
         WHERE u.session_expires_at > NOW()
         ORDER BY wp.session_start DESC NULLS LAST
         LIMIT 200`
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM users WHERE session_expires_at > NOW()) AS active_sessions,
           (SELECT COUNT(DISTINCT voucher_code)::int FROM users WHERE session_expires_at > NOW() AND voucher_code IS NOT NULL) AS active_vouchers,
           (SELECT COUNT(*)::int FROM voucher_redemptions WHERE created_at >= date_trunc('day', NOW())) AS redeemed_today,
           (SELECT COUNT(*)::int FROM vouchers WHERE created_at >= date_trunc('day', NOW()) AND deleted_at IS NULL) AS created_today,
           (SELECT COUNT(*)::int FROM voucher_approvals WHERE status = 'pending') AS pending_approvals,
           (SELECT COUNT(*)::int FROM access_log WHERE created_at >= date_trunc('day', NOW())) AS connections_today,
           (SELECT COUNT(*)::int FROM users WHERE created_at >= date_trunc('day', NOW())) AS signups_today`
      ),
      pool.query(
        `SELECT al.id, al.event, al.mac_address, al.ip_address, al.detail,
                al.created_at, u.voucher_code
         FROM access_log al
         LEFT JOIN users u ON u.id = al.user_id
         ORDER BY al.created_at DESC LIMIT 25`
      ),
      pool.query(
        `SELECT vr.voucher_code, vr.full_name AS redeemed_by, vr.mac_address,
                vr.ip_address, vr.created_at AS redeemed_at,
                u.full_name AS holder_name, u.alias, u.phone, u.user_agent,
                v.package_tier, v.price_amount
         FROM voucher_redemptions vr
         LEFT JOIN users u ON u.id = vr.user_id
         LEFT JOIN vouchers v ON v.id = vr.voucher_id
         ORDER BY vr.created_at DESC LIMIT 50`
      ),
    ]);

    const aps = apRes.rows;
    const vouchers = voucherRes.rows[0] || {};
    const authRate = vouchers.connections_today > 0
      ? Math.round((vouchers.redeemed_today / vouchers.connections_today) * 100)
      : 0;

    res.json({
      aps: {
        total: aps.length,
        online: aps.filter((a: any) => a.status === 'online').length,
        offline: aps.filter((a: any) => a.status === 'offline').length,
        clients: aps.reduce((s: number, a: any) => s + (a.clients_count || 0), 0),
        gateways: { total: gwRes.rows.reduce((s: number, g: any) => s + g.total, 0), online: gwRes.rows.reduce((s: number, g: any) => s + g.online, 0), byModel: gwRes.rows },
      },
      apsList: aps,
      clients: clientRes.rows,
      vouchers: {
        activeSessions: vouchers.active_sessions || 0,
        activeVouchers: vouchers.active_vouchers || 0,
        redeemedToday: vouchers.redeemed_today || 0,
        createdToday: vouchers.created_today || 0,
        pendingApprovals: vouchers.pending_approvals || 0,
        connectionsToday: vouchers.connections_today || 0,
        signupsToday: vouchers.signups_today || 0,
        authSuccessRate: authRate,
      },
      connectionLog: logRes.rows,
      voucherUsage: redemptionRes.rows,
    });
  } catch (err: any) {
    console.error('WiFi dashboard error:', err.message, err.query);
    res.status(500).json({ error: 'WiFi dashboard query failed' });
  }
});

adminRouter.get('/revenue', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  const { rows: revenue } = await pool.query(`
    SELECT COALESCE(SUM(amount), 0)::float AS total_revenue
    FROM transactions WHERE status = 'completed'
  `);
  const { rows: pending } = await pool.query(`
    SELECT COALESCE(SUM(amount), 0)::float AS total_pending
    FROM transactions WHERE status = 'pending'
  `);
  const { rows: salesRev } = await pool.query(`
    SELECT COALESCE(SUM(amount), 0)::float AS total_sales
    FROM sales
  `);
  const { rows: handoverPending } = await pool.query(`
    SELECT COALESCE(SUM(total_amount), 0)::float AS total_pending
    FROM cash_handovers WHERE status = 'pending'
  `);
  const { rows: handoverApproved } = await pool.query(`
    SELECT COALESCE(SUM(total_amount), 0)::float AS total_approved
    FROM cash_handovers WHERE status = 'approved'
  `);
  const { rows: byTier } = await pool.query(`
    SELECT package_tier, COUNT(*)::int AS count, COALESCE(SUM(price_amount), 0)::float AS total
    FROM vouchers WHERE package_tier IS NOT NULL AND price_amount > 0
    GROUP BY package_tier ORDER BY total DESC
  `);
  const { rows: recentTx } = await pool.query(`
    SELECT t.id, t.package_tier, t.amount, t.currency, t.status, t.created_at, t.completed_at,
           u.full_name AS user_name
    FROM transactions t
    LEFT JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC LIMIT 100
  `);
  res.json({
    totalRevenue: revenue[0].total_revenue + handoverApproved[0].total_approved,
    salesRevenue: salesRev[0].total_sales,
    combinedRevenue: revenue[0].total_revenue + handoverApproved[0].total_approved,
    pendingRevenue: pending[0].total_pending + handoverPending[0].total_pending,
    handoverPending: handoverPending[0].total_pending,
    handoverApproved: handoverApproved[0].total_approved,
    byTier,
    recentTransactions: recentTx,
  });
});

// ── Dashboard Sales (daily/weekly/monthly) ──

adminRouter.get('/dashboard/sales', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  const { rows: daily } = await pool.query(`
    SELECT COALESCE(SUM(amount), 0)::float AS amount, COUNT(*)::int AS count
    FROM sales WHERE sold_at >= CURRENT_DATE
  `);
  const { rows: weekly } = await pool.query(`
    SELECT COALESCE(SUM(amount), 0)::float AS amount, COUNT(*)::int AS count
    FROM sales WHERE sold_at >= DATE_TRUNC('week', CURRENT_DATE)
  `);
  const { rows: monthly } = await pool.query(`
    SELECT COALESCE(SUM(amount), 0)::float AS amount, COUNT(*)::int AS count
    FROM sales WHERE sold_at >= DATE_TRUNC('month', CURRENT_DATE)
  `);
  const { rows: total } = await pool.query(`
    SELECT COALESCE(SUM(amount), 0)::float AS amount, COUNT(*)::int AS count FROM sales
  `);
  const { rows: byStaff } = await pool.query(`
    SELECT s.sold_by_name, COUNT(*)::int AS count, COALESCE(SUM(s.amount), 0)::float AS total
    FROM sales s GROUP BY s.sold_by_name ORDER BY total DESC
  `);
  const { rows: recent } = await pool.query(`
    SELECT s.voucher_code, s.amount, s.currency, s.sold_by_name, s.sold_at
    FROM sales s ORDER BY s.sold_at DESC LIMIT 50
  `);
  res.json({ daily: daily[0], weekly: weekly[0], monthly: monthly[0], total: total[0], byStaff, recent });
});

// ── Staff Time Tracking ──

adminRouter.post('/clock-in', async (req: Request, res: Response) => {
  const { rows: existing } = await pool.query(
    `SELECT id FROM staff_time_logs WHERE admin_user_id = $1 AND clock_out IS NULL LIMIT 1`,
    [req.adminUser!.id]
  );
  if (existing.length > 0) {
    res.status(409).json({ error: 'Already clocked in. Clock out first.' });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO staff_time_logs (admin_user_id) VALUES ($1) RETURNING *`,
    [req.adminUser!.id]
  );
  // Notify CEO/Manager that staff clocked in
  insertAlert('staff_clock_in', 'info', `${req.adminUser!.fullName} clocked in`,
    `${req.adminUser!.fullName} (${req.adminUser!.role}) started their shift.`,
    'time', rows[0].id.toString());
  res.status(201).json(rows[0]);
});

adminRouter.post('/clock-out', async (req: Request, res: Response) => {
  const { rows: existing } = await pool.query(
    `SELECT id, clock_in FROM staff_time_logs WHERE admin_user_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,
    [req.adminUser!.id]
  );
  if (existing.length === 0) {
    res.status(409).json({ error: 'Not clocked in. Clock in first.' });
    return;
  }

  // Enforce handover: check for unhanded sales
  const { rows: unhanded } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM sales
     WHERE sold_by = $1 AND (handover_status IS NULL OR handover_status = 'pending')`,
    [req.adminUser!.id]
  );
  if (unhanded[0].cnt > 0) {
    res.status(409).json({
      error: `You have ${unhanded[0].cnt} unhanded sale(s). Please submit a cash handover before clocking out.`,
      requiresHandover: true,
      unhandedCount: unhanded[0].cnt,
    });
    return;
  }

  const log = existing[0];
  const durationMin = Math.round((Date.now() - new Date(log.clock_in).getTime()) / 60000);
  const { rows } = await pool.query(
    `UPDATE staff_time_logs SET clock_out = NOW(), duration_min = $1 WHERE id = $2 RETURNING *`,
    [durationMin, log.id]
  );
  // Notify CEO/Manager that staff clocked out
  insertAlert('staff_clock_out', 'info', `${req.adminUser!.fullName} clocked out`,
    `${req.adminUser!.fullName} clocked out after ${durationMin} minutes.`,
    'time', rows[0].id.toString());
  res.json(rows[0]);
});

adminRouter.get('/clock-status', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, clock_in, clock_out, duration_min FROM staff_time_logs WHERE admin_user_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,
    [req.adminUser!.id]
  );
  res.json({ clockedIn: rows.length > 0, log: rows[0] || null });
});

adminRouter.get('/time-logs', async (req: Request, res: Response) => {
  if (req.adminUser!.role === 'CEO' || req.adminUser!.role === 'Manager') {
    const { rows: logs } = await pool.query(`
      SELECT t.id, t.admin_user_id, a.full_name, a.role, t.clock_in, t.clock_out, t.duration_min
      FROM staff_time_logs t
      LEFT JOIN admin_users a ON a.id = t.admin_user_id AND a.deleted_at IS NULL
      ORDER BY t.clock_in DESC LIMIT 500
    `);
    const { rows: summary } = await pool.query(`
      SELECT a.id, a.full_name, a.role,
        COUNT(t.id)::int AS total_shifts,
        COALESCE(SUM(t.duration_min), 0)::int AS total_minutes
      FROM admin_users a
      LEFT JOIN staff_time_logs t ON t.admin_user_id = a.id
      WHERE a.deleted_at IS NULL
      GROUP BY a.id, a.full_name, a.role
      ORDER BY total_minutes DESC
    `);
    res.json({ logs, summary });
  } else {
    const { rows } = await pool.query(
      `SELECT id, clock_in, clock_out, duration_min
       FROM staff_time_logs WHERE admin_user_id = $1
       ORDER BY clock_in DESC LIMIT 200`,
      [req.adminUser!.id]
    );
    res.json({ logs: rows, summary: [] });
  }
});

// ── Staff Management (CEO/Manager only) ──

adminRouter.get('/staff', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, role, approved, created_at
     FROM admin_users WHERE role IN ('Staff', 'Manager') AND deleted_at IS NULL ORDER BY created_at DESC`
  );
  res.json(rows);
});

adminRouter.get('/staff-pending', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, role, created_at
     FROM admin_users WHERE role IN ('Staff', 'Manager') AND approved = FALSE AND deleted_at IS NULL ORDER BY created_at DESC`
  );
  res.json(rows);
});

adminRouter.post('/staff-approve/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE admin_users SET approved = TRUE WHERE id = $1 AND role = 'Staff' RETURNING id, full_name, email, role, approved`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Staff account not found' }); return; }
  const approvedUser = rows[0];
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'staff_approve', 'admin_user', id, `Approved ${approvedUser.full_name}`);
  sendAdminApprovedNotification(approvedUser.email, approvedUser.full_name);
  res.json({ message: 'Staff account approved', user: approvedUser });
});

adminRouter.post('/staff-reject/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE admin_users SET deleted_at = NOW(), status = 'inactive' WHERE id = $1 AND role = 'Staff' AND approved = FALSE AND deleted_at IS NULL RETURNING id, full_name, email`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Pending staff account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'staff_reject', 'admin_user', id, `Rejected ${rows[0].full_name}`);
  sendAdminRejectedNotification(rows[0].email, rows[0].full_name);
  res.json({ message: 'Staff account rejected and removed' });
});

// Staff online/offline status (CEO/Manager only)
adminRouter.get('/staff-status', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.full_name, a.role, a.approved,
            t.id AS shift_id, t.clock_in, t.clock_out,
            CASE WHEN t.id IS NOT NULL AND t.clock_out IS NULL THEN true ELSE false END AS is_online
     FROM admin_users a
     LEFT JOIN LATERAL (
       SELECT id, clock_in, clock_out FROM staff_time_logs WHERE admin_user_id = a.id ORDER BY clock_in DESC LIMIT 1
     ) t ON true
     WHERE a.role IN ('Staff', 'Manager') AND a.deleted_at IS NULL
     ORDER BY is_online DESC, a.full_name ASC`
  );
  const onlineCount = rows.filter((r: any) => r.is_online).length;
  res.json({ statuses: rows, onlineCount, totalStaff: rows.length });
});

adminRouter.post('/staff-deactivate/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE admin_users SET approved = FALSE WHERE id = $1 AND role = 'Staff' RETURNING id, full_name, email, role, approved`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Staff account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'staff_deactivate', 'admin_user', id, `Deactivated ${rows[0].full_name}`);
  res.json({ message: 'Staff account deactivated', user: rows[0] });
});

adminRouter.post('/staff-activate/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE admin_users SET approved = TRUE WHERE id = $1 AND role = 'Staff' RETURNING id, full_name, email, role, approved`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Staff account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'staff_activate', 'admin_user', id, `Activated ${rows[0].full_name}`);
  res.json({ message: 'Staff account activated', user: rows[0] });
});

adminRouter.post('/staff-remove/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE admin_users SET deleted_at = NOW(), status = 'inactive' WHERE id = $1 AND role = 'Staff' AND deleted_at IS NULL RETURNING id, full_name`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Staff account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'staff_remove', 'admin_user', id, `Removed staff ${rows[0].full_name}`);
  res.json({ message: 'Staff account removed' });
});

// ── Voucher Redemptions (any role) ──

adminRouter.get('/voucher-redemptions', async (req: Request, res: Response) => {
  const voucherId = req.query.voucher_id as string | undefined;
  const params: any[] = [];
  const conditions: string[] = [];
  if (voucherId) {
    params.push(voucherId);
    conditions.push(`vr.voucher_id = $${params.length}`);
  }
  const scope = scopeVoucherCondition(req, params);
  if (scope) conditions.push(scope);
  let query = `
    SELECT vr.id, vr.voucher_code, vr.full_name, vr.mac_address, vr.ip_address, vr.created_at,
           v.code AS voucher_code_lookup
    FROM voucher_redemptions vr
    LEFT JOIN vouchers v ON v.id = vr.voucher_id
  `;
  if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
  query += ' ORDER BY vr.created_at DESC LIMIT 1000';
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// ── Active Sessions / Real-time Usage (any role) ──

adminRouter.get('/active-sessions', async (req: Request, res: Response) => {
  // Active users with voucher + package details
  const userParams: any[] = [];
  const userScope = scopeUserVoucherCodeCondition(req, userParams, 'u');
  const { rows: activeUsers } = await pool.query(`
    SELECT u.id, u.full_name, u.phone, u.voucher_code, u.mac_address, u.ip_address,
           u.session_expires_at, u.created_at,
           v.duration_min, v.max_uses, v.used_count, v.data_limit_gb, v.is_uncapped,
           v.bandwidth_mbps_up, v.bandwidth_mbps_down, v.price_amount AS voucher_price,
           v.code AS voucher_code,
           wp.data_used_bytes, wp.data_quota_bytes, wp.session_start
    FROM users u
    LEFT JOIN vouchers v ON UPPER(u.voucher_code) = UPPER(v.code)
    LEFT JOIN wispr_profiles wp ON wp.user_id = u.id
    WHERE u.session_expires_at > NOW()
    ${userScope ? 'AND ' + userScope : ''}
    ORDER BY u.created_at DESC
  `, userParams);
  // Count connected users per voucher code
  const perVoucherParams: any[] = [];
  const perVoucherScope = scopeUserVoucherCodeCondition(req, perVoucherParams, 'users');
  const { rows: perVoucher } = await pool.query(`
    SELECT voucher_code, COUNT(*)::int AS connected_users
    FROM users WHERE session_expires_at > NOW()
    ${perVoucherScope ? 'AND ' + perVoucherScope : ''}
    GROUP BY voucher_code ORDER BY connected_users DESC
  `, perVoucherParams);
  // Total active users
  const totalActiveParams: any[] = [];
  const totalActiveScope = scopeUserVoucherCodeCondition(req, totalActiveParams, 'users');
  const { rows: totalActive } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM users WHERE session_expires_at > NOW()
    ${totalActiveScope ? 'AND ' + totalActiveScope : ''}
  `, totalActiveParams);
  // Total vouchers redeemed
  const { rows: totalRedeemed } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM voucher_redemptions
  `);

  // Enrich active users with calculated fields
  const enriched = activeUsers.map((u: any) => {
    const dataLimit = u.data_limit_gb ? u.data_limit_gb * 1024 * 1024 * 1024 : null;
    const dataUsed = u.data_used_bytes ? parseInt(u.data_used_bytes) : 0;
    const dataLeft = dataLimit ? Math.max(0, dataLimit - dataUsed) : (u.is_uncapped ? -1 : 0);
    const usagePercent = dataLimit && dataLimit > 0 ? ((dataUsed / dataLimit) * 100).toFixed(1) : null;
    const expiresAt = u.session_expires_at ? new Date(u.session_expires_at).getTime() : null;
    const timeLeft = expiresAt ? Math.max(0, expiresAt - Date.now()) : 0;
    const timeLeftMin = Math.round(timeLeft / 60000);
    return {
      ...u,
      data_used_bytes: dataUsed,
      data_limit_bytes: dataLimit,
      data_left_bytes: dataLeft,
      usage_percent: usagePercent,
      time_left_min: timeLeftMin,
    };
  });

  res.json({
    totalActive: totalActive[0].count,
    totalRedeemed: totalRedeemed[0].count,
    perVoucher,
    activeUsers: enriched,
  });
});

// ── Manager Management (CEO only) ──

adminRouter.get('/managers', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, role, approved, created_at
     FROM admin_users WHERE role = 'Manager' AND deleted_at IS NULL ORDER BY created_at DESC`
  );
  res.json(rows);
});

adminRouter.post('/manager-promote/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  // Check manager slot isn't taken (max 2)
  const { rows: existing } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM admin_users WHERE role = 'Manager' AND deleted_at IS NULL`
  );
  if (existing[0].cnt >= 2) {
    res.status(409).json({ error: 'Maximum 2 Manager accounts allowed. Demote an existing Manager first.' });
    return;
  }
  const { rows } = await pool.query(
    `UPDATE admin_users SET role = 'Manager', approved = TRUE WHERE id = $1 AND role = 'Staff' RETURNING id, full_name, email, role`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Staff account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'manager_promote', 'admin_user', id, `Promoted ${rows[0].full_name} to Manager`);
  res.json({ message: 'Staff promoted to Manager', user: rows[0] });
});

adminRouter.post('/manager-demote/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE admin_users SET role = 'Staff', approved = TRUE WHERE id = $1 AND role = 'Manager' RETURNING id, full_name, email, role`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Manager account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'manager_demote', 'admin_user', id, `Demoted ${rows[0].full_name} to Staff`);
  res.json({ message: 'Manager demoted to Staff', user: rows[0] });
});

adminRouter.post('/manager-remove/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  // Prevent CEO from removing themselves
  if (id === req.adminUser!.id) {
    res.status(400).json({ error: 'Cannot remove your own account' });
    return;
  }
  const { rows } = await pool.query(
    `UPDATE admin_users SET deleted_at = NOW(), status = 'inactive' WHERE id = $1 AND role = 'Manager' AND deleted_at IS NULL RETURNING id, full_name`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Manager account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'manager_remove', 'admin_user', id, `Removed Manager ${rows[0].full_name}`);
  res.json({ message: 'Manager removed' });
});

// ── Settings (CEO only) ──

adminRouter.get('/settings', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT key, value, updated_at FROM settings ORDER BY key');
  const settingsMap: Record<string, string> = {};
  rows.forEach((r: any) => { settingsMap[r.key] = r.value; });
  res.json(settingsMap);
});

adminRouter.put('/settings', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const settings = req.body as Record<string, string>;
  const keys = Object.keys(settings);
  if (keys.length === 0) { res.status(422).json({ error: 'No settings provided' }); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of keys) {
      await client.query(
        `INSERT INTO settings (key, value, updated_at, updated_by)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
        [key, settings[key], req.adminUser!.id]
      );
    }
    await client.query('COMMIT');
    await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'settings_update', undefined, undefined, `Updated ${keys.length} setting(s)`);
    res.json({ message: `${keys.length} setting(s) updated` });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ── Admin Audit Log (CEO only) ──

adminRouter.get('/audit-log', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, admin_name, action, target_type, target_id, detail, created_at
     FROM admin_audit_log ORDER BY created_at DESC LIMIT 500`
  );
  res.json(rows);
});

// ── CSV Revenue Export (CEO only) ──

adminRouter.get('/revenue/export', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.package_tier, t.amount, t.currency, t.status, t.created_at, t.completed_at,
            u.full_name AS user_name, u.phone AS user_phone
     FROM transactions t
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.status = 'completed'
     ORDER BY t.created_at DESC`
  );

  const header = 'Transaction ID,Package Tier,Amount,Currency,Status,Created,Completed,User Name,User Phone\n';
  const csv = header + rows.map((r: any) =>
    `"${r.id}","${r.package_tier}",${r.amount},"${r.currency}","${r.status}","${r.created_at}","${r.completed_at || ''}","${(r.user_name || '').replace(/"/g, '""')}","${(r.user_phone || '').replace(/"/g, '""')}"`
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="preyone-revenue-export.csv"');
  res.send(csv);
});

adminRouter.get('/charts', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  // Daily user signups for last 7 days
  const { rows: dailySignups } = await pool.query(`
    SELECT DATE(created_at) AS day, COUNT(*)::int AS count
    FROM users
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(created_at)
    ORDER BY day
  `);
  // Active sessions right now
  const { rows: activeSessions } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM users WHERE session_expires_at > NOW()
  `);
  // Expired sessions
  const { rows: expiredSessions } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM users WHERE session_expires_at IS NOT NULL AND session_expires_at <= NOW()
  `);
  // Revenue data for last 7 days
  const { rows: dailyRevenue } = await pool.query(`
    SELECT DATE(created_at) AS day, COALESCE(SUM(amount), 0)::float AS revenue
    FROM transactions WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(created_at) ORDER BY day
  `);
  // Sales data for last 7 days
  const { rows: dailySales } = await pool.query(`
    SELECT DATE(sold_at) AS day, COALESCE(SUM(amount), 0)::float AS revenue, COUNT(*)::int AS count
    FROM sales WHERE sold_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(sold_at) ORDER BY day
  `);

  res.json({
    dailySignups,
    activeSessions: activeSessions[0].count,
    expiredSessions: expiredSessions[0].count,
    dailyRevenue,
    dailySales,
  });
});

// ═══════════════════════════════════════════════════════
// NEW: AP Health Dashboard
// ═══════════════════════════════════════════════════════

adminRouter.get('/ap-devices', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    'SELECT * FROM ap_devices ORDER BY name ASC'
  );
  res.json(rows);
});

adminRouter.post('/ap-devices', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { name, model, macAddress, ipAddress, location } = req.body as {
    name: string; model?: string; macAddress: string; ipAddress?: string; location?: string;
  };
  if (!name || !macAddress) { res.status(422).json({ error: 'name and macAddress required' }); return; }
  const { rows } = await pool.query(
    `INSERT INTO ap_devices (name, model, mac_address, ip_address, location)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, model || null, macAddress.toUpperCase(), ipAddress || null, location || null]
  );
  res.status(201).json(rows[0]);
});

adminRouter.put('/ap-devices/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, model, macAddress, ipAddress, location, status, firmwareVersion, clientsCount } = req.body as any;
  const { rows } = await pool.query(
    `UPDATE ap_devices SET
      name = COALESCE($1, name),
      model = COALESCE($2, model),
      mac_address = COALESCE($3, mac_address),
      ip_address = COALESCE($4, ip_address),
      location = COALESCE($5, location),
      status = COALESCE($6, status),
      firmware_version = COALESCE($7, firmware_version),
      clients_count = COALESCE($8, clients_count)
     WHERE id = $9 RETURNING *`,
    [name, model, macAddress ? macAddress.toUpperCase() : null, ipAddress, location, status, firmwareVersion, clientsCount, id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'AP device not found' }); return; }
  res.json(rows[0]);
});

adminRouter.delete('/ap-devices/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query('DELETE FROM ap_devices WHERE id = $1 RETURNING id', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'AP device not found' }); return; }
  res.json({ message: 'AP device removed' });
});

adminRouter.get('/ap-health', async (_req: Request, res: Response) => {
  const { rows: devices } = await pool.query('SELECT * FROM ap_devices ORDER BY name ASC');
  const total = devices.length;
  const online = devices.filter((d: any) => d.status === 'online').length;
  const offline = devices.filter((d: any) => d.status === 'offline').length;
  const warning = devices.filter((d: any) => d.status === 'warning').length;
  const totalClients = devices.reduce((sum: number, d: any) => sum + (d.clients_count || 0), 0);

  // Recent bandwidth snapshots
  const { rows: recentBw } = await pool.query(`
    SELECT ap_id, SUM(bytes_up)::bigint AS bytes_up, SUM(bytes_down)::bigint AS bytes_down,
           AVG(clients_count)::int AS avg_clients, MAX(recorded_at) AS last_recorded
    FROM ap_bandwidth_snapshots
    WHERE recorded_at >= NOW() - INTERVAL '1 hour'
    GROUP BY ap_id
  `);

  res.json({ total, online, offline, warning, totalClients, devices, recentBw });
});

// ═══════════════════════════════════════════════════════
// NEW: Real-time Bandwidth Monitor
// ═══════════════════════════════════════════════════════

adminRouter.get('/bandwidth', async (_req: Request, res: Response) => {
  // Aggregate bandwidth from wispr_profiles (per-user actual usage)
  const { rows: aggregate } = await pool.query(`
    SELECT
      COALESCE(SUM(data_used_bytes), 0)::bigint AS total_bytes_used,
      COUNT(*)::int AS total_profiles,
      COALESCE(SUM(data_quota_bytes), 0)::bigint AS total_quota
    FROM wispr_profiles
    WHERE session_end IS NULL
  `);

  // Hourly bandwidth snapshots for last 24h
  const { rows: hourly } = await pool.query(`
    SELECT
      DATE_TRUNC('hour', recorded_at) AS hour,
      SUM(bytes_up)::bigint AS bytes_up,
      SUM(bytes_down)::bigint AS bytes_down
    FROM ap_bandwidth_snapshots
    WHERE recorded_at >= NOW() - INTERVAL '24 hours'
    GROUP BY DATE_TRUNC('hour', recorded_at)
    ORDER BY hour
  `);

  // Active user count now
  const { rows: activeNow } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM users WHERE session_expires_at > NOW()
  `);

  res.json({
    totalBytesUsed: aggregate[0].total_bytes_used,
    totalProfiles: aggregate[0].total_profiles,
    totalQuota: aggregate[0].total_quota,
    activeNow: activeNow[0].count,
    hourly,
  });
});

adminRouter.get('/bandwidth/top-users', async (req: Request, res: Response) => {
  const params: any[] = [];
  const scope = scopeVoucherCondition(req, params);
  const { rows } = await pool.query(`
    SELECT u.id, u.full_name, u.mac_address, u.ip_address,
           wp.data_used_bytes, wp.data_quota_bytes, wp.bandwidth_up_kbps, wp.bandwidth_down_kbps,
           wp.session_start, wp.is_uncapped
    FROM wispr_profiles wp
    INNER JOIN users u ON u.id = wp.user_id
    LEFT JOIN vouchers v ON UPPER(u.voucher_code) = UPPER(v.code)
    WHERE wp.session_end IS NULL
    ${scope ? 'AND ' + scope : ''}
    ORDER BY wp.data_used_bytes DESC
    LIMIT 20
  `, params);
  res.json(rows);
});

// ═══════════════════════════════════════════════════════
// NEW: Peak Hour / Usage Analytics
// ═══════════════════════════════════════════════════════

adminRouter.get('/peak-hours', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  // User signups grouped by hour for last 7 days
  const { rows: signupHours } = await pool.query(`
    SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count
    FROM users
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY EXTRACT(HOUR FROM created_at)
    ORDER BY hour
  `);

  // Access log events grouped by hour for last 7 days
  const { rows: accessHours } = await pool.query(`
    SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count
    FROM access_log
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY EXTRACT(HOUR FROM created_at)
    ORDER BY hour
  `);

  // Daily active session peak (from users table, session creation day)
  const { rows: dailyPeaks } = await pool.query(`
    SELECT DATE(created_at) AS day, COUNT(*)::int AS signups
    FROM users
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY DATE(created_at)
    ORDER BY day
  `);

  res.json({ signupHours, accessHours, dailyPeaks });
});

// ═══════════════════════════════════════════════════════
// NEW: Alerting System
// ═══════════════════════════════════════════════════════

adminRouter.get('/alerts', async (req: Request, res: Response) => {
  const role = req.adminUser!.role;
  if (role === 'Staff') {
    // Staff sees only alerts specifically addressed to them
    const { rows: active } = await pool.query(`
      SELECT * FROM alerts WHERE acknowledged = FALSE AND admin_id = $1 ORDER BY created_at DESC
    `, [req.adminUser!.id]);
    const { rows: all } = await pool.query(`
      SELECT * FROM alerts WHERE admin_id = $1 ORDER BY created_at DESC LIMIT 100
    `, [req.adminUser!.id]);
    const { rows: counts } = await pool.query(`
      SELECT severity, COUNT(*)::int AS count FROM alerts WHERE acknowledged = FALSE AND admin_id = $1 GROUP BY severity
    `, [req.adminUser!.id]);
    res.json({ active, all, counts, totalUnacknowledged: active.length });
  } else {
    // CEO/Manager see all management alerts (admin_id IS NULL)
    const { rows: active } = await pool.query(`
      SELECT * FROM alerts WHERE acknowledged = FALSE AND admin_id IS NULL ORDER BY created_at DESC
    `);
    const { rows: all } = await pool.query(`
      SELECT * FROM alerts WHERE admin_id IS NULL ORDER BY created_at DESC LIMIT 100
    `);
    const { rows: counts } = await pool.query(`
      SELECT severity, COUNT(*)::int AS count FROM alerts WHERE acknowledged = FALSE AND admin_id IS NULL GROUP BY severity
    `);
    res.json({ active, all, counts, totalUnacknowledged: active.length });
  }
});

adminRouter.post('/alerts/:id/acknowledge', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE alerts SET acknowledged = TRUE, acknowledged_by = $1 WHERE id = $2 AND acknowledged = FALSE RETURNING *`,
    [req.adminUser!.id, id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Alert not found or already acknowledged' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'alert_acknowledge', 'alert', id, `Acknowledged: ${rows[0].title}`);
  res.json(rows[0]);
});

// ═══════════════════════════════════════════════════════
// NEW: MAC Blacklist / Whitelist Management
// ═══════════════════════════════════════════════════════

adminRouter.get('/blacklist', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT b.*, a.full_name AS blocked_by_name
     FROM mac_blacklist b
     LEFT JOIN admin_users a ON a.id = b.blocked_by AND a.deleted_at IS NULL
     ORDER BY b.created_at DESC`
  );
  res.json(rows);
});

adminRouter.post('/blacklist', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { macAddress, reason } = req.body as { macAddress: string; reason?: string };
  if (!macAddress) { res.status(422).json({ error: 'macAddress required' }); return; }
  const mac = macAddress.toUpperCase();
  // Check not already blacklisted
  const { rows: existing } = await pool.query('SELECT id FROM mac_blacklist WHERE mac_address = $1', [mac]);
  if (existing.length > 0) { res.status(409).json({ error: 'MAC already blacklisted' }); return; }
  const { rows } = await pool.query(
    `INSERT INTO mac_blacklist (mac_address, reason, blocked_by) VALUES ($1, $2, $3) RETURNING *`,
    [mac, reason || null, req.adminUser!.id]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'blacklist_add', 'mac', mac, `Blacklisted ${mac}: ${reason || 'No reason'}`);
  res.status(201).json(rows[0]);
});

adminRouter.delete('/blacklist/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query('DELETE FROM mac_blacklist WHERE id = $1 RETURNING mac_address', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Blacklist entry not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'blacklist_remove', 'mac', rows[0].mac_address, `Unblacklisted ${rows[0].mac_address}`);
  res.json({ message: 'MAC removed from blacklist' });
});

adminRouter.get('/whitelist', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT w.*, a.full_name AS added_by_name
     FROM mac_whitelist w
     LEFT JOIN admin_users a ON a.id = w.added_by AND a.deleted_at IS NULL
     ORDER BY w.created_at DESC`
  );
  res.json(rows);
});

adminRouter.post('/whitelist', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { macAddress, label } = req.body as { macAddress: string; label?: string };
  if (!macAddress) { res.status(422).json({ error: 'macAddress required' }); return; }
  const mac = macAddress.toUpperCase();
  const { rows: existing } = await pool.query('SELECT id FROM mac_whitelist WHERE mac_address = $1', [mac]);
  if (existing.length > 0) { res.status(409).json({ error: 'MAC already whitelisted' }); return; }
  const { rows } = await pool.query(
    `INSERT INTO mac_whitelist (mac_address, label, added_by) VALUES ($1, $2, $3) RETURNING *`,
    [mac, label || null, req.adminUser!.id]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'whitelist_add', 'mac', mac, `Whitelisted ${mac}: ${label || 'No label'}`);
  res.status(201).json(rows[0]);
});

adminRouter.delete('/whitelist/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query('DELETE FROM mac_whitelist WHERE id = $1 RETURNING mac_address', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Whitelist entry not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'whitelist_remove', 'mac', rows[0].mac_address, `Removed ${rows[0].mac_address} from whitelist`);
  res.json({ message: 'MAC removed from whitelist' });
});

// ═══════════════════════════════════════════════════════
// NEW: Bulk Voucher Operations
// ═══════════════════════════════════════════════════════

adminRouter.post('/vouchers/bulk', async (req: Request, res: Response) => {
  const { count = 10, packageTier, priceAmount, expiresAt, paymentMethod, paymentReference, holderName, holderPhone } = req.body as {
    count?: number; packageTier?: string; priceAmount?: number; expiresAt?: string;
    paymentMethod?: string; paymentReference?: string; holderName?: string; holderPhone?: string;
  };

  const saleMethod = paymentMethod && paymentMethod.trim() ? paymentMethod.trim() : 'Cash';
  const saleReference = paymentReference && paymentReference.trim() ? paymentReference.trim() : null;
  const holderNameValue = holderName && holderName.trim() ? holderName.trim().slice(0, 120) : null;
  const holderPhoneValue = holderPhone && holderPhone.trim() ? holderPhone.trim().slice(0, 32) : null;

  if (!packageTier) { res.status(422).json({ error: 'packageTier required' }); return; }
  if (count < 1 || count > 100) { res.status(422).json({ error: 'count must be between 1 and 100' }); return; }

  // Staff cannot create bulk vouchers at all — must request approval
  if (req.adminUser!.role === 'Staff') {
    res.status(403).json({
      error: 'Staff cannot sell Bulk vouchers. Only Management may approve the sale. Submit an approval request.',
      requiresApproval: true
    });
    return;
  }

  // Manager must be clocked in to create bulk vouchers
  if (req.adminUser!.role === 'Manager') {
    const clockedIn = await requireClockedIn(req.adminUser!.id);
    if (!clockedIn) {
      res.status(403).json({ error: 'You must clock in before selling vouchers.' });
      return;
    }
  }

  // Lookup package
  const { rows: pkgs } = await pool.query(
    `SELECT tier_name, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, max_devices
     FROM packages WHERE tier_name = $1 AND deleted_at IS NULL`,
    [packageTier]
  );
  if (pkgs.length === 0) { res.status(422).json({ error: 'Package not found' }); return; }
  const pkg = pkgs[0];

  const slug = packageTier.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

  // Ruijie Cloud: mint all codes up front (one API call each, quantity=1) so the
  // HTTP work never happens inside the DB transaction.
  let ruijieMints: StaffRuijieMint[] = [];
  if (isRuijieCloudConfigured()) {
    for (let i = 0; i < count; i++) {
      const m = await staffRuijieMint(packageTier, `Bulk by ${req.adminUser!.fullName}`);
      if (!m) break;
      ruijieMints.push(m);
    }
  }
  const created: any[] = [];
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < count; i++) {
      const bytes = crypto.randomBytes(4);
      let rand = '';
      for (let j = 0; j < 4; j++) rand += chars[bytes[j] % chars.length];
      const code = ruijieMints.length > i ? ruijieMints[i].code : `${slug}-${rand}`.toLowerCase();

      const { rows } = await client.query(
        `INSERT INTO vouchers (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, sold_by, price_amount, package_tier, max_devices, holder_name, holder_phone)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [code, pkg.duration_min, expiresAt || null, pkg.data_limit_gb, pkg.is_uncapped, pkg.bandwidth_mbps_up, pkg.bandwidth_mbps_down, req.adminUser!.id, priceAmount || null, packageTier, pkg.max_devices, holderNameValue, holderPhoneValue]
      );

      if (ruijieMints.length > i) {
        await client.query(RUIJIE_VOUCHER_AUDIT_SQL, [
          ruijieMints[i].code, packageTier, ruijieMints[i].userGroupId, ruijieMints[i].profile,
          ruijieMints[i].expiryTime ?? null, null, 'staff', null,
        ]);
      }

      // Log sale if price set
      if (priceAmount && priceAmount > 0) {
        await client.query(
          `INSERT INTO sales (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency, payment_method, payment_reference)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [rows[0].id, rows[0].code, req.adminUser!.id, req.adminUser!.fullName, priceAmount, 'USD', saleMethod, saleReference]
        );
      }
      created.push(rows[0]);
    }
    await client.query('COMMIT');
    await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'bulk_voucher_create', 'voucher', undefined, `Created ${count} vouchers for ${packageTier}`);
    res.status(201).json({ message: `${count} voucher(s) created`, count, vouchers: created });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════
// Voucher Approval Workflow (Staff → Manager/CEO)
// ═══════════════════════════════════════════════════════

const APPROVAL_TIERS = ['PreMax', 'PreUltra', 'PreExecutive'];

async function insertAlert(type: string, severity: string, title: string, message: string, targetType: string, targetId: string, adminId?: string) {
  try {
    await pool.query(
      `INSERT INTO alerts (type, severity, title, message, target_type, target_id, admin_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [type, severity, title, message, targetType, targetId, adminId || null]
    );
  } catch (_) { /* alert logging is best-effort */ }
}

// Helper: check if user is clocked in (for Staff/Manager voucher creation)
async function requireClockedIn(adminId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id FROM staff_time_logs WHERE admin_user_id = $1 AND clock_out IS NULL LIMIT 1`,
    [adminId]
  );
  return rows.length > 0;
}

// Staff submits an approval request
adminRouter.post('/vouchers/request-approval', async (req: Request, res: Response) => {
  const { requestType, packageTier, priceAmount, count, code, maxUses, paymentMethod, paymentReference } = req.body as {
    requestType: string; packageTier: string; priceAmount?: number; count?: number; code?: string; maxUses?: number;
    paymentMethod?: string; paymentReference?: string;
  };

  if (!requestType || !packageTier) {
    res.status(422).json({ error: 'requestType and packageTier required' }); return;
  }
  if (requestType !== 'single' && requestType !== 'bulk') {
    res.status(422).json({ error: 'requestType must be single or bulk' }); return;
  }

  const { rows: pkgs } = await pool.query(
    'SELECT tier_name FROM packages WHERE tier_name = $1 AND deleted_at IS NULL', [packageTier]
  );
  if (pkgs.length === 0) { res.status(422).json({ error: 'Package not found' }); return; }

  // Staff can request bulk + restricted tiers; Manager/CEO bypasses
  if (req.adminUser!.role !== 'Staff') {
    res.status(403).json({ error: 'Only Staff need approval. Create vouchers directly.' }); return;
  }

  const { rows } = await pool.query(
    `INSERT INTO voucher_approvals (requested_by, requested_by_name, request_type, package_tier, voucher_count, price_amount, max_uses, voucher_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [req.adminUser!.id, req.adminUser!.fullName, requestType, packageTier, count || 1, priceAmount || null, maxUses || 1,
     JSON.stringify({ code: code || null, paymentMethod: (paymentMethod && paymentMethod.trim()) ? paymentMethod.trim() : 'Cash', paymentReference: (paymentReference && paymentReference.trim()) ? paymentReference.trim() : null })]
  );

  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'voucher_approval_request', 'voucher_approval', rows[0].id,
    `Requested ${requestType} voucher(s) for ${packageTier}${priceAmount ? ' ($' + priceAmount + ')' : ''}`);

  // Alert for management + specific alert for the requesting staff
  await insertAlert('voucher_approval_request', 'info', 'Voucher Approval Request',
    `${req.adminUser!.fullName} requested ${count || 1} ${requestType} voucher(s) for ${packageTier}`,
    'voucher_approval', rows[0].id);
  await insertAlert('voucher_approval_submitted', 'info', 'Approval Request Submitted',
    `Your request for ${count || 1} ${requestType} voucher(s) for ${packageTier} has been submitted for approval.`,
    'voucher_approval', rows[0].id, req.adminUser!.id);

  res.status(201).json({ message: 'Approval request submitted. Awaiting management approval.', approval: rows[0] });
});

// Manager/CEO views pending approvals
adminRouter.get('/vouchers/pending-approvals', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT * FROM voucher_approvals WHERE status = 'pending' ORDER BY created_at DESC`
  );
  res.json(rows);
});

// Manager/CEO approves a request
adminRouter.post('/vouchers/approvals/:id/approve', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const { id } = req.params;

  const { rows: existing } = await pool.query(
    'SELECT * FROM voucher_approvals WHERE id = $1', [id]
  );
  if (existing.length === 0) { res.status(404).json({ error: 'Approval request not found' }); return; }
  const approval = existing[0];
  if (approval.status !== 'pending') { res.status(400).json({ error: 'Request already ' + approval.status }); return; }

  const pkgRes = await pool.query(
    `SELECT tier_name, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, max_devices
     FROM packages WHERE tier_name = $1 AND deleted_at IS NULL`, [approval.package_tier]
  );
  if (pkgRes.rows.length === 0) { res.status(422).json({ error: 'Package not found' }); return; }
  const pkg = pkgRes.rows[0];

  const slug = approval.package_tier.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const created: any[] = [];
  const count = approval.voucher_count || 1;
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';

  // Ruijie Cloud: mint all codes up front so HTTP work happens before BEGIN.
  let ruijieMints: StaffRuijieMint[] = [];
  if (isRuijieCloudConfigured()) {
    for (let i = 0; i < count; i++) {
      const m = await staffRuijieMint(approval.package_tier, `Approval by ${req.adminUser!.fullName}`);
      if (!m) break;
      ruijieMints.push(m);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < count; i++) {
      const bytes = crypto.randomBytes(4);
      let rand = '';
      for (let j = 0; j < 4; j++) rand += chars[bytes[j] % chars.length];
      const voucherCode = ruijieMints.length > i
        ? ruijieMints[i].code
        : (approval.request_type === 'single' && approval.voucher_data?.code
          ? String(approval.voucher_data.code || '').trim().toLowerCase()
          : `${slug}-${rand}`);

      const { rows: vrows } = await client.query(
        `INSERT INTO vouchers (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, sold_by, price_amount, package_tier, max_devices)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
         [voucherCode, pkg.duration_min, approval.max_uses || 1, pkg.data_limit_gb, pkg.is_uncapped, pkg.bandwidth_mbps_up, pkg.bandwidth_mbps_down,
          approval.requested_by, approval.price_amount || null, approval.package_tier, pkg.max_devices]
      );

      if (ruijieMints.length > i) {
        await client.query(RUIJIE_VOUCHER_AUDIT_SQL, [
          ruijieMints[i].code, approval.package_tier, ruijieMints[i].userGroupId, ruijieMints[i].profile,
          ruijieMints[i].expiryTime ?? null, null, 'staff', null,
        ]);
      }

      if (approval.price_amount && approval.price_amount > 0) {
        await client.query(
          `INSERT INTO sales (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency, payment_method, payment_reference)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [vrows[0].id, vrows[0].code, approval.requested_by, approval.requested_by_name, approval.price_amount, 'USD',
           approval.voucher_data?.paymentMethod || 'Cash', approval.voucher_data?.paymentReference || null]
        );
      }
      created.push(vrows[0]);
    }

    await client.query(
      `UPDATE voucher_approvals SET status = 'approved', approved_by = $1, approved_by_name = $2, approved_at = NOW(), updated_at = NOW(), voucher_data = $3::jsonb
       WHERE id = $4`,
      [req.adminUser!.id, req.adminUser!.fullName, JSON.stringify({ codes: created.map((v: any) => v.code) }), id]
    );

    await client.query('COMMIT');

    await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'voucher_approval_approve', 'voucher_approval', id,
      `Approved ${count} ${approval.request_type} voucher(s) for ${approval.package_tier} (requested by ${approval.requested_by_name})`);

    await insertAlert('voucher_approval_approved', 'success', 'Voucher Request Approved',
      `${approval.requested_by_name}'s ${approval.request_type} voucher request for ${approval.package_tier} was approved by ${req.adminUser!.fullName}`,
      'voucher_approval', id);
    await insertAlert('voucher_approval_approved_notify', 'success', 'Your Voucher Request Was Approved',
      `Your ${approval.request_type} voucher request for ${approval.package_tier} was approved by ${req.adminUser!.fullName}. You can now download the vouchers.`,
      'voucher_approval', id, approval.requested_by);

    res.json({ message: `${count} voucher(s) approved and created`, count, vouchers: created });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Manager/CEO rejects a request
adminRouter.post('/vouchers/approvals/:id/reject', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows: existing } = await pool.query('SELECT * FROM voucher_approvals WHERE id = $1', [id]);
  if (existing.length === 0) { res.status(404).json({ error: 'Approval request not found' }); return; }
  if (existing[0].status !== 'pending') { res.status(400).json({ error: 'Request already ' + existing[0].status }); return; }

  await pool.query(
    `UPDATE voucher_approvals SET status = 'rejected', approved_by = $1, approved_by_name = $2, approved_at = NOW(), updated_at = NOW()
     WHERE id = $3`,
    [req.adminUser!.id, req.adminUser!.fullName, id]
  );

  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'voucher_approval_reject', 'voucher_approval', id,
    `Rejected ${existing[0].request_type} voucher request for ${existing[0].package_tier} by ${existing[0].requested_by_name}`);

  await insertAlert('voucher_approval_rejected', 'warning', 'Voucher Request Rejected',
    `${existing[0].requested_by_name}'s ${existing[0].request_type} voucher request for ${existing[0].package_tier} was rejected by ${req.adminUser!.fullName}`,
    'voucher_approval', id);
  await insertAlert('voucher_approval_rejected_notify', 'warning', 'Your Voucher Request Was Rejected',
    `Your ${existing[0].request_type} voucher request for ${existing[0].package_tier} was rejected by ${req.adminUser!.fullName}.`,
    'voucher_approval', id, existing[0].requested_by);

  res.json({ message: 'Request rejected' });
});

// Staff views their approved/rejected requests
adminRouter.get('/vouchers/my-approvals', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT * FROM voucher_approvals WHERE requested_by = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.adminUser!.id]
  );
  res.json(rows);
});

// ═══════════════════════════════════════════════════════
// Staff Dashboard Stats (own data only)
// ═══════════════════════════════════════════════════════

adminRouter.get('/staff/stats', async (req: Request, res: Response) => {
  const staffId = req.adminUser!.id;

  const { rows: activeSessions } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM users
    WHERE session_expires_at > NOW()
    AND voucher_code IN (SELECT code FROM vouchers WHERE sold_by = $1)
  `, [staffId]);

  const { rows: totalUsers } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM users
    WHERE voucher_code IN (SELECT code FROM vouchers WHERE sold_by = $1)
  `, [staffId]);

  const { rows: vouchersCreated } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM vouchers WHERE sold_by = $1
  `, [staffId]);

  const { rows: vouchersUsed } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM vouchers
    WHERE sold_by = $1 AND used_count > 0
  `, [staffId]);

  res.json({
    activeSessions: activeSessions[0].count,
    totalUsers: totalUsers[0].count,
    vouchersCreated: vouchersCreated[0].count,
    vouchersUsed: vouchersUsed[0].count,
  });
});

// ═══════════════════════════════════════════════════════
// Cash Handover Routes (Staff → Manager/CEO)
// ═══════════════════════════════════════════════════════

// Get sales available for handover (Staff's unhanded sales)
adminRouter.get('/cash-handovers/available-sales', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT s.*, v.code AS voucher_code, v.package_tier
     FROM sales s
     INNER JOIN vouchers v ON v.id = s.voucher_id
     WHERE s.sold_by = $1 AND (s.handover_status IS NULL OR s.handover_status = 'pending')
       AND (s.payment_method IS NULL OR s.payment_method = 'Cash')
     ORDER BY s.sold_at DESC`,
    [req.adminUser!.id]
  );
  const totalAvailable = rows.reduce((sum: number, r: any) => sum + (parseFloat(r.amount) || 0), 0);
  res.json({ sales: rows, totalAvailable, count: rows.length });
});

// Staff submits a cash handover
adminRouter.post('/cash-handovers', async (req: Request, res: Response) => {
  const { saleIds } = req.body as { saleIds: string[] };
  if (!saleIds || saleIds.length === 0) {
    res.status(422).json({ error: 'At least one sale required' }); return;
  }

  // Verify all sales belong to this staff and are unhanded
  const { rows: sales } = await pool.query(
    `SELECT s.* FROM sales s
     WHERE s.id = ANY($1::uuid[]) AND s.sold_by = $2 AND (s.handover_status IS NULL OR s.handover_status = 'pending')
       AND (s.payment_method IS NULL OR s.payment_method = 'Cash')`,
    [saleIds, req.adminUser!.id]
  );

  if (sales.length !== saleIds.length) {
    res.status(422).json({ error: 'Some sales not found, already handed over, or not yours' }); return;
  }

  const totalAmount = sales.reduce((sum: number, s: any) => sum + (parseFloat(s.amount) || 0), 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: handovers } = await client.query(
      `INSERT INTO cash_handovers (staff_id, staff_name, total_amount, sale_count)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.adminUser!.id, req.adminUser!.fullName, totalAmount, sales.length]
    );
    const handover = handovers[0];

    // Update all sales in this handover
    await client.query(
      `UPDATE sales SET handover_id = $1, handover_status = 'handed_over'
       WHERE id = ANY($2::uuid[])`,
      [handover.id, saleIds]
    );

    await client.query('COMMIT');

    await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'cash_handover_submit', 'cash_handover', handover.id,
      `Handed over $${totalAmount.toFixed(2)} from ${sales.length} sale(s)`);

    await insertAlert('cash_handover_request', 'info', 'Cash Handover Submitted',
      `${req.adminUser!.fullName} handed over $${totalAmount.toFixed(2)} from ${sales.length} sale(s) for approval`,
      'cash_handover', handover.id);

    res.status(201).json({ message: `Handover of $${totalAmount.toFixed(2)} submitted for approval`, handover });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Manager/CEO views pending handovers
adminRouter.get('/cash-handovers/pending', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT * FROM cash_handovers WHERE status = 'pending' ORDER BY created_at DESC`
  );
  // Include the sales for each handover
  const result = [];
  for (const h of rows) {
    const { rows: sales } = await pool.query(
      `SELECT s.*, v.code AS voucher_code, v.package_tier
       FROM sales s
       INNER JOIN vouchers v ON v.id = s.voucher_id
       WHERE s.handover_id = $1`,
      [h.id]
    );
    result.push({ ...h, sales });
  }
  res.json(result);
});

// Manager/CEO approves a handover
adminRouter.post('/cash-handovers/:id/approve', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows: existing } = await pool.query('SELECT * FROM cash_handovers WHERE id = $1', [id]);
  if (existing.length === 0) { res.status(404).json({ error: 'Handover not found' }); return; }
  if (existing[0].status !== 'pending') { res.status(400).json({ error: 'Handover already ' + existing[0].status }); return; }

  await pool.query(
    `UPDATE cash_handovers SET status = 'approved', approved_by = $1, approved_by_name = $2, approved_at = NOW()
     WHERE id = $3`,
    [req.adminUser!.id, req.adminUser!.fullName, id]
  );

  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'cash_handover_approve', 'cash_handover', id,
    `Approved handover of $${parseFloat(existing[0].total_amount).toFixed(2)} from ${existing[0].staff_name}`);

  await insertAlert('cash_handover_approved', 'success', 'Cash Handover Approved',
    `${existing[0].staff_name}'s cash handover of $${parseFloat(existing[0].total_amount).toFixed(2)} was approved by ${req.adminUser!.fullName}`,
    'cash_handover', id);

  res.json({ message: 'Cash handover approved' });
});

// Manager/CEO rejects a handover
adminRouter.post('/cash-handovers/:id/reject', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows: existing } = await pool.query('SELECT * FROM cash_handovers WHERE id = $1', [id]);
  if (existing.length === 0) { res.status(404).json({ error: 'Handover not found' }); return; }
  if (existing[0].status !== 'pending') { res.status(400).json({ error: 'Handover already ' + existing[0].status }); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE cash_handovers SET status = 'rejected', approved_by = $1, approved_by_name = $2, approved_at = NOW()
       WHERE id = $3`,
      [req.adminUser!.id, req.adminUser!.fullName, id]
    );

    // Return sales to pending status
    await client.query(
      `UPDATE sales SET handover_id = NULL, handover_status = 'pending'
       WHERE handover_id = $1`,
      [id]
    );

    await client.query('COMMIT');

    await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'cash_handover_reject', 'cash_handover', id,
      `Rejected handover of $${parseFloat(existing[0].total_amount).toFixed(2)} from ${existing[0].staff_name}`);

    await insertAlert('cash_handover_rejected', 'warning', 'Cash Handover Rejected',
      `${existing[0].staff_name}'s cash handover of $${parseFloat(existing[0].total_amount).toFixed(2)} was rejected by ${req.adminUser!.fullName}. Sales returned to pending.`,
      'cash_handover', id);

    res.json({ message: 'Cash handover rejected. Sales returned to pending.' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Staff views their handover history
adminRouter.get('/cash-handovers/my', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT * FROM cash_handovers WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.adminUser!.id]
  );
  res.json(rows);
});

// ═══════════════════════════════════════════════════════
// NEW: Customer Experience KPIs
// ═══════════════════════════════════════════════════════

adminRouter.get('/customer-kpis', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (_req: Request, res: Response) => {
  // Average session duration
  const { rows: avgSession } = await pool.query(`
    SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(session_expires_at, NOW()) - created_at)) / 60), 0)::float AS avg_duration_min
    FROM users WHERE session_expires_at IS NOT NULL
  `);

  // Average data per user
  const { rows: avgData } = await pool.query(`
    SELECT COALESCE(AVG(data_used_bytes), 0)::bigint AS avg_bytes_per_user
    FROM wispr_profiles
  `);

  // Reconnection rate (users who have used multiple vouchers)
  const { rows: reconnectStats } = await pool.query(`
    SELECT
      COUNT(DISTINCT mac_address) AS unique_macs,
      COUNT(*)::int AS total_uses,
      CASE WHEN COUNT(DISTINCT mac_address) > 0
        THEN ROUND((COUNT(*)::numeric - COUNT(DISTINCT mac_address)::numeric) / COUNT(*)::numeric * 100, 1)
        ELSE 0 END AS reconnect_rate
    FROM voucher_redemptions
  `);

  // Top packages sold
  const { rows: topPackages } = await pool.query(`
    SELECT COALESCE(package_tier, 'Unknown') AS package_tier, COUNT(*)::int AS count
    FROM vouchers WHERE package_tier IS NOT NULL
    GROUP BY package_tier ORDER BY count DESC LIMIT 5
  `);

  // Session success rate (ratio of completed sessions)
  const totalUsers = (await pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count;
  const expiredSessions = (await pool.query(`
    SELECT COUNT(*)::int AS count FROM users WHERE session_expires_at IS NOT NULL AND session_expires_at <= NOW()
  `)).rows[0].count;

  res.json({
    avgSessionDurationMin: Math.round(avgSession[0].avg_duration_min * 10) / 10,
    avgBytesPerUser: avgData[0].avg_bytes_per_user,
    reconnectRate: reconnectStats[0].reconnect_rate || 0,
    uniqueMacs: reconnectStats[0].unique_macs || 0,
    totalRedemptionUses: reconnectStats[0].total_uses || 0,
    topPackages,
    totalUsers,
    completedSessions: expiredSessions,
    completionRate: totalUsers > 0 ? Math.round((expiredSessions / totalUsers) * 1000) / 10 : 0,
  });
});

// ═══════════════════════════════════════════════════════
// NEW: Network-wide QoS View
// ═══════════════════════════════════════════════════════

adminRouter.get('/qos-view', async (_req: Request, res: Response) => {
  const { rows: qosData } = await pool.query(`
    SELECT
      u.id AS user_id, u.full_name, u.mac_address, u.ip_address, u.voucher_code,
      wp.bandwidth_up_kbps, wp.bandwidth_down_kbps,
      wp.data_used_bytes, wp.data_quota_bytes, wp.is_uncapped,
      wp.session_start,
      p.bandwidth_mbps_up AS package_bw_up, p.bandwidth_mbps_down AS package_bw_down,
      p.tier_name, p.display_name
    FROM wispr_profiles wp
    INNER JOIN users u ON u.id = wp.user_id
    LEFT JOIN vouchers v ON UPPER(u.voucher_code) = UPPER(v.code)
    LEFT JOIN packages p ON v.data_limit_gb IS NOT DISTINCT FROM p.data_limit_gb AND p.deleted_at IS NULL
      AND v.bandwidth_mbps_up = p.bandwidth_mbps_up
      AND v.bandwidth_mbps_down = p.bandwidth_mbps_down
    WHERE wp.session_end IS NULL
    ORDER BY wp.data_used_bytes DESC
  `);

  // Aggregate QoS stats
  const totalProfiles = qosData.length;
  const throttled = qosData.filter((r: any) => r.bandwidth_up_kbps < (r.package_bw_up || 0) * 1000).length;

  res.json({
    totalActiveProfiles: totalProfiles,
    throttledUsers: throttled,
    matchingQoS: totalProfiles - throttled,
    profiles: qosData,
  });
});

// ═══════════════════════════════════════════════════════
// Notification counts for polling
// ═══════════════════════════════════════════════════════

adminRouter.get('/notifications/count', async (req: Request, res: Response) => {
  const role = req.adminUser!.role;
  const result: any = {};

  // Unread broadcasts for all roles
  const { rows: unreadBcasts } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM broadcast_notifications WHERE NOT (read_by @> $1::jsonb)`,
    [JSON.stringify([req.adminUser!.id])]
  );
  result.unreadBroadcasts = unreadBcasts[0].count;

  if (role === 'CEO' || role === 'Manager') {
    const { rows: pendingApprovals } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM voucher_approvals WHERE status = 'pending'`
    );
    const { rows: pendingHandovers } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM cash_handovers WHERE status = 'pending'`
    );
    const { rows: pendingStaff } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM admin_users WHERE role IN ('Staff', 'Manager') AND approved = FALSE AND deleted_at IS NULL`
    );
    result.pendingApprovals = pendingApprovals[0].count;
    result.pendingHandovers = pendingHandovers[0].count;
    result.pendingStaff = pendingStaff[0].count;
  }

  if (role === 'Staff') {
    const { rows: approved } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM voucher_approvals WHERE requested_by = $1 AND status = 'approved' AND (voucher_data->>'notified' IS NULL OR voucher_data->>'notified' = 'false')`,
      [req.adminUser!.id]
    );
    result.newApproved = approved[0].count;
  }

  // Total = sum of all pending items
  result.total = (result.pendingApprovals || 0) + (result.pendingHandovers || 0) + (result.newApproved || 0) + result.unreadBroadcasts;

  res.json(result);
});

// Allow Staff to mark notifications as seen
adminRouter.post('/notifications/acknowledge', async (req: Request, res: Response) => {
  if (req.adminUser!.role === 'Staff') {
    await pool.query(
      `UPDATE voucher_approvals SET voucher_data = jsonb_set(COALESCE(voucher_data, '{}'::jsonb), '{notified}', '"true"')
       WHERE requested_by = $1 AND status = 'approved' AND (voucher_data->>'notified' IS NULL OR voucher_data->>'notified' = 'false')`,
      [req.adminUser!.id]
    );
  }
  res.json({ message: 'ok' });
});

// ═══════════════════════════════════════════════════════
// NEW: Bandwidth Snapshot ingestion (for Ruijie AP integration)
// ═══════════════════════════════════════════════════════

adminRouter.post('/bandwidth/snapshot', async (req: Request, res: Response) => {
  const { apId, bytesUp, bytesDown, clientsCount } = req.body as {
    apId: string; bytesUp: number; bytesDown: number; clientsCount?: number;
  };
  if (!apId) { res.status(422).json({ error: 'apId required' }); return; }
  const { rows } = await pool.query(
    `INSERT INTO ap_bandwidth_snapshots (ap_id, bytes_up, bytes_down, clients_count)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [apId, bytesUp || 0, bytesDown || 0, clientsCount || 0]
  );
  res.status(201).json(rows[0]);
});

// ═══════════════════════════════════════════════════════
// CEO: Package Management (CRUD)
// ═══════════════════════════════════════════════════════

adminRouter.get('/packages/manage', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM packages WHERE deleted_at IS NULL ORDER BY price_amount ASC');
  res.json(rows);
});

adminRouter.post('/packages', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { tierName, displayName, priceAmount, priceCurrency, billingPeriod, durationMin, dataLimitGb, isUncapped, bandwidthUp, bandwidthDown, maxDevices } = req.body as any;
  if (!tierName || !displayName || priceAmount === undefined) {
    res.status(422).json({ error: 'tierName, displayName, and priceAmount are required' }); return;
  }
  const { rows } = await pool.query(
    `INSERT INTO packages (tier_name, display_name, price_amount, price_currency, billing_period, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, max_devices)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [tierName, displayName, priceAmount, priceCurrency || 'USD', billingPeriod || 'daily', durationMin || 1440, dataLimitGb ?? null, !!isUncapped, bandwidthUp || 2, bandwidthDown || 2, maxDevices ?? null]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'package_create', 'package', rows[0].id, `Created package ${tierName}`);
  res.status(201).json(rows[0]);
});

adminRouter.put('/packages/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  const fields = req.body as any;
  const sets: string[] = []; const vals: any[] = []; let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    const col = ({ tierName: 'tier_name', displayName: 'display_name', priceAmount: 'price_amount', priceCurrency: 'price_currency', billingPeriod: 'billing_period', durationMin: 'duration_min', dataLimitGb: 'data_limit_gb', isUncapped: 'is_uncapped', bandwidthUp: 'bandwidth_mbps_up', bandwidthDown: 'bandwidth_mbps_down', maxDevices: 'max_devices' } as any)[k];
    if (col) { sets.push(`${col} = $${idx++}`); vals.push(v); }
  }
  if (sets.length === 0) { res.status(422).json({ error: 'No valid fields' }); return; }
  vals.push(id);
  const { rows } = await pool.query(`UPDATE packages SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`, vals);
  if (rows.length === 0) { res.status(404).json({ error: 'Package not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'package_update', 'package', id, `Updated package ${rows[0].tier_name}`);
  res.json(rows[0]);
});

adminRouter.delete('/packages/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query('UPDATE packages SET deleted_at = NOW(), status = \'archived\' WHERE id = $1 AND deleted_at IS NULL RETURNING tier_name', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Package not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'package_delete', 'package', id, `Deleted package ${rows[0].tier_name}`);
  res.json({ message: `Package ${rows[0].tier_name} deleted` });
});

// ═══════════════════════════════════════════════════════
// CEO: Maintenance Mode
// ═══════════════════════════════════════════════════════

adminRouter.get('/maintenance', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'maintenance_mode'");
  const { rows: msgRows } = await pool.query("SELECT value FROM settings WHERE key = 'maintenance_message'");
  res.json({
    enabled: rows.length > 0 && rows[0].value === 'true',
    message: msgRows.length > 0 ? msgRows[0].value : 'System under maintenance. Please check back later.',
  });
});

adminRouter.put('/maintenance', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { enabled, message } = req.body as { enabled: boolean; message?: string };
  await pool.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('maintenance_mode', $1, NOW(), $2)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW(), updated_by = $2`,
    [enabled ? 'true' : 'false', req.adminUser!.id]
  );
  if (message) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('maintenance_message', $1, NOW(), $2)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW(), updated_by = $2`,
      [message, req.adminUser!.id]
    );
  }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'maintenance_toggle', undefined, undefined, `Maintenance mode: ${enabled ? 'ON' : 'OFF'}`);
  res.json({ message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'}` });
});

// ═══════════════════════════════════════════════════════
// CEO: Data Retention Policy
// ═══════════════════════════════════════════════════════

adminRouter.get('/retention', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM retention_policies LIMIT 1');
  res.json(rows[0] || { session_days: 90, access_log_days: 30, audit_log_days: 365 });
});

adminRouter.put('/retention', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { sessionDays, accessLogDays, auditLogDays } = req.body as any;
  const { rows } = await pool.query(
    `UPDATE retention_policies SET session_days = $1, access_log_days = $2, audit_log_days = $3, updated_by = $4, updated_at = NOW() RETURNING *`,
    [sessionDays ?? 90, accessLogDays ?? 30, auditLogDays ?? 365, req.adminUser!.id]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'retention_update', undefined, undefined, `Retention: sessions=${sessionDays}d, access_log=${accessLogDays}d, audit=${auditLogDays}d`);
  res.json(rows[0]);
});

// ═══════════════════════════════════════════════════════
// CEO: Staff Commission Management
// ═══════════════════════════════════════════════════════

adminRouter.get('/commissions', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT sc.id, sc.staff_id, sc.commission_pct, sc.updated_at, au.full_name, au.email
     FROM staff_commissions sc
     RIGHT JOIN admin_users au ON au.id = sc.staff_id AND au.role IN ('Staff', 'Manager') AND au.deleted_at IS NULL
     ORDER BY au.full_name`
  );
  res.json(rows);
});

adminRouter.put('/commissions/:staffId', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { staffId } = req.params;
  const { commissionPct } = req.body as { commissionPct: number };
  if (commissionPct < 0 || commissionPct > 100) {
    res.status(422).json({ error: 'Commission must be 0-100%' }); return;
  }
  const { rows } = await pool.query(
    `INSERT INTO staff_commissions (staff_id, commission_pct, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (staff_id) DO UPDATE SET commission_pct = $2, updated_by = $3, updated_at = NOW()
     RETURNING *`,
    [staffId, commissionPct, req.adminUser!.id]
  );
  const { rows: staff } = await pool.query('SELECT full_name FROM admin_users WHERE id = $1 AND deleted_at IS NULL', [staffId]);
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'commission_set', 'staff_commission', staffId, `Set ${staff[0]?.full_name || staffId} commission to ${commissionPct}%`);
  res.json(rows[0]);
});

// ═══════════════════════════════════════════════════════
// CEO: Broadcast to All Admins
// ═══════════════════════════════════════════════════════

adminRouter.post('/broadcast', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { title, message } = req.body as { title: string; message: string };
  if (!title || !message) { res.status(422).json({ error: 'title and message required' }); return; }
  const { rows } = await pool.query(
    `INSERT INTO broadcast_notifications (title, message, created_by, created_by_name)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [title, message, req.adminUser!.id, req.adminUser!.fullName]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'broadcast', 'broadcast', rows[0].id, `Broadcast: ${title}`);
  res.status(201).json(rows[0]);
});

adminRouter.get('/broadcasts', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT *, NOT (read_by @> $1::jsonb) AS is_unread FROM broadcast_notifications ORDER BY created_at DESC LIMIT 50`,
    [JSON.stringify([req.adminUser!.id])]
  );
  // Mask read_by for privacy
  const sanitized = rows.map((r: any) => {
    const { read_by, ...rest } = r;
    return rest;
  });
  res.json(sanitized);
});

// Mark broadcast as read by current user
adminRouter.post('/broadcasts/:id/read', async (req: Request, res: Response) => {
  const { id } = req.params;
  await pool.query(
    `UPDATE broadcast_notifications SET read_by = read_by || $1::jsonb WHERE id = $2 AND NOT (read_by @> $1::jsonb)`,
    [JSON.stringify([req.adminUser!.id]), id]
  );
  res.json({ message: 'marked as read' });
});

// Mark all broadcasts as read by current user
adminRouter.post('/broadcasts/read-all', async (req: Request, res: Response) => {
  const currentId = JSON.stringify([req.adminUser!.id]);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM broadcast_notifications WHERE NOT (read_by @> $1::jsonb)`,
    [currentId]
  );
  await pool.query(
    `UPDATE broadcast_notifications SET read_by = read_by || $1::jsonb WHERE NOT (read_by @> $1::jsonb)`,
    [currentId]
  );
  res.json({ message: `${rows[0].cnt} broadcast(s) marked as read` });
});

// ═══════════════════════════════════════════════════════
// CEO: Kill Switch - force-disconnect all active sessions
// ═══════════════════════════════════════════════════════

adminRouter.post('/kill-sessions', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `UPDATE users SET session_expires_at = NOW() WHERE session_expires_at > NOW() RETURNING id`
  );
  // Also expire all active WISPr profiles
  await pool.query(
    `UPDATE wispr_profiles SET session_end = NOW() WHERE session_end IS NULL`
  );
  const count = rows.length;
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'kill_sessions', undefined, undefined, `Force-disconnected ${count} active session(s)`);
  await insertAlert('kill_switch', 'critical', 'Kill Switch Activated',
    `${req.adminUser!.fullName} force-disconnected all ${count} active sessions system-wide.`,
    'system', 'kill');
  res.json({ message: `${count} active session(s) terminated` });
});

// ═══════════════════════════════════════════════════════
// CEO: White-Label Branding
// ═══════════════════════════════════════════════════════

adminRouter.get('/branding', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM branding LIMIT 1');
  res.json(rows[0] || { portal_title: 'Preyone WiFi', primary_color: '#ff00ff', accent_color: '#6a0dad' });
});

adminRouter.put('/branding', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { portalTitle, voucherHeader, voucherFooter, primaryColor, accentColor } = req.body as any;
  const { rows } = await pool.query(
    `UPDATE branding SET portal_title = COALESCE($1, portal_title), voucher_header = COALESCE($2, voucher_header), voucher_footer = COALESCE($3, voucher_footer), primary_color = COALESCE($4, primary_color), accent_color = COALESCE($5, accent_color), updated_by = $6, updated_at = NOW() RETURNING *`,
    [portalTitle || null, voucherHeader || null, voucherFooter || null, primaryColor || null, accentColor || null, req.adminUser!.id]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'branding_update', undefined, undefined, `Updated branding: title="${portalTitle}"`);
  res.json(rows[0]);
});

// ═══════════════════════════════════════════════════════
// CEO: Backup Manager
// ═══════════════════════════════════════════════════════

adminRouter.post('/backup', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  // Export key data as JSON snapshot (no pg_dump dependency)
  const dump: any = {};
  const tables = ['packages', 'users', 'vouchers', 'payments', 'admin_users', 'sales', 'settings', 'branding', 'retention_policies', 'staff_commissions', 'ap_devices', 'mac_blacklist', 'mac_whitelist'];
  for (const table of tables) {
    const { rows } = await pool.query(`SELECT * FROM ${table}`);
    dump[table] = rows;
  }

  const REDACTED = '[REDACTED]';
  const sensitiveCols = ['password_hash', 'reset_token', 'reset_password_token', 'reset_token_expires_at', 'reset_password_expires_at', 'email_verification_token', 'jwt_secret'];
  for (const table of Object.keys(dump)) {
    for (const row of dump[table]) {
      for (const col of sensitiveCols) {
        if (col in row) row[col] = row[col] ? REDACTED : null;
      }
    }
  }

  const json = JSON.stringify(dump, null, 2);
  const fileName = `preyone-backup-${new Date().toISOString().slice(0, 10)}.json`;
  // Store backup metadata in DB
  const { rows: logRow } = await pool.query(
    `INSERT INTO backup_logs (file_name, file_size, created_by, created_by_name)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [fileName, Buffer.byteLength(json, 'utf8'), req.adminUser!.id, req.adminUser!.fullName]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'backup_create', 'backup', logRow[0].id, `Created backup: ${fileName} (${(Buffer.byteLength(json, 'utf8') / 1024).toFixed(1)} KB)`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.json({ backupId: logRow[0].id, fileName, fileSize: Buffer.byteLength(json, 'utf8'), data: JSON.parse(json) });
});

adminRouter.get('/backup/logs', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM backup_logs ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

// ═══════════════════════════════════════════════════════
// CEO: Scheduled Reports
// ═══════════════════════════════════════════════════════

adminRouter.get('/report-schedules', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM report_schedules ORDER BY created_at DESC');
  res.json(rows);
});

adminRouter.post('/report-schedules', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { frequency, recipients, enabled } = req.body as { frequency: string; recipients: string[]; enabled: boolean };
  if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
    res.status(422).json({ error: 'frequency must be daily, weekly, or monthly' }); return;
  }
  const { rows } = await pool.query(
    `INSERT INTO report_schedules (frequency, recipients, enabled, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [frequency, JSON.stringify(recipients || []), !!enabled, req.adminUser!.id]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'report_schedule_create', 'report_schedule', rows[0].id, `Created ${frequency} report schedule`);
  res.status(201).json(rows[0]);
});

adminRouter.put('/report-schedules/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { frequency, recipients, enabled } = req.body as any;
  const sets: string[] = []; const vals: any[] = []; let idx = 1;
  if (frequency) { sets.push(`frequency = $${idx++}`); vals.push(frequency); }
  if (recipients !== undefined) { sets.push(`recipients = $${idx++}`); vals.push(JSON.stringify(recipients)); }
  if (enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(!!enabled); }
  sets.push('updated_at = NOW()');
  vals.push(id);
  if (sets.length === 1) { res.status(422).json({ error: 'No fields to update' }); return; }
  const { rows } = await pool.query(`UPDATE report_schedules SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
  if (rows.length === 0) { res.status(404).json({ error: 'Schedule not found' }); return; }
  res.json(rows[0]);
});

adminRouter.delete('/report-schedules/:id', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query('DELETE FROM report_schedules WHERE id = $1 RETURNING id', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Schedule not found' }); return; }
  res.json({ message: 'Schedule deleted' });
});

// ═══════════════════════════════════════════════════════
// POS: Company profile (single source of truth for receipts/invoices)
// ═══════════════════════════════════════════════════════

adminRouter.get('/company', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM companies ORDER BY created_at LIMIT 1');
  res.json(rows[0] || { name: 'Preyone', currency: 'USD', tax_pct: 0 });
});

adminRouter.put('/company', requireRole('CEO'), async (req: Request, res: Response) => {
  const {
    name, tagline, address, email, supportPhone, website, logoPath,
    currency, taxPct, invoicePrefix, quotePrefix, receiptFooter, termsText,
  } = req.body as any;
  const { rows } = await pool.query(
    `UPDATE companies SET
       name           = COALESCE($1,  name),
       tagline        = COALESCE($2,  tagline),
       address        = COALESCE($3,  address),
       email          = COALESCE($4,  email),
       support_phone  = COALESCE($5,  support_phone),
       website        = COALESCE($6,  website),
       logo_path      = COALESCE($7,  logo_path),
       currency       = COALESCE($8,  currency),
       tax_pct        = COALESCE($9,  tax_pct),
       invoice_prefix = COALESCE($10, invoice_prefix),
       quote_prefix   = COALESCE($11, quote_prefix),
       receipt_footer = COALESCE($12, receipt_footer),
       terms_text     = COALESCE($13, terms_text),
       updated_by     = $14, updated_at = NOW()
     RETURNING *`,
    [name ?? null, tagline ?? null, address ?? null, email ?? null, supportPhone ?? null,
     website ?? null, logoPath ?? null, currency ?? null, taxPct ?? null, invoicePrefix ?? null,
     quotePrefix ?? null, receiptFooter ?? null, termsText ?? null, req.adminUser!.id]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'company_update', 'companies', rows[0]?.id, `Company profile updated`);
  res.json(rows[0]);
});

// ═══════════════════════════════════════════════════════
// POS: Devices & Endpoints (desktop / web / android)
// ═══════════════════════════════════════════════════════

adminRouter.get('/devices', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const { rows } = await pool.query(
    `SELECT d.*, c.name AS company_name
       FROM pos_devices d
       LEFT JOIN companies c ON c.id = d.company_id
       ${type ? 'WHERE d.device_type = $1' : ''}
       ORDER BY d.last_seen DESC NULLS LAST, d.created_at DESC`,
    type ? [type] : []
  );
  res.json(rows);
});

adminRouter.post('/devices', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const { deviceId, deviceType, name, branch, appVersion, serverUrl, status, notes } = req.body as any;
  if (!deviceId || !['desktop', 'web', 'android'].includes(deviceType)) {
    res.status(422).json({ error: 'deviceId and deviceType (desktop|web|android) are required' }); return;
  }
  const { rows } = await pool.query(
    `INSERT INTO pos_devices (device_id, device_type, name, branch, app_version, server_url, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (device_id) DO UPDATE SET
       device_type = EXCLUDED.device_type,
       name = EXCLUDED.name,
       branch = EXCLUDED.branch,
       app_version = EXCLUDED.app_version,
       server_url = EXCLUDED.server_url,
       status = EXCLUDED.status,
       notes = EXCLUDED.notes,
       updated_at = NOW()
     RETURNING *`,
    [deviceId, deviceType, name || deviceId, branch ?? null, appVersion ?? null, serverUrl ?? null, status || 'registered', notes ?? null]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'pos_device_register', 'pos_device', rows[0].id, `Registered ${deviceType} device ${deviceId}`);
  res.status(201).json(rows[0]);
});

adminRouter.put('/devices/:id', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { deviceId, deviceType, name, branch, appVersion, serverUrl, status, notes } = req.body as any;
  const sets: string[] = []; const vals: any[] = []; let idx = 1;
  if (deviceId)          { sets.push(`device_id = $${idx++}`); vals.push(deviceId); }
  if (deviceType)        { sets.push(`device_type = $${idx++}`); vals.push(deviceType); }
  if (name !== undefined){ sets.push(`name = $${idx++}`); vals.push(name); }
  if (branch !== undefined)  { sets.push(`branch = $${idx++}`); vals.push(branch); }
  if (appVersion !== undefined){ sets.push(`app_version = $${idx++}`); vals.push(appVersion); }
  if (serverUrl !== undefined){ sets.push(`server_url = $${idx++}`); vals.push(serverUrl); }
  if (status)            { sets.push(`status = $${idx++}`); vals.push(status); }
  if (notes !== undefined)   { sets.push(`notes = $${idx++}`); vals.push(notes); }
  sets.push('updated_at = NOW()');
  vals.push(id);
  if (sets.length === 1) { res.status(422).json({ error: 'No fields to update' }); return; }
  const { rows } = await pool.query(`UPDATE pos_devices SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
  if (rows.length === 0) { res.status(404).json({ error: 'Device not found' }); return; }
  res.json(rows[0]);
});

adminRouter.post('/devices/:id/suspend', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(`UPDATE pos_devices SET status = 'suspended', updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Device not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'pos_device_suspend', 'pos_device', id, `Suspended device ${rows[0].device_id}`);
  res.json(rows[0]);
});

adminRouter.post('/devices/:id/activate', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(`UPDATE pos_devices SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Device not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'pos_device_activate', 'pos_device', id, `Activated device ${rows[0].device_id}`);
  res.json(rows[0]);
});

adminRouter.delete('/devices/:id', requireRole('CEO'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query('DELETE FROM pos_devices WHERE id = $1 RETURNING id, device_id', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Device not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'pos_device_delete', 'pos_device', id, `Removed device ${rows[0].device_id}`);
  res.json({ message: 'Device removed' });
});
adminRouter.get('/dashboard/ultranet/sales-summary', async (req: Request, res: Response) => {
  try {
    const user = req.adminUser!;
    const isStaff = user.role === 'Staff';
    const [mySales, platformDaily, platformYesterday, weekly, monthly, target, matrix, velocity, activity] = await Promise.all([
      isStaff ? getStaffDailyRevenue(user.id) : Promise.resolve(0),
      getPlatformDailyRevenue(),
      getPlatformYesterdayRevenue(),
      getPlatformWeeklyRevenue(),
      getPlatformMonthlyRevenue(),
      getPlatformMonthlyTarget(),
      getStaffSalesMatrix(),
      getHourlySalesVelocity(1),
      getRecentActivity(20),
    ]);
    const [itemized] = await Promise.all([
      isStaff ? getStaffDailySalesItemized(user.id) : getPlatformDailySalesItemized(),
    ]);
    res.json({ mySales, platformDaily, platformYesterday, weekly, monthly, target, matrix, velocity, activity, itemized });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

