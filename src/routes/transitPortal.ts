import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { requireTransitSession } from '../middleware/transitAuth';
import { formatZimPhone } from '../utils/phone';
import { sendTransitPasswordSetup } from '../services/notificationService';
import { transitAudit } from '../services/transitAudit';

/**
 * transit.preyone.com staff portal API.
 *
 * Public endpoints issue one-time password-setup links for transit_users.
 * Everything else uses the *session* JWT from /api/transit/auth/login (not a
 * device token), so a browser never bypasses the app's one-account-one-device
 * binding rules. Device-protected routes still reject these tokens.
 */

const STRONG_PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const SETUP_TTL_MS = 60 * 60 * 1000;
const GENERIC_SETUP_MESSAGE = 'If that account is registered, a setup link has been sent.';

const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many requests. Try again later.' },
});

export const transitPortalRouter = express.Router();

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function identifierKind(identifier: string): 'email' | 'phone' | 'unknown' {
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier)) return 'email';
  if (/^\+?[0-9]{9,15}$/.test(identifier.replace(/[\s()-]/g, ''))) return 'phone';
  return 'unknown';
}

async function issueSetupLink(userId: string, email: string, fullName: string, companyName: string) {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + SETUP_TTL_MS);
  await pool.query(
    `UPDATE transit_users
        SET password_setup_token = $1, password_setup_expires_at = $2
      WHERE id = $3`,
    [token, expiresAt, userId]
  );
  const sent = await sendTransitPasswordSetup(email, token, fullName, companyName);
  return { token, sent };
}

// ── Public: request a password-setup link ───────────────────────────────
transitPortalRouter.post('/auth/request-setup', setupLimiter, async (req: Request, res: Response) => {
  const identifier = clean(req.body?.identifier ?? req.body?.email ?? req.body?.phone);
  if (!identifier) {
    res.status(422).json({ error: 'Email or phone is required.' });
    return;
  }

  const kind = identifierKind(identifier);
  const lookup = kind === 'phone' ? formatZimPhone(identifier) : identifier.toLowerCase();
  let rows: any[] = [];

  if (kind === 'email') {
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.email, c.id AS company_id, c.name AS company_name
         FROM transit_users u
         JOIN transit_companies c ON c.id = u.company_id AND c.deleted_at IS NULL
        WHERE lower(u.email) = $1 AND u.email != '' AND u.deleted_at IS NULL
          AND u.status = 'ACTIVE'`,
      [lookup]
    );
    rows = result.rows;
  } else if (kind === 'phone') {
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.email, c.id AS company_id, c.name AS company_name
         FROM transit_users u
         JOIN transit_companies c ON c.id = u.company_id AND c.deleted_at IS NULL
        WHERE u.phone = $1 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'`,
      [lookup]
    );
    // Phone alone is not unique across tenants. Send only when exactly one
    // active staff record matches, otherwise stay silent (anti-enumeration).
    rows = result.rows.length === 1 ? result.rows : [];
  }

  if (rows.length === 1 && rows[0].email) {
    await issueSetupLink(rows[0].id, rows[0].email, rows[0].full_name, rows[0].company_name);
    await transitAudit({
      companyId: rows[0].company_id,
      userId: rows[0].id,
      action: 'PASSWORD_SETUP_REQUESTED',
      entity: 'transit_user',
      entityId: rows[0].id,
      metadata: { via: kind },
    });
  }

  // Never disclose whether the account exists or which delivery channel was used.
  res.json({ message: GENERIC_SETUP_MESSAGE });
});

