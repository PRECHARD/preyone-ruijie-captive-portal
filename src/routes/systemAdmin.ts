import { Router, Request, Response, NextFunction } from 'express';
import os from 'os';
import { execSync } from 'child_process';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool';
import { requireAdminAuth } from '../middleware/adminAuth';
import { PERMISSIONS, requirePermission, loadPermissions } from '../middleware/rbac';
import { zimCareLine } from '../utils/phone';

/**
 * Level 0 (system.developer) routes — mounted at /api/v1/admin.
 * Tenant creation, gateway keys, feature flags, system-wide logs.
 * Non-developers (Level 1+ or Staff) get 403 from requirePermission.
 */
export const systemAdminRouter = Router();

systemAdminRouter.use(requireAdminAuth);
systemAdminRouter.use(requirePermission(PERMISSIONS.SYSTEM_DEVELOPER));
// Level 0 endpoints are platform-only, and system.developer is the single
// badge of that access — requirePermission above already rejects anyone
// without it. There is intentionally NO extra companyId guard here: the
// platform owner holds their own transit company binding (companyId) while
// carrying system.developer, and must keep working. Every other router
// (admin.ts, transitWeb.ts) treats system.developer as authoritative, and the
// SPA (App.tsx sectionAllowed) already lets a company-bound system.developer
// see platform sections. A company-scoped admin with no system.developer is
// still blocked above; a company that was mistakenly granted the capability
// is an ops fix in user_permissions/company_permissions, not a reason to
// lock out the real super-admin.

// ── Tenant management ─────────────────────────────────────

systemAdminRouter.get('/companies', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, name, slug, tagline, currency, status, company_code, contact_email,
            commission_rate, payment_gateway, gateway_merchant_id, created_at
     FROM transit_companies WHERE deleted_at IS NULL ORDER BY created_at DESC`
  );
  res.json(rows);
});

systemAdminRouter.get('/companies/:id', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.slug, c.tagline, c.currency, c.status, c.company_code, c.contact_email,
            c.commission_rate, c.payment_gateway, c.gateway_merchant_id, c.min_app_version, c.offline_lease_days,
            c.default_receipt_prefix, c.address, c.email, c.website, c.customer_care,
            c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM transit_users   u WHERE u.company_id = c.id AND u.deleted_at IS NULL)::int   AS user_count,
            (SELECT COUNT(*) FROM transit_devices d WHERE d.company_id = c.id)::int AS device_count,
            (SELECT COALESCE(SUM(t.total_cents),0) FROM transit_tickets t WHERE t.company_id = c.id AND t.synced_at >= date_trunc('month', CURRENT_DATE))::bigint AS month_revenue_cents
     FROM transit_companies c
     WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [req.params.id]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }
  res.json(rows[0]);
});

systemAdminRouter.put('/companies/:id', async (req: Request, res: Response) => {
  const allowed = [
    'name', 'tagline', 'address', 'email', 'website', 'customer_care', 'currency',
    'company_code', 'contact_email', 'commission_rate', 'payment_gateway', 'gateway_merchant_id',
    'min_app_version', 'offline_lease_days', 'default_receipt_prefix', 'status',
  ] as const;
  const { rows: existing } = await pool.query(
    'SELECT id FROM transit_companies WHERE id = $1 AND deleted_at IS NULL', [req.params.id]
  );
  if (existing.length === 0) { res.status(404).json({ error: 'Company not found' }); return; }

  const setClauses: string[] = [];
  const params: any[] = [];
  let idx = 1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      // Care line is a Zimbabwe support number on printed tickets — normalise
      // it to +263 E.164 form so devices and FreeRADIUS see one shape.
      params.push(key === 'customer_care' ? zimCareLine(req.body[key]) : req.body[key]);
      setClauses.push(`${key} = $${idx++}`);
    }
  }
  if (setClauses.length === 0) { res.json({ ok: true }); return; }
  setClauses.push('updated_at = NOW()');
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE transit_companies SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING id, name, slug, status`,
    params
  );
  res.json({ ok: true, company: rows[0] });
});

