import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { requireAdminAuth, AdminUser } from '../middleware/adminAuth';
import { PERMISSIONS, requirePermission, FIELD_STAFF_ROLES } from '../middleware/rbac';
import { transitAudit, transitSecurityEvent } from '../services/transitAudit';
import { recordAuditLog } from './adminAuth';
import { zimCareLine } from '../utils/phone';

/**
 * Web-portal transit management — mounted at /api/v1/transit.
 * Uses the ADMIN portal JWT (requireAdminAuth), NOT device tokens.
 * Level 0 (no companyId) sees all companies; Level 1+ is scoped to their company.
 */
export const transitWebRouter = Router();

transitWebRouter.use(requireAdminAuth);

/**
 * Appends a company scoping predicate (+ its params) for the given table alias.
 * Level 0 platform users (no companyId) see everything; Level 1+ only their company.
 */
function companyWhere(alias: string, u: AdminUser, params: any[], column = 'company_id'): string {
  if (!u.companyId) return 'TRUE';
  params.push(u.companyId);
  return `${alias}.${column} = $${params.length}`;
}

/** Pull an explicit company context from a Level 0 request (body / query / X-Company-Id header). */
function companyIdFromRequest(req: Request): string {
  const fromHeader = String(req.get('x-company-id') || '').trim();
  return String(req.query.companyId || req.body?.companyId || fromHeader || '').trim();
}

/**
 * Resolve the effective company target for staff/driver write endpoints.
 * Level 1+ is always pinned to its own company (a mismatched explicit target is rejected);
 * Level 0 platform operators must supply one via body/query/header.
 */
function resolveCompany(req: Request, u: AdminUser): { companyId: string | null; error?: string } {
  const passed = companyIdFromRequest(req);
  if (u.companyId) {
    if (passed && passed !== u.companyId) {
      return { companyId: null, error: 'Company-scoped admins cannot target another company' };
    }
    return { companyId: u.companyId };
  }
  return { companyId: passed || null };
}

/** companyWhere variant that also honors an explicit companyId supplied by Level 0 requests. */
function companyScope(alias: string, u: AdminUser, req: Request, params: any[]): string {
  if (u.companyId) {
    params.push(u.companyId);
    return `${alias}.company_id = $${params.length}`;
  }
  const cid = companyIdFromRequest(req);
  if (cid) {
    params.push(cid);
    return `${alias}.company_id = $${params.length}`;
  }
  return 'TRUE';
}

// ── Device management & remote revocation ───────────────────────────────

transitWebRouter.get('/devices', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [];
  const scope = companyWhere('d', u, params);
  const { rows } = await pool.query(
    `SELECT d.id AS device_id, d.device_uuid, d.device_model, d.app_version, d.status,
            d.last_sync, d.last_seen, d.battery_pct, d.active_trip, d.registered_at, d.revoked_at,
            u.username AS bound_username, u.full_name AS bound_name, u.role AS bound_role,
            c.name AS company_name, c.currency
     FROM transit_devices d
     JOIN transit_users u ON u.id = d.user_id AND u.deleted_at IS NULL
     JOIN transit_companies c ON c.id = d.company_id AND c.deleted_at IS NULL
     WHERE ${scope}
     ORDER BY d.last_seen DESC NULLS LAST`,
    params
  );
  res.json({ devices: rows });
});

type DeviceAction = 'disable' | 'revoke';

async function mutateDevice(req: Request, res: Response, action: DeviceAction, status: string, extraSql = ''): Promise<void> {
  const u = req.adminUser!;
  const params: any[] = [req.params.id, status];
  const scope = companyWhere('d', u, params);
  const { rows } = await pool.query(
    `UPDATE transit_devices d
        SET status = $2${extraSql ? ', ' + extraSql : ''}
      WHERE (d.id::text = $1 OR d.device_uuid = $1) AND ${scope}
      RETURNING d.id, d.device_uuid, d.company_id, d.user_id`,
    params
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  const row = rows[0];
  const actionCode = action === 'disable' ? 'DEVICE_DISABLED' : 'DEVICE_REVOKED';
  await transitAudit({
    companyId: row.company_id,
    userId: row.user_id,
    deviceId: row.id,
    action: actionCode,
    entity: 'transit_device',
    entityId: row.device_uuid,
    metadata: { by: u.email, role: u.role },
  });
  await transitSecurityEvent({ companyId: row.company_id, userId: row.user_id, deviceId: row.id, event: actionCode, detail: `device=${row.device_uuid}` });
  res.json({ ok: true, deviceId: row.id, deviceUuid: row.device_uuid, status });
}

/** Remote-disable a device (reversible — binding, status and signing key are retained). */
transitWebRouter.post('/devices/:id/disable', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  await mutateDevice(req, res, 'disable', 'DISABLED', 'revoked_at = NULL');
});

/**
 * Permanently revoke a device. Clears the signing key so any previously issued
 * device token/signature is dead instantly — requireTransitDevice re-reads the
 * device status from the DB on every request and 403s non-ACTIVE devices.
 */
transitWebRouter.post('/devices/:id/revoke', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  await mutateDevice(req, res, 'revoke', 'REVOKED', `revoked_at = NOW(), device_key = ''`);
});

/** Clear the binding + signing key and put the device back into unclaimed state. */
transitWebRouter.post('/devices/:id/reset-binding', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [req.params.id];
  const scope = companyWhere('d', u, params);
  const { rows } = await pool.query(
    `UPDATE transit_devices d
        SET status = 'UNBOUND', device_key = '', min_app_version = '', revoked_at = NULL
      WHERE (d.id::text = $1 OR d.device_uuid = $1) AND ${scope}
      RETURNING d.id, d.device_uuid, d.company_id, d.user_id`,
    params
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  const row = rows[0];
  await transitAudit({ companyId: row.company_id, userId: row.user_id, deviceId: row.id, action: 'DEVICE_BINDING_RESET', entity: 'transit_device', entityId: row.device_uuid, metadata: { by: u.email } });
  res.json({ ok: true, deviceId: row.id, deviceUuid: row.device_uuid, status: 'UNBOUND' });
});

// ── Blocked devices (hardware blacklist) ────────────────────────────────

const BLOCKED_TYPES = ['MAC', 'UUID', 'SERIAL'];

function normalizeHardwareId(raw: string): string {
  return String(raw || '').trim().toUpperCase();
}

/** Platform-wide blacklist. Read/write is restricted to super-admins (system.developer). */
transitWebRouter.get('/blocked-devices', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim().toUpperCase();
  const { rows } = await pool.query(
    `SELECT b.id, b.hardware_id, b.hardware_type, b.device_name, b.reason, b.blocked_at,
            a.full_name AS blocked_by_name,
            d.id AS bound_device_id, d.device_uuid AS bound_uuid, d.status AS bound_status, d.device_model AS bound_model
     FROM blocked_devices b
     LEFT JOIN admin_users a ON a.id = b.blocked_by
     LEFT JOIN transit_devices d ON UPPER(d.device_uuid) = b.hardware_id
     WHERE $1 = '' OR UPPER(b.hardware_id) LIKE '%' || $1 || '%' OR UPPER(b.device_name) LIKE '%' || $1 || '%'
     ORDER BY b.blocked_at DESC`,
    [q]
  );
  res.json({ devices: rows });
});

transitWebRouter.post('/blocked-devices', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const hardwareId = normalizeHardwareId(req.body?.hardwareId);
  if (!hardwareId) {
    res.status(422).json({ error: 'hardwareId is required' });
    return;
  }
  const hardwareType = String(req.body?.hardwareType || 'UUID').toUpperCase();
  if (!BLOCKED_TYPES.includes(hardwareType)) {
    res.status(422).json({ error: 'hardwareType must be one of MAC, UUID, SERIAL' });
    return;
  }
  if (hardwareType === 'MAC' && !/^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/.test(hardwareId)) {
    res.status(422).json({ error: 'Invalid MAC address format' });
    return;
  }
  const deviceName = String(req.body?.deviceName || '').slice(0, 255);
  const reason = String(req.body?.reason || '').slice(0, 1000);
  const { rows } = await pool.query(
    `INSERT INTO blocked_devices (hardware_id, hardware_type, device_name, reason, blocked_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (hardware_id)
     DO UPDATE SET hardware_type = EXCLUDED.hardware_type, device_name = EXCLUDED.device_name,
                   reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by, blocked_at = NOW()
     RETURNING id, hardware_id, hardware_type, device_name, reason, blocked_at`,
    [hardwareId, hardwareType, deviceName, reason, u.id]
  );
  const row = rows[0];
  await recordAuditLog(u.id, u.fullName, 'blocked_devices_add', 'hardware', row.hardware_id, `Blocked ${row.hardware_type} ${row.hardware_id}: ${reason || 'No reason'}`);
  res.status(201).json({ ok: true, device: row });
});

