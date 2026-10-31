import crypto from 'crypto';

/**
 * Hardware-bound POS device leases.
 *
 * A till token alone is a bearer credential: copy it off a tablet and it works
 * from anywhere. This module adds the two missing properties:
 *
 *   1. BINDING — the token row stores SHA-256(fingerprint) collected at
 *      enrolment, and every authenticated call must present the same
 *      fingerprint. A stolen token on different hardware fails closed.
 *
 *   2. OFFLINE LEASE — a short-lived, signed lease lets a till keep selling
 *      while the WAN is down. The lease is a compact JWS-style
 *      `base64url(payload).base64url(hmac)` token, verified locally with the
 *      shared secret, so offline checks need no database round-trip.
 *
 * Secrets: POS_LEASE_SECRET falls back to JWT_SECRET. A separate secret lets
 * operators rotate leases without invalidating staff sessions.
 */

export const DEFAULT_LEASE_DAYS = 7;
export const MAX_LEASE_DAYS = 7;

export interface DeviceLeaseClaims {
  /** Schema version — bump when the claim shape changes. */
  v: 1;
  /** pos_devices.device_id (hardware serial). */
  did: string;
  /** companies.id this device belongs to, or null when unassigned. */
  cid: string | null;
  /** shop/till number inside the company. */
  sid: number | null;
  /** Fingerprint hash, so a lease is useless on other hardware. */
  fph: string;
  /** Issued-at / expires-at, seconds since epoch. */
  iat: number;
  exp: number;
  /** Random id, useful for revocation lists in future. */
  jti: string;
}

export interface LeaseVerification {
  valid: boolean;
  claims?: DeviceLeaseClaims;
  reason?:
    | 'malformed'
    | 'bad_signature'
    | 'expired'
    | 'fingerprint_mismatch'
    | 'device_mismatch';
}

function leaseSecret(): string {
  return process.env.POS_LEASE_SECRET || process.env.JWT_SECRET || 'preyone-pos-lease-dev-only';
}

/** SHA-256 of a fingerprint, hex encoded. Empty/unusable input → null. */
export function hashFingerprint(fingerprint: string | null | undefined): string | null {
  const value = String(fingerprint ?? '').trim();
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function fingerprintsMatch(expected: string | null, actual: string | null): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(signingInput: string): string {
  return crypto.createHmac('sha256', leaseSecret()).update(signingInput).digest('base64url');
}

/**
 * Mint an offline lease. Defaults to 7 days and is hard-capped at 7 — a longer
 * cut-off would let a revoked device keep selling for weeks.
 */
export function mintOfflineLease(
  claims: Omit<DeviceLeaseClaims, 'v' | 'iat' | 'exp' | 'jti'>,
  options: { days?: number; now?: Date } = {}
): { lease: string; expiresAt: string; days: number } {
  const days = Math.min(MAX_LEASE_DAYS, Math.max(1, Math.floor(options.days ?? DEFAULT_LEASE_DAYS)));
  const now = options.now ?? new Date();
  const exp = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const payload: DeviceLeaseClaims = {
    v: 1,
    ...claims,
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(exp.getTime() / 1000),
    jti: crypto.randomBytes(9).toString('base64url'),
  };
  const body = base64url(JSON.stringify(payload));
  return { lease: `${body}.${sign(body)}`, expiresAt: exp.toISOString(), days };
}

/**
 * Verify a lease token. `fingerprint` is optional; when supplied it must match
 * the bound hash, which is what stops a lease file being copied to another
 * machine. Returns a reason on failure so the caller can answer precisely.
 */
export function verifyOfflineLease(
  lease: string | null | undefined,
  options: { fingerprint?: string | null; deviceId?: string; now?: Date } = {}
): LeaseVerification {
  if (!lease || typeof lease !== 'string') return { valid: false, reason: 'malformed' };
  const [body, signature, extra] = lease.split('.');
  if (!body || !signature || extra) return { valid: false, reason: 'malformed' };

  const expected = sign(body);
  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let claims: DeviceLeaseClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DeviceLeaseClaims;
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!claims || claims.v !== 1 || typeof claims.exp !== 'number') {
    return { valid: false, reason: 'malformed' };
  }

  const now = options.now ?? new Date();
  if (claims.exp * 1000 <= now.getTime()) return { valid: false, reason: 'expired', claims };

  if (options.deviceId && claims.did !== options.deviceId) {
    return { valid: false, reason: 'device_mismatch', claims };
  }
  if (options.fingerprint) {
    const actual = hashFingerprint(options.fingerprint);
    if (!fingerprintsMatch(claims.fph, actual)) {
      return { valid: false, reason: 'fingerprint_mismatch', claims };
    }
  }

  return { valid: true, claims };
}

/** Milliseconds until a lease expires (negative when already expired). */
export function leaseRemainingMs(expiresAt: string | Date | null | undefined, now = new Date()): number {
  if (!expiresAt) return 0;
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return 0;
  return at.getTime() - now.getTime();
}

/** True when the device has not checked in inside its lease window. */
export function isLeaseStale(
  lastSeenAt: string | Date | null | undefined,
  leaseDays: number | null | undefined,
  now = new Date()
): boolean {
  const days = Math.min(MAX_LEASE_DAYS * 4, Math.max(1, Number(leaseDays) || DEFAULT_LEASE_DAYS));
  if (!lastSeenAt) return false; // never checked in yet — enrolment grace
  const at = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  if (Number.isNaN(at.getTime())) return false;
  return now.getTime() - at.getTime() > days * 24 * 60 * 60 * 1000;
}
