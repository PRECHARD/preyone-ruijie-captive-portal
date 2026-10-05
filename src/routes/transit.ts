import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { transitAudit, transitSecurityEvent } from '../services/transitAudit';
import { compareVersions, getTransitJwtSecret, requireTransitDevice, requireTransitRoles, requireTransitSession } from '../middleware/transitAuth';
import { PERMISSIONS, loadPermissions, requireTransitPermission } from '../middleware/rbac';
import { formatZimPhone } from '../utils/phone';

const UNIT_SEPARATOR = String.fromCharCode(0x1f);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

// Busy devices legitimately push every sale, but a single stuck/buggy device
// (or a scripted replay) must never starve the DB pool. 600 req / hour is far
// above any real shift's traffic yet still stops a runaway loop from hammering
// the pool; the per-request batch cap bounds transaction size too. Devices can
// share a NAT IP so this stays generous and acts as a coarse trip-wire.
const syncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sync requests. Pause and retry in a few minutes.' },
});
// Ceiling per sync request: a real trip sells < 200 tickets in a single push,
// so anything larger is a malformed/replayed payload â€” split it into chunks.
const MAX_TICKETS_PER_SYNC = 200;

export const transitRouter = Router();

const DEVICE_TOKENS_IN = '30d';
const SESSION_TOKENS_IN = '12h';

// Loose UUID v4 shape check. transit_trips.id is a uuid column, but a device
// mints ids for its own on-the-go runs (TRIP-<device>-<epoch>) that are not
// uuids and can never exist server-side. Guards those out of uuid-typed
// parameters before they reach Postgres.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

// â”€â”€ Shared helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Deterministic payload string the Android app signs for every sale. Must match the Dart side exactly. */
export function buildCanonicalTicketPayload(t: {
  txId: string;
  clientReceiptNo: string;
  tripNo?: string;
  routeCode?: string;
  routeName?: string;
  driver?: string;
  driverPhone?: string;
  conductor1?: string;
  conductor2?: string;
  conductorPhone?: string;
  seatNumber?: string;
  customerName?: string;
  customerMobile?: string;
  itemsJson?: string;
  totalCents: number;
  cashCents: number;
  changeCents: number;
  saleTime?: string;
}): string {
  return [
    t.txId,
    t.clientReceiptNo,
    t.tripNo ?? '',
    t.routeCode ?? '',
    t.routeName ?? '',
    t.driver ?? '',
    t.driverPhone ?? '',
    t.conductor1 ?? '',
    t.conductor2 ?? '',
    t.conductorPhone ?? '',
    t.seatNumber ?? '',
    t.customerName ?? '',
    t.customerMobile ?? '',
    t.itemsJson ?? '[]',
    String(t.totalCents),
    String(t.cashCents),
    String(t.changeCents),
    t.saleTime ?? '',
  ].join(UNIT_SEPARATOR);
}

