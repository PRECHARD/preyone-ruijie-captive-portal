import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../src/services/ruijieCloud', () => ({
  isRuijieCloudConfigured: vi.fn(),
  upsertRuijieUserGroup: vi.fn(),
  getRuijieUserGroups: vi.fn(),
}));

import { pool } from '../src/db/pool';
import {
  getRuijieUserGroups,
  isRuijieCloudConfigured,
  upsertRuijieUserGroup,
} from '../src/services/ruijieCloud';
import {
  __resetRuijieUserGroupQueueForTests,
  provisionRuijieUserGroupForPackage,
} from '../src/services/ruijieUserGroups';
import { __resetRuijieSyncForTests } from '../src/services/ruijieSync';
import { RuijieApiError } from '../src/services/ruijieErrors';

const packageRow = {
  tier_name: 'preStream_Daily',
  display_name: 'Stream Daily',
  duration_min: 1440,
  data_limit_gb: null,
  is_uncapped: true,
  bandwidth_mbps_up: 10,
  bandwidth_mbps_down: 10,
  max_devices: 1,
};

function stubPackageLookup() {
  (pool.query as any).mockImplementation(async (sql: string) => {
    if (sql.includes('FROM packages')) return { rows: [packageRow] };
    if (sql.includes('FROM voucher_profiles')) return { rows: [] };
    return { rows: [] };
  });
}

const ruijieGroup = {
  id: '169219',
  name: 'preStream_Daily',
  authProfileId: '59166157613789994967220217112841',
  timePeriodMin: 1440,
  quotaMb: 0,
  noOfDevice: 1,
  rateLimitKbps: 10240,
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRuijieSyncForTests();
  __resetRuijieUserGroupQueueForTests();
  stubPackageLookup();
});

describe('Ruijie User Group provisioning', () => {
  it('caches the desired policy and skips the push when Ruijie is unconfigured', async () => {
    (isRuijieCloudConfigured as any).mockReturnValue(false);

    const result = await provisionRuijieUserGroupForPackage('preStream_Daily');

    expect(result.status).toBe('skipped');
    expect(result.degraded).toBe(true);
    expect(upsertRuijieUserGroup).not.toHaveBeenCalled();
    // Desired policy is still persisted for a later retry.
    const calls = (pool.query as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calls.some((sql: string) => sql.includes('INSERT INTO ruijie_user_group_sync'))).toBe(true);
  });

  it('maps a group that already exists in Ruijie (no duplicate create)', async () => {
    (isRuijieCloudConfigured as any).mockReturnValue(true);
    (getRuijieUserGroups as any).mockResolvedValue([ruijieGroup]);

    const result = await provisionRuijieUserGroupForPackage('preStream_Daily', { immediate: true });

    expect(result).toMatchObject({ status: 'synced', degraded: false, userGroupId: '169219' });
    expect(upsertRuijieUserGroup).not.toHaveBeenCalled();
    const mapping = (pool.query as any).mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO voucher_profiles'));
    expect(mapping?.[1]).toEqual([
      'preStream_Daily',
      '169219',
      '59166157613789994967220217112841',
      'preStream_Daily',
      1440,
      0,
      1,
      10240,
    ]);
    const outcome = (pool.query as any).mock.calls.find((c: any[]) => String(c[0]).includes('UPDATE ruijie_user_group_sync'));
    expect(outcome?.[1]).toEqual(['preStream_Daily', 'synced', '169219', null]);
  });

  it('creates the group when absent, then writes the voucher_profiles mapping', async () => {
    (isRuijieCloudConfigured as any).mockReturnValue(true);
    (getRuijieUserGroups as any)
      .mockResolvedValueOnce([])
      .mockResolvedValue([ruijieGroup]);
    (upsertRuijieUserGroup as any).mockResolvedValue({ id: '169219', policy: { name: 'preStream_Daily' } });

    const result = await provisionRuijieUserGroupForPackage('preStream_Daily', { immediate: true });

    expect(result).toMatchObject({ status: 'synced', degraded: false, userGroupId: '169219' });
    expect(upsertRuijieUserGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'preStream_Daily',
        timePeriodMin: 1440,
        quotaMb: 0,
        noOfDevice: 1,
        rateLimitKbpsDown: 10240,
      })
    );
    const calls = (pool.query as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calls.some((sql: string) => sql.includes('INSERT INTO voucher_profiles'))).toBe(true);
  });

  it('degrades to pending (never throws) when Ruijie throttles', async () => {
    (isRuijieCloudConfigured as any).mockReturnValue(true);
    (getRuijieUserGroups as any).mockRejectedValue(new RuijieApiError(44, 'Too many requests'));

    const result = await provisionRuijieUserGroupForPackage('preStream_Daily', { immediate: true });

    expect(result.status).toBe('pending');
    expect(result.degraded).toBe(true);
    expect(result.error).toMatch(/too many requests/i);
  });

  it('does not list groups when the tier is already mapped', async () => {
    (isRuijieCloudConfigured as any).mockReturnValue(true);
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM packages')) return { rows: [packageRow] };
      if (sql.includes('FROM voucher_profiles')) {
        return { rows: [{ ruijie_user_group_id: '127499', ruijie_profile_uuid: 'prof-1' }] };
      }
      return { rows: [] };
    });
    (upsertRuijieUserGroup as any).mockResolvedValue({ id: '127499', policy: { name: 'preStream_Daily' } });

    const result = await provisionRuijieUserGroupForPackage('preStream_Daily', { immediate: true });

    expect(result.status).toBe('synced');
    expect(getRuijieUserGroups).not.toHaveBeenCalled();
    expect(upsertRuijieUserGroup).toHaveBeenCalledTimes(1);
  });

  it('returns a failed result instead of throwing when the local write breaks', async () => {
    (pool.query as any).mockRejectedValueOnce(new Error('db down'));

    const result = await provisionRuijieUserGroupForPackage('preStream_Daily');

    expect(result.status).toBe('failed');
    expect(result.degraded).toBe(true);
    expect(result.error).toContain('db down');
  });
});
