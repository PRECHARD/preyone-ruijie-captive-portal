import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn(),
  },
}));

import { sendHandoverReminders } from '../src/services/handoverReminder';
import { pool } from '../src/db/pool';

describe('sendHandoverReminders', () => {
  beforeEach(() => {
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('inserts deduped reminders only for clocked-in staff with pending cash sales', async () => {
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 2 });

    const result = await sendHandoverReminders();

    expect(result).toBe(2);
    const [sql] = (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain(`'cash_handover_reminder'`);
    expect(sql).toContain(`payment_method = 'Cash'`);
    expect(sql).toContain('t.clock_out IS NULL'); // only clocked-in staff
    expect(sql).toContain('acknowledged = FALSE'); // dedupe on unacknowledged
    expect(sql).toContain('NOT EXISTS');
  });

  it('returns 0 when no rows are inserted', async () => {
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 0 });

    const result = await sendHandoverReminders();
    expect(result).toBe(0);
  });

  it('propagates DB errors to the caller (scheduler logs them)', async () => {
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));

    await expect(sendHandoverReminders()).rejects.toThrow('db down');
  });
});