export function verifyDeviceSignature(publicKeyB64u: string, signatureB64: string, payload: string): boolean {
  try {
    const x = publicKeyB64u.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch (err) {
    console.error('verifyDeviceSignature error:', (err as Error).message);
    return false;
  }
}

function isValidEd25519PublicKey(publicKeyB64u: string): boolean {
  try {
    const x = publicKeyB64u.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

async function loadCompany(companyId: string) {
  const { rows } = await pool.query('SELECT * FROM transit_companies WHERE id = $1 AND deleted_at IS NULL', [companyId]);
  return rows[0] || null;
}

function publicCompany(company: any) {
  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    tagline: company.tagline,
    address: company.address,
    email: company.email,
    website: company.website,
    customerCare: company.customer_care,
    currency: company.currency,
    defaultReceiptPrefix: company.default_receipt_prefix,
    offlineLeaseDays: company.offline_lease_days,
    minAppVersion: company.min_app_version,
  };
}

async function leaseExpiryForDevice(company: any, now = new Date()): Promise<string> {
  const { rows } = await pool.query(
    'SELECT NOW() + ($1 * INTERVAL \'1 day\') AS expiry',
    [company.offline_lease_days || 7]
  );
  return rows[0].expiry;
}

function issueDeviceToken(user: any, device: any): string {
  return jwt.sign(
    {
      type: 'device',
      sub: user.id,
      companyId: user.company_id,
      deviceId: device.id,
      deviceUuid: device.device_uuid,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
    },
    getTransitJwtSecret(),
    { expiresIn: DEVICE_TOKENS_IN }
  );
}

function issueSessionToken(user: any): string {
  return jwt.sign(
    { type: 'session', sub: user.id, companyId: user.company_id, role: user.role, username: user.username },
    getTransitJwtSecret(),
    { expiresIn: SESSION_TOKENS_IN }
  );
}

// â”€â”€ Authentication â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

transitRouter.post('/auth/login', authLimiter, async (req: Request, res: Response) => {
  const { username, password, deviceUuid, devicePublicKey, deviceModel, appVersion } = req.body as {
    username?: string;
    password?: string;
    deviceUuid?: string;
    devicePublicKey?: string;
    deviceModel?: string;
    appVersion?: string;
  };

  if (!username || !password) {
    res.status(422).json({ error: 'Username and password are required' });
    return;
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.company_id, u.username, u.full_name, u.role, u.phone, u.password_hash, u.status AS user_status,
            c.status AS company_status, c.name AS company_name
     FROM transit_users u
     JOIN transit_companies c ON c.id = u.company_id
     WHERE lower(u.username) = lower($1) AND u.deleted_at IS NULL AND c.deleted_at IS NULL`,
    [username.trim()]
  );

  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';

  if (rows.length === 0) {
    await transitSecurityEvent({ event: 'FAILED_LOGIN', detail: `Unknown username: ${username}`, ip: clientIp });
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  const user = rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    await transitSecurityEvent({
      companyId: user.company_id,
      userId: user.id,
      event: 'FAILED_LOGIN',
      detail: `Invalid password for user ${user.username}`,
      ip: clientIp,
    });
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  if (user.company_status !== 'ACTIVE') {
    res.status(403).json({ error: 'Your organization is inactive. Contact your administrator.' });
    return;
  }
  if (user.user_status !== 'ACTIVE') {
    await transitAudit({ companyId: user.company_id, userId: user.id, action: 'LOGIN_DENIED', entity: 'transit_user', entityId: user.id, metadata: { reason: 'disabled' } });
    res.status(403).json({ error: 'Your account has been disabled. Please contact your administrator.', code: 'USER_DISABLED' });
    return;
  }

  const company = await loadCompany(user.company_id);

  // Effective permissions (role defaults + per-user + company-wide grants) so
  // the app can gate UI the same way the API gates the write. The app must
  // still fall back to role-based checks when this list is absent (older server
  // or a session restored before this field existed) â€” never lock a conductor
  // out of selling because a permission list is missing.
  const permissions = await loadPermissions(user.role, user.id, user.company_id);
  const publicUser = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    phone: user.phone || '',
    permissions,
  };

  const sessionToken = issueSessionToken(user);
  const appNeedsUpdate = !!(company?.min_app_version && appVersion && !compareVersions(appVersion, company.min_app_version));

  await transitAudit({ companyId: user.company_id, userId: user.id, action: 'LOGIN', entity: 'transit_user', entityId: user.id, metadata: { deviceUuid: deviceUuid || null } });

  // Device binding state for this user
  const { rows: devices } = await pool.query(
    `SELECT id, device_uuid, status, device_model, app_version FROM transit_devices WHERE user_id = $1 ORDER BY registered_at DESC LIMIT 1`,
    [user.id]
  );
  const existing = devices[0] || null;

  if (!deviceUuid) {
    res.json({
      sessionToken,
      user: publicUser,
      company: company ? publicCompany(company) : null,
      device: existing ? { deviceUuid: existing.device_uuid, status: existing.status } : null,
      needsDeviceRegistration: !existing || existing.status !== 'ACTIVE',
      appNeedsUpdate,
    });
    return;
  }

  // Device supplied: if it matches the user's bound device, issue a device token.
  if (existing && existing.device_uuid === deviceUuid && existing.status === 'ACTIVE') {
    await pool.query(
      `UPDATE transit_devices SET last_seen = NOW(), app_version = $1, device_model = $2,
              offline_authorization_expires_at = NOW() + ($3 * INTERVAL '1 day')
       WHERE id = $4`,
      [appVersion || existing.app_version, deviceModel || existing.device_model, company.offline_lease_days || 7, existing.id]
    );
    const leaseExpiresAt = await leaseExpiryForDevice(company);
    await transitAudit({
      companyId: user.company_id,
      userId: user.id,
      deviceId: existing.id,
      action: 'LOGIN',
      entity: 'transit_device',
      entityId: existing.device_uuid,
      metadata: { boundDevice: true },
    });
    const deviceToken = issueDeviceToken(user, existing);
    res.json({
      sessionToken,
      deviceToken,
      user: publicUser,
      company: publicCompany(company),
      device: { deviceUuid: existing.device_uuid, status: existing.status },
      needsDeviceRegistration: false,
      licenseExpiresAt: leaseExpiresAt,
      minAppVersion: company.min_app_version,
      serverTime: new Date().toISOString(),
    });
    return;
  }

  // Different device already bound, or the bound device is disabled/revoked.
  res.json({
    sessionToken,
    user: publicUser,
    company: company ? publicCompany(company) : null,
    device: existing ? { deviceUuid: existing.device_uuid, status: existing.status } : null,
    needsDeviceRegistration: !existing || existing.status !== 'ACTIVE',
    deviceMismatch: !!(existing && existing.device_uuid !== deviceUuid),
    deviceDisabled: !!(existing && existing.status !== 'ACTIVE'),
    error: existing && existing.status !== 'ACTIVE'
      ? 'This device has been disabled. Please contact your administrator.'
      : undefined,
  });
});

// â”€â”€ Device registration (one account, one bound device) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

transitRouter.post('/devices/register', requireTransitSession, async (req: Request, res: Response) => {
  const session = req.transitSession?.session!;
  const { deviceUuid, devicePublicKey, deviceModel, appVersion } = req.body as {
    deviceUuid?: string;
    devicePublicKey?: string;
    deviceModel?: string;
    appVersion?: string;
  };

  if (!deviceUuid || !devicePublicKey) {
    res.status(422).json({ error: 'deviceUuid and devicePublicKey are required' });
    return;
  }
  if (!isValidEd25519PublicKey(devicePublicKey)) {
    res.status(422).json({ error: 'Invalid device public key' });
    return;
  }

  // Blanket hardware blacklist: reject onboarding from a blocked device immediately.
  const { rows: blocked } = await pool.query(
    `SELECT id, hardware_id, hardware_type, device_name, reason FROM blocked_devices WHERE hardware_id = $1`,
    [deviceUuid.trim().toUpperCase()]
  );
  if (blocked.length > 0) {
    await transitSecurityEvent({
      companyId: session.companyId,
      userId: session.sub,
      event: 'HARDWARE_BLOCKED',
      detail: `Device ${deviceUuid} blocked: ${blocked[0].reason || 'No reason'}`,
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '',
    });
    res.status(403).json({
      error: 'This device has been blocked. Contact your administrator for assistance.',
      code: 'DEVICE_BLOCKED',
    });
    return;
  }

  const company = await loadCompany(session.companyId);

  // One-user-one-device: reject binding to a second, active device.
  const { rows: conflicts } = await pool.query(
    `SELECT device_uuid, status FROM transit_devices WHERE user_id = $1`,
    [session.sub]
  );
  const otherActive = conflicts.find((d: any) => d.device_uuid !== deviceUuid && d.status === 'ACTIVE');
  if (otherActive) {
    await transitSecurityEvent({
      companyId: session.companyId,
      userId: session.sub,
      event: 'SECOND_DEVICE_REJECTED',
      detail: `Device ${deviceUuid} attempted registration while ${otherActive.device_uuid} is active`,
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '',
    });
    await transitAudit({
      companyId: session.companyId,
      userId: session.sub,
      action: 'DEVICE_REGISTRATION_REJECTED',
      entity: 'transit_device',
      entityId: deviceUuid,
      metadata: { reason: 'device already bound elsewhere' },
    });
    res.status(409).json({ error: 'This account is already registered to another device. Contact your administrator.' });
    return;
  }

  // device_uuid is globally unique; if it is actively bound to another user,
  // refuse. A row whose user_id is NULL is a released UNBOUND terminal that is
  // free to be re-registered to any staff member.
  const { rows: owned } = await pool.query(
    `SELECT id, user_id FROM transit_devices WHERE device_uuid = $1`,
    [deviceUuid]
  );
  if (owned.length > 0 && owned[0].user_id !== null && owned[0].user_id !== session.sub) {
    res.status(409).json({
      error: 'This device identifier is already bound to another account.',
      code: 'DEVICE_BOUND_OTHER',
    });
    return;
  }

  const now = new Date();
  let deviceId: string;
  if (owned.length > 0) {
    const { rows: updated } = await pool.query(
      `UPDATE transit_devices
       SET status = 'ACTIVE', device_key = $1, device_model = $2, app_version = $3,
           registered_at = $4, reset_by = NULL,
           last_seen = NOW(),
           offline_authorization_expires_at = NOW() + ($5 * INTERVAL '1 day'),
           user_id = $6, company_id = $7
       WHERE id = $8
       RETURNING id`,
      [devicePublicKey, deviceModel || '', appVersion || '', now, company.offline_lease_days || 7, session.sub, session.companyId, owned[0].id]
    );
    deviceId = updated[0].id;
  } else {
    const { rows: inserted } = await pool.query(
      `INSERT INTO transit_devices (company_id, user_id, device_uuid, device_key, device_model, app_version, status, offline_authorization_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', NOW() + ($7 * INTERVAL '1 day'))
       RETURNING id`,
      [session.companyId, session.sub, deviceUuid, devicePublicKey, deviceModel || '', appVersion || '', company.offline_lease_days || 7]
    );
    deviceId = inserted[0].id;
  }

  const { rows: deviceRows } = await pool.query(
    `SELECT id, company_id, user_id, device_uuid FROM transit_devices WHERE id = $1`,
    [deviceId]
  );
  const device = deviceRows[0];
  const deviceToken = issueDeviceToken({ id: session.sub, company_id: session.companyId, username: session.username, full_name: '', role: session.role }, device);
  const leaseExpiresAt = await leaseExpiryForDevice(company);

  await transitAudit({
    companyId: session.companyId,
    userId: session.sub,
    deviceId,
    action: 'DEVICE_REGISTERED',
    entity: 'transit_device',
    entityId: deviceUuid,
    metadata: { model: deviceModel || '', appVersion: appVersion || '' },
  });

  res.status(201).json({
    deviceToken,
    device: { id: deviceId, deviceUuid: device.device_uuid, status: 'ACTIVE' },
    licenseExpiresAt: leaseExpiresAt,
    minAppVersion: company.min_app_version,
    serverTime: new Date().toISOString(),
  });
});

// â”€â”€ Heartbeat / status check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

transitRouter.post('/devices/check', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { location, batteryPct, activeTrip, appVersion } = req.body as {
    location?: string;
    batteryPct?: number;
    activeTrip?: string;
    appVersion?: string;
  };

  const { rows } = await pool.query(
    `UPDATE transit_devices
     SET last_seen = NOW(),
         last_location = COALESCE($2, last_location),
         battery_pct = COALESCE($3, battery_pct),
         active_trip = COALESCE($4, active_trip),
         app_version = COALESCE($5, app_version)
     WHERE id = $1
     RETURNING id`,
    [transit.device.id, location || null, batteryPct ?? null, activeTrip || null, appVersion || null]
  );

  const { rows: companyRows } = await pool.query(
    'SELECT offline_lease_days, min_app_version FROM transit_companies WHERE id = $1 AND deleted_at IS NULL',
    [transit.user.companyId]
  );
  const company = companyRows[0];
  const expiry = await leaseExpiryForDevice(company);

  if (rows.length > 0) {
    await transitAudit({
      companyId: transit.user.companyId,
      userId: transit.user.id,
      deviceId: transit.device.id,
      action: 'DEVICE_HEARTBEAT',
      entity: 'transit_device',
      entityId: transit.device.deviceUuid,
      metadata: { location: location || null, batteryPct: batteryPct ?? null },
    });
  }

  res.json({
    deviceStatus: 'ACTIVE',
    licenseExpiresAt: expiry,
    minAppVersion: company.min_app_version,
    // Re-delivered on every heartbeat so a capability granted (or revoked)
    // mid-session reaches the app without forcing a re-login.
    permissions: transit.user.permissions,
    serverTime: new Date().toISOString(),
  });
});

// â”€â”€ Signed, idempotent sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

transitRouter.post('/sync', syncLimiter, requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { tickets, location, batteryPct, activeTrip, appVersion } = req.body as {
    tickets?: Array<Record<string, any>>;
    location?: string;
    batteryPct?: number;
    activeTrip?: string;
    appVersion?: string;
  };

  const payload = Array.isArray(tickets) ? tickets.slice(0, MAX_TICKETS_PER_SYNC) : [];
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';

  const { rows: deviceRows } = await pool.query('SELECT device_key FROM transit_devices WHERE id = $1', [transit.device.id]);
  const deviceKey = deviceRows[0].device_key;

  const synced: string[] = [];
  const duplicates: string[] = [];
  const rejected: { txId?: string; reason: string; code: string }[] = [];
  const conflicts: string[] = [];
  const seenSeats = new Set<string>();

  // Safe string coercion: NULL / missing / blank become the fallback so a
  // sloppy offline payload can never trip a NOT NULL constraint.
  const str = (v: unknown, fallback = '') =>
    v == null || String(v).trim() === '' ? fallback : String(v).trim();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const ticket of payload) {
      const txId = str(ticket.txId || ticket.ticket_id || ticket.ticketId);
      if (!txId) continue;

      const totalCents = Math.round(Number(ticket.totalCents) || 0);
      const cashCents = Math.round(Number(ticket.cashCents) || 0);
      const changeCents = Math.round(Number(ticket.changeCents) || 0);
      const clientReceiptNo = str(ticket.clientReceiptNo, txId);
      const canonical = buildCanonicalTicketPayload({
        txId,
        clientReceiptNo,
        tripNo: ticket.tripNo,
        routeCode: ticket.routeCode,
        routeName: ticket.routeName,
        driver: ticket.driver,
        driverPhone: ticket.driverPhone,
        conductor1: ticket.conductor1,
        conductor2: ticket.conductor2,
        conductorPhone: ticket.conductorPhone,
        seatNumber: ticket.seatNumber,
        customerName: ticket.customerName,
        customerMobile: ticket.customerMobile,
        itemsJson: Array.isArray(ticket.items) ? JSON.stringify(ticket.items) : String(ticket.itemsJson || '[]'),
        totalCents,
        cashCents,
        changeCents,
        saleTime: ticket.saleTime,
      });

      const signatureOk = typeof ticket.signature === 'string' && ticket.signature.length > 0
        ? verifyDeviceSignature(deviceKey, ticket.signature, canonical)
        : false;
      if (!signatureOk) {
        rejected.push({ txId, reason: 'Invalid signature', code: 'INVALID_SIGNATURE' });
        await transitSecurityEvent({
          companyId: transit.user.companyId,
          userId: transit.user.id,
          deviceId: transit.device.id,
          event: 'INVALID_SIGNATURE',
          detail: `ticket txId=${txId}`,
          ip,
        });
        continue;
      }

      const seatNumber = str(ticket.seatNumber);
      const tripNo = str(ticket.tripNo);

      const { rows: dupRows } = await client.query('SELECT id FROM transit_tickets WHERE tx_id = $1', [txId]);
      if (dupRows.length > 0) {
        duplicates.push(txId);
        continue;
      }

      let isConflict = false;
      if (seatNumber && tripNo) {
        const { rows: seatHits } = await client.query(
          `SELECT 1 FROM transit_tickets
           WHERE company_id = $1 AND trip_no = $2 AND seat_number = $3 AND tx_id <> $4
           LIMIT 1`,
          [transit.user.companyId, tripNo, seatNumber, txId]
        );
        const batchDuplicate = seenSeats.has(`${tripNo}\u0000${seatNumber}`);
        if (seatHits.length > 0 || batchDuplicate) isConflict = true;
        seenSeats.add(`${tripNo}\u0000${seatNumber}`);
      }

      const status = isConflict ? 'SEAT_CONFLICT' : 'SYNCED';
      let inserted = false;
      try {
        const result = await client.query(
          `INSERT INTO transit_tickets
             (company_id, user_id, device_id, tx_id, client_receipt_no, trip_no, route_code, route_name,
              bus_reg,
              driver, driver_phone, conductor1, conductor2, conductor_phone, seat_number,
              customer_name, customer_mobile, items_json, total_cents, cash_cents, change_cents,
              payment_method, status, payload_signature, sale_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
           RETURNING id`,
          [
            transit.user.companyId,
            transit.user.id,
            transit.device.id,
            txId,
            clientReceiptNo,
            tripNo,
            str(ticket.routeCode),
            str(ticket.routeName),
            str(ticket.bus_reg ?? ticket.busReg),
            str(ticket.driver),
            str(ticket.driverPhone),
            str(ticket.conductor1),
            str(ticket.conductor2),
            str(ticket.conductorPhone),
            seatNumber,
            str(ticket.customerName || ticket.customer_name),
            str(ticket.customerMobile || ticket.customer_mobile || ticket.customer_phone),
            Array.isArray(ticket.items) ? JSON.stringify(ticket.items) : String(ticket.itemsJson || '[]'),
            totalCents,
            cashCents,
            changeCents,
            str(ticket.paymentMethod || ticket.payment_method, 'cash').toLowerCase() || 'cash',
            status,
            ticket.signature,
            str(ticket.saleTime),
          ]
        );
        inserted = result.rows.length > 0;
      } catch (err: any) {
        if (err.code === '23505' && err.constraint?.includes('seat_lock')) {
          isConflict = true;
          conflicts.push(txId);
          await transitSecurityEvent({
            companyId: transit.user.companyId,
            userId: transit.user.id,
            deviceId: transit.device.id,
            event: 'SEAT_CONFLICT',
            detail: `trip=${tripNo} seat=${seatNumber} txId=${txId} (unique constraint)`,
            ip,
          });
          continue;
        }
        throw err;
      }
      if (inserted) {
        if (isConflict) {
          conflicts.push(txId);
          await transitSecurityEvent({
            companyId: transit.user.companyId,
            userId: transit.user.id,
            deviceId: transit.device.id,
            event: 'SEAT_CONFLICT',
            detail: `trip=${tripNo} seat=${seatNumber} txId=${txId} (not silently overwritten)`,
            ip,
          });
        }
        synced.push(txId);
      } else {
        duplicates.push(txId);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('/sync transaction rolled back:', (err as Error).message);
    throw err;
  } finally {
    client.release();
  }

  const { rows: companyRows } = await pool.query(
    'SELECT offline_lease_days, min_app_version FROM transit_companies WHERE id = $1 AND deleted_at IS NULL',
    [transit.user.companyId]
  );
  const company = companyRows[0];
  const expiry = await leaseExpiryForDevice(company);

  await pool.query(
    `UPDATE transit_devices
     SET last_sync = NOW(), last_seen = NOW(), active_trip = COALESCE($2, active_trip),
         app_version = COALESCE($3, app_version),
         battery_pct = COALESCE($4, battery_pct),
         last_location = COALESCE($5, last_location),
         offline_authorization_expires_at = NOW() + ($6 * INTERVAL '1 day')
     WHERE id = $1`,
    [transit.device.id, activeTrip || null, appVersion || null, batteryPct ?? null, location || null, company.offline_lease_days || 7]
  );

  await transitAudit({
    companyId: transit.user.companyId,
    userId: transit.user.id,
    deviceId: transit.device.id,
    action: 'SYNC_COMPLETED',
    entity: 'transit_ticket',
    metadata: { sync: '/sync', synced: synced.length, duplicates: duplicates.length, rejected: rejected.length, conflicts: conflicts.length },
  });

  res.json({
    success: true,
    synced_count: synced.length,
    ids: synced,
    synced: synced.length,
    duplicates: duplicates.length,
    rejected,
    conflicts: conflicts.length,
    device: { status: 'ACTIVE', licenseExpiresAt: expiry, minAppVersion: company.min_app_version, serverTime: new Date().toISOString() },
  });
});

// ── Legacy /sync alias ────────────────────────────────────────────────────

// â”€â”€ Idempotent offline ticket sync (ticket_id upsert) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * POST /api/transit/tickets/sync
 * Accepts an array of offline tickets keyed by an app-generated `ticket_id`.
 * Idempotent: re-syncing the same ticket_id performs an ON CONFLICT DO UPDATE
 * instead of creating a duplicate. Seat conflicts (partial unique index on
 * company_id/trip_no/seat_number) are reported and never overwrite existing seats.
 */
transitRouter.post('/tickets/sync', syncLimiter, requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { tickets, batteryPct, activeTrip, appVersion } = req.body as {
    tickets?: Array<Record<string, any>>;
    batteryPct?: number;
    activeTrip?: string;
    appVersion?: string;
  };
  const payload = Array.isArray(tickets) ? tickets.slice(0, MAX_TICKETS_PER_SYNC) : [];
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';

  const synced: string[] = [];
  const duplicates: string[] = [];
  const rejected: { ticketId?: string; reason: string; code: string }[] = [];
  const conflicts: string[] = [];
  // Tickets whose printed number is already used by another sale in this
  // company — two handsets minted the same number, so two passengers hold paper
  // with identical text. Kept apart from `conflicts` because this needs an
  // operator to reconcile two real tickets, not a seat reassignment.
  const duplicateReceipts: string[] = [];
  const seenSeats = new Set<string>();
  const tripIdsToRefresh = new Set<string>();
  const tripNosToRefresh = new Set<string>();

  // Safe string coercion: NULL / missing / blank become the fallback so a
  // sloppy offline payload can never trip a NOT NULL constraint.
  const str = (v: unknown, fallback = '') =>
    v == null || String(v).trim() === '' ? fallback : String(v).trim();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const ticket of payload) {
      const ticketId = String(ticket.ticket_id || ticket.ticketId || ticket.txId || '').trim();
      if (!ticketId) {
        rejected.push({ reason: 'Missing ticket_id', code: 'MISSING_TICKET_ID' });
        continue;
      }

      const tripNo = str(ticket.trip_no ?? ticket.tripNo);
      const routeFrom = str(ticket.route_from);
      const routeTo = str(ticket.route_to);
      const routeName = (routeFrom || routeTo)
        ? [routeFrom, routeTo].filter(Boolean).join(' - ')
        : str(ticket.route_name ?? ticket.routeName);
      const routeCode = str(ticket.route_code ?? ticket.routeCode);
      const seatNumber = str(ticket.seat_number ?? ticket.seatNumber);
      const customerName = str(ticket.customer_name ?? ticket.customerName);
      const customerMobile = str(ticket.customer_phone ?? ticket.customer_mobile ?? ticket.customerMobile ?? ticket.customerPhone);
      let driver = str(ticket.driver_name ?? ticket.driver);
      let driverPhone = str(ticket.driver_phone);
      let conductor1 = str(ticket.conductor_name ?? ticket.conductor1);
      let conductor2 = str(ticket.conductor2);
      let conductorPhone = str(ticket.conductor_phone);
      let busReg = str(ticket.bus_reg ?? ticket.busReg);
      const paymentMethod = str(ticket.payment_method ?? ticket.paymentMethod, 'cash').toLowerCase() || 'cash';
      const clientReceiptNo = str(ticket.receipt_no ?? ticket.clientReceiptNo, ticketId);
      const totalCents = Math.round(Number(ticket.amount ?? ticket.totalCents ?? ticket.total ?? 0));
      const cashCents = Math.round(Number(ticket.cash_cents ?? ticket.cashCents ?? totalCents));
      const changeCents = Math.round(Number(ticket.change_cents ?? ticket.changeCents ?? 0));
      const saleTime = str(ticket.created_at ?? ticket.saleTime);
      const customFare = Math.max(0, Math.round(Number(ticket.custom_fare ?? ticket.customFare ?? 0)));
      let departureTime = str(ticket.departure_time ?? ticket.departureTime);
      const luggageLinkedTicketId = str(ticket.luggage_linked_ticket_id ?? ticket.luggageLinkedTicketId);
      const itemsJson = Array.isArray(ticket.items)
        ? JSON.stringify(ticket.items)
        : str(ticket.items_json, '[]') || '[]';

      // Resolve the shift_id (if supplied) against an OPEN shift owned by this
      // exact user in this company. Best-effort: a missing/foreign/invalid shift
      // must never block the ticket insert (offline-first), so failures degrade
      // to null and the ticket still syncs unattached.
      let shiftId: string | null = str(ticket.shift_id ?? ticket.shiftId) || null;
      if (shiftId) {
        try {
          const { rows: shiftRows } = await client.query(
            `SELECT id FROM transit_shifts
             WHERE id = $1 AND company_id = $2 AND user_id = $3 AND status = 'OPEN'`,
            [shiftId, transit.user.companyId, transit.user.id]
          );
          shiftId = shiftRows.length > 0 ? shiftRows[0].id : null;
        } catch {
          shiftId = null;
        }
      }
      const driverId = str(ticket.driver_id ?? ticket.driverId).trim();
      const conductorId = str(ticket.conductor_id ?? ticket.conductorId).trim();

      // Resolve the trip_id (if supplied) against this company's trips so an
      // attacker can never attach a ticket to another company's trip.
      //
      // The device mints ids for its own on-the-go runs (TRIP-<device>-<epoch>),
      // which are NOT server uuids. transit_trips.id is a uuid column, so
      // querying with one of those ids raised "invalid input syntax for type
      // uuid" and rolled back the ENTIRE batch — one conductor-created run
      // silently blocked every ticket on the device from ever syncing. Such a
      // trip can never exist server-side by definition, so it is simply not
      // resolvable: drop it and keep the ticket, exactly as an unknown id is
      // handled below.
      let tripId: string | null = str(ticket.trip_id ?? ticket.tripId) || null;
      if (tripId && !UUID_RE.test(tripId)) {
        tripId = null;
      }
      if (tripId) {
        const { rows: tripRows } = await client.query(
          `SELECT id, bus_reg, driver, driver_phone,
                  conductor1, conductor2, conductor_phone, departure_time
           FROM transit_trips WHERE id = $1 AND company_id = $2`,
          [tripId, transit.user.companyId]
        );
        if (tripRows.length > 0) {
          tripId = tripRows[0].id;
          // The trip is the canonical vehicle/crew source: backfill whichever
          // fields the offline payload left blank so stored tickets (and the
          // admin screen) always carry the full picture.
          const t = tripRows[0];
          if (!driver) driver = str(t.driver);
          if (!driverPhone) driverPhone = str(t.driver_phone);
          if (!conductor1) conductor1 = str(t.conductor1);
          if (!conductor2) conductor2 = str(t.conductor2);
          if (!conductorPhone) conductorPhone = str(t.conductor_phone);
          if (!busReg) busReg = str(t.bus_reg);
          if (!departureTime) departureTime = str(t.departure_time);
        } else {
          tripId = null;
        }
      }

      const markTripAffected = () => {
        if (tripId) tripIdsToRefresh.add(tripId);
        else if (tripNo) tripNosToRefresh.add(tripNo);
      };

      let isConflict = false;
      if (seatNumber && (tripNo || routeName)) {
        const tripKey = tripNo || routeName;
        // Seat lock is scoped to the trip INSTANCE (trip_id) when one is
        // resolved, mirroring idx_transit_tickets_seat_lock: a repeated label
        // like "600-20260918" across different trips must not false-conflict.
        const { rows: seatHits } = tripId
          ? await client.query(
              `SELECT 1 FROM transit_tickets
               WHERE company_id = $1 AND trip_id = $2 AND seat_number = $3 AND ticket_id <> $4
               LIMIT 1`,
              [transit.user.companyId, tripId, seatNumber, ticketId]
            )
          : await client.query(
              `SELECT 1 FROM transit_tickets
               WHERE company_id = $1 AND trip_no = $2 AND seat_number = $3 AND ticket_id <> $4
               LIMIT 1`,
              [transit.user.companyId, tripNo, seatNumber, ticketId]
            );
        const batchDuplicate = seenSeats.has(`${tripKey}\u0000${seatNumber}`);
        if (seatHits.length > 0 || batchDuplicate) isConflict = true;
        seenSeats.add(`${tripKey}\u0000${seatNumber}`);
      }

      const status = isConflict ? 'SEAT_CONFLICT' : 'SYNCED';
      let handled = false;
      try {
        const result = await client.query(
          `INSERT INTO transit_tickets
             (company_id, user_id, device_id, ticket_id, tx_id, client_receipt_no, trip_no,
              trip_id,
              route_code, route_name, route_from, route_to,
              bus_reg,
              driver, driver_phone, conductor1, conductor2, conductor_phone, seat_number,
              customer_name, customer_mobile, items_json, total_cents, cash_cents, change_cents,
              custom_fare, departure_time, luggage_linked_ticket_id,
              status, sale_time, shift_id, driver_id, conductor_id,
              payment_method)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)
           ON CONFLICT (ticket_id) DO UPDATE
             SET trip_no = EXCLUDED.trip_no,
                 trip_id = EXCLUDED.trip_id,
                 route_code = EXCLUDED.route_code,
                 route_name = EXCLUDED.route_name,
                 route_from = EXCLUDED.route_from,
                 route_to = EXCLUDED.route_to,
                 bus_reg = EXCLUDED.bus_reg,
                 seat_number = EXCLUDED.seat_number,
                 customer_name = EXCLUDED.customer_name,
                 customer_mobile = EXCLUDED.customer_mobile,
                 driver = EXCLUDED.driver,
                 driver_phone = EXCLUDED.driver_phone,
                 conductor1 = EXCLUDED.conductor1,
                 conductor2 = EXCLUDED.conductor2,
                 conductor_phone = EXCLUDED.conductor_phone,
                 total_cents = EXCLUDED.total_cents,
                 cash_cents = EXCLUDED.cash_cents,
                 change_cents = EXCLUDED.change_cents,
                 custom_fare = EXCLUDED.custom_fare,
                 departure_time = EXCLUDED.departure_time,
                 luggage_linked_ticket_id = EXCLUDED.luggage_linked_ticket_id,
                 shift_id = EXCLUDED.shift_id,
                 driver_id = EXCLUDED.driver_id,
                 conductor_id = EXCLUDED.conductor_id,
                 payment_method = EXCLUDED.payment_method,
                 status = 'SYNCED',
                 synced_at = NOW()
           RETURNING id`,
          [
            transit.user.companyId,
            transit.user.id,
            transit.device.id,
            ticketId,
            ticketId,
            clientReceiptNo,
            tripNo,
            tripId,
            routeCode,
            routeName,
            routeFrom,
            routeTo,
            busReg,
            driver,
            driverPhone,
            conductor1,
            conductor2,
            conductorPhone,
            seatNumber,
            customerName,
            customerMobile,
            itemsJson,
            totalCents,
            cashCents,
            changeCents,
            customFare,
            departureTime,
            luggageLinkedTicketId,
            status,
            saleTime,
            shiftId,
            driverId,
            conductorId,
            paymentMethod,
          ]
        );
        handled = result.rows.length > 0;
      } catch (err: any) {
        if (err.code === '23505' && err.constraint?.includes('seat_lock')) {
          isConflict = true;
          conflicts.push(ticketId);
          await transitSecurityEvent({
            companyId: transit.user.companyId,
            userId: transit.user.id,
            deviceId: transit.device.id,
            event: 'SEAT_CONFLICT',
            detail: `trip=${tripNo} seat=${seatNumber} ticketId=${ticketId} (unique constraint)`,
            ip,
          });
          continue;
        }
        // The same ticket number already exists in this company. Two different
        // handsets minted it, which means two passengers are holding paper with
        // the same number. We must NOT silently overwrite the earlier sale, and
        // we must NOT retry forever either: the number is already printed and
        // the clash is permanent, so it needs a human. Record it as a security
        // event and leave the row out of `synced` so the client can surface it.
        if (err.code === '23505' && err.constraint?.includes('receipt_unique')) {
          await transitSecurityEvent({
            companyId: transit.user.companyId,
            userId: transit.user.id,
            deviceId: transit.device.id,
            event: 'DUPLICATE_RECEIPT_NO',
            detail: `receiptNo=${clientReceiptNo} ticketId=${ticketId} (unique constraint)`,
            ip,
          });
          duplicateReceipts.push(ticketId);
          continue;
        }
        throw err;
      }

      if (handled) {
        if (isConflict) {
          conflicts.push(ticketId);
          await transitSecurityEvent({
            companyId: transit.user.companyId,
            userId: transit.user.id,
            deviceId: transit.device.id,
            event: 'SEAT_CONFLICT',
            detail: `trip=${tripNo} seat=${seatNumber} ticketId=${ticketId} (not silently overwritten)`,
            ip,
          });
        }
        synced.push(ticketId);
        markTripAffected();
        // A re-synced ticket_id that previously sat behind a SEAT_CONFLICT row is
        // promoted back to SYNCED by the ON CONFLICT update above.
        if (isConflict) continue;
      } else {
        duplicates.push(ticketId);
      }
    }

    // Recompute seats_sold for every trip this batch touched (COUNT-based, so
    // re-syncing the same ticket_id can never inflate the number).
    for (const tid of tripIdsToRefresh) {
      await client.query(
        `UPDATE transit_trips
         SET seats_sold = (SELECT COUNT(*) FROM transit_tickets
                           WHERE trip_id = $1 AND status <> 'SEAT_CONFLICT' AND status <> 'CANCELLED')
         WHERE id = $1`,
        [tid]
      );
    }
    for (const tn of tripNosToRefresh) {
      await client.query(
        `UPDATE transit_trips
         SET seats_sold = (SELECT COUNT(*) FROM transit_tickets
                           WHERE company_id = $1 AND trip_no = $2 AND status <> 'SEAT_CONFLICT' AND status <> 'CANCELLED')
         WHERE company_id = $1 AND trip_no = $2`,
        [transit.user.companyId, tn]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('tickets/sync transaction rolled back:', (err as Error).message);
    throw err;
  } finally {
    client.release();
  }

  const { rows: companyRows } = await pool.query(
    'SELECT offline_lease_days, min_app_version FROM transit_companies WHERE id = $1 AND deleted_at IS NULL',
    [transit.user.companyId]
  );
  const company = companyRows[0];
  const expiry = await leaseExpiryForDevice(company);

  await pool.query(
    `UPDATE transit_devices
     SET last_sync = NOW(), last_seen = NOW(), active_trip = COALESCE($2, active_trip),
         app_version = COALESCE($3, app_version),
         battery_pct = COALESCE($4, battery_pct),
         offline_authorization_expires_at = NOW() + ($5 * INTERVAL '1 day')
     WHERE id = $1`,
    [transit.device.id, activeTrip || null, appVersion || null, batteryPct ?? null, company.offline_lease_days || 7]
  );

  await transitAudit({
    companyId: transit.user.companyId,
    userId: transit.user.id,
    deviceId: transit.device.id,
    action: 'SYNC_COMPLETED',
    entity: 'transit_ticket',
    metadata: { sync: 'tickets/sync', synced: synced.length, duplicates: duplicates.length, rejected: rejected.length, conflicts: conflicts.length, duplicateReceipts: duplicateReceipts.length },
  });

  res.json({
    success: true,
    synced_count: synced.length,
    ids: synced,
    synced: synced.length,
    duplicates: duplicates.length,
    rejected,
    conflicts: conflicts.length,
    // Tickets refused because their printed number already belongs to another
    // sale. The client must NOT retry these forever: the paper is already in a
    // passenger's hand, so this is a reconciliation task, not a transient
    // failure. Kept as a separate count so the app can tell the conductor
    // instead of silently dropping the ticket.
    duplicate_receipts: duplicateReceipts.length,
    duplicate_receipt_ids: duplicateReceipts,
    device: { status: 'ACTIVE', licenseExpiresAt: expiry, minAppVersion: company.min_app_version, serverTime: new Date().toISOString() },
  });
});

// â”€â”€ Ticket detail (hydration) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * GET /api/transit/tickets/:ticketId
 * Returns the server-side copy of one ticket so field apps can backfill
 * customer / crew / bus fields that were missing when the sale was made
 * offline. Falls back to the trip's bus registration when the ticket itself
 * has none. Scoped to the device's own company.
 */
transitRouter.get('/tickets/:ticketId', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const ticketId = String(req.params.ticketId || '');
  if (!ticketId) {
    res.status(422).json({ error: 'ticketId is required' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT t.client_receipt_no, t.trip_no, t.trip_id,
            t.route_code, t.route_name, t.route_from, t.route_to,
            t.bus_reg, t.driver, t.driver_phone,
            t.conductor1, t.conductor2, t.conductor_phone,
            t.seat_number, t.customer_name, t.customer_mobile,
            t.departure_time, t.payment_method, t.total_cents,
            tr.bus_reg AS trip_bus_reg, tr.driver AS trip_driver,
            tr.driver_phone AS trip_driver_phone,
            tr.conductor1 AS trip_conductor1, tr.conductor2 AS trip_conductor2,
            tr.conductor_phone AS trip_conductor_phone,
            tr.departure_time AS trip_departure_time
     FROM transit_tickets t
     LEFT JOIN transit_trips tr ON tr.id = t.trip_id
     WHERE t.ticket_id = $1 AND t.company_id = $2
     LIMIT 1`,
    [ticketId, transit.user.companyId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  const row = rows[0];
  // A sale made with no trip picked carries the trip's canonical vehicle/crew/
  // departure fields so field hydration (and admin) always sees them.
  const busReg = String(row.bus_reg || row.trip_bus_reg || '');
  const driver = String(row.driver || row.trip_driver || '');
  const driverPhone = String(row.driver_phone || row.trip_driver_phone || '');
  const conductor1 = String(row.conductor1 || row.trip_conductor1 || '');
  const conductor2 = String(row.conductor2 || row.trip_conductor2 || '');
  const conductorPhone = String(
    row.conductor_phone || row.trip_conductor_phone || ''
  );
  const departureTime = String(
    row.departure_time || row.trip_departure_time || ''
  );
  res.json({
    ticket: {
      id: ticketId,
      receiptNo: row.client_receipt_no,
      tripNo: row.trip_no,
      routeCode: row.route_code,
      routeName: row.route_name,
      routeFrom: row.route_from,
      routeTo: row.route_to,
      busReg,
      driver,
      driverPhone,
      conductor1,
      conductor2,
      conductorPhone,
      seatNumber: row.seat_number,
      customerName: row.customer_name,
      customerMobile: row.customer_mobile,
      departureTime,
      paymentMethod: row.payment_method,
      totalCents: row.total_cents,
    },
  });
});

/**
 * IATA-style city codes used to auto-generate route codes from origin/destination
 * (e.g. "HARARE" -> "BULAWAYO" => "HRE-BYO"). Unmapped cities fall back to the
 * first three uppercase letters so any route still gets a stable code.
 */
const ROUTE_CITY_CODES: Record<string, string> = {
  BEITBRIDGE: 'BBE',
  BINDURA: 'BIN',
  BULAWAYO: 'BYO',
  CHINHOYI: 'CHI',
  CHIREDZI: 'CZD',
  CHITUNGWIZA: 'CHT',
  GROOMBRIDGE: 'GRB',
  GWERU: 'GWE',
  HARARE: 'HRE',
  HWANGE: 'HWA',
  KADOMA: 'KAD',
  KARIBA: 'KRB',
  KWEKWE: 'KWE',
  MARONDERA: 'MAR',
  MASVINGO: 'MAS',
  MUTARE: 'MUT',
  PLUMTREE: 'PLU',
  RUSAPE: 'RUS',
  SHAMVA: 'SHV',
  VICTORIA_FALLS: 'VFA',
  ZVISHAVANE: 'ZVI',
};

/** 3-letter code for one place name (manual map, else first 3 uppercase letters). */
function routeCodeForPlace(place: string): string {
  const name = place.toUpperCase().replace(/[^A-Z]/g, '');
  if (name.length === 0) return '';
  if (ROUTE_CITY_CODES[name]) return ROUTE_CITY_CODES[name];
  if (name.length >= 3) return name.slice(0, 3);
  return name.padEnd(3, 'X');
}

/** Route code from a FROM/TO pair (e.g. "Harare"-"Bulawayo" -> "HRE-BYO"). */
function autoRouteCode(from: string, to: string): string {
  const f = routeCodeForPlace(from);
  const t = routeCodeForPlace(to);
  if (!f || !t) return '';
  return `${f}-${t}`;
}

/** Shape a DB trip row for JSON (device-safe, no private fields). */
function publicTrip(row: any) {
  return {
    id: row.id,
    tripNo: row.trip_no,
    routeCode: row.route_code,
    routeFrom: row.route_from,
    routeTo: row.route_to,
    routeName: row.route_name,
    busReg: row.bus_reg,
    driver: row.driver,
    driverPhone: row.driver_phone,
    driverId: row.driver_id,
    conductor: row.conductor1,
    conductorPhone: row.conductor_phone,
    conductorId: row.conductor_id,
    departureTime: row.departure_time,
    status: row.status,
    baseFareCents: row.base_fare_cents ?? 0,
    totalSeats: row.total_seats,
    seatsSold: row.seats_sold,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

/** List the trips currently available for field staff to select / start. */
transitRouter.get('/trips/active', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { rows } = await pool.query(
    `SELECT * FROM transit_trips
     WHERE company_id = $1 AND status IN ('SCHEDULED', 'ACTIVE', 'OPEN')
     ORDER BY opened_at DESC`,
    [transit.user.companyId]
  );
  res.json({ trips: rows.map(publicTrip) });
});

/** Create a trip (SUPER_ADMIN / ADMIN, or any role holding COMPANY_ADMIN / OPERATIONS_MANAGE). */
transitRouter.post('/trips', requireTransitDevice, requireTransitPermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const transit = req.transit!;
  const {
    tripNo, routeCode, routeFrom, routeTo, busReg, driver, driverPhone, driverId,
    conductor, conductorPhone, conductorId, departureTime, totalSeats,
  } = req.body as {
    tripNo?: string; routeCode?: string; routeFrom?: string; routeTo?: string; busReg?: string;
    driver?: string; driverPhone?: string; driverId?: string;
    conductor?: string; conductorPhone?: string; conductorId?: string;
    departureTime?: string; totalSeats?: number;
  };

  if (!tripNo || !String(tripNo).trim() || !routeFrom || String(routeFrom).trim() === '' || !routeTo || String(routeTo).trim() === '') {
    res.status(422).json({ error: 'tripNo, routeFrom and routeTo are required' });
    return;
  }

  // Auto-generate the route code from origin/destination when one wasn't
  // supplied (e.g. "HARARE" / "BULAWAYO" -> "HRE-BYO").
  const resolvedRouteCode = String(routeCode || '').trim()
    || autoRouteCode(String(routeFrom), String(routeTo));

  const { rows } = await pool.query(
    `INSERT INTO transit_trips
       (company_id, user_id, device_id, trip_no, route_code, route_from, route_to, route_name,
        bus_reg, driver, driver_phone, driver_id, conductor1, conductor_phone, conductor_id,
        departure_time, total_seats, status, opened_at, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'SCHEDULED', NOW(), NULL)
     RETURNING *`,
    [
      transit.user.companyId,
      transit.user.id,
      transit.device.id,
      String(tripNo).trim(),
      resolvedRouteCode,
      String(routeFrom).trim(),
      String(routeTo).trim(),
      [String(routeFrom).trim(), String(routeTo).trim()].filter(Boolean).join(' - '),
      String(busReg || ''),
      String(driver || ''),
      String(driverPhone || ''),
      String(driverId || ''),
      String(conductor || ''),
      String(conductorPhone || ''),
      String(conductorId || ''),
      String(departureTime || ''),
      Math.max(0, Math.round(Number(totalSeats) || 0)),
    ]
  );
  await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, deviceId: transit.device.id, action: 'TRIP_CREATED', entity: 'transit_trip', entityId: rows[0].id, metadata: { tripNo: String(tripNo).trim(), by: transit.user.username } });
  res.status(201).json({ trip: publicTrip(rows[0]) });
});

/** Start a trip â€” field staff (driver/conductor) and admins can pull this to open the trip. */
transitRouter.post('/trips/:id/start', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { rows } = await pool.query(
    `UPDATE transit_trips
     SET status = 'ACTIVE', opened_at = COALESCE(opened_at, NOW()), closed_at = NULL
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [req.params.id, transit.user.companyId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }
  await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, deviceId: transit.device.id, action: 'TRIP_STARTED', entity: 'transit_trip', entityId: rows[0].id, metadata: { tripNo: rows[0].trip_no, by: transit.user.username } });
  res.json({ trip: publicTrip(rows[0]) });
});

/** Complete a trip â€” closes it after the run so reports stop accumulating seats. */
transitRouter.post('/trips/:id/complete', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { rows } = await pool.query(
    `UPDATE transit_trips
     SET status = 'COMPLETED', closed_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [req.params.id, transit.user.companyId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }
  await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, deviceId: transit.device.id, action: 'TRIP_COMPLETED', entity: 'transit_trip', entityId: rows[0].id, metadata: { tripNo: rows[0].trip_no, by: transit.user.username } });
  res.json({ trip: publicTrip(rows[0]) });
});

/** Pull the reference manifest for reporting / printing from the app. */
transitRouter.get('/trips/:id/manifest', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { rows: tripRows } = await pool.query(
    'SELECT * FROM transit_trips WHERE id = $1 AND company_id = $2',
    [req.params.id, transit.user.companyId]
  );
  if (tripRows.length === 0) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }
  const trip = tripRows[0];
  const { rows: ticketRows } = await pool.query(
    `SELECT seat_number, customer_name, customer_mobile, total_cents, cash_cents, change_cents, ticket_id, payment_method
     FROM transit_tickets
     WHERE company_id = $1 AND trip_id = $2 AND status <> 'CANCELLED'
     ORDER BY seat_number`,
    [transit.user.companyId, trip.id]
  );
  const tickets = ticketRows.map((t: any) => ({
    seatNumber: t.seat_number,
    customerName: t.customer_name,
    customerMobile: t.customer_mobile,
    amount: t.total_cents,
    cashCents: t.cash_cents,
    changeCents: t.change_cents,
    ticketId: t.ticket_id,
    paymentMethod: t.payment_method || 'cash',
  }));
  res.json({ trip: publicTrip(trip), tickets, count: tickets.length });
});