systemAdminRouter.post('/companies', async (req: Request, res: Response) => {
  const { name, slug, tagline, address, email, website, customer_care, currency, adminUsername, adminPassword, adminName, adminEmail, adminPhone } =
    req.body as Record<string, string | undefined>;

  if (!name || !slug) {
    res.status(422).json({ error: 'name and slug are required' });
    return;
  }

  const webAdminEmail = String(adminEmail || '').trim().toLowerCase();
  const webAdminPassword = adminPassword ? String(adminPassword) : '';
  const seedWebAdmin = !!webAdminEmail && !!webAdminPassword;
  if (webAdminEmail && !adminPassword) {
    res.status(422).json({ error: 'adminEmail and adminPassword must be provided together' });
    return;
  }
  if (seedWebAdmin) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(webAdminEmail)) {
      res.status(422).json({ error: 'adminEmail must be a valid email address' });
      return;
    }
    if (webAdminPassword.length < 10 || !/[A-Z]/.test(webAdminPassword) || !/[0-9]/.test(webAdminPassword)) {
      res.status(422).json({ error: 'adminPassword must be at least 10 characters with at least 1 uppercase letter and 1 number.' });
      return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO transit_companies (name, slug, tagline, address, email, website, customer_care, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [name, slug, tagline || '', address || '', email || '', website || '', zimCareLine(customer_care), currency || 'USD']
    );
    let companyId = rows[0]?.id;
    if (!companyId) {
      const found = await client.query('SELECT id FROM transit_companies WHERE slug = $1', [slug]);
      companyId = found.rows[0]?.id;
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'A transit company with this slug already exists' });
      return;
    }

    // Optionally seed the company SUPER_ADMIN on creation (Level 0 provisioner)
    let adminUser: { id: string; username: string } | null = null;
    if (adminUsername && adminPassword) {
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      const inserted = await client.query(
        `INSERT INTO transit_users (company_id, username, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4, 'SUPER_ADMIN')
         ON CONFLICT (username) DO NOTHING
         RETURNING id`,
        [companyId, adminUsername, passwordHash, adminName || name]
      );
      if (inserted.rows.length > 0) {
        adminUser = { id: inserted.rows[0].id, username: adminUsername };
      }
    }

    // Optionally seed the initial company-scoped web admin (admin_users) in the same transaction
    let webAdmin: { id: string; email: string; role: string } | null = null;
    if (seedWebAdmin) {
      const passwordHash = await bcrypt.hash(webAdminPassword, 12);
      const inserted = await client.query(
        `INSERT INTO admin_users (full_name, email, phone, role, password_hash, company_id)
         VALUES ($1, $2, $3, 'CEO', $4, $5)
         RETURNING id`,
        [String(adminName || '').trim() || webAdminEmail.split('@')[0], webAdminEmail, String(adminPhone || '').trim(), passwordHash, companyId]
      );
      if (inserted.rows.length > 0) {
        webAdmin = { id: inserted.rows[0].id, email: webAdminEmail, role: 'CEO' };
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ companyId, adminUser, webAdmin });
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

// ── Permission catalog (for portal/console UIs) ────────────

systemAdminRouter.get('/permissions', async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT code, description FROM permissions ORDER BY code ASC');
  res.json(rows);
});

// ── Feature flags (global) ─────────────────────────────────