/** Unblock a hardware identifier. The next onboarding/registration call for it succeeds immediately. */
transitWebRouter.delete('/blocked-devices/:hardwareId', requirePermission(PERMISSIONS.SYSTEM_DEVELOPER), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const hardwareId = normalizeHardwareId(req.params.hardwareId);
  if (!hardwareId) {
    res.status(422).json({ error: 'hardwareId is required' });
    return;
  }
  const { rows } = await pool.query(
    `DELETE FROM blocked_devices WHERE hardware_id = $1 RETURNING id, hardware_id, hardware_type`,
    [hardwareId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Blocked device not found' });
    return;
  }
  const row = rows[0];
  await recordAuditLog(u.id, u.fullName, 'blocked_devices_unblock', 'hardware', row.hardware_id, `Unblocked ${row.hardware_type} ${row.hardware_id}`);
  res.json({ ok: true, hardwareId: row.hardware_id });
});

/** Require a minimum app version on a device (server-driven update policy). */
transitWebRouter.post('/devices/:id/require-update', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const minVersion = String(req.body?.minAppVersion || '');
  if (!/^\d+\.\d+\.\d+/.test(minVersion)) {
    res.status(422).json({ error: 'minAppVersion must look like x.y.z' });
    return;
  }
  const u = req.adminUser!;
  const params: any[] = [req.params.id, minVersion];
  const scope = companyWhere('d', u, params);
  const { rows } = await pool.query(
    `UPDATE transit_devices d SET min_app_version = $2
      WHERE (d.id::text = $1 OR d.device_uuid = $1) AND ${scope}
      RETURNING d.id, d.device_uuid`,
    params
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  res.json({ ok: true, deviceUuid: rows[0].device_uuid, minAppVersion: minVersion });
});

// ── Staff & user management (transit_users) ─────────────────────────────

const STAFF_ROLES_ALLOWED = ['OPERATIONS', 'DISPATCHER', 'ACCOUNTANT', 'CONDUCTOR', 'DRIVER', 'TICKET_SELLER'] as const;

/** Releases every terminal locked to a staff member back into the UNBOUND pool. */
const UNBIND_USER_DEVICES_SQL = `UPDATE transit_devices d
    SET user_id = NULL, status = 'UNBOUND', device_key = '',
        min_app_version = '', revoked_at = NULL
  WHERE d.user_id::text = $1
  RETURNING d.id, d.device_uuid`;

transitWebRouter.get('/staff', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [];
  const scope = companyScope('u', u, req, params);
  const role = String(req.query.role || '');
  let roleSql = '';
  if (role) {
    params.push(role);
    // Case-insensitive match so POS dropdowns pick up every active driver
    // regardless of how the role casing was stored.
    roleSql = ` AND UPPER(u.role) = UPPER($${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.phone, u.role, u.status, u.created_at,
            (SELECT COUNT(*) FROM transit_devices d WHERE d.user_id = u.id)::int AS device_count,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'deviceUuid', d.device_uuid, 'status', d.status)
                                        ORDER BY d.last_seen DESC NULLS LAST), '[]')
             FROM transit_devices d WHERE d.user_id = u.id AND d.status <> 'UNBOUND') AS devices
     FROM transit_users u
     WHERE ${scope} AND u.deleted_at IS NULL${roleSql}
     ORDER BY u.created_at DESC`,
    params
  );
  res.json({ staff: rows });
});

function slugifyUsername(fullName: string): string {
  const base = fullName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 10);
  return `${base}${Math.floor(1000 + Math.random() * 9000)}`;
}

function generateSecurePassword(): string {
  return crypto.randomBytes(9).toString('base64url');
}