// â”€â”€ Company profile (device fetch for receipt branding) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Pulls the company profile so the app can render branded receipts offline. */
transitRouter.get('/company', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { rows } = await pool.query(
    `SELECT id, name, slug, tagline, address, email, website, customer_care, currency,
            logo_url, receipt_header, receipt_footer
     FROM transit_companies
     WHERE id = $1 AND deleted_at IS NULL`,
    [transit.user.companyId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }
  const c = rows[0];
  res.json({
    company: {
      id: c.id,
      name: c.name,
      slug: c.slug,
      slogan: c.tagline || '',
      logoUrl: c.logo_url || '',
      website: c.website || '',
      customerCare: c.customer_care || '',
      companyAddress: c.address || '',
      companyEmail: c.email || '',
      currency: c.currency || 'USD',
      receiptHeader: c.receipt_header || '',
      receiptFooter: c.receipt_footer || '',
    },
  });
});

// â”€â”€ Staff registry (device roster for pickers) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Returns the DRIVER / CONDUCTOR roster for the company: the staff registry
 * (transit_staff) plus every ACTIVE DRIVER/CONDUCTOR login account
 * (transit_users â€” the profiles admins edit in the Fleet page, where conductor
 * phone numbers live). When a login account and a registry profile share a
 * full name, the registry row wins (it carries license_no etc.). The app
 * merges this into its local drivers/conductors tables so the shift-start
 * screen resolves the signed-in conductor's phone from here, never by hand.
 */