systemAdminRouter.get('/feature-flags', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'feature_flags'`);
  if (rows.length === 0) {
    res.json({});
    return;
  }
  try {
    res.json(JSON.parse(rows[0].value));
  } catch {
    res.json({});
  }
});

systemAdminRouter.put('/feature-flags', async (req: Request, res: Response) => {
  const flags = req.body && typeof req.body === 'object' ? req.body : {};
  await pool.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ('feature_flags', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(flags), req.adminUser!.id]
  );
  res.json({ ok: true });
});

// ── Payment gateway keys (Level 0 only, keys redacted) ─────

function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

systemAdminRouter.get('/payment-keys', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'payment_gateway_keys'`);
  if (rows.length === 0) {
    res.json({});
    return;
  }
  let keys: Record<string, string> = {};
  try {
    keys = JSON.parse(rows[0].value);
  } catch {
    keys = {};
  }
  const redacted: Record<string, string> = {};
  for (const [k, v] of Object.entries(keys)) {
    redacted[k] = maskSecret(v);
  }
  res.json(redacted);
});

systemAdminRouter.put('/payment-keys', async (req: Request, res: Response) => {
  const keys = req.body && typeof req.body === 'object' ? req.body : {};
  const invalid = (Object.values(keys)).some((v) => typeof v !== 'string');
  if (invalid) {
    res.status(422).json({ error: 'All payment key values must be strings' });
    return;
  }
  await pool.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ('payment_gateway_keys', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(keys), req.adminUser!.id]
  );
  res.json({ ok: true });
});

// ── Gateway & RADIUS settings (Level 0, secrets masked) ─────────────────

const GATEWAY_SETTINGS_KEY = 'gateway_settings';

