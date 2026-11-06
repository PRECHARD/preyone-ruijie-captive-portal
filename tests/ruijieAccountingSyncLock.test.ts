import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  isRuijieCloudConfigured: vi.fn(() => true),
}));

vi.mock('../src/db/pool', () => ({
  pool: { connect: mocks.connect },
}));
vi.mock('../src/services/ruijieCloud', () => ({
  isRuijieCloudConfigured: mocks.isRuijieCloudConfigured,
  getRuijieVouchers: vi.fn(),
  RuijieApiError: class RuijieApiError extends Error {},
  withTokenRefresh: vi.fn(),
}));
vi.mock('../src/services/ruijieRateLimiter', () => ({
  attachRuijieQuotaGuard: (client: unknown) => client,
}));
vi.mock('../src/services/voucherBindingService', () => ({
  resolveVoucherBindings: vi.fn(),
  resolveVoucherCodesByIp: vi.fn(),
  verifyVoucherCodes: vi.fn(),
}));

import { syncAccountingData } from '../src/services/ruijieService';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isRuijieCloudConfigured.mockReturnValue(true);
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  mocks.clientQuery.mockResolvedValue({ rows: [{ locked: false }], rowCount: 1 });
});

describe('syncAccountingData lock', () => {
  it('releases the pooled client when another worker holds the lock', async () => {
    const result = await syncAccountingData();

    expect(result).toMatchObject({ skipped: true, reason: 'another_worker_running' });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