transitRouter.get('/staff', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const role = String(req.query.role || '').trim().toUpperCase();
  if (role && !['DRIVER', 'CONDUCTOR'].includes(role)) {
    res.status(422).json({ error: 'role must be DRIVER or CONDUCTOR' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT r.id, r.role, r.full_name, r.phone, r.license_no, r.status
     FROM (
       SELECT s.id::text AS id, s.role, s.full_name, s.phone, s.license_no, s.status
       FROM transit_staff s
       WHERE s.company_id = $1 AND s.deleted_at IS NULL
         AND ($2 = '' OR UPPER(s.role) = $2)
       UNION ALL
       SELECT u.id::text AS id, u.role, u.full_name, u.phone, '' AS license_no, u.status
       FROM transit_users u
       WHERE u.company_id = $1 AND u.deleted_at IS NULL
         AND u.status = 'ACTIVE'
         AND UPPER(u.role) IN ('DRIVER', 'CONDUCTOR')
         AND ($2 = '' OR UPPER(u.role) = $2)
         AND NOT EXISTS (
           SELECT 1 FROM transit_staff s2
           WHERE s2.company_id = u.company_id AND s2.deleted_at IS NULL
             AND UPPER(s2.full_name) = UPPER(u.full_name)
         )
     ) r
     ORDER BY r.full_name ASC`,
    [transit.user.companyId, ['DRIVER', 'CONDUCTOR'].includes(role) ? role : '']
  );
  res.json({
    staff: rows.map((r: any) => ({
      id: r.id,
      role: r.role,
      fullName: r.full_name,
      phone: r.phone || '',
      phone_number: r.phone || '',
      licenseNo: r.license_no || '',
      status: r.status,
    })),
  });
});

// â”€â”€ Driver shifts (offline sales attribution) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const publicShift = (s: any) => ({
  id: s.id,
  userId: s.user_id,
  deviceId: s.device_id,
  driverId: s.driver_id,
  driverName: s.driver_name,
  driverPhone: s.driver_phone ?? '',
  conductorName: s.conductor_name ?? '',
  conductorPhone: s.conductor_phone ?? '',
  vehicleReg: s.vehicle_reg,
  status: s.status,
  notes: s.notes,
  startedAt: s.started_at,
  closedAt: s.closed_at,
  ticketCount: s.ticket_count ?? 0,
  totalCents: s.total_cents ?? 0,
});

/** Start (or idempotently re-push) a shift. The app may supply its local
 *  shift UUID so tickets synced offline can reference it immediately. */
transitRouter.post('/shifts/start', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { shiftId, driverId, driverName, driverPhone, conductorName, conductorPhone, vehicleReg, notes } = req.body as {
    shiftId?: string; driverId?: string; driverName?: string; driverPhone?: string;
    conductorName?: string; conductorPhone?: string; vehicleReg?: string; notes?: string;
  };
  const id = String(shiftId || '').trim();
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    res.status(422).json({ error: 'shiftId must be a UUID' });
    return;
  }
  const driverIdent = String(driverId || '').trim();
  const driver = String(driverName || '').trim();
  const driverPhoneNorm = formatZimPhone(driverPhone);
  const conductor = String(conductorName || '').trim();
  const conductorPhoneNorm = formatZimPhone(conductorPhone);
  const vehicle = String(vehicleReg || '').trim();
  const shiftNotes = String(notes || '').trim();
  try {
    const { rows } = await pool.query(
      `INSERT INTO transit_shifts
         (id, company_id, user_id, device_id, driver_id, driver_name, driver_phone,
          conductor_name, conductor_phone, vehicle_reg, status, notes)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, 'OPEN', $11)
       ON CONFLICT (id) DO UPDATE SET
         driver_id = EXCLUDED.driver_id,
         driver_name = EXCLUDED.driver_name,
         driver_phone = EXCLUDED.driver_phone,
         conductor_name = EXCLUDED.conductor_name,
         conductor_phone = EXCLUDED.conductor_phone,
         vehicle_reg = EXCLUDED.vehicle_reg,
         notes = EXCLUDED.notes,
         -- A start that arrives for a shift the server has already closed is a
         -- replay of an offline start/close pair, not a fresh duty. Reopening it
         -- would resurrect a finished shift and stamp its close time as NULL.
         status = CASE WHEN transit_shifts.status = 'CLOSED' THEN 'CLOSED' ELSE 'OPEN' END,
         closed_at = CASE WHEN transit_shifts.status = 'CLOSED' THEN transit_shifts.closed_at ELSE NULL END
       RETURNING *`,
      [id || null, transit.user.companyId, transit.user.id, transit.device.id, driverIdent, driver,
       driverPhoneNorm, conductor, conductorPhoneNorm, vehicle, shiftNotes]
    );
    await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, deviceId: transit.device.id, action: 'SHIFT_STARTED', entity: 'transit_shift', entityId: rows[0].id, metadata: { driverName: driver, vehicleReg: vehicle, by: transit.user.username } });
    res.status(201).json({ shift: publicShift(rows[0]) });
  } catch (err: any) {
    if (err.code === '23505' && err.constraint?.includes('idx_one_open_shift')) {
      res.status(409).json({ error: 'A shift is already open for this user. Close it first.', code: 'SHIFT_ALREADY_OPEN' });
      return;
    }
    throw err;
  }
});

/** Close the user's open shift. Accepts server-computed totals for bookkeeping.
 *
 *  A device that lost connectivity at end of shift replays the close later, and
 *  sends the time the conductor actually finished in `closedAt`. Without this the
 *  server would stamp the close at reconnection time and admin would see a
 *  multi-hour shift for a bus that went off duty in the afternoon. An invalid or
 *  unparseable timestamp is ignored in favour of NOW() rather than rejected, so a
 *  bad clock on one handset can never block the close.
 *
 *  Re-sending an already-closed shift is a success, not a 404: replay must be
 *  idempotent or a handset that got no response would retry forever. */
transitRouter.post('/shifts/close', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const shiftId = String(req.body.shiftId || '').trim();
  if (!shiftId) {
    res.status(422).json({ error: 'shiftId is required' });
    return;
  }
  const rawClosedAt = String(req.body.closedAt || '').trim();
  const parsedClosedAt = rawClosedAt ? new Date(rawClosedAt) : null;
  const useClosedAt = parsedClosedAt !== null && !Number.isNaN(parsedClosedAt.getTime());
  // $11 keeps the timestamp out of the way of the column positions. The INSERT
  // branch has no table to coalesce against (a bare column name in VALUES does
  // not resolve), so only the DO UPDATE branch can preserve an earlier close.
  const insertClosedAt = useClosedAt ? '$11::timestamptz' : 'NOW()';
  // With no usable timestamp, fall back to the server clock — but only for a
  // shift that has not been closed yet, so replaying an already-closed shift
  // still keeps its original finish time.
  const updateClosedAt = useClosedAt
    ? 'COALESCE(transit_shifts.closed_at, $11::timestamptz)'
    : 'COALESCE(transit_shifts.closed_at, NOW())';
  const { rows } = await pool.query(
    `INSERT INTO transit_shifts
       (id, company_id, user_id, device_id, driver_id, driver_name, driver_phone,
        conductor_name, conductor_phone, vehicle_reg, status, closed_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CLOSED', ${insertClosedAt})
     ON CONFLICT (id) DO UPDATE SET
       status = 'CLOSED',
       closed_at = ${updateClosedAt},
       -- Fill in crew details the server never received (shift started and ended
       -- while the handset was offline) without overwriting what it already knows.
       driver_id = COALESCE(NULLIF(transit_shifts.driver_id, ''), EXCLUDED.driver_id),
       driver_name = COALESCE(NULLIF(transit_shifts.driver_name, ''), EXCLUDED.driver_name),
       driver_phone = COALESCE(NULLIF(transit_shifts.driver_phone, ''), EXCLUDED.driver_phone),
       conductor_name = COALESCE(NULLIF(transit_shifts.conductor_name, ''), EXCLUDED.conductor_name),
       conductor_phone = COALESCE(NULLIF(transit_shifts.conductor_phone, ''), EXCLUDED.conductor_phone),
       vehicle_reg = COALESCE(NULLIF(transit_shifts.vehicle_reg, ''), EXCLUDED.vehicle_reg)
     -- Without this guard the upsert would happily close a shift id owned by a
     -- DIFFERENT company: ON CONFLICT (id) matches on the primary key alone,
     -- which would be a cross-tenant write. A mismatched row falls through
     -- without being updated and is reported as 404 below.
     WHERE transit_shifts.company_id = EXCLUDED.company_id
     RETURNING *`,
    [
      shiftId,
      transit.user.companyId,
      transit.user.id,
      transit.device.id,
      // These columns are NOT NULL in the schema (they default to ''), so an
      // absent value must be sent as an empty string rather than NULL.
      String(req.body.driverId || '').trim(),
      String(req.body.driverName || '').trim(),
      formatZimPhone(req.body.driverPhone),
      String(req.body.conductorName || '').trim(),
      formatZimPhone(req.body.conductorPhone),
      String(req.body.vehicleReg || '').trim(),
      // Postgres rejects a bind list longer than the placeholders the statement
      // actually uses, so $11 is only supplied when the timestamp is referenced.
      ...(useClosedAt ? [(parsedClosedAt as Date).toISOString()] : []),
    ]
  );
  if (rows.length === 0) {
    // The id belongs to another company. Never disclose that it exists.
    res.status(404).json({ error: 'Shift not found' });
    return;
  }
  await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, deviceId: transit.device.id, action: 'SHIFT_CLOSED', entity: 'transit_shift', entityId: rows[0].id, metadata: { by: transit.user.username } });
  res.json({ shift: publicShift(rows[0]) });
});

/** Open shifts for the company (used by devices to reconcile their local shift). */
transitRouter.get('/shifts/active', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, s.device_id, s.driver_id, s.driver_name, s.driver_phone,
              s.conductor_name, s.conductor_phone, s.vehicle_reg,
              s.status, s.notes, s.started_at, s.closed_at, s.ticket_count, s.total_cents
      FROM transit_shifts s
      WHERE s.company_id = $1 AND s.status = 'OPEN'
      ORDER BY s.started_at DESC`,
      [transit.user.companyId]
    );
  res.json({ shifts: rows.map(publicShift) });
});

// â”€â”€ Promotions module (admin-only mutation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** List promotions for the company (all roles may view, e.g. checkout discount lookup). */
transitRouter.get('/promotions', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { rows } = await pool.query(
    `SELECT id, code, description, type, value, minimum_cents, max_value_cents, active, usage_count, created_at, updated_at
     FROM transit_promotions
     WHERE company_id = $1
     ORDER BY active DESC, code ASC`,
    [transit.user.companyId]
  );
  res.json({
    promotions: rows.map((r: any) => ({
      id: r.id,
      code: r.code,
      description: r.description,
      type: r.type,
      value: r.value,
      minimumCents: r.minimum_cents,
      maxValueCents: r.max_value_cents,
      active: r.active,
      usageCount: r.usage_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

/** Create a promotion. STRICTLY SUPER_ADMIN / ADMIN â€” 403 for Conductor / Driver / Ticket Seller. */
transitRouter.post('/promotions', requireTransitDevice, requireTransitRoles('SUPER_ADMIN', 'ADMIN'), async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { code, description, type, value, minimumCents, maxValueCents, active } = req.body as {
    code?: string; description?: string; type?: string; value?: number;
    minimumCents?: number; maxValueCents?: number; active?: boolean;
  };
  const promoCode = String(code || '').trim().toUpperCase();
  if (!promoCode || !/^[A-Z0-9_-]{2,24}$/.test(promoCode)) {
    res.status(422).json({ error: 'code is required and must be 2-24 chars (letters, digits, _ or -)' });
    return;
  }
  const promoType = type === 'FLAT' ? 'FLAT' : 'PERCENT';
  const promoValue = Math.max(0, Math.round(Number(value) || 0));
  if (promoType === 'PERCENT' && promoValue > 100) {
    res.status(422).json({ error: 'Percent discount cannot exceed 100' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO transit_promotions
         (company_id, code, description, type, value, minimum_cents, max_value_cents, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        transit.user.companyId,
        promoCode,
        String(description || ''),
        promoType,
        promoValue,
        Math.max(0, Math.round(Number(minimumCents) || 0)),
        Math.max(0, Math.round(Number(maxValueCents) || 0)),
        active !== false,
        transit.user.id,
      ]
    );
    await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, deviceId: transit.device.id, action: 'PROMOTION_CREATED', entity: 'transit_promotion', entityId: rows[0].id, metadata: { code: promoCode, by: transit.user.username } });
    res.status(201).json({ promotion: rows[0] });
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A promotion with this code already exists', code: 'PROMO_CODE_EXISTS' });
      return;
    }
    throw err;
  }
});

/** Update (edit / activate / deactivate) a promotion. SUPER_ADMIN / ADMIN only. */
transitRouter.put('/promotions/:id', requireTransitDevice, requireTransitRoles('SUPER_ADMIN', 'ADMIN'), async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { code, description, type, value, minimumCents, maxValueCents, active } = req.body as {
    code?: string; description?: string; type?: string; value?: number;
    minimumCents?: number; maxValueCents?: number; active?: boolean;
  };
  const promoCode = code !== undefined ? String(code).trim().toUpperCase() : undefined;
  if (promoCode !== undefined && !/^[A-Z0-9_-]{2,24}$/.test(promoCode)) {
    res.status(422).json({ error: 'code must be 2-24 chars (letters, digits, _ or -)' });
    return;
  }
  const promoType = type === 'FLAT' ? 'FLAT' : type === 'PERCENT' ? 'PERCENT' : undefined;
  const promoValue = value !== undefined ? Math.max(0, Math.round(Number(value) || 0)) : undefined;
  if (promoType === 'PERCENT' && promoValue !== undefined && promoValue > 100) {
    res.status(422).json({ error: 'Percent discount cannot exceed 100' });
    return;
  }
  const fields: string[] = [];
  const params: any[] = [];
  const push = (col: string, val: any) => {
    params.push(val);
    fields.push(`${col} = $${params.length}`);
  };
  if (promoCode !== undefined) push('code', promoCode);
  if (description !== undefined) push('description', String(description));
  if (promoType !== undefined) push('type', promoType);
  if (promoValue !== undefined) push('value', promoValue);
  if (minimumCents !== undefined) push('minimum_cents', Math.max(0, Math.round(Number(minimumCents) || 0)));
  if (maxValueCents !== undefined) push('max_value_cents', Math.max(0, Math.round(Number(maxValueCents) || 0)));
  if (active !== undefined) push('active', active !== false);
  if (fields.length === 0) {
    res.status(422).json({ error: 'Nothing to update' });
    return;
  }
  fields.push('updated_at = NOW()');
  params.push(req.params.id, transit.user.companyId);
  try {
    const { rows } = await pool.query(
      `UPDATE transit_promotions SET ${fields.join(', ')}
       WHERE id = $${params.length - 1} AND company_id = $${params.length}
       RETURNING *`,
      params
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Promotion not found' });
      return;
    }
    await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, deviceId: transit.device.id, action: 'PROMOTION_UPDATED', entity: 'transit_promotion', entityId: rows[0].id, metadata: { code: rows[0].code, by: transit.user.username } });
    res.json({ promotion: rows[0] });
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A promotion with this code already exists', code: 'PROMO_CODE_EXISTS' });
      return;
    }
    throw err;
  }
}
);

