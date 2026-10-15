import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { FIELD_STAFF_ROLES, loadPermissions } from './rbac';
import { INACTIVITY_TIMEOUT_SEC, MAX_SESSION_LIFETIME_SEC } from '../sessionPolicy';

const JWT_SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';
let _jwtSecretWarned = false;
function getJwtSecret(): string {
  if (!_jwtSecretWarned && JWT_SECRET === 'preyone-jwt-secret-change-in-production') {
    console.warn('WARNING: JWT_SECRET is not set. Using insecure default. Set JWT_SECRET in .env for production.');
    _jwtSecretWarned = true;
  }
  return JWT_SECRET;
}

export { INACTIVITY_TIMEOUT_SEC, MAX_SESSION_LIFETIME_SEC };

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  fullName: string;
  /** Transit company for the Transit Operations realm; null (Level 0) sees all. */
  companyId?: string | null;
  /** Portal company for the POS/invoice/WiFi realm; null when unassigned. */
  portalCompanyId?: string | null;
  /** Effective permission codes resolved from role_permissions + user_permissions. */
  permissions?: string[];
}

/** Clock state resolved from the session during auth. */
export interface AdminSessionState {
  /** True when the inactivity window has lapsed (console must be unlocked). */
  locked: boolean;
  /** ISO stamp of the moment 2FA succeeded — the 10-hour absolute anchor. */
  authTime: string | null;
  /** ISO stamp of the last sliding refresh. */
  lastActivity: string | null;
  /** Per-device session row this token binds to; null for a pre-upgrade token
   *  that still resolves through the admin_users mirror columns. */
  sid: string | null;
}

declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminUser;
      adminSession?: AdminSessionState;
    }
  }
}

/** Response codes the SPAs branch on. */
export const SESSION_EXPIRED_CODE = 'SESSION_EXPIRED';
export const SESSION_LOCKED_CODE = 'SESSION_LOCKED';
export const SESSION_REVOKED_CODE = 'SESSION_REVOKED';

interface DecodedAdminToken extends AdminUser {
  sid?: string;
}

type SessionVerdict =
  | { state: 'ok' }
  | { state: 'locked'; session: AdminSessionState }
  | { state: 'expired'; session: AdminSessionState }
  | { state: 'revoked' }
  | { state: 'unknown-user' }
  | { state: 'field-staff' };

function policyBody() {
  return {
    sessionPolicy: {
      inactivityTimeoutSec: INACTIVITY_TIMEOUT_SEC,
      maxSessionLifetimeSec: MAX_SESSION_LIFETIME_SEC,
    },
  };
}

function decode(token: string): DecodedAdminToken {
  return jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as DecodedAdminToken;
}

function bearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

/**
 * Resolves the two session clocks from the per-device session row.
 *
 * Read-only: an API call must never slide `last_activity` on its own, or a
 * background poll would keep an abandoned console alive forever. Only the
 * explicit activity endpoints (POST /refresh, POST /unlock) advance the clock.
 *
 * Each bearer token binds to its own admin_user_sessions row (keyed by the JWT
 * `sid` claim), so a laptop and a phone hold independent sessions with
 * independent clocks: signing in on one no longer revokes the other, and each
 * device locks/expires on its own activity.
 *
 * Tokens minted before per-device sessions carry no row; they fall back to the
 * admin_users mirror columns and the original active_sid binding check, so a
 * deploy never has to sign anybody out mid-flight.
 */
