import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  isRuijieCloudConfigured: vi.fn(() => true),
  getAllRuijieVouchers: vi.fn(async (): Promise<any[]> => []),
}));

vi.mock('../src/db/pool', () => ({
  pool: { connect: mocks.connect },
}));
vi.mock('../src/services/ruijieCloud', () => ({
  isRuijieCloudConfigured: mocks.isRuijieCloudConfigured,
  getAllRuijieVouchers: mocks.getAllRuijieVouchers,
}));

import {
  classifyRuijieVoucher,
  isRuijieVoucherOnline,
  planVoucherUpdate,
  syncRuijieVoucherStatuses,
  type LocalVoucherState,
} from '../src/services/ruijieVoucherStatusSync';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const NOW_MS = NOW.getTime();

function local(overrides: Partial<LocalVoucherState> = {}): LocalVoucherState {
  return {
    id: 'v-1',
    code: 'alpha',
    max_uses: 1,
    used_count: 0,
    activated_at: null,
    last_seen_at: null,
    expires_at: null,
    ruijie_sync_status: null,
    ruijie_voucher_id: null,
    ruijie_active_clients: 0,
    ruijie_max_clients: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isRuijieCloudConfigured.mockReturnValue(true);
  mocks.getAllRuijieVouchers.mockResolvedValue([]);
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Ruijie voucher lifecycle classification', () => {
  it('treats remote usage or an online client as activity', () => {
    const used = classifyRuijieVoucher({ voucherCode: 'ABC', usedTimeMin: 5 }, NOW_MS);
    expect(used).toMatchObject({ code: 'abc', hasActivity: true, online: false, expired: false });

    const online = classifyRuijieVoucher(
      { voucherCode: 'ABC', currentClients: 3, maxClients: 5 },
      NOW_MS
    );
    expect(online).toMatchObject({
      hasActivity: true,
      online: true,
      activeDevices: 3,
      maxClients: 5,
    });

    const count = classifyRuijieVoucher({ voucherCode: 'ABC', usedCount: 2 }, NOW_MS);
    expect(count.hasActivity).toBe(true);
  });

  it('prefers explicit onlineStatus and falls back to currentClients', () => {
    expect(isRuijieVoucherOnline({ onlineStatus: 'online', currentClients: 0 })).toBe(true);
    expect(isRuijieVoucherOnline({ onlineStatus: 1, currentClients: 0 })).toBe(true);
    expect(isRuijieVoucherOnline({ onlineStatus: false, currentClients: 3 })).toBe(false);
    expect(isRuijieVoucherOnline({ currentClients: 2 })).toBe(true);
  });

  it('flags expiry and quota depletion without treating unlimited plans as depleted', () => {
    const expired = classifyRuijieVoucher(
      { voucherCode: 'ABC', expiryTime: NOW_MS - 1 },
      NOW_MS
    );
    expect(expired.expired).toBe(true);

    const depleted = classifyRuijieVoucher(
      { voucherCode: 'ABC', quotaMb: 100, usedQuotaMb: 100 },
      NOW_MS
    );
    expect(depleted.depleted).toBe(true);

    const unlimited = classifyRuijieVoucher(
      { voucherCode: 'ABC', usedQuotaMb: 999 },
      NOW_MS
    );
    expect(unlimited.depleted).toBe(false);
  });
});