// â”€â”€ Master route templates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// A company-owned stage list + stage-to-stage fare matrix that a conductor uses
// to open an UNSCHEDULED on-the-go run. Read is open to every device (all
// conductors need them to sell offline); writes need
// `route.templates.manage`, which a company can be granted outright so a
// field-staff owner is not forced to become COMPANY_ADMIN.

interface NormalizedTemplateStage {
  seq: number;
  name: string;
}
interface NormalizedTemplateFare {
  fromSeq: number;
  toSeq: number;
  priceCents: number;
}
interface NormalizedTemplate {
  name: string;
  code: string;
  description: string;
  active: boolean;
  stages: NormalizedTemplateStage[];
  fares: NormalizedTemplateFare[];
}

/**
 * Validate + normalise a template body. Mirrors the POS `saveRouteTemplate`
 * rules exactly so a round-trip is stable: blank stage names are dropped and the
 * survivors are renumbered 1..n, and degenerate (from == to) legs are skipped.
 * Legs are stored in forward order (from < to) and de-duplicated, last wins.
 */
export function normalizeRouteTemplate(body: any): { ok: true; value: NormalizedTemplate } | { ok: false; error: string } {
  const name = String(body?.name ?? '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > 120) return { ok: false, error: 'name must be 120 characters or fewer' };

  const rawCode = String(body?.code ?? '').trim().toUpperCase();
  if (rawCode && !/^[A-Z0-9_-]{1,24}$/.test(rawCode)) {
    return { ok: false, error: 'code must be 1-24 chars (letters, digits, _ or -)' };
  }

  const rawStages: any[] = Array.isArray(body?.stages) ? body.stages : [];
  const stages: NormalizedTemplateStage[] = [];
  for (const s of rawStages) {
    const stageName = String(s?.name ?? '').trim();
    if (!stageName) continue;
    if (stageName.length > 120) return { ok: false, error: `stage name too long: ${stageName.slice(0, 40)}â€¦` };
    stages.push({ seq: stages.length + 1, name: stageName });
  }
  if (stages.length < 2) {
    return { ok: false, error: 'a template needs at least 2 named stages' };
  }

  const byLeg = new Map<string, NormalizedTemplateFare>();
  for (const f of Array.isArray(body?.fares) ? body.fares : []) {
    const fromSeq = Math.round(Number(f?.fromSeq));
    const toSeq = Math.round(Number(f?.toSeq));
    if (!Number.isFinite(fromSeq) || !Number.isFinite(toSeq)) continue;
    if (fromSeq === toSeq) continue;
    const lo = Math.min(fromSeq, toSeq);
    const hi = Math.max(fromSeq, toSeq);
    const priceCents = Math.max(0, Math.round(Number(f?.priceCents) || 0));
    byLeg.set(`${lo}:${hi}`, { fromSeq: lo, toSeq: hi, priceCents });
  }
  const fares = [...byLeg.values()].sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq);

  return {
    ok: true,
    value: {
      name,
      code: rawCode,
      description: String(body?.description ?? '').trim().slice(0, 500),
      active: body?.active !== false,
      stages,
      fares,
    },
  };
}

