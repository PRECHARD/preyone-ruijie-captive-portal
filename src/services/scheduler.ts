import { pool } from '../db/pool';
import {
  buildMonthEndSummary,
  buildSalesWorkbookBuffer,
  previousMonthPeriod,
  type ReportPeriod,
} from './exportService';
import { sendMonthEndReportEmail } from './email';

/**
 * Month-End / Staff report scheduler.
 *
 * Cron contract: `0 8 3 * *` — the 3rd of every month at 08:00, covering the
 * previous calendar month. Implemented with a self-scheduling `setTimeout`
 * (no `node-cron` dependency) plus a catch-up check, so a restart that misses
 * the exact minute still delivers the report later that day.
 *
 * Four PM2 workers run this file. Sending is guarded three ways:
 *
 *   1. `pg_try_advisory_lock` — only one worker (across all clusters) may run a
 *      given tick; the others return `locked`.
 *   2. The `month_end_report_last_sent` settings row — once a period has been
 *      delivered it is never sent again, even after a restart.
 *   3. A re-check of that marker *inside* the lock, so two workers racing the
 *      lock the moment it frees cannot both mail.
 *
 * Any failure (SMTP down, database hiccup) leaves the marker untouched, so the
 * next tick retries instead of silently skipping the month.
 */

export const MONTH_END_CRON = '0 8 3 * *';
const LOCK_KEY = 'preyone:month_end_report';
const SETTING_ENABLED = 'month_end_report_enabled';
const SETTING_RECIPIENTS = 'month_end_report_recipients';
const SETTING_LAST_SENT = 'month_end_report_last_sent';
const DEFAULT_RECIPIENTS = 'admin@preyone.com';
/** Re-check at least this often so a missed 08:00 is picked up the same day. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface MonthEndRunResult {
  sent: boolean;
  skipped: boolean;
  reason?: 'disabled' | 'already_sent' | 'locked' | 'no_recipients' | 'smtp_unavailable_or_rejected';
  period: { from: string; to: string; label: string };
  recipients: string[];
  attachmentName?: string;
  salesCount?: number;
  totalRevenue?: number;
  error?: string;
}

interface SchedulerState {
  timerScheduled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: MonthEndRunResult | null;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let started = false;
let state: SchedulerState = {
  timerScheduled: false,
  nextRunAt: null,
  lastRunAt: null,
  lastResult: null,
};

/** Most recent 3rd-of-month 08:00 that has already passed (local server time). */
export function mostRecentDueAt(now: Date = new Date()): Date {
  const candidate = new Date(now.getFullYear(), now.getMonth(), 3, 8, 0, 0, 0);
  if (now.getTime() >= candidate.getTime()) return candidate;
  return new Date(now.getFullYear(), now.getMonth() - 1, 3, 8, 0, 0, 0);
}

/** Next 3rd-of-month 08:00 strictly after `now`. */
export function nextDueAt(now: Date = new Date()): Date {
  const candidate = new Date(now.getFullYear(), now.getMonth(), 3, 8, 0, 0, 0);
  if (candidate.getTime() > now.getTime()) return candidate;
  return new Date(now.getFullYear(), now.getMonth() + 1, 3, 8, 0, 0, 0);
}

/** Period a given due-date reports on (the calendar month before it). */
export function periodForDueAt(dueAt: Date): ReportPeriod {
  return previousMonthPeriod(dueAt);
}

async function readSetting(key: string): Promise<string | null> {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0]?.value == null ? null : String(rows[0].value);
  } catch {
    return null;
  }
}

async function writeSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

function periodKey(period: ReportPeriod): string {
  return period.from.toISOString().slice(0, 10);
}

function parseRecipients(raw: string | null): string[] {
  const list = String(raw ?? DEFAULT_RECIPIENTS)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_RECIPIENTS];
}

/**
 * Run the month-end report for one period.
 *
 * @param opts.force skip the "already sent" marker (manual resend from the UI).
 * @param opts.trigger label stored on the state for observability.
 */