transitWebRouter.post('/staff', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const { companyId, error } = resolveCompany(req, u);
  if (error) {
    res.status(403).json({ error });
    return;
  }
  if (!companyId) {
    res.status(422).json({ error: 'Staff provisioning requires a company context' });
    return;
  }
  const { fullName, role, salesCode, phone, forcePassword } = req.body as {
    fullName?: string; role?: string; salesCode?: string; phone?: string; forcePassword?: string;
  };
  if (!fullName || !role || !STAFF_ROLES_ALLOWED.includes(role as any)) {
    res.status(422).json({ error: `fullName and a valid role (${STAFF_ROLES_ALLOWED.join(', ')}) are required` });
    return;
  }
  const plainPassword = forcePassword && forcePassword.length >= 8 ? String(forcePassword) : generateSecurePassword();
  const username = String(salesCode || '').trim() || slugifyUsername(fullName);

  // Level 0 platform operators must target a real, non-deleted company
  if (!u.companyId) {
    const { rows: comp } = await pool.query(
      'SELECT id FROM transit_companies WHERE id = $1 AND deleted_at IS NULL', [companyId]
    );
    if (comp.length === 0) {
      res.status(404).json({ error: 'Company not found' });
      return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM transit_users WHERE company_id = $1 AND username = $2', [companyId, username]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: `Username "${username}" already exists in this company` });
      return;
    }
    const passwordHash = await bcrypt.hash(plainPassword, 12);
    const { rows } = await client.query(
      `INSERT INTO transit_users (company_id, username, password_hash, full_name, role, phone)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, role, status`,
      [companyId, username, passwordHash, fullName, role, String(phone || '').trim()]
    );
    await client.query('COMMIT');
    const staff = rows[0];
    await transitAudit({ companyId, action: 'STAFF_CREATED', entity: 'transit_user', entityId: staff.id, metadata: { username, role, phone: String(phone || '').trim(), by: u.email } });
    res.status(201).json({
      staff: { id: staff.id, username: staff.username, role: staff.role, status: staff.status, fullName, phone: String(phone || '').trim() },
      generatedPassword: plainPassword,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

transitWebRouter.post('/staff/:id/status', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const status = String(req.body?.status || '');
  if (!['ACTIVE', 'DISABLED'].includes(status)) {
    res.status(422).json({ error: 'status must be ACTIVE or DISABLED' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params: any[] = [req.params.id, status];
    const scope = companyWhere('u', u, params);
    const { rows } = await client.query(
      `UPDATE transit_users u SET status = $2
        WHERE u.id::text = $1 AND ${scope} RETURNING u.id, u.username, u.role`,
      params
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Staff member not found' });
      return;
    }
    // Deactivating a profile also releases its bound terminals, so the device
    // cannot keep selling offline under a disabled account.
    let devicesUnbound = 0;
    if (status === 'DISABLED') {
      const { rows: unbound } = await client.query(UNBIND_USER_DEVICES_SQL, [req.params.id]);
      devicesUnbound = unbound.length;
      if (devicesUnbound > 0) {
        await transitAudit({
          companyId: u.companyId || undefined,
          action: 'STAFF_DEVICE_AUTO_UNBOUND',
          entity: 'transit_user',
          entityId: rows[0].id,
          metadata: { username: rows[0].username, devicesUnbound, reason: 'staff disabled', by: u.email },
        });
      }
    }
    await client.query('COMMIT');
    await transitAudit({ companyId: u.companyId || undefined, action: status === 'ACTIVE' ? 'STAFF_ACTIVATED' : 'STAFF_DISABLED', entity: 'transit_user', entityId: rows[0].id, metadata: { username: rows[0].username, by: u.email } });
    res.json({ ok: true, id: rows[0].id, status, devicesUnbound });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/** Update a staff profile: full name, phone and/or role (company-scoped). */
transitWebRouter.patch('/staff/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const maxLen = (v: string) => v.length > 160 ? v.slice(0, 160) : v;

  const updates: string[] = [];
  const params: any[] = [];

  const fullName = typeof req.body?.fullName === 'string' ? maxLen(req.body.fullName.trim()) : '';
  if (fullName) {
    params.push(fullName);
    updates.push(`full_name = $${params.length}`);
  }
  const phoneRaw = req.body?.phone ?? req.body?.phoneNumber ?? req.body?.phone_number;
  if (typeof phoneRaw === 'string') {
    params.push(maxLen(phoneRaw.trim()));
    updates.push(`phone = $${params.length}`);
  }
  if (typeof req.body?.role === 'string' && String(req.body.role).trim()) {
    const role = String(req.body.role).trim();
    if (!STAFF_ROLES_ALLOWED.includes(role as any)) {
      res.status(422).json({ error: `Invalid role; must be one of ${STAFF_ROLES_ALLOWED.join(', ')}` });
      return;
    }
    params.push(role);
    updates.push(`role = $${params.length}`);
  }
  if (updates.length === 0) {
    res.status(422).json({ error: 'Provide at least one updatable field: fullName, phone or role' });
    return;
  }

  params.push(String(req.params.id));
  const idIdx = params.length;
  const scope = companyScope('u', u, req, params);
  const { rows } = await pool.query(
    `UPDATE transit_users u
        SET ${updates.join(', ')}, updated_at = NOW()
      WHERE u.id::text = $${idIdx} AND ${scope} AND u.deleted_at IS NULL
      RETURNING u.id, u.username, u.full_name, u.phone, u.role, u.company_id`,
    params
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Staff member not found' });
    return;
  }
  const staff = rows[0];
  // Re-roling a field operator (conductor/driver/seller) out of the field
  // invalidates any terminals locked to them — release them back to the pool.
  const roleChanged = updates.some(field => field.startsWith('role'));
  let devicesUnbound = 0;
  if (roleChanged && !FIELD_STAFF_ROLES.includes(staff.role as any)) {
    const { rows: unbound } = await pool.query(UNBIND_USER_DEVICES_SQL, [staff.id]);
    devicesUnbound = unbound.length;
    if (devicesUnbound > 0) {
      await transitAudit({
        companyId: u.companyId || staff.company_id,
        action: 'STAFF_DEVICE_AUTO_UNBOUND',
        entity: 'transit_user',
        entityId: staff.id,
        metadata: { username: staff.username, devicesUnbound, reason: 'role changed to non-field', by: u.email },
      });
    }
  }
  await transitAudit({
    companyId: u.companyId || staff.company_id,
    action: 'STAFF_UPDATED',
    entity: 'transit_user',
    entityId: staff.id,
    metadata: { username: staff.username, fields: updates.map(s => s.split('=')[0].trim()), by: u.email },
  });
  res.json({ staff: { id: staff.id, username: staff.username, fullName: staff.full_name, phone: staff.phone, role: staff.role }, devicesUnbound });
});

/**
 * Reset a staff member's password (admin manual override). A fresh secure
 * password is generated, stored hashed, and returned in plaintext exactly
 * once so the operator can hand it over to the staff member directly.
 */
transitWebRouter.patch('/staff/:id/reset-password', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [req.params.id];
  const scope = companyWhere('u', u, params);
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.company_id
     FROM transit_users u
     WHERE u.id::text = $1 AND ${scope} AND u.deleted_at IS NULL`,
    params
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Staff member not found' });
    return;
  }
  const staff = rows[0];
  const plainPassword = generateSecurePassword();
  const passwordHash = await bcrypt.hash(plainPassword, 12);
  await pool.query(
    'UPDATE transit_users SET password_hash = $1, updated_at = NOW() WHERE id::text = $2',
    [passwordHash, req.params.id]
  );
  await transitAudit({
    companyId: u.companyId || staff.company_id,
    action: 'STAFF_PASSWORD_RESET',
    entity: 'transit_user',
    entityId: staff.id,
    metadata: { username: staff.username, by: u.email },
  });
  res.json({
    staff: { id: staff.id, username: staff.username },
    generatedPassword: plainPassword,
  });
});

/**
 * Unbind every terminal locked to a staff profile. Clears the user binding
 * (device.user_id -> NULL), wipes the flashing signing key and returns the
 * devices to the UNBOUND pool so they can be re-registered to another operator.
 */
transitWebRouter.post('/staff/:id/unbind-device', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [req.params.id];
  const scope = companyWhere('u', u, params);
  const { rows: users } = await pool.query(
    `SELECT u.id, u.username, u.company_id
     FROM transit_users u
     WHERE u.id::text = $1 AND ${scope} AND u.deleted_at IS NULL`,
    params
  );
  if (users.length === 0) {
    res.status(404).json({ error: 'Staff member not found' });
    return;
  }
  const user = users[0];
  const devParams: any[] = [req.params.id, user.company_id];
  const devScope = companyWhere('d', u, devParams);
  const { rows } = await pool.query(
    `UPDATE transit_devices d
        SET user_id = NULL, status = 'UNBOUND', device_key = '',
            min_app_version = '', revoked_at = NULL
      WHERE d.user_id::text = $1 AND d.company_id = $2 AND ${devScope}
      RETURNING d.id, d.device_uuid`,
    devParams
  );
  if (rows.length > 0) {
    await transitAudit({
      companyId: user.company_id,
      action: 'STAFF_DEVICE_UNBOUND',
      entity: 'transit_user',
      entityId: user.id,
      metadata: { username: user.username, devicesUnbound: rows.length, by: u.email },
    });
  }
  res.json({
    success: true,
    message: 'Device unbound successfully',
    ok: true,
    userId: user.id,
    devicesUnbound: rows.length,
    deviceUuids: rows.map((r: any) => r.device_uuid),
  });
});

/**
 * Permanently delete a transit_users profile (hard delete). Guarded: a profile
 * with any linked shifts, tickets or trips is refused (409) — keep using the
 * disable flow for active staff. Bound devices are released to the UNBOUND pool
 * first (the FK is ON DELETE SET NULL); audit, security, promo and reset
 * references are ON DELETE SET NULL so history is preserved.
 * Intended for erroneous/test profiles only.
 */
transitWebRouter.delete('/staff/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [req.params.id];
  const scope = companyWhere('u', u, params);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT u.id, u.username, u.full_name, u.company_id,
              (SELECT COUNT(*) FROM transit_shifts s WHERE s.user_id = u.id)::int AS shifts,
              (SELECT COUNT(*) FROM transit_tickets t WHERE t.user_id = u.id)::int AS tickets,
              (SELECT COUNT(*) FROM transit_trips tr WHERE tr.user_id = u.id)::int AS trips
       FROM transit_users u
       WHERE u.id::text = $1 AND ${scope} AND u.deleted_at IS NULL`,
      params
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Staff member not found' });
      return;
    }
    const staff = rows[0];
    if (staff.shifts > 0 || staff.tickets > 0 || staff.trips > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({
        error: 'Staff has linked shifts, tickets or trips and cannot be hard-deleted. Deactivate the account instead.',
        shifts: staff.shifts,
        tickets: staff.tickets,
        trips: staff.trips,
      });
      return;
    }
    const { rows: unbound } = await client.query(UNBIND_USER_DEVICES_SQL, [req.params.id]);
    await client.query('DELETE FROM transit_users WHERE id::text = $1', [req.params.id]);
    await client.query('COMMIT');
    if (unbound.length > 0) {
      await transitAudit({
        companyId: staff.company_id,
        action: 'STAFF_DEVICE_AUTO_UNBOUND',
        entity: 'transit_user',
        entityId: staff.id,
        metadata: { username: staff.username, devicesUnbound: unbound.length, reason: 'staff deleted', by: u.email },
      });
    }
    await transitAudit({
      companyId: staff.company_id,
      action: 'STAFF_DELETED',
      entity: 'transit_user',
      entityId: staff.id,
      metadata: { username: staff.username, fullName: staff.full_name, by: u.email },
    });
    res.json({ ok: true, id: staff.id, deleted: true, devicesUnbound: unbound.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ── Transit operations dashboard ────────────────────────────────────
// Company-scoped aggregates over transit_trips / transit_tickets /
// transit_devices / transit_staff / transit_shifts only. No WiFi or POS
// tables are read here (sector isolation).
transitWebRouter.get('/dashboard', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;

  const q = (alias: string, sql: string) => {
    const params: any[] = [];
    const scope = companyWhere(alias, u, params);
    return pool.query(sql.replace('{{scope}}', scope), params);
  };

  try {
    const [
      statusRes, todayRes, weekRes, monthRes,
      vehicleRes, deviceRes, staffRes, shiftRes,
      routeRes, templateRes, userRes, companyRes, tripRes,
      historyRes,
    ] = await Promise.all([
      q('t', `SELECT status, COUNT(*)::int AS count FROM transit_trips t WHERE {{scope}} GROUP BY status`),
      q('k', `SELECT COUNT(*)::int AS tickets, COALESCE(SUM(k.total_cents),0)::bigint AS gross,
                     COALESCE(SUM(k.cash_cents),0)::bigint AS cash
              FROM transit_tickets k WHERE {{scope}} AND k.status <> 'CANCELLED' AND k.synced_at >= date_trunc('day', NOW())`),
      q('k', `SELECT COUNT(*)::int AS tickets, COALESCE(SUM(k.total_cents),0)::bigint AS gross
              FROM transit_tickets k WHERE {{scope}} AND k.status <> 'CANCELLED'
              AND k.synced_at >= date_trunc('week', NOW())`),
      q('k', `SELECT COUNT(*)::int AS tickets, COALESCE(SUM(k.total_cents),0)::bigint AS gross
              FROM transit_tickets k WHERE {{scope}} AND k.status <> 'CANCELLED'
              AND k.synced_at >= date_trunc('month', NOW())`),
      q('t', `SELECT t.bus_reg AS registration, COUNT(*)::int AS tripCount
              FROM transit_trips t WHERE {{scope}} AND t.bus_reg <> '' GROUP BY t.bus_reg ORDER BY t.bus_reg`),
      q('d', `SELECT d.status, COUNT(*)::int AS total,
                     COUNT(*) FILTER (WHERE d.last_seen >= NOW() - interval '5 minutes')::int AS online
              FROM transit_devices d WHERE {{scope}} GROUP BY d.status`),
      q('s', `SELECT s.role, COUNT(*)::int AS total FROM transit_staff s
              WHERE {{scope}} AND s.status = 'ACTIVE' AND s.deleted_at IS NULL GROUP BY s.role`),
      q('sh', `SELECT COUNT(*) FILTER (WHERE sh.status = 'OPEN')::int AS open, COUNT(*)::int AS total
               FROM transit_shifts sh WHERE {{scope}}`),
      q('k', `SELECT COALESCE(NULLIF(k.route_name,''), k.route_code) AS route,
                     COUNT(*)::int AS trips, COALESCE(SUM(k.total_cents),0)::bigint AS gross
              FROM transit_tickets k WHERE {{scope}} AND k.status <> 'CANCELLED'
              GROUP BY 1 ORDER BY gross DESC LIMIT 8`),
      q('rt', `SELECT COUNT(*)::int AS active FROM transit_route_templates rt WHERE {{scope}} AND rt.active = TRUE`),
      q('tu', `SELECT COUNT(*)::int AS total FROM transit_users tu WHERE {{scope}}`),
      (() => { const p: any[] = []; const sc = companyWhere('c', u, p, 'id'); return pool.query(
        `SELECT id, name, slug, currency, default_receipt_prefix
         FROM transit_companies c WHERE ${sc} AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 1`, p); })(),
      (() => { const p: any[] = []; const sc = companyWhere('t', u, p); p.push(8); return pool.query(
        `SELECT t.id, t.trip_no, t.bus_reg, t.route_code, t.route_name, t.route_from, t.route_to,
                t.departure_time, t.driver, t.conductor1, t.status, t.opened_at, t.closed_at,
                u.username AS operator,
                (SELECT COUNT(*) FROM transit_tickets k WHERE k.trip_id = t.id)::int AS ticket_count,
                (SELECT COALESCE(SUM(k.total_cents),0) FROM transit_tickets k WHERE k.trip_id = t.id)::bigint AS total_cents
         FROM transit_trips t LEFT JOIN transit_users u ON u.id = t.user_id AND u.deleted_at IS NULL
         WHERE ${sc} ORDER BY t.opened_at DESC LIMIT $${p.length}`, p); })(),
      q('t', `SELECT date_trunc('hour', t.opened_at) AS hour,
                     COUNT(*)::int AS trips,
                     COUNT(*) FILTER (WHERE t.status IN ('COMPLETED','CLOSED'))::int AS completed
              FROM transit_trips t WHERE {{scope}} AND t.opened_at >= NOW() - interval '24 hours'
              GROUP BY 1 ORDER BY 1`),
    ]);

    const counts: Record<string, number> = {};
    for (const r of statusRes.rows) counts[r.status] = r.count;

    const deviceOnline = deviceRes.rows.reduce((s: number, r: any) => s + (r.online || 0), 0);
    const deviceTotal = deviceRes.rows.reduce((s: number, r: any) => s + (r.total || 0), 0);
    const staff = {
      drivers: (staffRes.rows.find((r: any) => r.role === 'DRIVER') || { total: 0 }).total as number,
      conductors: (staffRes.rows.find((r: any) => r.role === 'CONDUCTOR') || { total: 0 }).total as number,
    };

    res.json({
      company: companyRes.rows[0] || null,
      fleet: {
        vehicles: vehicleRes.rows.length,
        fleet: vehicleRes.rows,
        deviceOnline,
        deviceTotal,
        openShifts: shiftRes.rows[0]?.open || 0,
        totalShifts: shiftRes.rows[0]?.total || 0,
        activeTemplates: templateRes.rows[0]?.active || 0,
        transitUsers: userRes.rows[0]?.total || 0,
        drivers: staff.drivers,
        conductors: staff.conductors,
      },
      status: {
        scheduled: counts['SCHEDULED'] || 0,
        open: counts['OPEN'] || 0,
        active: counts['ACTIVE'] || 0,
        completed: counts['COMPLETED'] || 0,
        cancelled: counts['CANCELLED'] || 0,
        closed: counts['CLOSED'] || 0,
      },
      today: todayRes.rows[0] || { tickets: 0, gross: 0, cash: 0 },
      period: {
        week: weekRes.rows[0] || { tickets: 0, gross: 0 },
        month: monthRes.rows[0] || { tickets: 0, gross: 0 },
      },
      routes: routeRes.rows,
      recentTrips: tripRes.rows,
      history24h: historyRes.rows,
    });
  } catch (err: any) {
    console.error('Transit dashboard error:', err.message, err.query);
    res.status(500).json({ error: 'Transit dashboard query failed' });
  }
});

// ── Trip schedules ──────────────────────────────────────────────────────

transitWebRouter.get('/trips', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [];
  const scope = companyWhere('t', u, params);
  params.push(Math.min(Number(req.query.limit) || 200, 500));
  const { rows } = await pool.query(
    `SELECT t.id, t.company_id, t.trip_no, t.bus_reg, t.route_code, t.route_name,
            t.route_from, t.route_to, t.departure_time, t.base_fare_cents,
            t.total_seats, t.seats_sold,
            t.driver, t.driver_id, t.driver_phone, t.conductor1, t.conductor2, t.conductor_phone,
            t.status, t.opened_at, t.closed_at,
            u.username AS operator,
            (SELECT COUNT(*) FROM transit_tickets k WHERE k.trip_id = t.id)::int AS ticket_count,
            (SELECT COALESCE(SUM(k.total_cents),0) FROM transit_tickets k WHERE k.trip_id = t.id)::bigint AS total_cents
     FROM transit_trips t
     LEFT JOIN transit_users u ON u.id = t.user_id AND u.deleted_at IS NULL
     WHERE ${scope}
     ORDER BY t.opened_at DESC LIMIT $${params.length}`,
    params
  );
  res.json({
    trips: rows.map((r: any) => ({
      ...r,
      _companyId: r.company_id,
      _driverId: r.driver_id,
      company_id: undefined,
      driver_id: undefined,
    })),
  });
});

// ── Route & fleet reference (for the admin trip-schedule form) ──────────

transitWebRouter.get('/routes', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [];
  const scope = companyScope('t', u, req, params);
  const { rows } = await pool.query(
    `SELECT DISTINCT
            COALESCE(NULLIF(t.route_code, ''), '') AS "routeCode",
            COALESCE(NULLIF(t.route_from, ''), split_part(t.route_name, ' - ', 1)) AS "routeFrom",
            COALESCE(NULLIF(t.route_to, ''), split_part(t.route_name, ' - ', 2)) AS "routeTo",
            COALESCE(NULLIF(t.route_name, ''), '') AS "routeName"
     FROM transit_trips t
     WHERE ${scope} AND (t.route_code <> '' OR t.route_name <> '')
     ORDER BY "routeName" ASC NULLS LAST, "routeCode" ASC`,
    params
  );
  res.json({ routes: rows });
});

transitWebRouter.get('/fleet', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [];
  const scope = companyScope('t', u, req, params);
  const { rows } = await pool.query(
    `SELECT t.bus_reg AS registration, COUNT(*)::int AS "tripCount"
     FROM transit_trips t
     WHERE ${scope} AND t.bus_reg <> ''
     GROUP BY t.bus_reg
     ORDER BY t.bus_reg ASC`,
    params
  );
  res.json({ vehicles: rows });
});

// ── Admin trip scheduling ───────────────────────────────────────────────
//
// Level 1+ schedules for its own company; Level 0 must pass companyId via
// body / query / X-Company-Id header. Unlike device-created trips, admin
// trips are NOT bound to a POS user/device (user_id / device_id stay NULL)
// and start in SCHEDULED status.

function scheduleTripNo(routeCode: string, departureTime: string): string {
  const stamp = departureTime ? departureTime.slice(0, 10).replace(/-/g, '') : '';
  const base = routeCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10);
  return `${base || 'TRIP'}${stamp ? `-${stamp}` : ''}`;
}

transitWebRouter.post('/trips', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const { companyId, error } = resolveCompany(req, u);
  if (error) {
    res.status(403).json({ error });
    return;
  }
  if (!companyId) {
    res.status(422).json({ error: 'Scheduling a trip requires a company context (Level 0 must pass companyId)' });
    return;
  }
  const b = req.body || {};
  const routeFrom = String(b.routeFrom || '').trim();
  const routeTo = String(b.routeTo || '').trim();
  const routeCode = String(b.routeCode || '').trim().toUpperCase();
  if (!routeFrom || !routeTo) {
    res.status(422).json({ error: 'routeFrom and routeTo are required' });
    return;
  }
  const departureTime = String(b.departureTime || '').trim();
  if (departureTime && Number.isNaN(Date.parse(departureTime))) {
    res.status(422).json({ error: 'departureTime must be a valid date/time' });
    return;
  }
  const baseFareCents = Math.max(0, Math.round(Number(b.baseFareCents) || 0));
  const totalSeats = Math.max(0, Math.round(Number(b.totalSeats) || 0));
  const busReg = String(b.busReg || '').trim();
  const requestedTripNo = String(b.tripNo || '').trim();

  // Resolve the assigned driver (optional; a POS operator can attach a driver later)
  let driverName = '';
  let driverId = '';
  const requestedDriverId = String(b.driverId || '').trim();
  if (requestedDriverId) {
    const { rows: drivers } = await pool.query(
      `SELECT id, full_name FROM transit_users
       WHERE id::text = $1 AND company_id = $2 AND deleted_at IS NULL AND status = 'ACTIVE'`,
      [requestedDriverId, companyId]
    );
    if (drivers.length === 0) {
      res.status(422).json({ error: 'Assigned driver not found in this company' });
      return;
    }
    driverId = drivers[0].id;
    driverName = drivers[0].full_name;
  }

  // Unique trip number per company: honour an explicit tripNo, else auto-derive
  // from route code + departure date, bumping a numeric suffix on collisions.
  const baseTripNo = requestedTripNo || scheduleTripNo(routeCode, departureTime);
  let tripNo = baseTripNo;
  const insertTrip = async (no: string): Promise<any> => {
    const { rows } = await pool.query(
      `INSERT INTO transit_trips
         (company_id, user_id, device_id, trip_no, bus_reg, route_code, route_name,
          route_from, route_to, departure_time, driver, driver_id, driver_phone,
          total_seats, base_fare_cents, status)
       VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'SCHEDULED')
       RETURNING id, trip_no, bus_reg, route_code, route_from, route_to, route_name,
                 departure_time, driver, driver_id, total_seats, base_fare_cents, status, opened_at`,
      [companyId, no, busReg, routeCode, `${routeFrom} - ${routeTo}`, routeFrom, routeTo,
       departureTime || new Date().toISOString(), driverName, driverId, String(b.driverPhone || '').trim(),
       totalSeats, baseFareCents]
    );
    return rows[0];
  };

  try {
    let row: any = null;
    if (requestedTripNo) {
      row = await insertTrip(requestedTripNo);
      tripNo = requestedTripNo;
    } else {
      for (let attempt = 1; attempt <= 50 && !row; attempt++) {
        try {
          row = await insertTrip(tripNo);
        } catch (e: any) {
          if (e?.code !== '23505') throw e;
          tripNo = `${baseTripNo}-${attempt + 1}`;
        }
      }
      if (!row) {
        res.status(409).json({ error: 'Could not allocate a unique trip number' });
        return;
      }
    }
    await transitAudit({ companyId, action: 'TRIP_SCHEDULED', entity: 'transit_trip', entityId: row.id, metadata: { tripNo, routeName: `${routeFrom} - ${routeTo}`, by: u.email } });
    res.status(201).json({ trip: row });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: `Trip "${tripNo}" already exists for this company` });
      return;
    }
    throw err;
  }
});

