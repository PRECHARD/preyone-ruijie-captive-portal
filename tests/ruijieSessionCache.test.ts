import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Resilient live-session feed. Mirrors tests/ruijieRoster.test.ts: the shared
 * Postgres row is the cross-worker cache, so the assertions are all about
 * "did we touch upstream, and what did we serve when we couldn't".
 */

const poolQuery = vi.hoisted(() => vi.fn());
const cloud = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  cooldownRemaining: vi.fn(() => 0),
  isRateLimit: vi.fn((err: any) => Number(err?.code) === 44),
}));
const service = vi.hoisted(() => ({ listOnline: vi.fn() }));

vi.mock('../src/db/pool', () => ({
  pool: { query: poolQuery },
}));

vi.mock('../src/services/ruijieCloud', () => ({
  isRuijieCloudConfigured: cloud.isConfigured,
  ruijieReadCooldownMsRemaining: cloud.cooldownRemaining,
  isRateLimitError: cloud.isRateLimit,
}));

vi.mock('../src/services/ruijieService', () => ({
  listRuijieOnlineUsers: service.listOnline,
}));

import {
  getRuijieSessionSnapshot,
  isRuijieSessionBreakerOpen,
  SESSION_TTL_MS,
  __resetRuijieSessionCacheForTests,
} from '../src/services/ruijieSessionCache';

