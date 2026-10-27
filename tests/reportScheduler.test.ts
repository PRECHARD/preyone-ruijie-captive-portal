import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Month-End scheduler contract: the report is due on the 3rd at 08:00 and
 * covers the previous calendar month. Sending is guarded by the last-sent
 * marker plus an advisory lock, so all four PM2 workers cannot double-mail.
 */

const poolQuery = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));
const mail = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('../src/db/pool', () => ({
  pool: {
    query: poolQuery,
    connect: async () => client,
  },
}));

vi.mock('../src/services/notificationService', () => ({
  sendTransactionalEmail: mail.send,
  buildEmailShell: (title: string, body: string) => `<h1>${title}</h1>${body}`,
}));

import {
  mostRecentDueAt,
  nextDueAt,
  periodForDueAt,
  runMonthEndReport,
  MONTH_END_CRON,
  getSchedulerStatus,
  stopReportScheduler,
} from '../src/services/scheduler';

/** settings rows served by the mocked pool. */
let settings: Record<string, string>;
/** true when pg_try_advisory_lock should refuse. */
let lockAvailable: boolean;

beforeEach(() => {
  settings = {
    month_end_report_enabled: '1',
    month_end_report_recipients: 'admin@preyone.com',
    month_end_report_last_sent: '',
  };
  lockAvailable = true;
  poolQuery.mockReset();
  client.query.mockReset();
  client.release.mockReset();
  mail.send.mockReset();
  mail.send.mockResolvedValue(true);
  stopReportScheduler();

  client.query.mockImplementation(async (sql: string) => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: lockAvailable }] };
    return { rows: [] };
  });

  poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/FROM settings WHERE key = \$1/.test(sql)) {
      const key = String(params?.[0]);
      return { rows: key in settings ? [{ value: settings[key] }] : [] };
    }
    if (/FROM sales/i.test(sql)) return { rows: [] };
    if (/cash_handovers/i.test(sql)) {
      return { rows: [{ active_count: 0, active_value: 0, approved_value: 0 }] };
    }
    if (/staff_commissions/i.test(sql)) return { rows: [] };
    return { rows: [] };
  });
});

const localDue = (year: number, monthIndex: number) => new Date(year, monthIndex, 3, 8, 0, 0, 0);

describe('cron contract', () => {
  it('is the 3rd of the month at 08:00', () => {
    expect(MONTH_END_CRON).toBe('0 8 3 * *');
  });
});

describe('mostRecentDueAt', () => {
  it('returns this month\'s 3rd once it has passed', () => {
    const now = new Date(2026, 9, 27, 9, 0, 0);
    expect(mostRecentDueAt(now).getTime()).toBe(localDue(2026, 9).getTime());
  });

  it('returns last month\'s 3rd before this month\'s run', () => {
    const now = new Date(2026, 9, 1, 7, 0, 0);
    expect(mostRecentDueAt(now).getTime()).toBe(localDue(2026, 8).getTime());
  });

  it('treats the exact due minute as already passed', () => {
    const now = localDue(2026, 9);
    expect(mostRecentDueAt(now).getTime()).toBe(now.getTime());
  });

  it('rolls back across the year boundary', () => {
    const now = new Date(2027, 0, 1, 12, 0, 0);
    expect(mostRecentDueAt(now).getTime()).toBe(localDue(2026, 11).getTime());
  });
});

describe('nextDueAt', () => {
  it('points at this month\'s 3rd before it happens', () => {
    const now = new Date(2026, 9, 1, 7, 0, 0);
    expect(nextDueAt(now).getTime()).toBe(localDue(2026, 9).getTime());
  });

  it('points at next month\'s 3rd after it happens', () => {
    const now = new Date(2026, 9, 27, 9, 0, 0);
    expect(nextDueAt(now).getTime()).toBe(localDue(2026, 10).getTime());
  });

  it('rolls forward across the year boundary', () => {
    const now = new Date(2026, 11, 20, 9, 0, 0);
    expect(nextDueAt(now).getTime()).toBe(localDue(2027, 0).getTime());
  });
});