// ── Trip detail (single SCHEDULED/OPEN/CLOSED/ACTIVE trip + its tickets) ─

transitWebRouter.get('/trips/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE, PERMISSIONS.FINANCE_VIEW), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const tripId = String(req.params.id || '');
  if (!tripId) {
    res.status(400).json({ error: 'trip id is required' });
    return;
  }
  const params: any[] = [tripId];
  const scope = companyWhere('t', u, params);
  const { rows: trips } = await pool.query(
    `SELECT t.id, t.company_id, t.trip_no, t.bus_reg, t.route_code, t.route_name,
            t.route_from, t.route_to, t.departure_time, t.base_fare_cents,
            t.total_seats, t.seats_sold,
            t.driver, t.driver_id, t.driver_phone, t.conductor1, t.conductor2, t.conductor_phone,
            t.status, t.opened_at, t.closed_at, t.updated_at,
            u.username AS operator
     FROM transit_trips t
     LEFT JOIN transit_users u ON u.id = t.user_id AND u.deleted_at IS NULL
     WHERE ${scope} AND t.id::text = $1`,
    params
  );
  if (trips.length === 0) {
    res.status(404).json({ error: 'Trip not found in this company scope' });
    return;
  }
  const trip = trips[0];
  const { rows: tickets } = await pool.query(
    `SELECT t.seat_number, t.customer_name, t.customer_mobile, t.total_cents,
            t.cash_cents, t.change_cents, t.client_receipt_no, t.payment_method,
            t.status, t.sale_time
     FROM transit_tickets t
     WHERE t.company_id = $2 AND t.trip_id = $1 AND t.status <> 'CANCELLED'
     ORDER BY t.seat_number ASC NULLS LAST, t.sale_time ASC`,
    [trip.id, trip.company_id]
  );
  res.json({ trip, tickets, count: tickets.length });
});