/** Replace a template's stage list + fare matrix wholesale (one transaction). */
async function writeTemplateChildren(
  client: any,
  templateId: string,
  stages: NormalizedTemplateStage[],
  fares: NormalizedTemplateFare[],
): Promise<void> {
  await client.query('DELETE FROM transit_route_template_stages WHERE template_id = $1', [templateId]);
  await client.query('DELETE FROM transit_route_template_fares WHERE template_id = $1', [templateId]);
  for (const s of stages) {
    await client.query(
      'INSERT INTO transit_route_template_stages (template_id, seq, name) VALUES ($1, $2, $3)',
      [templateId, s.seq, s.name],
    );
  }
  for (const f of fares) {
    await client.query(
      `INSERT INTO transit_route_template_fares (template_id, from_seq, to_seq, price_cents)
       VALUES ($1, $2, $3, $4)`,
      [templateId, f.fromSeq, f.toSeq, f.priceCents],
    );
  }
}

/** Shape a template row + its children for the POS catalog mirror. */
function publicRouteTemplate(
  row: any,
  stages: any[] = [],
  fares: any[] = [],
): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stages: stages.map((s) => ({ id: s.id, seq: s.seq, name: s.name })),
    fares: fares.map((f) => ({
      id: f.id,
      fromSeq: f.from_seq,
      toSeq: f.to_seq,
      priceCents: f.price_cents,
    })),
  };
}

