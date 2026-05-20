import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { requireAdminAuth, requireRole } from '../middleware/adminAuth';
import { recordAuditLog } from './adminAuth';

export const adminRouter = Router();

adminRouter.use(requireAdminAuth);

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

adminRouter.get('/access-log', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT al.id, al.event, al.mac_address, al.ip_address, al.detail, al.created_at, u.full_name
      FROM access_log al LEFT JOIN users u ON u.id = al.user_id ORDER BY al.created_at DESC LIMIT 1000`
  );
  res.json(rows);
});

adminRouter.get('/packages', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    'SELECT * FROM packages ORDER BY price_amount ASC'
  );
  res.json(rows);
});

adminRouter.post('/vouchers', async (req: Request, res: Response) => {
  const { code, maxUses = 1, expiresAt, priceAmount, packageTier } = req.body as {
    code: string; maxUses?: number; expiresAt?: string; priceAmount?: number | null; packageTier?: string;
  };

  let durationMin = 60;
  let dataLimitGb: number | null = null;
  let isUncapped = true;
  let bandwidthUp = 2;
  let bandwidthDown = 5;
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

  const approvalTiers = ['PreMAX', 'PreULTRA', 'PreEXECUTIVE'];
  if (packageTier && req.adminUser!.role === 'Staff' && approvalTiers.includes(packageTier)) {
    res.status(403).json({
      error: 'Staff cannot sell Restricted packages. Submit an approval request for management authorization.',
      requiresApproval: true
    });
    return;
  }

  if (packageTier) {
    const { rows: pkgs } = await pool.query(
      `SELECT tier_name, display_name, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down
       FROM packages WHERE tier_name = $1`,
      [packageTier]
    );
    if (pkgs.length === 0) { res.status(422).json({ error: 'Package not found' }); return; }
    const pkg = pkgs[0];
    durationMin = pkg.duration_min;
    dataLimitGb = pkg.data_limit_gb;
    isUncapped = pkg.is_uncapped;
    bandwidthUp = pkg.bandwidth_mbps_up;
    bandwidthDown = pkg.bandwidth_mbps_down;
    resolvedPackageTier = pkg.tier_name;
  }

  const soldBy = req.adminUser!.role === 'Staff' ? req.adminUser!.id : (priceAmount ? req.adminUser!.id : null);

  const { rows } = await pool.query(
    `INSERT INTO vouchers (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, sold_by, price_amount, package_tier)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [code.toUpperCase(), durationMin, maxUses, expiresAt ?? null, dataLimitGb, isUncapped, bandwidthUp, bandwidthDown, soldBy, priceAmount ?? null, resolvedPackageTier]
  );

  // Log sale if price was set
  if (priceAmount && soldBy && rows.length > 0) {
    await pool.query(
      `INSERT INTO sales (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [rows[0].id, rows[0].code, soldBy, req.adminUser!.fullName, priceAmount, 'USD']
    );
  }

  res.status(201).json({ ...rows[0], package_tier: resolvedPackageTier });
});

adminRouter.get('/vouchers', async (req: Request, res: Response) => {
  if (req.adminUser!.role === 'Staff') {
    const { rows } = await pool.query(
      'SELECT * FROM vouchers WHERE sold_by = $1 ORDER BY created_at DESC',
      [req.adminUser!.id]
    );
    res.json(rows);
  } else {
    const { rows } = await pool.query('SELECT * FROM vouchers ORDER BY created_at DESC');
    res.json(rows);
  }
});

// ── Staff Sales (any role — staff see own sales) ──

adminRouter.get('/my-sales', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT v.*, a.full_name AS sold_by_name
     FROM vouchers v
     LEFT JOIN admin_users a ON a.id = v.sold_by
     WHERE v.sold_by = $1
     ORDER BY v.created_at DESC`,
    [req.adminUser!.id]
  );
  const totalAmount = rows.reduce((sum: number, r: any) => sum + (parseFloat(r.price_amount) || 0), 0);
  const totalSales = rows.length;
  res.json({ sales: rows, totalAmount, totalSales });
});

// ── Staff Sales Aggregated (CEO/Manager only) ──

