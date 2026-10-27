import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Outbound Ruijie quota guard.
 *
 * Ruijie caps the tenant at ~20 calls/min and 5,000/day. The portal must never
 * exceed 15/min and must degrade to a cached/degraded answer instead of a 5xx
 * when its own guard refuses a call.
 */

const poolQuery = vi.hoisted(() => vi.fn());

vi.mock('../src/db/pool', () => ({
  pool: { query: poolQuery },
}));

import {
  attachRuijieQuotaGuard,
  DAY_LIMIT,
  MINUTE_LIMIT,
  reserveRuijieCall,
  ruijieQuotaStatus,
  __resetRuijieQuotaForTests,
  __testing,
} from '../src/services/ruijieRateLimiter';
import { RuijieApiError, isRateLimitError } from '../src/services/ruijieErrors';

beforeEach(() => {
  poolQuery.mockReset();
  __resetRuijieQuotaForTests();
});

describe('quota limits', () => {
  it('stays safely below the Ruijie tenant ceiling', () => {
    expect(MINUTE_LIMIT).toBeLessThan(20);
    expect(MINUTE_LIMIT).toBe(15);
    expect(DAY_LIMIT).toBeLessThanOrEqual(5000);
  });

  it('divides the budget for the per-worker in-memory fallback', () => {
    expect(__testing.FALLBACK_MINUTE_LIMIT).toBeGreaterThanOrEqual(1);
    expect(__testing.FALLBACK_MINUTE_LIMIT).toBeLessThanOrEqual(MINUTE_LIMIT);
    expect(__testing.FALLBACK_MINUTE_LIMIT * __testing.WORKER_COUNT).toBeLessThanOrEqual(MINUTE_LIMIT);
  });
});

describe('reserveRuijieCall - database path (cluster wide)', () => {
  it('counts a granted call and reports the shared counters', async () => {
    poolQuery.mockResolvedValue({ rows: [{ minute_count: 4, day_count: 120 }] });

    const reservation = await reserveRuijieCall();

    expect(reservation).toMatchObject({
      allowed: true,
      source: 'db',
      minuteCount: 4,
      minuteLimit: MINUTE_LIMIT,
      dayCount: 120,
      dayLimit: DAY_LIMIT,
    });
    expect(poolQuery).toHaveBeenCalledTimes(1);
    // The atomic UPSERT carries the ceilings as parameters - never interpolated.
    expect(poolQuery.mock.calls[0][1]).toEqual([MINUTE_LIMIT, DAY_LIMIT]);
  });

  it('refuses with the Ruijie throttling error when the UPSERT returns no row', async () => {
    // No row => the WHERE clause refused the increment (window exhausted).
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ minute_count: 15, day_count: 400, minute_reset_at: null, day_reset_at: null }] });

    const err = await reserveRuijieCall().catch((e) => e);

    expect(err).toBeInstanceOf(RuijieApiError);
    expect(isRateLimitError(err)).toBe(true);
    expect((err as RuijieApiError).code).toBe(44);
  });

  it('never leaks an infrastructure failure as a 5xx - falls back to memory', async () => {
    poolQuery.mockRejectedValue(new Error('relation "ruijie_api_quota" does not exist'));

    const reservation = await reserveRuijieCall();

    expect(reservation.source).toBe('memory');
    expect(reservation.allowed).toBe(true);
  });
});

describe('reserveRuijieCall - in-memory fallback', () => {
  it('caps a single worker at its share of the ceiling', async () => {
    poolQuery.mockRejectedValue(new Error('db down'));

    for (let i = 0; i < __testing.FALLBACK_MINUTE_LIMIT; i += 1) {
      await expect(reserveRuijieCall()).resolves.toMatchObject({ source: 'memory' });
    }

    const err = await reserveRuijieCall().catch((e) => e);
    expect(err).toBeInstanceOf(RuijieApiError);
    expect(isRateLimitError(err)).toBe(true);
  });
});

describe('ruijieQuotaStatus', () => {
  it('reports the database counters without reserving a call', async () => {
    poolQuery.mockResolvedValue({
      rows: [{
        minute_count: 3,
        day_count: 42,
        minute_reset_at: new Date('2026-10-27T10:01:00.000Z'),
        day_reset_at: new Date('2026-10-28T00:00:00.000Z'),
      }],
    });

    const status = await ruijieQuotaStatus();

    expect(status).toMatchObject({ source: 'db', minuteCount: 3, dayCount: 42, exhausted: false });
    expect(status.minuteResetAt?.toISOString()).toBe('2026-10-27T10:01:00.000Z');
    // One read-only SELECT, no UPSERT.
    expect(String(poolQuery.mock.calls[0][0])).toMatch(/SELECT/i);
    expect(String(poolQuery.mock.calls[0][0])).not.toMatch(/UPDATE/i);
  });

  it('never throws when the table is missing', async () => {
    poolQuery.mockRejectedValue(new Error('missing'));

    await expect(ruijieQuotaStatus()).resolves.toMatchObject({ source: 'memory', exhausted: false });
  });
});

describe('attachRuijieQuotaGuard', () => {
  function fakeInstance() {
    const handler = { fn: null as null | ((config: any) => Promise<any>) };
    const instance = {
      interceptors: {
        request: {
          use: vi.fn((fn: (config: any) => Promise<any>) => {
            handler.fn = fn;
          }),
        },
      },
    };
    return { instance, handler };
  }

  it('reserves a slot before every outbound request', async () => {
    poolQuery.mockResolvedValue({ rows: [{ minute_count: 1, day_count: 1 }] });
    const { instance, handler } = fakeInstance();

    attachRuijieQuotaGuard(instance as any);
    expect(instance.interceptors.request.use).toHaveBeenCalledTimes(1);
    expect(handler.fn).toBeTypeOf('function');

    const config = { url: '/service/api/open/auth/voucher/create' };
    await expect(handler.fn!(config)).resolves.toBe(config);
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects the request (instead of sending it) when the quota is exhausted', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ minute_count: 15, day_count: 400 }] });
    const { instance, handler } = fakeInstance();
    attachRuijieQuotaGuard(instance as any);

    const err = await handler.fn!({ url: '/service/api/intl/usergroup/list' }).catch((e) => e);
    expect(isRateLimitError(err)).toBe(true);
  });

  it('is a no-op on partial axios stubs (unit-test doubles)', () => {
    const stub = { get: vi.fn(), post: vi.fn() };
    expect(() => attachRuijieQuotaGuard(stub as any)).not.toThrow();
    expect(attachRuijieQuotaGuard(stub as any)).toBe(stub);
  });
});
