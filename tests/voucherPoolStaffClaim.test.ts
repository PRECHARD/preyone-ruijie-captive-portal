import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQuery = vi.hoisted(() => vi.fn());

vi.mock('../src/db/pool', () => ({
  pool: { query: poolQuery, connect: vi.fn() },
}));

vi.mock('../src/services/ruijieMint', () => ({
  isRuijieCloudConfigured: vi.fn(() => true),
  mintRuijieVoucherForTier: vi.fn(),
}));

import { claimPooledVoucherForStaff, releasePooledVouchers } from '../src/services/voucherPool';

const ROW = {
  code_no: 'pooled123',
  tier_name: 'PreLite',
  user_group_id: '9624342',
  profile_uuid: '30113648274480073538014045592098',
  ruijie_expiry: '1798761600000',
};

beforeEach(() => {
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('claimPooledVoucherForStaff', () => {
  it('assigns the oldest usable pooled code for the tier', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });

    const claimed = await claimPooledVoucherForStaff('PreLite', 'Staff sale by Ada');

    expect(claimed).toEqual(ROW);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(String(sql)).toContain("pool_status = 'available'");
    expect(String(sql)).toContain('SKIP LOCKED');
    // A counter sale must never look like an online payment claim.
    expect(String(sql)).toContain("source = 'staff'");
    expect(String(sql)).not.toContain('payment_id = $2');
    expect(params).toEqual(['PreLite', 'Staff sale by Ada']);
  });

  it('returns null so the caller can surface the retryable throttle', async () => {
    await expect(claimPooledVoucherForStaff('PreMax')).resolves.toBeNull();
    // No comment supplied is passed as NULL, keeping the old pool comment.
    expect(poolQuery.mock.calls[0][1]).toEqual(['PreMax', null]);
  });

  it('ignores rows that are reserved for an online payment or already expired', async () => {
    await claimPooledVoucherForStaff('PreGo');
    const sql = String(poolQuery.mock.calls[0][0]);
    expect(sql).toContain('payment_id IS NULL');
    expect(sql).toContain('ruijie_expiry >');
  });
});

describe('releasePooledVouchers', () => {
  it('returns unused staff claims to stock', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 });

    await expect(releasePooledVouchers(['a', 'b', 'c'])).resolves.toBe(3);

    const [sql, params] = poolQuery.mock.calls[0];
    expect(String(sql)).toContain("pool_status = 'available'");
    expect(String(sql)).toContain('assigned_at = NULL');
    // Only staff-sale claims may be released; online reservations belong to a payment.
    expect(String(sql)).toContain("payment_id IS NULL");
    expect(params).toEqual([['a', 'b', 'c']]);
  });

  it('does not touch the database when there is nothing to release', async () => {
    await expect(releasePooledVouchers([])).resolves.toBe(0);
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