adminRouter.get('/staff-sales', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
  const { rows: staffSummary } = await pool.query(`
    SELECT a.id, a.full_name, COUNT(v.id)::int AS total_sales, COALESCE(SUM(v.price_amount), 0)::float AS total_amount
    FROM admin_users a
    INNER JOIN vouchers v ON v.sold_by = a.id
    WHERE a.role = 'Staff'
    GROUP BY a.id, a.full_name
    ORDER BY total_amount DESC
  `);
  const { rows: allSales } = await pool.query(`
    SELECT v.*, a.full_name AS sold_by_name
    FROM vouchers v
    LEFT JOIN admin_users a ON a.id = v.sold_by
    WHERE v.sold_by IS NOT NULL
    ORDER BY v.created_at DESC
  `);
  res.json({ staffSummary, allSales });
});

adminRouter.get('/admin-users', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    'SELECT id, full_name, email, phone, role, created_at FROM admin_users ORDER BY created_at DESC'
  );
  res.json(rows);
});

adminRouter.get('/revenue', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
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
    SELECT package_tier, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS total
    FROM transactions WHERE status = 'completed'
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

adminRouter.get('/dashboard/sales', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
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
      LEFT JOIN admin_users a ON a.id = t.admin_user_id
      ORDER BY t.clock_in DESC LIMIT 500
    `);
    const { rows: summary } = await pool.query(`
      SELECT a.id, a.full_name, a.role,
        COUNT(t.id)::int AS total_shifts,
        COALESCE(SUM(t.duration_min), 0)::int AS total_minutes
      FROM admin_users a
      LEFT JOIN staff_time_logs t ON t.admin_user_id = a.id
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

adminRouter.get('/staff', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, role, approved, created_at
     FROM admin_users WHERE role = 'Staff' ORDER BY created_at DESC`
  );
  res.json(rows);
});

adminRouter.get('/staff-pending', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, created_at
     FROM admin_users WHERE role = 'Staff' AND approved = FALSE ORDER BY created_at DESC`
  );
  res.json(rows);
});

adminRouter.post('/staff-approve/:id', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE admin_users SET approved = TRUE WHERE id = $1 AND role = 'Staff' RETURNING id, full_name, email, role, approved`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Staff account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'staff_approve', 'admin_user', id, `Approved ${rows[0].full_name}`);
  res.json({ message: 'Staff account approved', user: rows[0] });
});

adminRouter.post('/staff-reject/:id', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `DELETE FROM admin_users WHERE id = $1 AND role = 'Staff' AND approved = FALSE RETURNING id, full_name`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Pending staff account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'staff_reject', 'admin_user', id, `Rejected ${rows[0].full_name}`);
  res.json({ message: 'Staff account rejected and removed' });
});

// Staff online/offline status (CEO/Manager only)
adminRouter.get('/staff-status', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.full_name, a.role, a.approved,
            t.id AS shift_id, t.clock_in, t.clock_out,
            CASE WHEN t.id IS NOT NULL AND t.clock_out IS NULL THEN true ELSE false END AS is_online
     FROM admin_users a
     LEFT JOIN LATERAL (
       SELECT id, clock_in, clock_out FROM staff_time_logs WHERE admin_user_id = a.id ORDER BY clock_in DESC LIMIT 1
     ) t ON true
     WHERE a.role IN ('Staff', 'Manager')
     ORDER BY is_online DESC, a.full_name ASC`
  );
  const onlineCount = rows.filter((r: any) => r.is_online).length;
  res.json({ statuses: rows, onlineCount, totalStaff: rows.length });
});

adminRouter.post('/staff-deactivate/:id', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE admin_users SET approved = FALSE WHERE id = $1 AND role = 'Staff' RETURNING id, full_name, email, role, approved`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Staff account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'staff_deactivate', 'admin_user', id, `Deactivated ${rows[0].full_name}`);
  res.json({ message: 'Staff account deactivated', user: rows[0] });
});

adminRouter.post('/staff-activate/:id', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE admin_users SET approved = TRUE WHERE id = $1 AND role = 'Staff' RETURNING id, full_name, email, role, approved`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Staff account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'staff_activate', 'admin_user', id, `Activated ${rows[0].full_name}`);
  res.json({ message: 'Staff account activated', user: rows[0] });
});

adminRouter.post('/staff-remove/:id', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `DELETE FROM admin_users WHERE id = $1 AND role = 'Staff' RETURNING id, full_name`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Staff account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'staff_remove', 'admin_user', id, `Removed staff ${rows[0].full_name}`);
  res.json({ message: 'Staff account removed' });
});

// ── Voucher Redemptions (any role) ──