// ── Edit a SCHEDULED trip (bus, route, departure, fare, seats, crew) ─────

transitWebRouter.patch('/trips/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const b = req.body || {};
  const tripId = String(req.params.id || '');
  if (!tripId) {
    res.status(400).json({ error: 'trip id is required' });
    return;
  }
  const params: any[] = [tripId];
  const scope = companyWhere('t', u, params);
  const { rows: trips } = await pool.query(
    `SELECT t.id, t.company_id, t.status FROM transit_trips t
     WHERE ${scope} AND t.id::text = $1`,
    params
  );
  if (trips.length === 0) {
    res.status(404).json({ error: 'Trip not found in this company scope' });
    return;
  }
  const trip = trips[0];
  if (trip.status !== 'SCHEDULED') {
    res.status(409).json({ error: `Trip ${trip.status} — only SCHEDULED trips can be edited (has tickets)` });
    return;
  }
  const companyId = trip.company_id;

  const routeFrom = String(b.routeFrom ?? '').trim();
  const routeTo = String(b.routeTo ?? '').trim();
  const routeCode = String(b.routeCode ?? '').trim().toUpperCase();
  const routeName = String(b.routeName ?? '').trim();
  if ((routeFrom || routeTo || routeCode || routeName) && (!routeFrom || !routeTo)) {
    res.status(422).json({ error: 'routeFrom and routeTo are required when editing the route' });
    return;
  }
  const departureTime = String(b.departureTime ?? '').trim();
  if (departureTime && Number.isNaN(Date.parse(departureTime))) {
    res.status(422).json({ error: 'departureTime must be a valid date/time' });
    return;
  }
  const baseFareCents = Math.max(0, Math.round(Number(b.baseFareCents ?? trip.base_fare_cents) || 0));
  const totalSeats = Math.max(0, Math.round(Number(b.totalSeats ?? trip.total_seats) || 0));
  const busReg = String(b.busReg ?? '').trim();

  // Resolve an (optional) reassigned driver against this company's ACTIVE staff.
  let driverName = trip.driver || '';
  let driverId = trip.driver_id || '';
  if (b.driverId !== undefined) {
    const requestedDriverId = String(b.driverId || '').trim();
    if (requestedDriverId) {
      const { rows: drivers } = await pool.query(
        `SELECT id, full_name FROM transit_users
         WHERE id::text = $1 AND company_id = $2 AND deleted_at IS NULL AND status = 'ACTIVE'`,
        [requestedDriverId, companyId]
      );
      if (drivers.length === 0) {
        res.status(422).json({ error: 'Assigned driver not found in this company' });
        return;
      }
      driverId = drivers[0].id;
      driverName = drivers[0].full_name;
    } else {
      driverId = '';
      driverName = '';
    }
  }

  const { rows } = await pool.query(
    `UPDATE transit_trips SET
       route_code = $2,
       route_from  = $3,
       route_to    = $4,
       route_name  = $5,
       departure_time = $6,
       base_fare_cents = $7,
       total_seats = $8,
       bus_reg = $9,
       driver = $10,
       driver_id = $11,
       driver_phone = $12,
       updated_at = NOW()
     WHERE id = $1
     RETURNING id, trip_no, bus_reg, route_code, route_from, route_to, route_name,
               departure_time, driver, driver_id, total_seats, base_fare_cents,
               status, opened_at, updated_at`,
    [
      trip.id,
      routeCode,
      routeFrom || trip.route_from || '',
      routeTo || trip.route_to || '',
      routeName || trip.route_name || `${routeFrom} - ${routeTo}` || trip.route_name,
      departureTime || trip.departure_time || null,
      baseFareCents,
      totalSeats,
      busReg,
      driverName,
      driverId,
      String(b.driverPhone ?? trip.driver_phone ?? '').trim(),
    ]
  );
  await transitAudit({
    companyId: String(companyId),
    action: 'TRIP_UPDATED',
    entity: 'transit_trip',
    entityId: trip.id,
    metadata: { tripNo: rows[0].trip_no, by: u.email },
  });
  res.json({ trip: rows[0] });
});