/** All company templates with stages + matrix hydrated. Readable by every device. */
transitRouter.get('/route-templates', requireTransitDevice, async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { rows } = await pool.query(
    `SELECT id, name, code, description, active, created_at, updated_at
     FROM transit_route_templates
     WHERE company_id = $1
     ORDER BY active DESC, name ASC`,
    [transit.user.companyId],
  );
  if (rows.length === 0) {
    res.json({ routeTemplates: [] });
    return;
  }
  const ids = rows.map((r: any) => r.id);
  const [stageRes, fareRes] = await Promise.all([
    pool.query(
      `SELECT id, template_id, seq, name FROM transit_route_template_stages
       WHERE template_id = ANY($1::uuid[]) ORDER BY template_id ASC, seq ASC`,
      [ids],
    ),
    pool.query(
      `SELECT id, template_id, from_seq, to_seq, price_cents FROM transit_route_template_fares
       WHERE template_id = ANY($1::uuid[]) ORDER BY template_id ASC, from_seq ASC, to_seq ASC`,
      [ids],
    ),
  ]);
  const stagesBy = new Map<string, any[]>();
  for (const s of stageRes.rows) {
    const list = stagesBy.get(s.template_id) ?? [];
    list.push(s);
    stagesBy.set(s.template_id, list);
  }
  const faresBy = new Map<string, any[]>();
  for (const f of fareRes.rows) {
    const list = faresBy.get(f.template_id) ?? [];
    list.push(f);
    faresBy.set(f.template_id, list);
  }
  res.json({
    routeTemplates: rows.map((r: any) =>
      publicRouteTemplate(r, stagesBy.get(r.id) ?? [], faresBy.get(r.id) ?? []),
    ),
  });
});

