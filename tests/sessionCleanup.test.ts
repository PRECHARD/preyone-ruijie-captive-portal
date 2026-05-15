import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn(),
  },
}));

import { cleanupExpiredSessions } from '../src/services/sessionCleanup';
import { pool } from '../src/db/pool';

describe('cleanupExpiredSessions', () => {
  beforeEach(() => {
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('clears expired sessions and returns the number of rows updated', async () => {
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 7 });
    const result = await cleanupExpiredSessions();
    expect(result).toBe(7);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users'),
    );
  });

  it('returns 0 when no rows are updated', async () => {
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 0 });
    const result = await cleanupExpiredSessions();
    expect(result).toBe(0);
  });
});