async function readStoredSettings(): Promise<Record<string, any>> {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = $1`, [GATEWAY_SETTINGS_KEY]);
  if (rows.length === 0) return {};
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return {};
  }
}

systemAdminRouter.get('/gateway-settings', async (_req: Request, res: Response) => {
  const stored = await readStoredSettings();
  // Mask all *secret-ish* fields; expose operational fields as-is.
  const redacted: Record<string, any> = {};
  const SECRET_KEYS = new Set(['radius_secret', 'api_secret', 'share_secret', 'ext_login_secret']);
  for (const [k, v] of Object.entries(stored)) {
    redacted[k] = typeof v === 'string' && SECRET_KEYS.has(k) ? maskSecret(v) : v;
  }
  res.json(redacted);
});

systemAdminRouter.put('/gateway-settings', async (req: Request, res: Response) => {
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  const allowedKeys = [
    'gateway_ip', 'gateway_model', 'gateway_port', 'radius_host', 'radius_auth_port', 'radius_acct_port',
    'radius_secret', 'ext_login_host', 'ext_login_port', 'auth_mode', 'api_base_url', 'api_secret',
    'email_service', 'sms_provider',
  ];
  const current = await readStoredSettings();
  const next: Record<string, string> = { ...current };
  for (const key of allowedKeys) {
    if (incoming[key] === undefined) continue;
    const value = String(incoming[key]);
    // Blank secret fields keep their stored value (fields are pre-masked in the UI);
    // only updates that aren't just '****...' masked placeholders are applied.
    if ((key === 'radius_secret' || key === 'api_secret') && (value === '' || value.startsWith('****'))) {
      continue;
    }
    next[key] = value;
  }
  await pool.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [GATEWAY_SETTINGS_KEY, JSON.stringify(next), req.adminUser!.id]
  );
  res.json({ ok: true });
});

// ── System health (Level 0) ─────────────────────────────────────────────

systemAdminRouter.get('/system-health', async (_req: Request, res: Response) => {
  const db = await pool.query('SELECT 1 AS ok');
  const uptimeSec = Math.round(process.uptime());
  const mem = process.memoryUsage();
  let diskFree = 0;
  let diskTotal = 0;
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic logicaldisk where drivetype=3 get size,freespace /format:csv', { encoding: 'utf8', timeout: 5000 });
      const line = out.split(/\r?\n/).find((l) => /,/.test(l) && /\d/.test(l));
      if (line) {
        const [, size, free] = line.split(',');
        diskFree = parseInt(free || '0', 10) || 0;
        diskTotal = parseInt(size || '0', 10) || 0;
      }
    } else {
      const out = execSync('df -Pk / | tail -1', { encoding: 'utf8', timeout: 5000 });
      const parts = out.trim().split(/\s+/);
      diskTotal = parseInt(parts[1] || '0', 10) * 1024;
      diskFree = parseInt(parts[3] || '0', 10) * 1024;
    }
  } catch { /* disk probe is best-effort */ }

  const uptime = {
    days: Math.floor(uptimeSec / 86400),
    hours: Math.floor((uptimeSec % 86400) / 3600),
    minutes: Math.floor((uptimeSec % 3600) / 60),
  };

  res.json({
    db: { ok: db.rowCount === 1, latencyMs: 0 },
    redis: { ok: null, note: process.env.REDIS_URL ? 'ping not wired' : 'not configured' },
    memory: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) },
    disk: { freeBytes: diskFree, totalBytes: diskTotal, freeGb: +(diskFree / 1e9).toFixed(1), totalGb: +(diskTotal / 1e9).toFixed(1) },
    uptime,
    gatewaySettings: await readStoredSettings(),
    hostname: os.hostname(),
    node: process.version,
    time: new Date().toISOString(),
  });
});

// ── Global revenue (all companies, Level 0) ─────────────────────────────

systemAdminRouter.get('/revenue', async (_req: Request, res: Response) => {
  const [totals, byDay, byCompany] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total_tickets,
              COALESCE(SUM(total_cents),0)::bigint AS total_cents,
              COALESCE(SUM(CASE WHEN synced_at >= date_trunc('month', CURRENT_DATE) THEN total_cents ELSE 0 END),0)::bigint AS month_cents
       FROM transit_tickets`
    ),
    pool.query(
      `SELECT to_char(synced_at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count,
              COALESCE(SUM(total_cents),0)::bigint AS total_cents
       FROM transit_tickets GROUP BY 1 ORDER BY 1 DESC LIMIT 30`
    ),
    pool.query(
      `SELECT c.id, c.name, c.slug, c.currency, c.commission_rate, c.status,
              COALESCE(SUM(t.total_cents),0)::bigint AS gross_cents,
              COUNT(t.id)::int AS ticket_count,
              COUNT(DISTINCT t.user_id)::int AS active_staff
       FROM transit_companies c
       LEFT JOIN transit_tickets t ON t.company_id = c.id
       WHERE c.deleted_at IS NULL
       GROUP BY c.id ORDER BY gross_cents DESC`
    ),
  ]);
  const t = totals.rows[0];
  res.json({
    totals: { totalTickets: t.total_tickets, totalCents: t.total_cents, monthCents: t.month_cents },
    byDay: byDay.rows.map((r: any) => ({ day: r.day, count: r.count, totalCents: r.total_cents })),
    byCompany: byCompany.rows.map((r: any) => ({
      id: r.id, name: r.name, slug: r.slug, currency: r.currency, commissionRate: r.commission_rate,
      status: r.status, grossCents: r.gross_cents, ticketCount: r.ticket_count, activeStaff: r.active_staff,
    })),
  });
});

// ── System-wide logs (union of all audit sources) ──────────

systemAdminRouter.get('/system-logs', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT 'admin' AS source, created_at, admin_name AS actor, action, target_type, target_id AS entity_id, detail AS detail
      FROM admin_audit_log
    UNION ALL
    SELECT 'transit', created_at, NULL::text, action, entity, entity_id, metadata::text
      FROM transit_audit_log
    UNION ALL
    SELECT 'security', created_at, NULL::text, event, 'transit_security_event', detail, ip
      FROM transit_security_events
    ORDER BY created_at DESC LIMIT 500
  `);
  res.json(rows);
});

// ── Role/permission lookup for a user (any level) ──────────

systemAdminRouter.get('/users/:id/permissions', async (req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT role FROM admin_users WHERE id = $1', [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'Admin user not found' });
    return;
  }
  const permissions = await loadPermissions(rows[0].role, req.params.id);
  res.json({ role: rows[0].role, permissions });
});