describe('planVoucherUpdate', () => {
  it('activates a used code, records first use, last seen and remote expiry', () => {
    const firstUse = new Date('2026-10-20T08:00:00.000Z');
    const expiry = new Date('2026-11-01T00:00:00.000Z');
    const remote = classifyRuijieVoucher(
      {
        voucherCode: 'alpha',
        usedTimeMin: 60,
        currentClients: 1,
        firstUseTime: firstUse.getTime(),
        loginTime: firstUse.getTime(),
        expiryTime: expiry.getTime(),
        quotaMb: 1024,
        usedQuotaMb: 50,
      },
      NOW_MS
    );

    const plan = planVoucherUpdate(local(), remote, NOW);
    expect(plan).toMatchObject({
      usedCount: 1,
      activatedAt: firstUse,
      lastSeenAt: NOW,
      expiresAt: expiry,
      changed: true,
    });
  });

  it('marks an exhausted multi-use voucher as fully used', () => {
    const remote = classifyRuijieVoucher(
      { voucherCode: 'alpha', quotaMb: 100, usedQuotaMb: 100 },
      NOW_MS
    );
    expect(planVoucherUpdate(local({ max_uses: 3 }), remote, NOW).usedCount).toBe(3);
  });

  it('never extends an earlier local expiry', () => {
    const localExpiry = new Date('2026-10-24T00:00:00.000Z');
    const remote = classifyRuijieVoucher(
      { voucherCode: 'alpha', expiryTime: Date.UTC(2026, 11, 1) },
      NOW_MS
    );
    expect(planVoucherUpdate(local({ expires_at: localExpiry }), remote, NOW).expiresAt).toEqual(localExpiry);
  });

  it('is a no-op once a clean voucher is already synced', () => {
    const remote = classifyRuijieVoucher({ voucherCode: 'alpha' }, NOW_MS);
    const plan = planVoucherUpdate(
      local({ ruijie_sync_status: 'synced', ruijie_voucher_id: 'alpha' }),
      remote,
      NOW
    );
    expect(plan.changed).toBe(false);
  });

  it('plans live device count and per-voucher client cap changes', () => {
    const remote = classifyRuijieVoucher(
      { voucherCode: 'alpha', currentClients: 2, maxClients: 4 },
      NOW_MS
    );
    const plan = planVoucherUpdate(
      local({
        ruijie_sync_status: 'synced',
        ruijie_voucher_id: 'alpha',
        ruijie_active_clients: 1,
        ruijie_max_clients: 2,
      }),
      remote,
      NOW
    );

    expect(plan).toMatchObject({
      activeDevices: 2,
      maxClients: 4,
      changed: true,
    });
  });

  it('does not undo an admin renew/reset from stale remote usage', () => {
    const renewed = local({
      used_count: 0,
      activated_at: '2026-10-01T00:00:00.000Z',
      expires_at: '2026-12-01T00:00:00.000Z',
      max_uses: 1,
      ruijie_sync_status: 'synced',
      ruijie_voucher_id: 'alpha',
    });
    const remote = classifyRuijieVoucher(
      {
        voucherCode: 'alpha',
        quotaMb: 100,
        usedQuotaMb: 100,
        usedTimeMin: 300,
        expiryTime: Date.UTC(2026, 9, 2),
      },
      NOW_MS
    );

    const plan = planVoucherUpdate(renewed, remote, NOW);
    expect(plan.usedCount).toBe(0);
    expect(plan.expiresAt).toEqual(new Date('2026-12-01T00:00:00.000Z'));
    expect(plan.lastSeenAt).toEqual(NOW);
  });
});

describe('syncRuijieVoucherStatuses', () => {
  it('updates all matched local vouchers without touching payment or pool metadata', async () => {
    mocks.getAllRuijieVouchers.mockResolvedValue([
      { voucherCode: 'alpha', usedTimeMin: 30, currentClients: 1, quotaMb: 1024, usedQuotaMb: 30 },
      { voucherCode: 'BETA', usedTimeMin: 10 },
    ]);
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql.includes('FROM vouchers')) {
        return {
          rows: [
            local({ id: 'v-alpha', code: 'alpha' }),
            local({ id: 'v-beta', code: 'BETA', max_uses: 2 }),
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('UPDATE vouchers')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await syncRuijieVoucherStatuses({ force: true });

    expect(result).toMatchObject({
      skipped: false,
      remoteCount: 2,
      matched: 2,
      updated: 2,
      online: 1,
      errors: [],
    });
    const updateCalls = mocks.clientQuery.mock.calls.filter(([sql]) => String(sql).includes('UPDATE vouchers'));
    expect(updateCalls).toHaveLength(2);
    for (const [sql] of updateCalls) {
      expect(sql).not.toMatch(/payment_id|pool_status|assigned_at|sales|ruijie_vouchers/);
    }
  });

  it('skips when Ruijie Cloud is not configured', async () => {
    mocks.isRuijieCloudConfigured.mockReturnValue(false);
    const result = await syncRuijieVoucherStatuses({ force: true });
    expect(result).toMatchObject({ skipped: true, reason: 'ruijie_cloud_not_configured' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('skips when another worker owns the advisory lock', async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ locked: false }], rowCount: 1 });
    const result = await syncRuijieVoucherStatuses({ force: true });
    expect(result).toMatchObject({ skipped: true, reason: 'another_worker_running' });
    expect(mocks.getAllRuijieVouchers).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });
});