export async function runMonthEndReport(opts: {
  period?: ReportPeriod;
  recipients?: string[];
  force?: boolean;
  trigger?: 'scheduler' | 'manual' | 'catch-up';
} = {}): Promise<MonthEndRunResult> {
  const period = opts.period ?? periodForDueAt(mostRecentDueAt());
  const base: MonthEndRunResult = {
    sent: false,
    skipped: true,
    period: {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      label: period.label,
    },
    recipients: [],
  };

  const enabled = (await readSetting(SETTING_ENABLED)) ?? '1';
  if (!opts.force && enabled !== '1') {
    return { ...base, reason: 'disabled' };
  }

  const recipients = opts.recipients?.length
    ? opts.recipients.map((r) => r.trim()).filter(Boolean)
    : parseRecipients(await readSetting(SETTING_RECIPIENTS));
  base.recipients = recipients;
  if (recipients.length === 0) return { ...base, reason: 'no_recipients' };

  const alreadySent = await readSetting(SETTING_LAST_SENT);
  if (!opts.force && alreadySent && alreadySent.startsWith(periodKey(period))) {
    return { ...base, reason: 'already_sent' };
  }

  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK_KEY]);
    locked = rows[0]?.locked === true;
    if (!locked) return { ...base, reason: 'locked' };

    // Re-check under the lock: another worker may have finished while we waited.
    if (!opts.force) {
      const sentNow = await readSetting(SETTING_LAST_SENT);
      if (sentNow && sentNow.startsWith(periodKey(period))) {
        return { ...base, reason: 'already_sent' };
      }
    }

    const summary = await buildMonthEndSummary(period);
    const attachment = await buildSalesWorkbookBuffer({
      sheetName: 'Month-End Sales',
      rows: summary.rows,
      title: 'Month-End Sales & Reconciliation Ledger',
      subtitle: `Period: ${period.label}`,
      company: null,
    });

    const result = await sendMonthEndReportEmail({
      recipients,
      summary,
      attachment,
      attachmentName: `preyone-month-end-${period.from.toISOString().slice(0, 7)}.xlsx`,
    });

    state = {
      ...state,
      lastRunAt: new Date().toISOString(),
      lastResult: {
        sent: result.sent,
        skipped: false,
        reason: result.reason as MonthEndRunResult['reason'],
        period: base.period,
        recipients,
        attachmentName: result.attachmentName,
        salesCount: summary.salesCount,
        totalRevenue: summary.totalRevenue,
      },
    };

    if (!result.sent) {
      console.warn(`[report-scheduler] month-end ${period.label} not delivered (${result.reason ?? 'unknown'})`);
      return {
        ...base,
        skipped: false,
        recipients,
        attachmentName: result.attachmentName,
        salesCount: summary.salesCount,
        totalRevenue: summary.totalRevenue,
        reason: 'smtp_unavailable_or_rejected',
      };
    }

    await writeSetting(SETTING_LAST_SENT, periodKey(period));
    console.log(
      `[report-scheduler] ${opts.trigger ?? 'scheduler'} sent ${period.label} ` +
      `to ${recipients.join(', ')} (${summary.salesCount} sales)`
    );
    return {
      sent: true,
      skipped: false,
      period: base.period,
      recipients,
      attachmentName: result.attachmentName,
      salesCount: summary.salesCount,
      totalRevenue: summary.totalRevenue,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[report-scheduler] month-end run failed:', message);
    state = {
      ...state,
      lastRunAt: new Date().toISOString(),
      lastResult: { ...base, skipped: false, recipients, error: message },
    };
    return { ...base, skipped: false, recipients, error: message };
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
      } catch {
        /* session is about to be released anyway */
      }
    }
    client.release();
  }
}

async function tick(trigger: 'scheduler' | 'catch-up' = 'scheduler'): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const dueAt = mostRecentDueAt(now);
    const period = periodForDueAt(dueAt);
    const lastSent = await readSetting(SETTING_LAST_SENT);
    const due = !lastSent || !lastSent.startsWith(periodKey(period));
    if (due) {
      const result = await runMonthEndReport({ period, trigger });
      if (result.reason === 'smtp_unavailable_or_rejected') {
        // Retry sooner than the next cron tick so a transient SMTP blip does
        // not cost the whole month.
        scheduleNext(new Date(Date.now() + 15 * 60 * 1000));
        return;
      }
    }
  } catch (err) {
    console.error('[report-scheduler] tick failed:', err);
  } finally {
    running = false;
  }
  scheduleNext();
}

function scheduleNext(at: Date = nextDueAt()): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void tick('scheduler');
  }, Math.max(30_000, at.getTime() - Date.now()));
  timer.unref?.();
  state = { ...state, timerScheduled: true, nextRunAt: at.toISOString() };
}

/**
 * Boot hook — idempotent. Opt out with REPORT_SCHEDULER_DISABLED=1 (used by
 * tests and one-off debug sessions).
 */
export function startReportScheduler(): void {
  if (process.env.REPORT_SCHEDULER_DISABLED === '1') {
    console.log('[report-scheduler] disabled via REPORT_SCHEDULER_DISABLED');
    return;
  }
  if (started) return;
  started = true;

  // Catch-up: a restart after 08:00 on the 3rd must still deliver today.
  setTimeout(() => { void tick('catch-up'); }, 45_000).unref?.();
  scheduleNext();
  console.log(
    `[report-scheduler] Month-End report scheduled (${MONTH_END_CRON}); next run ${state.nextRunAt}`
  );

  // Hourly safety net: picks up a missed minute (restart, DST, long deploy).
  const heartbeat = setInterval(() => { void tick('catch-up'); }, CHECK_INTERVAL_MS);
  heartbeat.unref?.();
}

export function stopReportScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  state = { ...state, timerScheduled: false };
}

export function getSchedulerStatus(): SchedulerState & { cron: string; running: boolean } {
  return { ...state, cron: MONTH_END_CRON, running };
}

/** Test-only: clear module state between suites. */
export function __resetReportSchedulerForTests(): void {
  stopReportScheduler();
  running = false;
  state = { timerScheduled: false, nextRunAt: null, lastRunAt: null, lastResult: null };
}
