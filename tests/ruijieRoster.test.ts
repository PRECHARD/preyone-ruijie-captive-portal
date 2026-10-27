import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ rows: [] as any[] }));
const cloud = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  getAll: vi.fn(),
}));

const poolQuery = vi.hoisted(() => vi.fn());

vi.mock('../src/db/pool', () => ({
  pool: { query: poolQuery },
}));

vi.mock('../src/services/ruijieCloud', () => ({
  isRuijieCloudConfigured: cloud.isConfigured,
  getAllRuijieVouchers: cloud.getAll,
}));

import { getRuijieRoster, __resetRuijieRosterForTests } from '../src/services/ruijieRoster';

const VOUCHER = { codeNo: 'abc123', voucherCode: 'abc123', quotaMb: 1024, usedQuotaMb: 512 };

beforeEach(() => {
  __resetRuijieRosterForTests();
  db.rows = [];
  poolQuery.mockReset();
  poolQuery.mockImplementation(async (sql: string) => {
    if (/^\s*SELECT payload/i.test(sql)) return { rows: db.rows };
    return { rows: [{ fetched_at: new Date() }] };
  });
  cloud.isConfigured.mockReturnValue(true);
  cloud.getAll.mockReset();
});

describe('getRuijieRoster', () => {
  it('returns an empty roster without calling Ruijie when keys are missing', async () => {
    cloud.isConfigured.mockReturnValue(false);
    const roster = await getRuijieRoster();
    expect(roster).toEqual({ vouchers: [], fetchedAt: null, stale: false });
    expect(cloud.getAll).not.toHaveBeenCalled();
  });

  it('serves a fresh snapshot from Postgres without pulling Ruijie', async () => {
    db.rows = [{ payload: [VOUCHER], fetched_at: new Date() }];
    const roster = await getRuijieRoster();

    expect(roster.vouchers).toEqual([VOUCHER]);
    expect(roster.stale).toBe(false);
    expect(cloud.getAll).not.toHaveBeenCalled();
  });

  it('pulls and persists the roster when the snapshot is stale', async () => {
    db.rows = [{ payload: [{ codeNo: 'old' }], fetched_at: new Date(Date.now() - 10 * 60_000) }];
    cloud.getAll.mockResolvedValue([VOUCHER]);

    const roster = await getRuijieRoster();

    expect(roster.vouchers).toEqual([VOUCHER]);
    expect(roster.stale).toBe(false);
    expect(cloud.getAll).toHaveBeenCalledTimes(1);
    const insert = poolQuery.mock.calls.find(([sql]) => /INSERT INTO ruijie_roster_cache/i.test(String(sql)));
    expect(insert).toBeTruthy();
  });

  it('serves the last good snapshot (stale) when Ruijie is rate-limiting', async () => {
    const fetchedAt = new Date(Date.now() - 10 * 60_000);
    db.rows = [{ payload: [VOUCHER], fetched_at: fetchedAt }];
    cloud.getAll.mockRejectedValue(Object.assign(new Error('Too many requests'), { code: 44 }));

    const roster = await getRuijieRoster();

    expect(roster.stale).toBe(true);
    expect(roster.vouchers).toEqual([VOUCHER]);
    expect(roster.fetchedAt?.getTime()).toBe(fetchedAt.getTime());
  });

  it('throws when there is no cached snapshot at all', async () => {
    cloud.getAll.mockRejectedValue(new Error('Too many requests'));

    await expect(getRuijieRoster()).rejects.toThrow('Too many requests');
  });

  it('deduplicates concurrent refreshes into one upstream pull', async () => {
    cloud.getAll.mockResolvedValue([VOUCHER]);

    const [a, b] = await Promise.all([getRuijieRoster(), getRuijieRoster()]);

    expect(cloud.getAll).toHaveBeenCalledTimes(1);
    expect(a.vouchers).toEqual(b.vouchers);
  });
});
