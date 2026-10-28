import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../src/services/ruijieCloud', () => ({
  isRuijieCloudConfigured: vi.fn(),
  upsertRuijieUserGroup: vi.fn(),
}));

import { pool } from '../src/db/pool';
import { isRuijieCloudConfigured, upsertRuijieUserGroup } from '../src/services/ruijieCloud';
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
    return { rows: [] };
  });
}

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

  it('pushes the derived policy and marks the row synced', async () => {
    (isRuijieCloudConfigured as any).mockReturnValue(true);
    (upsertRuijieUserGroup as any).mockResolvedValue({ id: 'ug-1', policy: { name: 'preStream_Daily' } });

    const result = await provisionRuijieUserGroupForPackage('preStream_Daily', { immediate: true });

    expect(result).toMatchObject({ status: 'synced', degraded: false, userGroupId: 'ug-1' });
    expect(upsertRuijieUserGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'preStream_Daily',
        timePeriodMin: 1440,
        quotaMb: 0,
        noOfDevice: 1,
        rateLimitKbpsDown: 10240,
      })
    );
    const outcome = (pool.query as any).mock.calls.find((c: any[]) => String(c[0]).includes('UPDATE ruijie_user_group_sync'));
    expect(outcome?.[1]).toEqual(['preStream_Daily', 'synced', 'ug-1', null]);
  });

  it('degrades to pending (never throws) when Ruijie throttles', async () => {
    (isRuijieCloudConfigured as any).mockReturnValue(true);
    (upsertRuijieUserGroup as any).mockRejectedValue(new RuijieApiError(44, 'Too many requests'));

    const result = await provisionRuijieUserGroupForPackage('preStream_Daily', { immediate: true });

    expect(result.status).toBe('pending');
    expect(result.degraded).toBe(true);
    expect(result.error).toMatch(/too many requests/i);
  });

  it('returns a failed result instead of throwing when the local write breaks', async () => {
    (pool.query as any).mockRejectedValueOnce(new Error('db down'));

    const result = await provisionRuijieUserGroupForPackage('preStream_Daily');

    expect(result.status).toBe('failed');
    expect(result.degraded).toBe(true);
    expect(result.error).toContain('db down');
  });
});