// ── Cancel a SCHEDULED trip (soft — kept for audit, never hard-deleted) ──

transitWebRouter.post('/trips/:id/cancel', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const tripId = String(req.params.id || '');
  if (!tripId) {
    res.status(400).json({ error: 'trip id is required' });
    return;
  }
  const params: any[] = [tripId];
  const scope = companyWhere('t', u, params);
  const { rows } = await pool.query(
    `SELECT t.id, t.company_id, t.status, t.trip_no,
            (SELECT COUNT(*) FROM transit_tickets k WHERE k.trip_id = t.id)::int AS ticket_count
     FROM transit_trips t
     WHERE ${scope} AND t.id::text = $1`,
    params
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Trip not found in this company scope' });
    return;
  }
  const trip = rows[0];
  if (trip.status === 'CANCELLED') {
    res.status(409).json({ error: 'Trip is already cancelled' });
    return;
  }
  if (trip.status !== 'SCHEDULED') {
    res.status(409).json({ error: `Trip ${trip.status} — only SCHEDULED trips can be cancelled (${trip.ticket_count} ticket(s) already attached)` });
    return;
  }
  const { rows: updated } = await pool.query(
    `UPDATE transit_trips SET status = 'CANCELLED', updated_at = NOW()
     WHERE id = $1
     RETURNING id, trip_no, status, updated_at`,
    [trip.id]
  );
  await transitAudit({
    companyId: String(trip.company_id),
    action: 'TRIP_CANCELLED',
    entity: 'transit_trip',
    entityId: trip.id,
    metadata: { tripNo: trip.trip_no, by: u.email },
  });
  res.json({ trip: updated[0] });
});

// ── Ticket manifests ────────────────────────────────────────────────────

transitWebRouter.get('/tickets', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE, PERMISSIONS.FINANCE_VIEW), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [];
  const scope = companyWhere('t', u, params);
  params.push(Math.min(Number(req.query.limit) || 200, 500));
  const { rows } = await pool.query(
    `SELECT t.id, t.tx_id, t.client_receipt_no, t.trip_no, t.route_code, t.route_name,
            t.route_from, t.route_to,
            t.seat_number, t.customer_name, t.customer_mobile, t.total_cents, t.cash_cents,
            t.change_cents, t.status, t.sale_time, t.synced_at,
            t.conductor1, t.driver, u.username AS operator, c.name AS company_name,
            c.currency
     FROM transit_tickets t
     LEFT JOIN transit_users u ON u.id = t.user_id AND u.deleted_at IS NULL
     JOIN transit_companies c ON c.id = t.company_id AND c.deleted_at IS NULL
     WHERE ${scope}
     ORDER BY t.synced_at DESC LIMIT $${params.length}`,
    params
  );
  res.json({ tickets: rows });
});

// ── Per-trip passenger manifest ─────────────────────────────────────────

transitWebRouter.get('/manifest/:tripNo', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE, PERMISSIONS.FINANCE_VIEW), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const tripNo = String(req.params.tripNo || '');
  if (!tripNo) {
    res.status(400).json({ error: 'trip_no is required' });
    return;
  }
  const params: any[] = [tripNo];
  const scope = `${companyWhere('t', u, params)} AND t.trip_no = $1`;
  const { rows } = await pool.query(
    `SELECT t.id, t.tx_id, t.client_receipt_no AS receipt_no, t.trip_no,
            t.route_code, t.route_from AS origin, t.route_to AS destination, t.route_name,
            t.seat_number, t.customer_name, t.customer_mobile,
            t.driver AS driver_name, t.driver_phone, t.conductor1 AS conductor_name,
            t.conductor2, t.conductor_phone,
            t.total_cents, t.cash_cents, t.change_cents, t.status, t.sale_time, t.synced_at,
            c.name AS company_name, c.currency
     FROM transit_tickets t
     LEFT JOIN transit_users u ON u.id = t.user_id AND u.deleted_at IS NULL
     JOIN transit_companies c ON c.id = t.company_id AND c.deleted_at IS NULL
     WHERE ${scope}
     ORDER BY t.seat_number ASC NULLS LAST, t.synced_at ASC`,
    params
  );
  res.json({ tripNo, tickets: rows, count: rows.length });
});