const USER = { mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.0.7', ssid: 'Preyone UltraNet' };

/** Stored row consumed by readSnapshot(). */
let storedRow: { payload: unknown; fetched_at: Date } | null = null;

beforeEach(() => {
  __resetRuijieSessionCacheForTests();
  storedRow = null;
  poolQuery.mockReset();
  poolQuery.mockImplementation(async (sql: string) => {
    if (/^\s*SELECT payload/i.test(sql)) return { rows: storedRow ? [storedRow] : [] };
    return { rows: [{ fetched_at: new Date() }] };
  });
  cloud.isConfigured.mockReturnValue(true);
  cloud.cooldownRemaining.mockReturnValue(0);
  cloud.isRateLimit.mockImplementation((err: any) => Number(err?.code) === 44);
  service.listOnline.mockReset();
  service.listOnline.mockResolvedValue([USER]);
});

const cacheWrites = () =>
  poolQuery.mock.calls.filter(([sql]) => /INSERT INTO ruijie_session_cache/i.test(String(sql)));

describe('getRuijieSessionSnapshot', () => {
  it('reports a degraded empty snapshot when Ruijie keys are missing', async () => {
    cloud.isConfigured.mockReturnValue(false);
    const snap = await getRuijieSessionSnapshot();

    expect(snap.users).toEqual([]);
    expect(snap.degraded).toBe(true);
    expect(snap.reason).toBe('ruijie_cloud_not_configured');
    expect(service.listOnline).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('serves a fresh snapshot without touching upstream', async () => {
    storedRow = { payload: [USER], fetched_at: new Date() };
    const snap = await getRuijieSessionSnapshot();

    expect(snap.users).toEqual([USER]);
    expect(snap.stale).toBe(false);
    expect(snap.degraded).toBe(false);
    expect(snap.ttlMs).toBe(SESSION_TTL_MS);
    expect(service.listOnline).not.toHaveBeenCalled();
  });

  it('pulls and persists when the snapshot is older than the TTL', async () => {
    storedRow = { payload: [{ mac: 'old' }], fetched_at: new Date(Date.now() - SESSION_TTL_MS - 1000) };
    const snap = await getRuijieSessionSnapshot();

    expect(snap.users).toEqual([USER]);
    expect(snap.stale).toBe(false);
    expect(service.listOnline).toHaveBeenCalledTimes(1);
    expect(cacheWrites()).toHaveLength(1);
  });

  it('bypasses a fresh snapshot when force is set', async () => {
    storedRow = { payload: [{ mac: 'old' }], fetched_at: new Date() };
    const snap = await getRuijieSessionSnapshot({ force: true });

    expect(service.listOnline).toHaveBeenCalledTimes(1);
    expect(snap.users).toEqual([USER]);
  });

  it('serves the last good snapshot marked stale when the refresh fails', async () => {
    const fetchedAt = new Date(Date.now() - SESSION_TTL_MS - 5000);
    storedRow = { payload: [USER], fetched_at: fetchedAt };
    service.listOnline.mockRejectedValue(new Error('socket hang up'));

    const snap = await getRuijieSessionSnapshot();

    expect(snap.users).toEqual([USER]);
    expect(snap.stale).toBe(true);
    expect(snap.degraded).toBe(false);
    expect(snap.reason).toBe('unavailable');
    expect(snap.fetchedAt?.getTime()).toBe(fetchedAt.getTime());
  });

  it('returns an empty degraded snapshot on a cold start with no cache', async () => {
    service.listOnline.mockRejectedValue(new Error('socket hang up'));
    const snap = await getRuijieSessionSnapshot();

    expect(snap.users).toEqual([]);
    expect(snap.fetchedAt).toBeNull();
    expect(snap.degraded).toBe(true);
    expect(snap.stale).toBe(false);
    expect(snap.reason).toBe('unavailable');
  });

  it('classifies a rate-limit failure as rate_limited and opens the breaker immediately', async () => {
    storedRow = { payload: [USER], fetched_at: new Date(Date.now() - SESSION_TTL_MS - 5000) };
    service.listOnline.mockRejectedValue(Object.assign(new Error('Too many requests'), { code: 44 }));

    const snap = await getRuijieSessionSnapshot();

    expect(snap.reason).toBe('rate_limited');
    expect(snap.breakerOpen).toBe(true);
    expect(isRuijieSessionBreakerOpen()).toBe(true);
  });

  it('stops calling upstream while the breaker is open', async () => {
    storedRow = { payload: [USER], fetched_at: new Date(Date.now() - SESSION_TTL_MS - 5000) };
    service.listOnline.mockRejectedValue(Object.assign(new Error('Too many requests'), { code: 44 }));

    await getRuijieSessionSnapshot();
    const snap = await getRuijieSessionSnapshot();

    expect(service.listOnline).toHaveBeenCalledTimes(1);
    expect(snap.breakerOpen).toBe(true);
    expect(snap.users).toEqual([USER]);
  });

  it('trips the breaker after three consecutive non-rate-limit failures', async () => {
    storedRow = { payload: [USER], fetched_at: new Date(Date.now() - SESSION_TTL_MS - 5000) };
    service.listOnline.mockRejectedValue(new Error('boom'));

    await getRuijieSessionSnapshot();
    expect(isRuijieSessionBreakerOpen()).toBe(false);
    await getRuijieSessionSnapshot();
    expect(isRuijieSessionBreakerOpen()).toBe(false);
    await getRuijieSessionSnapshot();
    expect(isRuijieSessionBreakerOpen()).toBe(true);
  });

  it('respects an upstream read cooldown even with the breaker closed', async () => {
    storedRow = { payload: [USER], fetched_at: new Date(Date.now() - SESSION_TTL_MS - 5000) };
    cloud.cooldownRemaining.mockReturnValue(30_000);

    const snap = await getRuijieSessionSnapshot();

    expect(service.listOnline).not.toHaveBeenCalled();
    expect(snap.stale).toBe(true);
    expect(snap.reason).toBe('rate_limited');
  });

  it('deduplicates concurrent cold-start refreshes into one upstream pull', async () => {
    const [a, b] = await Promise.all([getRuijieSessionSnapshot(), getRuijieSessionSnapshot()]);

    expect(service.listOnline).toHaveBeenCalledTimes(1);
    expect(a.users).toEqual(b.users);
  });

  it('keeps working from memory when the cache table is missing', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (/^\s*SELECT payload/i.test(sql)) throw new Error('relation "ruijie_session_cache" does not exist');
      throw new Error('relation "ruijie_session_cache" does not exist');
    });

    const first = await getRuijieSessionSnapshot();
    expect(first.users).toEqual([USER]);

    // Second call inside the TTL is answered from the in-memory mirror.
    const second = await getRuijieSessionSnapshot();
    expect(second.users).toEqual([USER]);
    expect(service.listOnline).toHaveBeenCalledTimes(1);
  });
});
