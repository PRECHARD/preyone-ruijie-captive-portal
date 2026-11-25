import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { PREYONE_COOKIE } from './ssoCookie';

/** Hash route that mounts StarlinkAdmin (overview, customers, applications, transactions, kits, plans). */
export const ADMIN_STARLINK_HASH = '/#/ultranet/starlink';
export const ADMIN_STARLINK_URL = 'https://admin.preyone.com/#/ultranet/starlink';

const MANAGE_ROLES = new Set(['Manager', 'CEO']);

/** Customer-portal paths. `/starlink-privacy.html` does not match. */
export function isStarlinkCustomerPath(pathname: string): boolean {
  return pathname === '/starlink' || pathname.startsWith('/starlink/');
}

function wantsCustomerView(req: Request): boolean {
  return req.query.view === 'customer';
}

/**
 * A real page load, not a script/image/font fetch.
 * Paths with a file extension are left alone so assets and the privacy page
 * are never rewritten.
 */
function isSpaDocument(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const dest = req.get('sec-fetch-dest');
  if (dest && dest !== 'document') return false;
  const leaf = req.path.split('/').pop() || '';
  if (leaf.includes('.')) return false;
  const accept = req.get('accept') || '';
  if (accept && !accept.includes('text/html') && !accept.includes('*/*')) return false;
  return true;
}

/** Manager/CEO admin session from the shared `.preyone.com` cookie. Other tokens are ignored. */
function adminManageRole(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  const token = cookies?.[PREYONE_COOKIE];
  if (typeof token !== 'string' || !token) return null;
  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production',
      { algorithms: ['HS256'] },
    ) as { role?: unknown; purpose?: unknown; type?: unknown };
    if (payload.purpose != null || payload.type != null) return null;
    return typeof payload.role === 'string' && MANAGE_ROLES.has(payload.role) ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * Send the admin Starlink management entry to the designed console dashboard.
 *
 * `admin.preyone.com/starlink/portal` (the old navbar link, and any bookmark)
 * used to boot the customer SPA, which rewrote the URL to `/starlink/portal`
 * and hid the management tabs. A signed-in Manager/CEO opening
 * `starlink.preyone.com` hit the same customer shell. `?view=customer` and
 * password-reset links stay on the customer portal.
 */
export function starlinkAdminRedirect(req: Request): string | null {
  if (!isSpaDocument(req) || wantsCustomerView(req)) return null;
  if (req.query.mode === 'reset' && req.query.token) return null;

  const host = req.hostname;
  if (host === 'admin.preyone.com' && isStarlinkCustomerPath(req.path)) {
    return ADMIN_STARLINK_HASH;
  }
  if (host === 'starlink.preyone.com' && adminManageRole(req)) {
    return ADMIN_STARLINK_URL;
  }
  return null;
}
