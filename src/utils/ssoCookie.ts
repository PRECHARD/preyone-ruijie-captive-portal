import { Request, Response } from 'express';

/**
 * Cross-subdomain SSO via a single wildcard HTTP-Only cookie.
 * The cookie name is shared by every Preyone app so that a login on any
 * subdomain inherits the session on the others (cookie-scoped to `.preyone.com`).
 */
export const PREYONE_COOKIE = 'preyone_token';
export const SSO_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const isProduction = process.env.NODE_ENV === 'production';

/** Hosts that may present the admin SSO cookie. The public site and the Wi-Fi portal are not included. */
const TRUSTED_APP_HOSTS = new Set([
  'admin.preyone.com',
  'starlink.preyone.com',
  'pos.preyone.com',
  'invoice.preyone.com',
  'invoices.preyone.com',
  'app.preyone.com',
]);

export function isTrustedAppHost(hostHeader: string | undefined | null): boolean {
  const host = String(hostHeader || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
  if (host === 'localhost' || host === '127.0.0.1') return true;
  return TRUSTED_APP_HOSTS.has(host);
}

/** Cookie auth is limited to the app hosts. A browser Origin from anywhere else is refused. */
export function cookieAuthAllowed(req: Request): boolean {
  const host = req.hostname || req.headers.host;
  if (!isTrustedAppHost(host)) return false;
  const origin = req.get?.('origin') || (typeof req.headers.origin === 'string' ? req.headers.origin : undefined);
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !local) return false;
    return isTrustedAppHost(url.hostname);
  } catch {
    return false;
  }
}

export function setPreyoneCookie(res: Response, token: string): void {
  res.cookie(PREYONE_COOKIE, token, {
    domain: isProduction ? '.preyone.com' : undefined,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: SSO_COOKIE_MAX_AGE_MS,
  });
}

/**
 * Resolves the session token — Authorization Bearer takes precedence, falling
 * back to the wildcard SSO cookie. Used by shared session endpoints so SPAs can
 * inherit a logged-in state without ever touching the httpOnly cookie.
 */
export function resolveAuthToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || undefined;
  if (!cookieAuthAllowed(req)) return undefined;
  const cookie = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[PREYONE_COOKIE];
  return typeof cookie === 'string' && cookie ? cookie : undefined;
}

/** Clears the wildcard SSO cookie (logout). */
export function clearPreyoneCookie(res: Response): void {
  res.clearCookie(PREYONE_COOKIE, {
    domain: isProduction ? '.preyone.com' : undefined,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
}