// ── Public: verify a setup token before showing the form ────────────────
transitPortalRouter.get('/auth/verify-setup', async (req: Request, res: Response) => {
  const token = clean(req.query.token);
  if (!token) {
    res.status(400).json({ error: 'Missing token.' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT u.full_name, c.name AS company_name
       FROM transit_users u
       JOIN transit_companies c ON c.id = u.company_id
      WHERE u.password_setup_token = $1
        AND u.password_setup_expires_at > NOW()
        AND u.deleted_at IS NULL
        AND u.status = 'ACTIVE'`,
    [token]
  );
  if (rows.length === 0) {
    res.status(400).json({ error: 'Invalid or expired setup link.' });
    return;
  }
  res.json({ valid: true, fullName: rows[0].full_name, companyName: rows[0].company_name });
});

// ── Public: consume the setup token and set the password ────────────────
transitPortalRouter.post('/auth/set-password', async (req: Request, res: Response) => {
  const token = clean(req.body?.token);
  const password = String(req.body?.password ?? '');
  if (!token || !password) {
    res.status(422).json({ error: 'Token and password are required.' });
    return;
  }
  if (!STRONG_PASSWORD_RE.test(password)) {
    res.status(422).json({
      error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character.',
    });
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, company_id, full_name
       FROM transit_users
      WHERE password_setup_token = $1
        AND password_setup_expires_at > NOW()
        AND deleted_at IS NULL
        AND status = 'ACTIVE'`,
    [token]
  );
  if (rows.length === 0) {
    res.status(400).json({ error: 'Invalid or expired setup link.' });
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `UPDATE transit_users
        SET password_hash = $1, password_setup_token = NULL,
            password_setup_expires_at = NULL, updated_at = NOW()
      WHERE id = $2`,
    [hash, rows[0].id]
  );
  await transitAudit({
    companyId: rows[0].company_id,
    userId: rows[0].id,
    action: 'PASSWORD_SETUP_COMPLETED',
    entity: 'transit_user',
    entityId: rows[0].id,
    metadata: { via: 'transit_portal' },
  });
  res.json({ message: 'Password set. You can now sign in.' });
});

// ── Staff session: profile ──────────────────────────────────────────────
transitPortalRouter.get('/me', requireTransitSession, async (req: Request, res: Response) => {
  const session = req.transitSession!.session;
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.role, u.phone, u.email,
            u.status, u.created_at, c.id AS company_id, c.name AS company_name,
            c.currency, c.logo_url, c.customer_care, c.min_app_version
       FROM transit_users u
       JOIN transit_companies c ON c.id = u.company_id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [session.sub]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  const u = rows[0];
  res.json({
    user: {
      id: u.id,
      username: u.username,
      fullName: u.full_name,
      role: u.role,
      phone: u.phone || '',
      email: u.email || '',
      status: u.status,
      createdAt: u.created_at,
    },
    company: {
      id: u.company_id,
      name: u.company_name,
      currency: u.currency || 'USD',
      logoUrl: u.logo_url || '',
      customerCare: u.customer_care || '',
      minAppVersion: u.min_app_version || '',
    },
  });
});

transitPortalRouter.patch('/me', requireTransitSession, async (req: Request, res: Response) => {
  const session = req.transitSession!.session;
  const fullName = clean(req.body?.fullName);
  const phoneRaw = req.body?.phone;
  const emailRaw = clean(req.body?.email).toLowerCase();
  const updates: string[] = [];
  const params: any[] = [];

  if (fullName) {
    params.push(fullName.slice(0, 120));
    updates.push(`full_name = $${params.length}`);
  }
  if (typeof phoneRaw === 'string') {
    params.push(formatZimPhone(phoneRaw).slice(0, 32));
    updates.push(`phone = $${params.length}`);
  }
  if (typeof req.body?.email === 'string') {
    if (emailRaw && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw)) {
      res.status(422).json({ error: 'Enter a valid email address.' });
      return;
    }
    // The partial unique index is (company_id, lower(email)); check it here so
    // a clash returns a useful message instead of a 500 from Postgres.
    if (emailRaw) {
      const clash = await pool.query(
        `SELECT id FROM transit_users
          WHERE company_id = $1 AND lower(email) = $2
            AND id != $3 AND email != '' AND deleted_at IS NULL`,
        [session.companyId, emailRaw, session.sub]
      );
      if (clash.rows.length > 0) {
        res.status(409).json({ error: 'That email is already used by another staff member.' });
        return;
      }
    }
    params.push(emailRaw.slice(0, 200));
    updates.push(`email = $${params.length}`);
  }
  if (updates.length === 0) {
    res.status(422).json({ error: 'Provide at least one field to update.' });
    return;
  }

  params.push(session.sub);
  const { rows } = await pool.query(
    `UPDATE transit_users SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length} AND deleted_at IS NULL
      RETURNING id, username, full_name, role, phone, email`,
    params
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  const u = rows[0];
  res.json({
    user: {
      id: u.id,
      username: u.username,
      fullName: u.full_name,
      role: u.role,
      phone: u.phone || '',
      email: u.email || '',
    },
  });
});

transitPortalRouter.post('/me/change-password', requireTransitSession, async (req: Request, res: Response) => {
  const session = req.transitSession!.session;
  const currentPassword = String(req.body?.currentPassword ?? '');
  const newPassword = String(req.body?.newPassword ?? '');
  if (!currentPassword || !newPassword) {
    res.status(422).json({ error: 'Current and new passwords are required.' });
    return;
  }
  if (!STRONG_PASSWORD_RE.test(newPassword)) {
    res.status(422).json({
      error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character.',
    });
    return;
  }
  const { rows } = await pool.query(
    'SELECT id, password_hash FROM transit_users WHERE id = $1 AND deleted_at IS NULL',
    [session.sub]
  );
  if (rows.length === 0 || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
    res.status(403).json({ error: 'Current password is incorrect.' });
    return;
  }
  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query(
    `UPDATE transit_users SET password_hash = $1, password_setup_token = NULL,
            password_setup_expires_at = NULL, updated_at = NOW()
      WHERE id = $2`,
    [hash, session.sub]
  );
  await transitAudit({
    companyId: session.companyId,
    userId: session.sub,
    action: 'PASSWORD_CHANGED',
    entity: 'transit_user',
    entityId: session.sub,
    metadata: { via: 'transit_portal' },
  });
  res.json({ message: 'Password updated.' });
});

// ── Staff session: read-only operational views ──────────────────────────
transitPortalRouter.get('/devices', requireTransitSession, async (req: Request, res: Response) => {
  const session = req.transitSession!.session;
  const { rows } = await pool.query(
    `SELECT id, device_uuid, status, device_model, app_version, last_seen,
            offline_authorization_expires_at, min_app_version
       FROM transit_devices
      WHERE user_id = $1 AND company_id = $2
      ORDER BY registered_at DESC`,
    [session.sub, session.companyId]
  );
  res.json({
    devices: rows.map((d) => ({
      id: d.id,
      deviceUuid: d.device_uuid,
      status: d.status,
      model: d.device_model || '',
      appVersion: d.app_version || '',
      lastSeen: d.last_seen,
      offlineAuthorizationExpiresAt: d.offline_authorization_expires_at,
      minAppVersion: d.min_app_version || '',
    })),
  });
});

transitPortalRouter.get('/shifts', requireTransitSession, async (req: Request, res: Response) => {
  const session = req.transitSession!.session;
  const { rows } = await pool.query(
    `SELECT id, vehicle_reg, driver_name, conductor_name, status, ticket_count,
            total_cents, started_at, closed_at
       FROM transit_shifts
      WHERE user_id = $1 AND company_id = $2
      ORDER BY started_at DESC LIMIT 50`,
    [session.sub, session.companyId]
  );
  res.json({
    shifts: rows.map((s) => ({
      id: s.id,
      vehicleReg: s.vehicle_reg || '',
      driverName: s.driver_name || '',
      conductorName: s.conductor_name || '',
      status: s.status,
      ticketCount: s.ticket_count || 0,
      totalCents: s.total_cents || 0,
      startedAt: s.started_at,
      closedAt: s.closed_at,
    })),
  });
});

transitPortalRouter.get('/trips', requireTransitSession, async (req: Request, res: Response) => {
  const session = req.transitSession!.session;
  const { rows } = await pool.query(
    `SELECT id, trip_no, route_code, route_from, route_to, route_name, bus_reg,
            driver, status, total_seats, seats_sold, opened_at, closed_at
       FROM transit_trips
      WHERE user_id = $1 AND company_id = $2
      ORDER BY opened_at DESC LIMIT 50`,
    [session.sub, session.companyId]
  );
  res.json({
    trips: rows.map((t) => ({
      id: t.id,
      tripNo: t.trip_no,
      routeCode: t.route_code || '',
      routeFrom: t.route_from || '',
      routeTo: t.route_to || '',
      routeName: t.route_name || '',
      busReg: t.bus_reg || '',
      driver: t.driver || '',
      status: t.status,
      totalSeats: t.total_seats || 0,
      seatsSold: t.seats_sold || 0,
      openedAt: t.opened_at,
      closedAt: t.closed_at,
    })),
  });
});

transitPortalRouter.get('/sales', requireTransitSession, async (req: Request, res: Response) => {
  const session = req.transitSession!.session;
  const { rows } = await pool.query(
    `SELECT t.ticket_type, COUNT(*)::int AS count, COALESCE(SUM(t.total_cents), 0)::int AS cents
       FROM transit_tickets t
      WHERE t.user_id = $1 AND t.company_id = $2 AND t.status != 'CANCELLED'
      GROUP BY t.ticket_type`,
    [session.sub, session.companyId]
  );
  const byType: Record<string, { count: number; cents: number }> = {};
  let totalCount = 0;
  let totalCents = 0;
  for (const r of rows) {
    const key = r.ticket_type || 'busFare';
    byType[key] = { count: r.count, cents: r.cents };
    totalCount += r.count;
    totalCents += r.cents;
  }
  res.json({ summary: { totalCount, totalCents }, byType });
});

transitPortalRouter.get('/manifest/:tripNo', requireTransitSession, async (req: Request, res: Response) => {
  const session = req.transitSession!.session;
  const tripNo = clean(req.params.tripNo);
  if (!tripNo) {
    res.status(422).json({ error: 'Trip number is required.' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT t.tx_id, t.client_receipt_no, t.seat_number, t.customer_name,
            t.customer_mobile, t.total_cents, t.payment_method, t.ticket_type,
            t.sale_time, t.synced_at
       FROM transit_tickets t
       JOIN transit_trips tr ON tr.id = t.trip_id AND tr.company_id = t.company_id
      WHERE t.company_id = $1 AND tr.trip_no = $2
        AND (t.user_id = $3 OR tr.user_id = $3)
      ORDER BY t.synced_at ASC`,
    [session.companyId, tripNo, session.sub]
  );
  res.json({
    tripNo,
    tickets: rows.map((t) => ({
      txId: t.tx_id,
      receiptNo: t.client_receipt_no,
      seat: t.seat_number,
      passenger: t.customer_name || 'N/A',
      mobile: t.customer_mobile || '',
      totalCents: t.total_cents || 0,
      paymentMethod: t.payment_method || 'cash',
      ticketType: t.ticket_type || 'busFare',
      saleTime: t.sale_time || '',
      syncedAt: t.synced_at,
    })),
  });
});