adminRouter.get('/voucher-redemptions', async (req: Request, res: Response) => {
  const voucherId = req.query.voucher_id as string | undefined;
  let query = `
    SELECT vr.id, vr.voucher_code, vr.full_name, vr.mac_address, vr.ip_address, vr.created_at,
           v.code AS voucher_code_lookup
    FROM voucher_redemptions vr
    LEFT JOIN vouchers v ON v.id = vr.voucher_id
  `;
  const params: any[] = [];
  if (voucherId) {
    query += ' WHERE vr.voucher_id = $1';
    params.push(voucherId);
  }
  query += ' ORDER BY vr.created_at DESC LIMIT 1000';
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// ── Active Sessions / Real-time Usage (any role) ──

adminRouter.get('/active-sessions', async (req: Request, res: Response) => {
  const isStaff = req.adminUser!.role === 'Staff';
  const staffId = req.adminUser!.id;

  // Active users with voucher + package details
  const { rows: activeUsers } = await pool.query(`
    SELECT u.id, u.full_name, u.phone, u.voucher_code, u.mac_address, u.ip_address,
           u.session_expires_at, u.created_at,
           v.duration_min, v.max_uses, v.used_count, v.data_limit_gb, v.is_uncapped,
           v.bandwidth_mbps_up, v.bandwidth_mbps_down, v.price_amount AS voucher_price,
           v.code AS voucher_code,
           wp.data_used_bytes, wp.data_quota_bytes, wp.session_start
    FROM users u
    LEFT JOIN vouchers v ON UPPER(u.voucher_code) = v.code
    LEFT JOIN wispr_profiles wp ON wp.user_id = u.id
    WHERE u.session_expires_at > NOW()
    ${isStaff ? 'AND UPPER(u.voucher_code) IN (SELECT UPPER(code) FROM vouchers WHERE sold_by = $1)' : ''}
    ORDER BY u.created_at DESC
  `, isStaff ? [staffId] : []);
  // Count connected users per voucher code
  const { rows: perVoucher } = await pool.query(`
    SELECT voucher_code, COUNT(*)::int AS connected_users
    FROM users WHERE session_expires_at > NOW()
    ${isStaff ? 'AND voucher_code IN (SELECT code FROM vouchers WHERE sold_by = $1)' : ''}
    GROUP BY voucher_code ORDER BY connected_users DESC
  `, isStaff ? [staffId] : []);
  // Total active users
  const { rows: totalActive } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM users WHERE session_expires_at > NOW()
    ${isStaff ? 'AND voucher_code IN (SELECT code FROM vouchers WHERE sold_by = $1)' : ''}
  `, isStaff ? [staffId] : []);
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

adminRouter.get('/managers', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, role, approved, created_at
     FROM admin_users WHERE role = 'Manager' ORDER BY created_at DESC`
  );
  res.json(rows);
});

adminRouter.post('/manager-promote/:id', requireRole('CEO'), async (req: Request, res: Response) => {
  const { id } = req.params;
  // Check manager slot isn't taken
  const { rows: existing } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM admin_users WHERE role = 'Manager'`
  );
  if (existing[0].cnt >= 1) {
    res.status(409).json({ error: 'A Manager already exists. Remove or demote them first.' });
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

adminRouter.post('/manager-demote/:id', requireRole('CEO'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `UPDATE admin_users SET role = 'Staff', approved = TRUE WHERE id = $1 AND role = 'Manager' RETURNING id, full_name, email, role`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Manager account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'manager_demote', 'admin_user', id, `Demoted ${rows[0].full_name} to Staff`);
  res.json({ message: 'Manager demoted to Staff', user: rows[0] });
});

adminRouter.post('/manager-remove/:id', requireRole('CEO'), async (req: Request, res: Response) => {
  const { id } = req.params;
  // Prevent CEO from removing themselves
  if (id === req.adminUser!.id) {
    res.status(400).json({ error: 'Cannot remove your own account' });
    return;
  }
  const { rows } = await pool.query(
    `DELETE FROM admin_users WHERE id = $1 AND role = 'Manager' RETURNING id, full_name`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Manager account not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'manager_remove', 'admin_user', id, `Removed Manager ${rows[0].full_name}`);
  res.json({ message: 'Manager removed' });
});

// ── Settings (CEO only) ──

adminRouter.get('/settings', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT key, value, updated_at FROM settings ORDER BY key');
  const settingsMap: Record<string, string> = {};
  rows.forEach((r: any) => { settingsMap[r.key] = r.value; });
  res.json(settingsMap);
});

adminRouter.put('/settings', requireRole('CEO'), async (req: Request, res: Response) => {
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

adminRouter.get('/audit-log', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, admin_name, action, target_type, target_id, detail, created_at
     FROM admin_audit_log ORDER BY created_at DESC LIMIT 500`
  );
  res.json(rows);
});