describe('periodForDueAt', () => {
  it('reports the month before the due date', () => {
    const period = periodForDueAt(localDue(2026, 9));
    expect(period.from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(period.label).toBe('September 2026');
  });

  it('handles a January run (reports December)', () => {
    const period = periodForDueAt(localDue(2027, 0));
    expect(period.label).toBe('December 2026');
  });
});

describe('runMonthEndReport', () => {
  const period = periodForDueAt(localDue(2026, 9));

  it('sends and records the last-sent marker', async () => {
    const result = await runMonthEndReport({ period, force: true, trigger: 'manual' });

    expect(result.sent).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.recipients).toEqual(['admin@preyone.com']);
    expect(mail.send).toHaveBeenCalledTimes(1);

    const marker = poolQuery.mock.calls.find(
      ([sql, params]) =>
        /INSERT INTO settings/i.test(String(sql)) &&
        Array.isArray(params) &&
        params[0] === 'month_end_report_last_sent'
    );
    expect(marker?.[1]?.[1]).toBe('2026-09-01');
  });

  it('refuses to resend a period that is already marked sent', async () => {
    settings.month_end_report_last_sent = '2026-09-01';

    const result = await runMonthEndReport({ period });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('already_sent');
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('does nothing when the schedule is disabled (unless forced)', async () => {
    settings.month_end_report_enabled = '0';

    const skipped = await runMonthEndReport({ period });
    expect(skipped.reason).toBe('disabled');
    expect(mail.send).not.toHaveBeenCalled();

    const forced = await runMonthEndReport({ period, force: true });
    expect(forced.sent).toBe(true);
  });

  it('returns locked when another worker holds the advisory lock', async () => {
    lockAvailable = false;

    const result = await runMonthEndReport({ period, force: true });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('locked');
    expect(mail.send).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it('leaves the marker untouched when SMTP rejects the mail', async () => {
    mail.send.mockResolvedValue(false);

    const result = await runMonthEndReport({ period, force: true });

    expect(result.sent).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toBe('smtp_unavailable_or_rejected');
    const marker = poolQuery.mock.calls.find(
      ([sql, params]) =>
        /INSERT INTO settings/i.test(String(sql)) &&
        Array.isArray(params) &&
        params[0] === 'month_end_report_last_sent'
    );
    expect(marker).toBeUndefined();
  });

  it('uses explicit recipients when supplied', async () => {
    const result = await runMonthEndReport({
      period,
      force: true,
      recipients: ['finance@preyone.com', 'ceo@preyone.com'],
    });

    expect(result.recipients).toEqual(['finance@preyone.com', 'ceo@preyone.com']);
    expect(mail.send).toHaveBeenCalledTimes(1);
    const payload = mail.send.mock.calls[0][0];
    expect(payload.to).toEqual(['finance@preyone.com', 'ceo@preyone.com']);
    expect(payload.attachments[0].filename).toContain('2026-09');
  });

  it('always releases the advisory lock', async () => {
    await runMonthEndReport({ period, force: true });
    expect(client.release).toHaveBeenCalledTimes(1);
    const unlocked = client.query.mock.calls.some(([sql]) =>
      /pg_advisory_unlock/i.test(String(sql))
    );
    expect(unlocked).toBe(true);
  });

  it('surfaces a database failure without throwing', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (/FROM settings WHERE key = \$1/.test(sql)) return { rows: [] };
      throw new Error('connection terminated');
    });

    const result = await runMonthEndReport({ period, force: true });
    expect(result.sent).toBe(false);
    expect(result.error).toContain('connection terminated');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('getSchedulerStatus', () => {
  it('exposes the cron and the next run slot without starting a timer', () => {
    const status = getSchedulerStatus();
    expect(status.cron).toBe(MONTH_END_CRON);
    expect(status.running).toBe(false);
    expect(status.timerScheduled).toBe(false);
  });
});
