import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn(),
  },
}));

import { cleanupOldAccessLogs } from '../src/services/accessLogCleanup';
import { pool } from '../src/db/pool';

describe('cleanupOldAccessLogs', () => {
  beforeEach(() => {
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('deletes old access logs and returns the number of rows deleted', async () => {
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 5 });
    const result = await cleanupOldAccessLogs(30);
    expect(result).toBe(5);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM access_log"),
      [30],
    );
  });

  it('returns 0 when no rows are deleted', async () => {
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 0 });
    const result = await cleanupOldAccessLogs(30);
    expect(result).toBe(0);
  });
});