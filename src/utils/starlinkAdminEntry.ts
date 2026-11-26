import { Request } from 'express';

/** Hash route that mounts StarlinkAdmin (overview, customers, applications, transactions, kits, plans). */
export const ADMIN_STARLINK_HASH = '/#/ultranet/starlink';

/** Customer-portal paths. `/starlink-privacy.html` does not match. */
export function isStarlinkCustomerPath(pathname: string): boolean {
  return pathname === '/starlink' || pathname.startsWith('/starlink/');
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

/**
 * Keep the admin console's Starlink entry on the management dashboard.
 *
 * `admin.preyone.com/starlink/portal` (the old navbar link, and any bookmark)
 * used to boot the customer SPA, which rewrote the URL to `/starlink/portal`
 * and hid the management tabs.
 *
 * starlink.preyone.com is deliberately NOT touched: it must always serve the
 * original Starlink customer portal regardless of any admin session cookie.
 */
export function starlinkAdminRedirect(req: Request): string | null {
  if (!isSpaDocument(req)) return null;
  if (req.hostname === 'admin.preyone.com' && isStarlinkCustomerPath(req.path)) {
    return ADMIN_STARLINK_HASH;
  }
  return null;
}