async function resolveSessionState(
  decoded: DecodedAdminToken,
): Promise<{ verdict: SessionVerdict; session: AdminSessionState; role: string; companyId: string | null; portalCompanyId: string | null }> {
  const { rows } = await pool.query(
    `SELECT u.id, u.approved, u.role, u.company_id, u.portal_company_id,
            u.active_sid, u.last_activity, u.auth_time,
            s.sid           AS session_sid,
            s.auth_time     AS session_auth_time,
            s.last_activity AS session_last_activity
       FROM admin_users u
       LEFT JOIN admin_user_sessions s
         ON s.admin_user_id = u.id AND s.sid = $2
      WHERE u.id = $1`,
    [decoded.id, decoded.sid ?? null]
  );
  if (rows.length === 0 || !rows[0].approved) {
    return {
      verdict: { state: 'unknown-user' },
      session: { locked: false, authTime: null, lastActivity: null, sid: null },
      role: '',
      companyId: null,
      portalCompanyId: null,
    };
  }
  const row = rows[0];

  // A found session row IS the revocation record: /logout deletes it, so the
  // absence of a row (handled by the legacy branch below) is the revocation.
  const perDevice = row.session_sid != null;

  // Pre-upgrade token: no session row, so bind to the account mirror exactly
  // as the old one-session-per-account rule did. Logout rotates active_sid to
  // a sentinel no token can present, which kills every outstanding JWT even
  // though JWTs are stateless. NULL means the row has never signed in since
  // rotation shipped — grandfather those tokens so a deploy does not force a
  // platform-wide re-login.
  if (!perDevice && row.active_sid != null && row.active_sid !== decoded.sid) {
    return {
      verdict: { state: 'revoked' },
      session: { locked: false, authTime: null, lastActivity: null, sid: null },
      role: row.role,
      companyId: row.company_id ?? null,
      portalCompanyId: row.portal_company_id ?? null,
    };
  }

  const now = Date.now();
  const authTimeRaw = perDevice ? row.session_auth_time : row.auth_time;
  const lastActivityRaw = perDevice ? row.session_last_activity : row.last_activity;
  const authTime = authTimeRaw ? new Date(authTimeRaw) : null;
  const lastActivity = lastActivityRaw ? new Date(lastActivityRaw) : null;
  const session: AdminSessionState = {
    locked: false,
    sid: perDevice ? row.session_sid : null,
    authTime: authTime?.toISOString() ?? null,
    lastActivity: lastActivity?.toISOString() ?? null,
  };

  // State B (absolute expiry) outranks State A: past auth_time + 10h the
  // session is dead and must NOT be offered a password unlock.
  if (authTime && authTime.getTime() + MAX_SESSION_LIFETIME_SEC * 1000 <= now) {
    return { verdict: { state: 'expired', session }, session, role: row.role, companyId: row.company_id ?? null, portalCompanyId: row.portal_company_id ?? null };
  }

  if (lastActivity && lastActivity.getTime() + INACTIVITY_TIMEOUT_SEC * 1000 <= now) {
    session.locked = true;
    return { verdict: { state: 'locked', session }, session, role: row.role, companyId: row.company_id ?? null, portalCompanyId: row.portal_company_id ?? null };
  }

  if (FIELD_STAFF_ROLES.includes(row.role)) {
    return { verdict: { state: 'field-staff' }, session, role: row.role, companyId: row.company_id ?? null, portalCompanyId: row.portal_company_id ?? null };
  }

  return { verdict: { state: 'ok' }, session, role: row.role, companyId: row.company_id ?? null, portalCompanyId: row.portal_company_id ?? null };
}

function rejectLocked(res: Response, session: AdminSessionState): void {
  res.status(423).json({
    error: 'Session locked after inactivity. Enter your password to continue.',
    code: SESSION_LOCKED_CODE,
    session,
    ...policyBody(),
  });
}

function rejectExpired(res: Response, session?: AdminSessionState): void {
  res.status(401).json({
    error: 'Your session reached its maximum duration. Please sign in again.',
    code: SESSION_EXPIRED_CODE,
    session: session ?? null,
    ...policyBody(),
  });
}

async function runAuth(req: Request, res: Response, next: NextFunction, allowLocked: boolean): Promise<void> {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let decoded: DecodedAdminToken;
  try {
    decoded = decode(token);
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    throw err;
  }

  const { verdict, session, role, companyId, portalCompanyId } = await resolveSessionState(decoded);

  switch (verdict.state) {
    case 'unknown-user':
      res.status(401).json({ error: 'Account deactivated or removed' });
      return;
    case 'revoked':
      res.status(401).json({ error: 'Session revoked. Please sign in again.', code: SESSION_REVOKED_CODE });
      return;
    case 'expired':
      rejectExpired(res, session);
      return;
    case 'locked':
      if (!allowLocked) {
        rejectLocked(res, session);
        return;
      }
      break;
    case 'field-staff':
      res.status(403).json({ error: 'Field staff must use the Preyone Transit Mobile App.' });
      return;
    default:
      break;
  }

  req.adminSession = session;

  // Permissions (and the field-staff gate) are skipped for the locked path —
  // RBAC is irrelevant until the password is proven; /unlock only needs the id.
  if (allowLocked && session.locked) {
    req.adminUser = { ...decoded, role, companyId, portalCompanyId };
    next();
    return;
  }

  const permissions = await loadPermissions(role, decoded.id, companyId);
  req.adminUser = { ...decoded, role, companyId, portalCompanyId, permissions };
  next();
}

/**
 * Standard guard for every protected admin endpoint. Rejects inactivity-locked
 * sessions with 423 and absolutely-expired sessions with 401, so the console UI
 * cannot be bypassed by calling the API directly while locked.
 *
 * Async on purpose: callers (and the test suite) `await` this, so the promise
 * must not resolve before next() has fired.
 */
export const requireAdminAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await runAuth(req, res, next, false);
  } catch (err) {
    next(err);
  }
};

/**
 * Used ONLY by POST /unlock. Tolerates the locked state so the password can be
 * verified, but still rejects revoked (401 SESSION_REVOKED) and absolutely
 * expired (401 SESSION_EXPIRED) sessions — State B may never be unlocked.
 */
export const requireAdminAuthAllowLocked = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await runAuth(req, res, next, true);
  } catch (err) {
    next(err);
  }
};

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.adminUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!roles.includes(req.adminUser.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
