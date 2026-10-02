import { Request, Response } from 'express';

/**
 * Cross-subdomain SSO via a single wildcard HTTP-Only cookie.
 * The cookie name is shared by every Preyone app so that a login on any
 * subdomain inherits the session on the others (cookie-scoped to `.preyone.com`).
 */
export const PREYONE_COOKIE = 'preyone_token';
export const SSO_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const isProduction = process.env.NODE_ENV === 'production';

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