// ── Financial reports ───────────────────────────────────────────────────

transitWebRouter.get('/financials', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.FINANCE_VIEW), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [];
  const scope = companyWhere('t', u, params);
  const companyParams: any[] = [];
  const companyScope = companyWhere('c', u, companyParams, 'id');

  const [summaryRows, byDateRows, byRouteRows, byStaffRows, companyRows] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total_tickets,
              COALESCE(SUM(total_cents),0)::bigint AS total_cents,
              COALESCE(SUM(CASE WHEN synced_at::date = CURRENT_DATE THEN total_cents ELSE 0 END),0)::bigint AS today_cents,
              COALESCE(SUM(CASE WHEN synced_at >= date_trunc('week', CURRENT_DATE) THEN total_cents ELSE 0 END),0)::bigint AS week_cents,
              COALESCE(SUM(CASE WHEN synced_at >= date_trunc('month', CURRENT_DATE) THEN total_cents ELSE 0 END),0)::bigint AS month_cents,
              COUNT(*) FILTER (WHERE status = 'SEAT_CONFLICT')::int AS conflicts,
              COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
       FROM transit_tickets t WHERE ${scope}`,
      params
    ),
    pool.query(
      `SELECT to_char(synced_at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count,
              COALESCE(SUM(total_cents),0)::bigint AS total_cents
       FROM transit_tickets t WHERE ${scope}
       GROUP BY 1 ORDER BY 1 DESC LIMIT 14`,
      params
    ),
    pool.query(
      `SELECT t.route_name, COUNT(*)::int AS count, COALESCE(SUM(t.total_cents),0)::bigint AS total_cents
       FROM transit_tickets t WHERE ${scope}
       GROUP BY t.route_name ORDER BY total_cents DESC LIMIT 15`,
      params
    ),
    pool.query(
      `SELECT t.conductor1 AS staff, COUNT(*)::int AS count, COALESCE(SUM(t.total_cents),0)::bigint AS total_cents
       FROM transit_tickets t WHERE ${scope} AND t.conductor1 <> ''
       GROUP BY t.conductor1 ORDER BY total_cents DESC LIMIT 15`,
      params
    ),
    pool.query(
      `SELECT c.id, c.name, c.currency, c.commission_rate,
              (SELECT COALESCE(SUM(t.total_cents),0) FROM transit_tickets t
                WHERE t.company_id = c.id AND t.synced_at >= date_trunc('month', CURRENT_DATE))::bigint AS gross_cents,
              (SELECT COUNT(*) FROM transit_tickets t
                WHERE t.company_id = c.id AND t.synced_at >= date_trunc('month', CURRENT_DATE))::int AS ticket_count
       FROM transit_companies c
       WHERE c.deleted_at IS NULL AND ${companyScope}
       ORDER BY gross_cents DESC`,
      companyParams
    ),
  ]);

  const s = summaryRows.rows[0];
  res.json({
    summary: {
      totalTickets: s.total_tickets,
      totalCents: s.total_cents,
      todayCents: s.today_cents,
      weekCents: s.week_cents,
      monthCents: s.month_cents,
      conflicts: s.conflicts,
      cancelled: s.cancelled,
    },
    byDate: byDateRows.rows.map((r: any) => ({ day: r.day, count: r.count, totalCents: r.total_cents })),
    byRoute: byRouteRows.rows.map((r: any) => ({ routeName: r.route_name || 'Unassigned', count: r.count, totalCents: r.total_cents })),
    byStaff: byStaffRows.rows.map((r: any) => ({ staff: r.staff, count: r.count, totalCents: r.total_cents })),
    byCompany: companyRows.rows.map((r: any) => ({ id: r.id, name: r.name, currency: r.currency, commissionRate: r.commission_rate, grossCents: r.gross_cents, ticketCount: r.ticket_count })),
  });
});

// ── Company profile & branding (web admin) ─────────────────────────────

/**
 * Resolve the company context for a profile request. Level 1+ uses its bound
 * company; Level 0 platform operators must disambiguate with a companyId
 * query/body param (they have no bound company).
 */
function companyTarget(req: Request, u: AdminUser): string | null {
  if (u.companyId) return u.companyId;
  return companyIdFromRequest(req) || null;
}

function publicCompanyProfile(c: any) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    tagline: c.tagline || '',
    regNo: c.reg_no || '',
    taxId: c.tax_id || '',
    phone: c.contact_phone || '',
    email: c.email || '',
    address: c.address || '',
    website: c.website || '',
    customerCare: c.customer_care || '',
    contactEmail: c.contact_email || '',
    currency: c.currency || 'USD',
    logoUrl: c.logo_url || '',
    receiptHeader: c.receipt_header || '',
    receiptFooter: c.receipt_footer || '',
    defaultReceiptPrefix: c.default_receipt_prefix || '',
    companyCode: c.company_code || '',
    minAppVersion: c.min_app_version || '',
    commissionRate: Number(c.commission_rate) || 0,
    status: c.status || 'ACTIVE',
  };
}

const COMPANY_PROFILE_COLS = `id, name, slug, tagline, reg_no, tax_id, contact_phone, email,
  address, website, customer_care, contact_email, currency, logo_url, receipt_header,
  receipt_footer, default_receipt_prefix, company_code, min_app_version, commission_rate, status`;

transitWebRouter.get('/company', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE, PERMISSIONS.FINANCE_VIEW), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const companyId = companyTarget(req, u);
  if (!companyId) {
    res.status(422).json({ error: 'A company context is required' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT ${COMPANY_PROFILE_COLS}
     FROM transit_companies WHERE id = $1 AND deleted_at IS NULL`,
    [companyId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }
  res.json({ company: publicCompanyProfile(rows[0]) });
});

transitWebRouter.put('/company', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const companyId = companyTarget(req, u);
  if (!companyId) {
    res.status(422).json({ error: 'A company context is required' });
    return;
  }

  const body = req.body ?? {};
  const fields: string[] = [];
  const params: any[] = [];
  const push = (col: string, v: any) => {
    params.push(String(v ?? '').trim());
    fields.push(`${col} = $${params.length}`);
  };

  if (body.name !== undefined) {
    if (!String(body.name).trim()) {
      res.status(422).json({ error: 'Company name cannot be empty' });
      return;
    }
    push('name', body.name);
  }
  if (body.tagline !== undefined) push('tagline', body.tagline);
  if (body.phone !== undefined) push('contact_phone', body.phone);
  if (body.email !== undefined) push('email', body.email);
  if (body.taxId !== undefined) push('tax_id', body.taxId);
  if (body.regNo !== undefined) push('reg_no', body.regNo);
  if (body.address !== undefined) push('address', body.address);
  if (body.website !== undefined) push('website', body.website);
  if (body.customerCare !== undefined) push('customer_care', zimCareLine(body.customerCare));
  if (body.contactEmail !== undefined) push('contact_email', body.contactEmail);
  if (body.currency !== undefined) push('currency', body.currency);
  if (body.logoUrl !== undefined) push('logo_url', body.logoUrl);
  if (body.receiptHeader !== undefined) push('receipt_header', body.receiptHeader);
  if (body.receiptFooter !== undefined) push('receipt_footer', body.receiptFooter);

  if (fields.length === 0) {
    res.status(422).json({ error: 'No updatable fields provided' });
    return;
  }

  const companyParams = params;
  companyParams.push(companyId);
  const { rows } = await pool.query(
    `UPDATE transit_companies c
        SET ${fields.join(', ')}, updated_at = NOW()
      WHERE c.id = $${companyParams.length} AND c.deleted_at IS NULL
      RETURNING ${COMPANY_PROFILE_COLS}`,
    companyParams
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }
  await transitAudit({
    companyId,
    action: 'COMPANY_PROFILE_UPDATED',
    entity: 'transit_company',
    entityId: companyId,
    metadata: { by: u.email, fields: fields.map((f) => f.split(' = ')[0]) },
  });
  res.json({ company: publicCompanyProfile(rows[0]) });
});

