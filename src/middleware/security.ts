import { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

/**
 * Central security hardening layer.
 *
 * Everything here is additive: `src/index.ts` mounts these middlewares in the
 * same positions the inline Helmet block used to occupy, so route behaviour is
 * unchanged. The Content-Security-Policy is reproduced byte-for-byte from the
 * previous inline config — in particular `formAction: ['*']`, which is what
 * lets the captive portal POST to the Ruijie gateway at 192.168.x.1:2060.
 * Changing it silently breaks internet access for every customer.
 */

// ── Content Security Policy ──────────────────────────────────────────────────
//
// DO NOT tighten `formAction`. The gateway ext_login is on a private LAN
// address that differs per deployment, so a host allow-list is impossible.
export const CONTENT_SECURITY_POLICY = {
  directives: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    formAction: ['*'],
    connectSrc: ["'self'", 'http://192.168.1.216:2060', 'http://192.168.100.1:2060'],
    upgradeInsecureRequests: null,
  },
} as const;

/** Helmet, configured exactly as the portal has always run it. */
export const helmetMiddleware: RequestHandler = helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // HSTS is emitted by `securityHeaders` below, which gates it on the request
  // actually arriving over HTTPS (the captive-portal LAN flows are plain HTTP).
  strictTransportSecurity: false,
  contentSecurityPolicy: CONTENT_SECURITY_POLICY as any,
});

/**
 * Explicit reinforcement of the transport/anti-sniff headers. Helmet already
 * sets these, but they are cheap and they guarantee the contract survives a
 * future helmet upgrade or a config typo (they are asserted by the test suite).
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(self), usb=()'
  );
  // HSTS only over HTTPS: sending it on plain HTTP is ignored by browsers and
  // would confuse the captive-portal flows that still serve HTTP on the LAN.
  if (_req.secure || String(_req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

// ── Input sanitisation ───────────────────────────────────────────────────────

/**
 * Keys whose values must be passed through untouched: trimming or rewriting a
 * password/hash/token/signature silently breaks authentication and payment
 * webhook verification.
 */
const OPAQUE_KEY = /(pass(word|phrase)?|secret|token|hash|signature|sign|pin|otp|authorization|cookie|jwt|key)$/i;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeString(value: string): string {
  // Strip NUL/control characters (log-injection and Postgres text-truncation
  // vectors) but keep newlines and tabs — voucher comments and messages use them.
  return value.replace(CONTROL_CHARS, '').trim();
}

function sanitizeInPlace(target: Record<string, unknown>, depth = 0): void {
  if (!target || typeof target !== 'object' || depth > 8) return;
  for (const key of Object.keys(target)) {
    // Prototype-pollution guards: drop the classic keys outright.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      delete target[key];
      continue;
    }
    const value = target[key];
    if (typeof value === 'string') {
      if (!OPAQUE_KEY.test(key)) target[key] = sanitizeString(value);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        if (typeof item === 'string') {
          if (!OPAQUE_KEY.test(key)) value[i] = sanitizeString(item);
        } else if (item && typeof item === 'object') {
          sanitizeInPlace(item as Record<string, unknown>, depth + 1);
        }
      }
    } else if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
      sanitizeInPlace(value as Record<string, unknown>, depth + 1);
    }
  }
}

/**
 * Recursively sanitises `req.body`, `req.query` and `req.params`.
 *
 * `req.query` is a getter in Express 4 and some patch versions re-parse on every
 * access, which would silently discard an in-place mutation. The sanitised
 * object is therefore cached back onto the request via `defineProperty`, so
 * every downstream consumer (WISPr/gateway handlers, express-validator, the
 * admin routes) sees the same cleaned values without any code change.
 */
