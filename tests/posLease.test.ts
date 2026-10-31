import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEASE_DAYS,
  MAX_LEASE_DAYS,
  fingerprintsMatch,
  hashFingerprint,
  isLeaseStale,
  leaseRemainingMs,
  mintOfflineLease,
  verifyOfflineLease,
} from '../src/services/posLease';

const claims = {
  did: 'TILL-001',
  cid: '11111111-1111-1111-1111-111111111111',
  sid: 4,
  fph: hashFingerprint('machine-fingerprint-a')!,
};

const now = new Date('2026-10-31T10:00:00Z');

describe('posLease — hardware binding', () => {
  it('hashes fingerprints deterministically and rejects empty input', () => {
    expect(hashFingerprint('machine-fingerprint-a')).toBe(hashFingerprint('machine-fingerprint-a'));
    expect(hashFingerprint('machine-fingerprint-a')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFingerprint('machine-fingerprint-b')).not.toBe(hashFingerprint('machine-fingerprint-a'));
    expect(hashFingerprint('')).toBeNull();
    expect(hashFingerprint(null)).toBeNull();
    expect(hashFingerprint('   ')).toBeNull();
  });

  it('compares digests in constant time and fails closed on a missing side', () => {
    const a = hashFingerprint('machine-fingerprint-a');
    expect(fingerprintsMatch(a, a)).toBe(true);
    expect(fingerprintsMatch(a, hashFingerprint('machine-fingerprint-b'))).toBe(false);
    expect(fingerprintsMatch(a, null)).toBe(false);
    expect(fingerprintsMatch(null, a)).toBe(false);
    expect(fingerprintsMatch(null, null)).toBe(false);
  });
});

describe('posLease — minting and verification', () => {
  it('mints a lease that verifies on the bound device', () => {
    const { lease, expiresAt, days } = mintOfflineLease(claims, { now });
    expect(days).toBe(DEFAULT_LEASE_DAYS);
    expect(new Date(expiresAt).getTime()).toBe(now.getTime() + DEFAULT_LEASE_DAYS * 86_400_000);

    const result = verifyOfflineLease(lease, { fingerprint: 'machine-fingerprint-a', deviceId: 'TILL-001', now });
    expect(result.valid).toBe(true);
    expect(result.claims?.did).toBe('TILL-001');
    expect(result.claims?.cid).toBe(claims.cid);
  });

  it('clamps the lease to 1..7 days', () => {
    expect(mintOfflineLease(claims, { now, days: 0 }).days).toBe(1);
    expect(mintOfflineLease(claims, { now, days: -5 }).days).toBe(1);
    expect(mintOfflineLease(claims, { now, days: 30 }).days).toBe(MAX_LEASE_DAYS);
  });

  it('rejects an expired lease', () => {
    const { lease } = mintOfflineLease(claims, { now, days: 1 });
    const later = new Date(now.getTime() + 2 * 86_400_000);
    expect(verifyOfflineLease(lease, { now: later })).toMatchObject({ valid: false, reason: 'expired' });
  });

  it('rejects a lease replayed on different hardware', () => {
    const { lease } = mintOfflineLease(claims, { now });
    expect(verifyOfflineLease(lease, { fingerprint: 'machine-fingerprint-b', now })).toMatchObject({
      valid: false,
      reason: 'fingerprint_mismatch',
    });
    expect(verifyOfflineLease(lease, { fingerprint: null, now }).valid).toBe(true);
  });

  it('rejects a lease presented for a different device id', () => {
    const { lease } = mintOfflineLease(claims, { now });
    expect(verifyOfflineLease(lease, { deviceId: 'TILL-999', now })).toMatchObject({
      valid: false,
      reason: 'device_mismatch',
    });
  });

  it('rejects malformed and tampered tokens', () => {
    expect(verifyOfflineLease(null)).toMatchObject({ valid: false, reason: 'malformed' });
    expect(verifyOfflineLease('not-a-lease')).toMatchObject({ valid: false, reason: 'malformed' });

    const { lease } = mintOfflineLease(claims, { now });
    const [body, signature] = lease.split('.');
    const tamperedBody = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyOfflineLease(`${tamperedBody}.${signature}`, { now })).toMatchObject({
      valid: false,
      reason: 'bad_signature',
    });
  });
});

describe('posLease — check-in windows', () => {
  it('reports remaining time and clamps lapsed leases to zero', () => {
    expect(leaseRemainingMs(null, now)).toBe(0);
    expect(leaseRemainingMs('not-a-date', now)).toBe(0);
    expect(leaseRemainingMs(new Date(now.getTime() + 60_000), now)).toBe(60_000);
    expect(leaseRemainingMs(new Date(now.getTime() - 60_000), now)).toBeLessThan(0);
  });

  it('treats a never-seen device as enrolled and an old check-in as stale', () => {
    expect(isLeaseStale(null, 7, now)).toBe(false);
    expect(isLeaseStale('not-a-date', 7, now)).toBe(false);
    expect(isLeaseStale(new Date(now.getTime() - 2 * 86_400_000), 7, now)).toBe(false);
    expect(isLeaseStale(new Date(now.getTime() - 8 * 86_400_000), 7, now)).toBe(true);
  });
});