/** Create a template. Requires `route.templates.manage`. */
transitRouter.post(
  '/route-templates',
  requireTransitDevice,
  requireTransitPermission(PERMISSIONS.ROUTE_TEMPLATES_MANAGE),
  async (req: Request, res: Response) => {
    const transit = req.transit!;
    const parsed = normalizeRouteTemplate(req.body);
    if (!parsed.ok) {
      res.status(422).json({ error: parsed.error });
      return;
    }
    const t = parsed.value;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO transit_route_templates
           (company_id, name, code, description, active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [transit.user.companyId, t.name, t.code, t.description, t.active, transit.user.id],
      );
      const created = rows[0];
      await writeTemplateChildren(client, created.id, t.stages, t.fares);
      await client.query('COMMIT');
      await transitAudit({
        companyId: transit.user.companyId,
        userId: transit.user.id,
        deviceId: transit.device.id,
        action: 'ROUTE_TEMPLATE_CREATED',
        entity: 'transit_route_template',
        entityId: created.id,
        metadata: { name: t.name, stages: t.stages.length, by: transit.user.username },
      });
      const [stageRes, fareRes] = await Promise.all([
        pool.query(
          'SELECT id, seq, name FROM transit_route_template_stages WHERE template_id = $1 ORDER BY seq ASC',
          [created.id],
        ),
        pool.query(
          'SELECT id, from_seq, to_seq, price_cents FROM transit_route_template_fares WHERE template_id = $1 ORDER BY from_seq ASC, to_seq ASC',
          [created.id],
        ),
      ]);
      res.status(201).json({ routeTemplate: publicRouteTemplate(created, stageRes.rows, fareRes.rows) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
);

/** Update a template (stages + matrix replaced wholesale). Requires `route.templates.manage`. */
transitRouter.put(
  '/route-templates/:id',
  requireTransitDevice,
  requireTransitPermission(PERMISSIONS.ROUTE_TEMPLATES_MANAGE),
  async (req: Request, res: Response) => {
    const transit = req.transit!;
    const parsed = normalizeRouteTemplate(req.body);
    if (!parsed.ok) {
      res.status(422).json({ error: parsed.error });
      return;
    }
    const t = parsed.value;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // company_id in the WHERE is the tenant boundary: a template belonging to
      // another company must 404, never be editable.
      const { rows } = await client.query(
        `UPDATE transit_route_templates
         SET name = $1, code = $2, description = $3, active = $4, updated_at = NOW()
         WHERE id = $5 AND company_id = $6
         RETURNING *`,
        [t.name, t.code, t.description, t.active, req.params.id, transit.user.companyId],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Route template not found' });
        return;
      }
      const updated = rows[0];
      await writeTemplateChildren(client, updated.id, t.stages, t.fares);
      await client.query('COMMIT');
      await transitAudit({
        companyId: transit.user.companyId,
        userId: transit.user.id,
        deviceId: transit.device.id,
        action: 'ROUTE_TEMPLATE_UPDATED',
        entity: 'transit_route_template',
        entityId: updated.id,
        metadata: { name: t.name, stages: t.stages.length, by: transit.user.username },
      });
      const [stageRes, fareRes] = await Promise.all([
        pool.query(
          'SELECT id, seq, name FROM transit_route_template_stages WHERE template_id = $1 ORDER BY seq ASC',
          [updated.id],
        ),
        pool.query(
          'SELECT id, from_seq, to_seq, price_cents FROM transit_route_template_fares WHERE template_id = $1 ORDER BY from_seq ASC, to_seq ASC',
          [updated.id],
        ),
      ]);
      res.json({ routeTemplate: publicRouteTemplate(updated, stageRes.rows, fareRes.rows) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
);

/** Delete a template. Stages + matrix cascade. Past sales are unaffected â€”
 *  they reference the trip, never the template. Requires `route.templates.manage`. */
transitRouter.delete(
  '/route-templates/:id',
  requireTransitDevice,
  requireTransitPermission(PERMISSIONS.ROUTE_TEMPLATES_MANAGE),
  async (req: Request, res: Response) => {
    const transit = req.transit!;
    const { rowCount } = await pool.query(
      'DELETE FROM transit_route_templates WHERE id = $1 AND company_id = $2',
      [req.params.id, transit.user.companyId],
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Route template not found' });
      return;
    }
    await transitAudit({
      companyId: transit.user.companyId,
      userId: transit.user.id,
      deviceId: transit.device.id,
      action: 'ROUTE_TEMPLATE_DELETED',
      entity: 'transit_route_template',
      entityId: req.params.id,
      metadata: { by: transit.user.username },
    });
    res.json({ ok: true });
  },
);

// â”€â”€ Admin: device management & oversight â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

transitRouter.get('/admin/devices', requireTransitDevice, requireTransitPermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { rows } = await pool.query(
    `SELECT d.device_uuid, d.device_model, d.app_version, d.status, d.last_sync, d.last_seen,
            d.last_location, d.battery_pct, d.active_trip, d.offline_authorization_expires_at,
            d.registered_at, d.min_app_version, d.device_key,
            u.username, u.full_name, u.role, u.id AS user_id
     FROM transit_devices d
     JOIN transit_users u ON u.id = d.user_id AND u.deleted_at IS NULL
     WHERE d.company_id = $1
     ORDER BY d.last_seen DESC NULLS LAST`,
    [transit.user.companyId]
  );
  res.json({
    devices: rows.map((r: any) => ({
      deviceUuid: r.device_uuid,
      model: r.device_model,
      appVersion: r.app_version,
      status: r.status,
      lastSync: r.last_sync,
      lastSeen: r.last_seen,
      lastLocation: r.last_location,
      batteryPct: r.battery_pct,
      activeTrip: r.active_trip,
      offlineAuthorizationExpiresAt: r.offline_authorization_expires_at,
      registeredAt: r.registered_at,
      minAppVersion: r.min_app_version,
      hasKey: !!(r.device_key && r.device_key.length > 0),
      user: { id: r.user_id, username: r.username, fullName: r.full_name, role: r.role },
    })),
  });
});

transitRouter.post('/admin/devices/:deviceUuid/disable', requireTransitDevice, requireTransitPermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { deviceUuid } = req.params;
  const { rows } = await pool.query(
    'UPDATE transit_devices SET status = $1 WHERE device_uuid = $2 AND company_id = $3 RETURNING id, user_id',
    ['DISABLED', deviceUuid, transit.user.companyId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, action: 'DEVICE_DISABLED', entity: 'transit_device', entityId: deviceUuid, metadata: { by: transit.user.username } });
  await transitSecurityEvent({ companyId: transit.user.companyId, userId: transit.user.id, event: 'DEVICE_DISABLED', detail: `device=${deviceUuid}` });
  res.json({ ok: true, status: 'DISABLED' });
});

transitRouter.post('/admin/devices/:deviceUuid/revoke', requireTransitDevice, requireTransitPermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { deviceUuid } = req.params;
  const { rows } = await pool.query(
    'UPDATE transit_devices SET status = $1 WHERE device_uuid = $2 AND company_id = $3 RETURNING id',
    ['REVOKED', deviceUuid, transit.user.companyId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, action: 'DEVICE_REVOKED', entity: 'transit_device', entityId: deviceUuid, metadata: { by: transit.user.username } });
  await transitSecurityEvent({ companyId: transit.user.companyId, userId: transit.user.id, event: 'DEVICE_REVOKED', detail: `device=${deviceUuid}` });
  res.json({ ok: true, status: 'REVOKED' });
});

/** Clears the device key + forces re-registration (binding reset) by the owning user on that device. */
transitRouter.post('/admin/devices/:deviceUuid/reset-binding', requireTransitDevice, requireTransitPermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { deviceUuid } = req.params;
  const { rows } = await pool.query(
    `UPDATE transit_devices SET status = 'UNBOUND', device_key = '', reset_by = $1, min_app_version = ''
     WHERE device_uuid = $2 AND company_id = $3 RETURNING id`,
    [transit.user.id, deviceUuid, transit.user.companyId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, action: 'DEVICE_BINDING_RESET', entity: 'transit_device', entityId: deviceUuid, metadata: { by: transit.user.username } });
  res.json({ ok: true, status: 'UNBOUND' });
});

transitRouter.post('/admin/devices/:deviceUuid/require-update', requireTransitDevice, requireTransitPermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const transit = req.transit!;
  const { deviceUuid } = req.params;
  const minVersion = String(req.body.minAppVersion || '');
  if (!/^\d+\.\d+\.\d+/.test(minVersion)) {
    res.status(422).json({ error: 'minAppVersion must look like x.y.z' });
    return;
  }
  const { rows } = await pool.query(
    'UPDATE transit_devices SET min_app_version = $1 WHERE device_uuid = $2 AND company_id = $3 RETURNING id',
    [minVersion, deviceUuid, transit.user.companyId]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  await transitAudit({ companyId: transit.user.companyId, userId: transit.user.id, action: 'APP_UPDATE_REQUIRED', entity: 'transit_device', entityId: deviceUuid, metadata: { minAppVersion: minVersion } });
  res.json({ ok: true, minAppVersion: minVersion });
});

transitRouter.get('/admin/audit', requireTransitDevice, requireTransitPermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.OPERATIONS_MANAGE), async (req: Request, res: Response) => {
  const transit = req.transit!;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { rows } = await pool.query(
     `SELECT a.action, a.entity, a.entity_id, a.metadata, a.created_at, u.username
     FROM transit_audit_log a LEFT JOIN transit_users u ON u.id = a.user_id AND u.deleted_at IS NULL
     WHERE a.company_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
    [transit.user.companyId, limit]
  );
  res.json({ audit: rows });
});

transitRouter.get('/admin/security-events', requireTransitDevice, requireTransitPermission(PERMISSIONS.COMPANY_ADMIN), async (req: Request, res: Response) => {
  const transit = req.transit!;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { rows } = await pool.query(
     `SELECT s.event, s.detail, s.ip, s.created_at, u.username
     FROM transit_security_events s LEFT JOIN transit_users u ON u.id = s.user_id AND u.deleted_at IS NULL
     WHERE s.company_id = $1 ORDER BY s.created_at DESC LIMIT $2`,
    [transit.user.companyId, limit]
  );
  res.json({ events: rows });
});