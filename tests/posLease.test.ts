import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_LEASE_DAYS,
  MAX_LEASE_DAYS,
  hashFingerprint,
  fingerprintsMatch,
  mintOfflineLease,
  verifyOfflineLease,
  leaseRemainingMs,
  isLeaseStale,
} from '../src/services/posLease';

const FINGERPRINT = 'cpu:ABC123|motherboard:ZZ9|disk:SN-77';

describe('hardware fingerprint binding', () => {
  it('hashes a fingerprint deterministically with SHA-256', () => {
    const digest = hashFingerprint(FINGERPRINT);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFingerprint(FINGERPRINT)).toBe(digest);
  });

  it('returns null for an empty or whitespace fingerprint', () => {
    expect(hashFingerprint('')).toBeNull();
    expect(hashFingerprint('   ')).toBeNull();
    expect(hashFingerprint(null)).toBeNull();
    expect(hashFingerprint(undefined)).toBeNull();
  });

  it('compares digests without throwing on length mismatch', () => {
    const digest = hashFingerprint(FINGERPRINT)!;
    expect(fingerprintsMatch(digest, digest)).toBe(true);
    expect(fingerprintsMatch(digest, digest.slice(0, -1))).toBe(false);
    expect(fingerprintsMatch(digest, hashFingerprint('other hardware'))).toBe(false);
    expect(fingerprintsMatch(null, digest)).toBe(false);
    expect(fingerprintsMatch(digest, null)).toBe(false);
  });
});

describe('offline lease minting', () => {
  beforeEach(() => {
    delete process.env.POS_LEASE_SECRET;
  });

  const claims = () => ({
    did: 'TILL-0001',
    cid: 'company-1',
    sid: 2,
    fph: hashFingerprint(FINGERPRINT)!,
  });

  it('defaults to a 7-day window', () => {
    const minted = mintOfflineLease(claims());
    expect(minted.days).toBe(DEFAULT_LEASE_DAYS);
    const remaining = leaseRemainingMs(minted.expiresAt);
    expect(remaining).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000);
  });

  it('hard-caps a requested window at 7 days', () => {
    expect(mintOfflineLease(claims(), { days: 90 }).days).toBe(MAX_LEASE_DAYS);
    expect(mintOfflineLease(claims(), { days: 0 }).days).toBe(1);
  });

  it('produces a compact two-part token with no JWT header segment', () => {
    const { lease } = mintOfflineLease(claims());
    const parts = lease.split('.');
    // Two segments, not three: there is no unsigned `alg` header to swap.
    expect(parts).toHaveLength(2);
    expect(parts[1]).toHaveLength(43); // base64url of a 32-byte HMAC
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    expect(payload.v).toBe(1);
    expect(payload.did).toBe('TILL-0001');
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });
});

describe('offline lease verification', () => {
  const claims = () => ({
    did: 'TILL-0001',
    cid: 'company-1',
    sid: 2,
    fph: hashFingerprint(FINGERPRINT)!,
  });

  it('accepts a freshly minted lease on the bound hardware', () => {
    const { lease } = mintOfflineLease(claims(), { days: 3 });
    const result = verifyOfflineLease(lease, { fingerprint: FINGERPRINT, deviceId: 'TILL-0001' });
    expect(result.valid).toBe(true);
    expect(result.claims?.did).toBe('TILL-0001');
    expect(result.claims?.cid).toBe('company-1');
  });

  it('rejects an expired lease', () => {
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const { lease } = mintOfflineLease(claims(), { days: 2, now: past });
    expect(verifyOfflineLease(lease).reason).toBe('expired');
  });

  it('rejects a tampered signature', () => {
    const { lease } = mintOfflineLease(claims());
    const [body, signature] = lease.split('.');
    const tampered = `${body}.${signature.slice(0, -1)}${signature.endsWith('a') ? 'b' : 'a'}`;
    expect(verifyOfflineLease(tampered).reason).toBe('bad_signature');
  });

  it('rejects a lease copied onto different hardware', () => {
    const { lease } = mintOfflineLease(claims());
    expect(verifyOfflineLease(lease, { fingerprint: 'different pc' }).reason).toBe('fingerprint_mismatch');
  });

  it('rejects a lease presented for another device id', () => {
    const { lease } = mintOfflineLease(claims());
    expect(verifyOfflineLease(lease, { deviceId: 'TILL-9999' }).reason).toBe('device_mismatch');
  });

  it('rejects malformed input without throwing', () => {
    expect(verifyOfflineLease('not-a-lease').reason).toBe('malformed');
    expect(verifyOfflineLease('').reason).toBe('malformed');
    expect(verifyOfflineLease(null).reason).toBe('malformed');
    expect(verifyOfflineLease('a.b.c').reason).toBe('malformed');
  });

  it('detects a legacy replay after the secret rotates', () => {
    const { lease } = mintOfflineLease(claims());
    process.env.POS_LEASE_SECRET = 'rotated-secret';
    try {
      expect(verifyOfflineLease(lease).reason).toBe('bad_signature');
    } finally {
      delete process.env.POS_LEASE_SECRET;
    }
  });
});

describe('lease staleness helpers', () => {
  it('treats a device that never checked in as fresh (enrolment grace)', () => {
    expect(isLeaseStale(null, 7)).toBe(false);
  });

  it('flags a check-in older than the lease window', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(isLeaseStale(eightDaysAgo, 7)).toBe(true);
  });

  it('keeps a recent check-in valid even on the 7-day default', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(isLeaseStale(twoDaysAgo, 7)).toBe(false);
  });

  it('reports remaining milliseconds and zero for missing dates', () => {
    expect(leaseRemainingMs(null)).toBe(0);
    expect(leaseRemainingMs('not-a-date')).toBe(0);
    expect(leaseRemainingMs(new Date(Date.now() - 1000))).toBeLessThan(0);
    expect(leaseRemainingMs(new Date(Date.now() + 60_000))).toBeGreaterThan(50_000);
  });
});