// ── CSV Revenue Export (CEO only) ──

adminRouter.get('/revenue/export', requireRole('CEO'), async (_req: Request, res: Response) => {
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

adminRouter.get('/charts', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
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

adminRouter.get('/ap-devices', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    'SELECT * FROM ap_devices ORDER BY name ASC'
  );
  res.json(rows);
});

adminRouter.post('/ap-devices', async (req: Request, res: Response) => {
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

adminRouter.put('/ap-devices/:id', async (req: Request, res: Response) => {
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

adminRouter.delete('/ap-devices/:id', async (req: Request, res: Response) => {
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

adminRouter.get('/bandwidth/top-users', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.full_name, u.mac_address, u.ip_address,
           wp.data_used_bytes, wp.data_quota_bytes, wp.bandwidth_up_kbps, wp.bandwidth_down_kbps,
           wp.session_start, wp.is_uncapped
    FROM wispr_profiles wp
    INNER JOIN users u ON u.id = wp.user_id
    WHERE wp.session_end IS NULL
    ORDER BY wp.data_used_bytes DESC
    LIMIT 20
  `);
  res.json(rows);
});

// ═══════════════════════════════════════════════════════
// NEW: Peak Hour / Usage Analytics
// ═══════════════════════════════════════════════════════

adminRouter.get('/peak-hours', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
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

adminRouter.post('/alerts/seed-mock', async (req: Request, res: Response) => {
  const types = ['ap_down', 'traffic_spike', 'abuse_detected', 'voucher_abuse', 'ap_warning', 'system'];
  const severities = ['info', 'warning', 'critical'];
  const titles = [
    'AP Offline Detected',
    'Traffic Anomaly',
    'Multiple Failed Logins',
    'Voucher Code Brute Force',
    'High Memory Usage',
    'Bandwidth Cap Approaching',
  ];
  const inserted: any[] = [];
  for (let i = 0; i < 3; i++) {
    const type = types[Math.floor(Math.random() * types.length)];
    const severity = severities[Math.floor(Math.random() * severities.length)];
    const title = titles[Math.floor(Math.random() * titles.length)];
    const { rows } = await pool.query(
      `INSERT INTO alerts (type, severity, title, message) VALUES ($1, $2, $3, $4) RETURNING *`,
      [type, severity, title, `Mock alert generated at ${new Date().toISOString()}`]
    );
    inserted.push(rows[0]);
  }
  res.status(201).json({ message: `${inserted.length} mock alert(s) created`, alerts: inserted });
});

// ═══════════════════════════════════════════════════════
// NEW: MAC Blacklist / Whitelist Management
// ═══════════════════════════════════════════════════════

adminRouter.get('/blacklist', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT b.*, a.full_name AS blocked_by_name
     FROM mac_blacklist b
     LEFT JOIN admin_users a ON a.id = b.blocked_by
     ORDER BY b.created_at DESC`
  );
  res.json(rows);
});

adminRouter.post('/blacklist', async (req: Request, res: Response) => {
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

adminRouter.delete('/blacklist/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query('DELETE FROM mac_blacklist WHERE id = $1 RETURNING mac_address', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Blacklist entry not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'blacklist_remove', 'mac', rows[0].mac_address, `Unblacklisted ${rows[0].mac_address}`);
  res.json({ message: 'MAC removed from blacklist' });
});

adminRouter.get('/whitelist', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT w.*, a.full_name AS added_by_name
     FROM mac_whitelist w
     LEFT JOIN admin_users a ON a.id = w.added_by
     ORDER BY w.created_at DESC`
  );
  res.json(rows);
});

adminRouter.post('/whitelist', async (req: Request, res: Response) => {
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

adminRouter.delete('/whitelist/:id', async (req: Request, res: Response) => {
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
  const { count = 10, packageTier, priceAmount, expiresAt } = req.body as {
    count?: number; packageTier?: string; priceAmount?: number; expiresAt?: string;
  };

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
    `SELECT tier_name, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down
     FROM packages WHERE tier_name = $1`,
    [packageTier]
  );
  if (pkgs.length === 0) { res.status(422).json({ error: 'Package not found' }); return; }
  const pkg = pkgs[0];

  const slug = packageTier.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const created: any[] = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < count; i++) {
      const bytes = crypto.randomBytes(4);
      let rand = '';
      for (let j = 0; j < 4; j++) rand += chars[bytes[j] % chars.length];
      const code = `${slug}-${rand}`;

      const { rows } = await client.query(
        `INSERT INTO vouchers (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, sold_by, price_amount, package_tier)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [code, pkg.duration_min, expiresAt || null, pkg.data_limit_gb, pkg.is_uncapped, pkg.bandwidth_mbps_up, pkg.bandwidth_mbps_down, req.adminUser!.id, priceAmount || null, packageTier]
      );

      // Log sale if price set
      if (priceAmount && priceAmount > 0) {
        await client.query(
          `INSERT INTO sales (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency)
           VALUES ($1, $2, $3, $4, $5, 'USD')`,
          [rows[0].id, rows[0].code, req.adminUser!.id, req.adminUser!.fullName, priceAmount]
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

const APPROVAL_TIERS = ['PreMAX', 'PreULTRA', 'PreEXECUTIVE'];

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
  const { requestType, packageTier, priceAmount, count, code, maxUses } = req.body as {
    requestType: string; packageTier: string; priceAmount?: number; count?: number; code?: string; maxUses?: number;
  };

  if (!requestType || !packageTier) {
    res.status(422).json({ error: 'requestType and packageTier required' }); return;
  }
  if (requestType !== 'single' && requestType !== 'bulk') {
    res.status(422).json({ error: 'requestType must be single or bulk' }); return;
  }

  const { rows: pkgs } = await pool.query(
    'SELECT tier_name FROM packages WHERE tier_name = $1', [packageTier]
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
     JSON.stringify({ code: code || null })]
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
adminRouter.get('/vouchers/pending-approvals', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT * FROM voucher_approvals WHERE status = 'pending' ORDER BY created_at DESC`
  );
  res.json(rows);
});

// Manager/CEO approves a request
adminRouter.post('/vouchers/approvals/:id/approve', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
  const { id } = req.params;

  const { rows: existing } = await pool.query(
    'SELECT * FROM voucher_approvals WHERE id = $1', [id]
  );
  if (existing.length === 0) { res.status(404).json({ error: 'Approval request not found' }); return; }
  const approval = existing[0];
  if (approval.status !== 'pending') { res.status(400).json({ error: 'Request already ' + approval.status }); return; }

  const pkgRes = await pool.query(
    `SELECT tier_name, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down
     FROM packages WHERE tier_name = $1`, [approval.package_tier]
  );
  if (pkgRes.rows.length === 0) { res.status(422).json({ error: 'Package not found' }); return; }
  const pkg = pkgRes.rows[0];

  const slug = approval.package_tier.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const created: any[] = [];
  const count = approval.voucher_count || 1;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < count; i++) {
      const bytes = crypto.randomBytes(4);
      let rand = '';
      for (let j = 0; j < 4; j++) rand += chars[bytes[j] % chars.length];
      const voucherCode = approval.request_type === 'single' && approval.voucher_data?.code
        ? approval.voucher_data.code.toUpperCase()
        : `${slug}-${rand}`;

      const { rows: vrows } = await client.query(
        `INSERT INTO vouchers (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, sold_by, price_amount, package_tier)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [voucherCode, pkg.duration_min, approval.max_uses || 1, pkg.data_limit_gb, pkg.is_uncapped, pkg.bandwidth_mbps_up, pkg.bandwidth_mbps_down,
         req.adminUser!.id, approval.price_amount || null, approval.package_tier]
      );

      if (approval.price_amount && approval.price_amount > 0) {
        await client.query(
          `INSERT INTO sales (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency)
           VALUES ($1, $2, $3, $4, $5, 'USD')`,
          [vrows[0].id, vrows[0].code, req.adminUser!.id, req.adminUser!.fullName, approval.price_amount]
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
adminRouter.post('/vouchers/approvals/:id/reject', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
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
     WHERE s.id = ANY($1::uuid[]) AND s.sold_by = $2 AND (s.handover_status IS NULL OR s.handover_status = 'pending')`,
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
adminRouter.get('/cash-handovers/pending', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
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
adminRouter.post('/cash-handovers/:id/approve', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
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
adminRouter.post('/cash-handovers/:id/reject', requireRole('CEO', 'Manager'), async (req: Request, res: Response) => {
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

adminRouter.get('/customer-kpis', requireRole('CEO', 'Manager'), async (_req: Request, res: Response) => {
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
    LEFT JOIN vouchers v ON UPPER(u.voucher_code) = v.code
    LEFT JOIN packages p ON v.data_limit_gb IS NOT DISTINCT FROM p.data_limit_gb
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
    result.pendingApprovals = pendingApprovals[0].count;
    result.pendingHandovers = pendingHandovers[0].count;
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

adminRouter.get('/packages/manage', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM packages ORDER BY price_amount ASC');
  res.json(rows);
});

adminRouter.post('/packages', requireRole('CEO'), async (req: Request, res: Response) => {
  const { tierName, displayName, priceAmount, priceCurrency, billingPeriod, durationMin, dataLimitGb, isUncapped, bandwidthUp, bandwidthDown } = req.body as any;
  if (!tierName || !displayName || priceAmount === undefined) {
    res.status(422).json({ error: 'tierName, displayName, and priceAmount are required' }); return;
  }
  const { rows } = await pool.query(
    `INSERT INTO packages (tier_name, display_name, price_amount, price_currency, billing_period, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tierName, displayName, priceAmount, priceCurrency || 'USD', billingPeriod || 'daily', durationMin || 1440, dataLimitGb ?? null, !!isUncapped, bandwidthUp || 2, bandwidthDown || 2]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'package_create', 'package', rows[0].id, `Created package ${tierName}`);
  res.status(201).json(rows[0]);
});

adminRouter.put('/packages/:id', requireRole('CEO'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const fields = req.body as any;
  const sets: string[] = []; const vals: any[] = []; let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    const col = ({ tierName: 'tier_name', displayName: 'display_name', priceAmount: 'price_amount', priceCurrency: 'price_currency', billingPeriod: 'billing_period', durationMin: 'duration_min', dataLimitGb: 'data_limit_gb', isUncapped: 'is_uncapped', bandwidthUp: 'bandwidth_mbps_up', bandwidthDown: 'bandwidth_mbps_down' } as any)[k];
    if (col) { sets.push(`${col} = $${idx++}`); vals.push(v); }
  }
  if (sets.length === 0) { res.status(422).json({ error: 'No valid fields' }); return; }
  vals.push(id);
  const { rows } = await pool.query(`UPDATE packages SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`, vals);
  if (rows.length === 0) { res.status(404).json({ error: 'Package not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'package_update', 'package', id, `Updated package ${rows[0].tier_name}`);
  res.json(rows[0]);
});

adminRouter.delete('/packages/:id', requireRole('CEO'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query('DELETE FROM packages WHERE id = $1 RETURNING tier_name', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Package not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'package_delete', 'package', id, `Deleted package ${rows[0].tier_name}`);
  res.json({ message: `Package ${rows[0].tier_name} deleted` });
});

// ═══════════════════════════════════════════════════════
// CEO: AP Device Management (CRUD)
// ═══════════════════════════════════════════════════════

adminRouter.post('/ap-devices', requireRole('CEO'), async (req: Request, res: Response) => {
  const { name, model, macAddress, ipAddress, location } = req.body as any;
  if (!name || !macAddress) { res.status(422).json({ error: 'name and macAddress required' }); return; }
  const { rows } = await pool.query(
    `INSERT INTO ap_devices (name, model, mac_address, ip_address, location, status)
     VALUES ($1,$2,$3,$4,$5,'offline') RETURNING *`,
    [name, model || null, macAddress.toUpperCase(), ipAddress || null, location || null]
  );
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'ap_device_create', 'ap_device', rows[0].id, `Added AP ${name}`);
  res.status(201).json(rows[0]);
});

adminRouter.put('/ap-devices/:id', requireRole('CEO'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, model, macAddress, ipAddress, location, status } = req.body as any;
  const { rows } = await pool.query(
    `UPDATE ap_devices SET name = COALESCE($1, name), model = COALESCE($2, model), mac_address = COALESCE($3, mac_address), ip_address = COALESCE($4, ip_address), location = COALESCE($5, location), status = COALESCE($6, status) WHERE id = $7 RETURNING *`,
    [name || null, model || null, macAddress?.toUpperCase() || null, ipAddress || null, location || null, status || null, id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'AP device not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'ap_device_update', 'ap_device', id, `Updated AP ${rows[0].name}`);
  res.json(rows[0]);
});

adminRouter.delete('/ap-devices/:id', requireRole('CEO'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query('DELETE FROM ap_devices WHERE id = $1 RETURNING name', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'AP device not found' }); return; }
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'ap_device_delete', 'ap_device', id, `Deleted AP ${rows[0].name}`);
  res.json({ message: `AP ${rows[0].name} deleted` });
});

// ═══════════════════════════════════════════════════════
// CEO: Maintenance Mode
// ═══════════════════════════════════════════════════════

adminRouter.get('/maintenance', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'maintenance_mode'");
  const { rows: msgRows } = await pool.query("SELECT value FROM settings WHERE key = 'maintenance_message'");
  res.json({
    enabled: rows.length > 0 && rows[0].value === 'true',
    message: msgRows.length > 0 ? msgRows[0].value : 'System under maintenance. Please check back later.',
  });
});

adminRouter.put('/maintenance', requireRole('CEO'), async (req: Request, res: Response) => {
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

adminRouter.get('/retention', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM retention_policies LIMIT 1');
  res.json(rows[0] || { session_days: 90, access_log_days: 30, audit_log_days: 365 });
});

adminRouter.put('/retention', requireRole('CEO'), async (req: Request, res: Response) => {
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

adminRouter.get('/commissions', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT sc.id, sc.staff_id, sc.commission_pct, sc.updated_at, au.full_name, au.email
     FROM staff_commissions sc
     RIGHT JOIN admin_users au ON au.id = sc.staff_id AND au.role IN ('Staff', 'Manager')
     ORDER BY au.full_name`
  );
  res.json(rows);
});

adminRouter.put('/commissions/:staffId', requireRole('CEO'), async (req: Request, res: Response) => {
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
  const { rows: staff } = await pool.query('SELECT full_name FROM admin_users WHERE id = $1', [staffId]);
  await recordAuditLog(req.adminUser!.id, req.adminUser!.fullName, 'commission_set', 'staff_commission', staffId, `Set ${staff[0]?.full_name || staffId} commission to ${commissionPct}%`);
  res.json(rows[0]);
});

// ═══════════════════════════════════════════════════════
// CEO: Broadcast to All Admins
// ═══════════════════════════════════════════════════════

adminRouter.post('/broadcast', requireRole('CEO'), async (req: Request, res: Response) => {
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

adminRouter.post('/kill-sessions', requireRole('CEO'), async (req: Request, res: Response) => {
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

adminRouter.get('/branding', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM branding LIMIT 1');
  res.json(rows[0] || { portal_title: 'Preyone WiFi', primary_color: '#ff00ff', accent_color: '#6a0dad' });
});

adminRouter.put('/branding', requireRole('CEO'), async (req: Request, res: Response) => {
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

adminRouter.post('/backup', requireRole('CEO'), async (req: Request, res: Response) => {
  // Export key data as JSON snapshot (no pg_dump dependency)
  const dump: any = {};
  const tables = ['packages', 'users', 'vouchers', 'payments', 'admin_users', 'sales', 'settings', 'branding', 'retention_policies', 'staff_commissions', 'ap_devices', 'mac_blacklist', 'mac_whitelist'];
  for (const table of tables) {
    const { rows } = await pool.query(`SELECT * FROM ${table}`);
    dump[table] = rows;
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

adminRouter.get('/backup/logs', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM backup_logs ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

// ═══════════════════════════════════════════════════════
// CEO: Scheduled Reports
// ═══════════════════════════════════════════════════════

adminRouter.get('/report-schedules', requireRole('CEO'), async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM report_schedules ORDER BY created_at DESC');
  res.json(rows);
});

adminRouter.post('/report-schedules', requireRole('CEO'), async (req: Request, res: Response) => {
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

adminRouter.put('/report-schedules/:id', requireRole('CEO'), async (req: Request, res: Response) => {
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

adminRouter.delete('/report-schedules/:id', requireRole('CEO'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows } = await pool.query('DELETE FROM report_schedules WHERE id = $1 RETURNING id', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Schedule not found' }); return; }
  res.json({ message: 'Schedule deleted' });
});