// ── Staff registry (drivers & conductors — transit_staff) ──────────────

const STAFF_REGISTRY_ROLES = ['DRIVER', 'CONDUCTOR'] as const;
const STAFF_REGISTRY_STATUSES = ['ACTIVE', 'INACTIVE', 'ON_LEAVE'] as const;

function shapeStaff(s: any) {
  return {
    id: s.id,
    role: s.role,
    fullName: s.full_name,
    phone: s.phone || '',
    licenseNo: s.license_no || '',
    status: s.status,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

transitWebRouter.get('/drivers', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [];
  const scope = companyScope('s', u, req, params);
  const role = String(req.query.role || '').trim().toUpperCase();
  let roleSql = '';
  if (role) {
    if (!STAFF_REGISTRY_ROLES.includes(role as any)) {
      res.status(422).json({ error: 'role must be DRIVER or CONDUCTOR' });
      return;
    }
    params.push(role);
    roleSql = ` AND s.role = $${params.length}`;
  }
  const status = String(req.query.status || '').trim().toUpperCase();
  let statusSql = '';
  if (status) {
    if (!STAFF_REGISTRY_STATUSES.includes(status as any)) {
      res.status(422).json({ error: 'status must be ACTIVE, INACTIVE or ON_LEAVE' });
      return;
    }
    params.push(status);
    statusSql = ` AND s.status = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT s.id, s.role, s.full_name, s.phone, s.license_no, s.status, s.created_at, s.updated_at
     FROM transit_staff s
     WHERE ${scope} AND s.deleted_at IS NULL${roleSql}${statusSql}
     ORDER BY s.full_name ASC`,
    params
  );
  res.json({ staff: rows.map(shapeStaff) });
});

transitWebRouter.post('/drivers', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const { companyId, error } = resolveCompany(req, u);
  if (error) {
    res.status(403).json({ error });
    return;
  }
  if (!companyId) {
    res.status(422).json({ error: 'Staff registry provisioning requires a company context' });
    return;
  }
  const { role, fullName, phone, licenseNo, status } = req.body as {
    role?: string; fullName?: string; phone?: string; licenseNo?: string; status?: string;
  };
  const staffRole = String(role || 'DRIVER').trim().toUpperCase();
  if (!STAFF_REGISTRY_ROLES.includes(staffRole as any)) {
    res.status(422).json({ error: 'role must be DRIVER or CONDUCTOR' });
    return;
  }
  if (!fullName || !String(fullName).trim()) {
    res.status(422).json({ error: 'fullName is required' });
    return;
  }
  const staffStatus = String(status || 'ACTIVE').trim().toUpperCase();
  if (!STAFF_REGISTRY_STATUSES.includes(staffStatus as any)) {
    res.status(422).json({ error: 'status must be ACTIVE, INACTIVE or ON_LEAVE' });
    return;
  }
  // Level 0 platform operators must target a real, non-deleted company
  if (!u.companyId) {
    const { rows: comp } = await pool.query(
      'SELECT id FROM transit_companies WHERE id = $1 AND deleted_at IS NULL', [companyId]
    );
    if (comp.length === 0) {
      res.status(404).json({ error: 'Company not found' });
      return;
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO transit_staff (company_id, role, full_name, phone, license_no, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, role, full_name, phone, license_no, status, created_at, updated_at`,
    [
      companyId,
      staffRole,
      String(fullName).trim(),
      String(phone || '').trim(),
      String(licenseNo || '').trim(),
      staffStatus,
      u.id,
    ]
  );
  const s = rows[0];
  await transitAudit({
    companyId,
    action: 'STAFF_REGISTERED',
    entity: 'transit_staff',
    entityId: s.id,
    metadata: { role: staffRole, fullName: s.full_name, by: u.email },
  });
  res.status(201).json({ staff: shapeStaff(s) });
});

transitWebRouter.put('/drivers/:id', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [req.params.id];
  const scope = companyWhere('s', u, params);
  const body = req.body ?? {};
  const fields: string[] = [];
  const push = (col: string, v: any) => {
    params.push(v);
    fields.push(`${col} = $${params.length}`);
  };

  if (body.fullName !== undefined) {
    if (!String(body.fullName).trim()) {
      res.status(422).json({ error: 'fullName cannot be empty' });
      return;
    }
    push('full_name', String(body.fullName).trim());
  }
  if (body.phone !== undefined) push('phone', String(body.phone ?? '').trim());
  if (body.licenseNo !== undefined) push('license_no', String(body.licenseNo ?? '').trim());
  if (body.role !== undefined) {
    const r = String(body.role).trim().toUpperCase();
    if (!STAFF_REGISTRY_ROLES.includes(r as any)) {
      res.status(422).json({ error: 'role must be DRIVER or CONDUCTOR' });
      return;
    }
    push('role', r);
  }
  if (body.status !== undefined) {
    const st = String(body.status).trim().toUpperCase();
    if (!STAFF_REGISTRY_STATUSES.includes(st as any)) {
      res.status(422).json({ error: 'status must be ACTIVE, INACTIVE or ON_LEAVE' });
      return;
    }
    push('status', st);
  }
  if (fields.length === 0) {
    res.status(422).json({ error: 'No updatable fields provided' });
    return;
  }

  fields.push('updated_at = NOW()');
  const { rows } = await pool.query(
    `UPDATE transit_staff s SET ${fields.join(', ')}
      WHERE s.id::text = $1 AND ${scope} AND s.deleted_at IS NULL
      RETURNING id, role, full_name, phone, license_no, status, created_at, updated_at`,
    params
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Staff member not found' });
    return;
  }
  const s = rows[0];
  await transitAudit({
    companyId: u.companyId || undefined,
    action: 'STAFF_UPDATED',
    entity: 'transit_staff',
    entityId: s.id,
    metadata: { role: s.role, fullName: s.full_name, status: s.status, by: u.email },
  });
  res.json({ staff: shapeStaff(s) });
});

// ── Live shift monitoring ───────────────────────────────────────────────

transitWebRouter.get('/shifts', requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE, PERMISSIONS.FINANCE_VIEW), async (req: Request, res: Response) => {
  const u = req.adminUser!;
  const params: any[] = [];
  const scope = companyWhere('s', u, params);
  params.push(Math.min(Number(req.query.limit) || 200, 500));
  const { rows } = await pool.query(
    `SELECT s.id, s.driver_id, s.driver_name, s.vehicle_reg, s.status, s.notes,
            s.started_at, s.closed_at, s.user_id, s.device_id,
            tu.full_name AS conductor_name, tu.username AS conductor_username,
            d.device_uuid AS device_uuid,
            c.name AS company_name, c.currency,
            (SELECT COUNT(*) FROM transit_tickets t
              WHERE t.shift_id = s.id AND t.status <> 'CANCELLED')::int AS ticket_count,
            (SELECT COALESCE(SUM(t.total_cents),0) FROM transit_tickets t
              WHERE t.shift_id = s.id AND t.status <> 'CANCELLED')::bigint AS total_cents
     FROM transit_shifts s
     JOIN transit_companies c ON c.id = s.company_id AND c.deleted_at IS NULL
     LEFT JOIN transit_users tu ON tu.id = s.user_id AND tu.deleted_at IS NULL
     LEFT JOIN transit_devices d ON d.id = s.device_id
     WHERE ${scope}
     ORDER BY s.started_at DESC LIMIT $${params.length}`,
    params
  );
  res.json({
    shifts: rows.map((r: any) => ({
      id: r.id,
      driverId: r.driver_id || '',
      driverName: r.driver_name || '—',
      vehicleReg: r.vehicle_reg || '—',
      status: r.status,
      notes: r.notes || '',
      startedAt: r.started_at,
      closedAt: r.closed_at,
      conductorName: r.conductor_name || r.conductor_username || '—',
      conductorUsername: r.conductor_username || '',
      deviceUuid: r.device_uuid || '',
      companyName: r.company_name,
      currency: r.currency || 'USD',
      ticketCount: Number(r.ticket_count) || 0,
      totalCents: Number(r.total_cents) || 0,
    })),
  });
});

export default transitWebRouter;