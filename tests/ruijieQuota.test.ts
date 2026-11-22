import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../src/db/pool', () => ({
  pool: { query: mockQuery },
}));

import {
  reserveRuijieCall,
  ruijieQuotaStatus,
  BACKGROUND_MINUTE_LIMIT,
  DAY_LIMIT,
  MINUTE_LIMIT,
  __resetRuijieQuotaForTests,
  __testing,
} from '../src/services/ruijieRateLimiter';

/**
 * The atomic half of the quota split: a background call must pass a lower
 * minute ceiling into the same UPSERT, so four workers ticking together still
 * cannot spend the reserve a sale needs.
 */
describe('ruijie quota guard — background reserve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRuijieQuotaForTests();
  });

  it('reserves background work below the interactive minute ceiling', async () => {
    mockQuery.mockResolvedValue({ rows: [{ minute_count: 4, day_count: 20 }] });

    const r = await reserveRuijieCall({ background: true });

    expect(mockQuery.mock.calls[0][1]).toEqual([BACKGROUND_MINUTE_LIMIT, DAY_LIMIT]);
    expect(r.minuteLimit).toBe(BACKGROUND_MINUTE_LIMIT);
    expect(r.minuteLimit).toBeLessThan(MINUTE_LIMIT);
    expect(r.minuteCount).toBe(4);
  });

  it('lets interactive work use the full minute budget', async () => {
    mockQuery.mockResolvedValue({ rows: [{ minute_count: 12, day_count: 20 }] });

    const r = await reserveRuijieCall();

    expect(mockQuery.mock.calls[0][1]).toEqual([MINUTE_LIMIT, DAY_LIMIT]);
    expect(r.minuteLimit).toBe(MINUTE_LIMIT);
  });

  it('refuses a background call once the reserve is reached', async () => {
    // First query: the UPSERT refuses to increment. Second: status snapshot.
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          minute_count: BACKGROUND_MINUTE_LIMIT,
          day_count: 20,
          minute_reset_at: null,
          day_reset_at: null,
        }],
      });

    await expect(reserveRuijieCall({ background: true })).rejects.toThrow(/Too many requests/);
  });

  it('keeps a per-worker share when the quota table is unavailable', async () => {
    mockQuery.mockRejectedValue(new Error('quota table down'));

    const r = await reserveRuijieCall({ background: true });

    expect(r.source).toBe('memory');
    expect(r.minuteLimit).toBeGreaterThanOrEqual(1);
    expect(r.minuteLimit).toBeLessThanOrEqual(__testing.FALLBACK_MINUTE_LIMIT);
  });

  it('falls back to memory for interactive work when the table is unavailable', async () => {
    mockQuery.mockRejectedValue(new Error('quota table down'));

    const r = await reserveRuijieCall();

    expect(r.source).toBe('memory');
    expect(r.minuteLimit).toBe(__testing.FALLBACK_MINUTE_LIMIT);
  });

  it('reports a status snapshot without throwing', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ minute_count: 3, day_count: 11, minute_reset_at: null, day_reset_at: null }],
    });

    const s = await ruijieQuotaStatus();
    expect(s).toMatchObject({ minuteCount: 3, dayCount: 11, source: 'db', exhausted: false });
  });
});