export function sanitizeRequest(req: Request, _res: Response, next: NextFunction): void {
  if (isSanitizeExempt(requestPath(req))) {
    next();
    return;
  }
  try {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      sanitizeInPlace(req.body as Record<string, unknown>);
    }
    if (req.query && typeof req.query === 'object') {
      const query = req.query as unknown as Record<string, unknown>;
      sanitizeInPlace(query);
      // Pin the sanitised object so a re-parsing getter cannot undo the work.
      Object.defineProperty(req, 'query', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: query,
      });
    }
    if (req.params && typeof req.params === 'object') {
      sanitizeInPlace(req.params as unknown as Record<string, unknown>);
    }
  } catch {
    /* never let sanitisation take a request down */
  }
  next();
}

// ── Rate limiting ───────────────────────────────────────────────────────────

function intFromEnv(raw: string | undefined, fallback: number, min = 1): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.trunc(n);
}

/**
 * Paths that must never be throttled at the edge:
 *
 *   - captive-portal guest traffic: hundreds of phones share one gateway NAT IP,
 *     so an IP-keyed limiter would lock the whole hotspot out;
 *   - FreeRADIUS accounting/authorize bursts from the gateway;
 *   - payment-provider callbacks: a retry storm from Pesepay is legitimate and
 *     dropping one loses money;
 *   - the transit field app, whose devices also share a single NAT.
 */
const RATE_LIMIT_EXEMPT = [
  /^\/api\/auth\//,
  // Local captive-portal redemption: the same NAT-IP crowd as /api/auth, and
  // the route carries its own failure-only limiter.
  /^\/api\/portal\//,
  /^\/api\/radius\//,
  /^\/api\/payments\/webhook/,
  /^\/api\/payments\/pesepay\/(callback|webhook)/,
  /^\/api\/payments\/return/,
  /^\/api\/gateway\//,
  /^\/api\/health/,
  /^\/api\/v1\/transit\//,
];

/**
 * Payloads that must reach their handler byte-for-byte. Payment providers sign
 * and reference opaque values; trimming a string or stripping a control
 * character here could break a lookup or a signature check, so those bodies are
 * never rewritten.
 */
const SANITIZE_EXEMPT = [/^\/api\/payments\//, /^\/api\/radius\//, /^\/api\/gateway\//];

function isExempt(path: string): boolean {
  return RATE_LIMIT_EXEMPT.some((re) => re.test(path));
}

function isSanitizeExempt(path: string): boolean {
  return SANITIZE_EXEMPT.some((re) => re.test(path));
}

/** Request path without the query string (the limiters are mounted on prefixes). */
function requestPath(req: Request): string {
  const raw = String(req.originalUrl || req.url || '');
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

/**
 * Baseline limiter policy for every non-exempt API route. Generous enough for
 * the SPA and the POS terminals, tight enough to stop a single host hammering
 * the API. Exported so tests can exercise the real policy at a tiny ceiling
 * instead of firing thousands of requests at the production budget.
 */
export const API_RATE_LIMIT_OPTIONS = {
  windowMs: 60 * 1000,
  max: intFromEnv(process.env.API_RATE_LIMIT_PER_MIN, 1000, 60),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => isExempt(requestPath(req)),
  message: { error: 'Too many requests. Please slow down and retry.', retryable: true },
} as const;

export const apiRateLimit: RequestHandler = rateLimit(API_RATE_LIMIT_OPTIONS as any);

/**
 * Stricter ceiling for the authenticated admin/v1 surfaces. Keyed by admin id
 * once the token has been decoded, otherwise by IP, so one runaway tab cannot
 * exhaust the budget for the whole company.
 */
export const ADMIN_RATE_LIMIT_OPTIONS = {
  windowMs: 60 * 1000,
  max: intFromEnv(process.env.ADMIN_RATE_LIMIT_PER_MIN, 600, 60),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => `admin:${req.adminUser?.id || req.ip}`,
  message: { error: 'Too many admin requests. Please wait a moment.', retryable: true },
} as const;

export const adminApiRateLimit: RequestHandler = rateLimit(ADMIN_RATE_LIMIT_OPTIONS as any);

export const SECURITY_MIDDLEWARE = {
  helmetMiddleware,
  securityHeaders,
  sanitizeRequest,
  apiRateLimit,
  adminApiRateLimit,
};
