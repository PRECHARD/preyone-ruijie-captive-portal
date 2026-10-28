import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pool refill must degrade, never explode.
 *
 * Ruijie throttles the whole tenant (`{ code: 44, msg: "Too many requests" }`),
 * and the portal's promise is that a paying customer never sees that. The pool
 * holds pre-minted codes, so a throttled refill is simply a no-op: it reports
 * `degraded: true`, stops minting immediately and never throws into the worker
 * (which would be logged as a crash and, worse, could surface as a 5xx on a
 * sale that fell back to the pool).
 */

const { poolQuery, clientQuery, releaseMock } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  releaseMock: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({
  pool: {
    query: poolQuery,
    connect: vi.fn(async () => ({ query: clientQuery, release: releaseMock })),
  },
}));

vi.mock('../src/services/ruijieMint', () => ({
  isRuijieCloudConfigured: vi.fn(() => true),
  mintRuijieVoucherForTier: vi.fn(),
}));

import { pool } from '../src/db/pool';
import { isRuijieCloudConfigured, mintRuijieVoucherForTier } from '../src/services/ruijieMint';
import { RuijieApiError } from '../src/services/ruijieErrors';
import {
  __resetRuijieSyncForTests,
  noteRuijieSyncThrottle,
  RUIJIE_SYNC_BREAKER_THRESHOLD,
} from '../src/services/ruijieSync';
import {
  refillVoucherPool,
  syncVoucherPoolStock,
  VOUCHER_POOL_LOW_WATERMARK,
  VOUCHER_POOL_TARGET,
} from '../src/services/voucherPool';

const mintMock = vi.mocked(mintRuijieVoucherForTier);
const configuredMock = vi.mocked(isRuijieCloudConfigured);

interface StubOptions {
  /** Available stock reported for the only active tier. */
  available?: number;
}

function stubDb({ available = 0 }: StubOptions = {}) {
  clientQuery.mockImplementation(async (sql: string) => {
    const q = String(sql);
    if (q.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
    if (q.includes('pg_advisory_unlock')) return { rows: [], rowCount: 0 };
    if (q.includes('FROM voucher_profiles') && q.includes('ORDER BY vp.tier_name')) {
      return { rows: [{ tier_name: 'PreLite' }], rowCount: 1 };
    }
    if (q.includes('COUNT(*)::int')) return { rows: [{ count: available }], rowCount: 1 };
    if (q.includes('INSERT INTO ruijie_vouchers')) return { rows: [{ id: 'rv-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  poolQuery.mockImplementation(async (sql: string) => {
    const q = String(sql);
    if (q.includes('FROM voucher_profiles')) {
      return { rows: [{ tier_name: 'PreLite', available }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  configuredMock.mockReturnValue(true);
  __resetRuijieSyncForTests();
  stubDb();
});

describe('refillVoucherPool — throttle handling', () => {
  it('reports degraded instead of throwing when Ruijie answers code 44', async () => {
    mintMock.mockRejectedValueOnce(new RuijieApiError(44, 'Too many requests'));

    const result = await refillVoucherPool();

    expect(result.skipped).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.tiers).toHaveLength(1);
    expect(result.tiers[0]).toMatchObject({ tierName: 'PreLite', minted: 0, degraded: true });
    expect(result.tiers[0].errors[0]).toContain('Too many requests');
    // Stop hammering the tenant: one attempt, then give up for this tick.
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalled();
  });

  it('treats an HTTP 429 from the transport as a throttle too', async () => {
    mintMock.mockRejectedValueOnce(Object.assign(new Error('Request failed'), { response: { status: 429 } }));

    const result = await refillVoucherPool();

    expect(result.degraded).toBe(true);
    expect(result.tiers[0].degraded).toBe(true);
  });

  it('short-circuits without any outbound call while the breaker is open', async () => {
    for (let i = 0; i < RUIJIE_SYNC_BREAKER_THRESHOLD; i += 1) {
      noteRuijieSyncThrottle(new RuijieApiError(44, 'Too many requests'), Date.now());
    }

    const result = await refillVoucherPool();

    expect(result).toMatchObject({ skipped: true, degraded: true, locked: false, tiers: [] });
    expect(result.reason).toContain('circuit');
    expect(mintMock).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('is a no-op when Ruijie Cloud is not configured', async () => {
    configuredMock.mockReturnValueOnce(false);

    const result = await refillVoucherPool();

    expect(result).toMatchObject({ skipped: true, degraded: false, tiers: [] });
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('still mints normally when nothing is throttled', async () => {
    // One unit below target so the refill only needs a single mint — the pacing
    // queue would otherwise sleep 7s between each of the ten.
    stubDb({ available: VOUCHER_POOL_TARGET - 1 });
    mintMock.mockResolvedValue({
      codeNo: 'abc123',
      userGroupId: '9624342',
      profile: '30113648274480073538014045592098',
      expiryTime: null,
      comment: 'Pool PreLite',
    } as any);

    const result = await refillVoucherPool({ force: true });

    expect(result.degraded).toBe(false);
    expect(result.tiers[0].degraded).toBe(false);
    expect(result.tiers[0].minted).toBe(1);
    expect(mintMock).toHaveBeenCalledTimes(1);
  });
});

describe('syncVoucherPoolStock — only refill when stock is low', () => {
  it('does nothing while every tier is above its low watermark', async () => {
    stubDb({ available: VOUCHER_POOL_LOW_WATERMARK + 1 });

    const result = await syncVoucherPoolStock();

    expect(result.refillTriggered).toBe(false);
    expect(result.status.totalAvailable).toBe(VOUCHER_POOL_LOW_WATERMARK + 1);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('refills when a tier drops to the watermark', async () => {
    stubDb({ available: VOUCHER_POOL_LOW_WATERMARK });
    mintMock.mockRejectedValueOnce(new RuijieApiError(44, 'Too many requests'));

    const result = await syncVoucherPoolStock();

    expect(result.refillTriggered).toBe(true);
    expect(result.refill?.degraded).toBe(true);
    expect(pool.connect).toHaveBeenCalled();
  });

  it('does not attempt anything when Ruijie Cloud is not configured', async () => {
    configuredMock.mockReturnValue(false);

    const result = await syncVoucherPoolStock();

    expect(result.refillTriggered).toBe(false);
    expect(result.status.configured).toBe(false);
    expect(mintMock).not.toHaveBeenCalled();
  });
});
