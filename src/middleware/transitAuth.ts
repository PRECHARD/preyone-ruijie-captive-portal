import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { loadPermissions } from './rbac';

const JWT_SECRET = process.env.TRANSIT_JWT_SECRET || process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';
let _jwtSecretWarned = false;
export function getTransitJwtSecret(): string {
  if (!_jwtSecretWarned && JWT_SECRET === 'preyone-jwt-secret-change-in-production') {
    console.warn('WARNING: TRANSIT_JWT_SECRET is not set. Using insecure default. Set TRANSIT_JWT_SECRET in .env for production.');
    _jwtSecretWarned = true;
  }
  return JWT_SECRET;
}

export interface TransitUserRecord {
  id: string;
  companyId: string;
  username: string;
  fullName: string;
  role: string;
  permissions?: string[];
}

export interface TransitDeviceRecord {
  id: string;
  companyId: string;
  userId: string;
  deviceUuid: string;
  status: string;
}

declare global {
  namespace Express {
    interface Request {
      transitSession?: { session: { sub: string; companyId: string; role: string; username: string } };
      transit?: {
        user: TransitUserRecord;
        device: TransitDeviceRecord;
        minAppVersion: string;
      };
    }
  }
}

/** parse "<major>.<minor>.<patch>" and return comparable triple. */
function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec((v || '').trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionAtLeast(appVersion: string | undefined, minVersion: string): boolean {
  if (!minVersion) return true;
  if (!appVersion) return false;
  const a = parseVersion(appVersion);
  const b = parseVersion(minVersion);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

async function loadUserCompany(userId: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.company_id, u.username, u.full_name, u.role, u.status AS user_status,
            c.status AS company_status, c.min_app_version
     FROM transit_users u
     JOIN transit_companies c ON c.id = u.company_id
     WHERE u.id = $1 AND u.deleted_at IS NULL AND c.deleted_at IS NULL`,
    [userId]
  );
  return rows[0] || null;
}

/** Validates a Bearer JWT and re-loads the user + company from the DB (never trusts the token alone). */
export async function requireTransitSession(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const decoded = jwt.verify(auth.slice(7), getTransitJwtSecret(), { algorithms: ['HS256'] }) as any;
    if (!decoded || decoded.type !== 'session') {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    const user = await loadUserCompany(decoded.sub);
    if (!user || user.user_status !== 'ACTIVE') {
      res.status(401).json({ error: 'Account is disabled' });
      return;
    }
    if (user.company_status !== 'ACTIVE') {
      res.status(403).json({ error: 'Your organization is inactive. Contact your administrator.' });
      return;
    }
    req.transitSession = {
      session: {
        sub: user.id,
        companyId: user.company_id,
        role: user.role,
        username: user.username,
      },
    };
    next();
  } catch (err) {
    if ((err as Error).name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
      return;
    }
    res.status(401).json({ error: 'Invalid token' });
  }
}

/** Validates a device token and re-validates user/company/device/version from the DB on every request. */
export async function requireTransitDevice(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const decoded = jwt.verify(auth.slice(7), getTransitJwtSecret(), { algorithms: ['HS256'] }) as any;
    if (!decoded || decoded.type !== 'device') {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT d.id, d.company_id, d.user_id, d.device_uuid, d.status AS device_status,
              d.app_version, d.min_app_version,
              u.status AS user_status, u.role AS user_role, u.username AS user_username, u.full_name AS user_full_name,
              c.status AS company_status, c.min_app_version AS company_min_version
       FROM transit_devices d
       JOIN transit_users u ON u.id = d.user_id AND u.deleted_at IS NULL
       JOIN transit_companies c ON c.id = d.company_id AND c.deleted_at IS NULL
       WHERE d.id = $1`,
      [decoded.deviceId]
    );

    if (rows.length === 0) {
      res.status(401).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
      return;
    }
    const device = rows[0];

    if (device.device_status !== 'ACTIVE') {
      res.status(403).json({
        error: 'This device has been disabled. Please contact your administrator.',
        code: 'DEVICE_DISABLED',
      });
      return;
    }
    if (device.user_status !== 'ACTIVE') {
      res.status(403).json({ error: 'Your account has been disabled. Please contact your administrator.', code: 'USER_DISABLED' });
      return;
    }
    if (device.company_status !== 'ACTIVE') {
      res.status(403).json({ error: 'Your organization is inactive. Contact your administrator.', code: 'COMPANY_DISABLED' });
      return;
    }

    // App version control is server-driven, never hardcoded in the app.
    const appVersion = (req.headers['x-app-version'] as string) || device.app_version;
    const minVersion = device.min_app_version || device.company_min_version;
    if (!versionAtLeast(appVersion, minVersion)) {
      res.status(426).json({
        error: 'A newer version of the app is required. Please update before continuing.',
        code: 'APP_UPDATE_REQUIRED',
        minAppVersion: minVersion,
      });
      return;
    }

    const permissions = await loadPermissions(
      device.user_role,
      device.user_id,
      device.company_id,
    );
    req.transit = {
      user: {
        id: device.user_id,
        companyId: device.company_id,
        username: device.user_username,
        fullName: device.user_full_name,
        role: device.user_role,
        permissions,
      },
      device: {
        id: device.id,
        companyId: device.company_id,
        userId: device.user_id,
        deviceUuid: device.device_uuid,
        status: device.device_status,
      },
      minAppVersion: minVersion,
    };
    next();
  } catch (err) {
    if ((err as Error).name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
      return;
    }
    res.status(401).json({ error: 'Invalid token' });
  }
}

/** Role gate for device-authenticated requests. */
export function requireTransitRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.transit?.user.role;
    if (!role || !roles.includes(role)) {
      res.status(403).json({ error: 'You do not have permission to perform this action' });
      return;
    }
    next();
  };
}

export function compareVersions(appVersion: string, minVersion: string): boolean {
  return versionAtLeast(appVersion, minVersion);
}