import axios from 'axios';
import { pool } from '../db/pool';
import { RuijieApiError, RATE_LIMIT_CODE } from './ruijieErrors';

type AxiosInstance = ReturnType<typeof axios.create>;

/**
 * Cluster-wide outbound Ruijie Open-API quota guard.
 *
 * Why this exists
 * ---------------
 * Ruijie's tenant quota is tiny (`{ code: 44, msg: "Too many requests" }` once
 * exhausted) and PM2 runs several workers, each of which would otherwise call
 * upstream independently. Caching (`ruijieRoster`, `ruijieSessionCache`,
 * `ruijieDeviceCache`) already cuts background traffic a lot, but nothing
 * *hard-capped* the number of outbound requests. A burst of interactive voucher
 * lookups could still burn the whole window in one second and take sales down
 * with it.
 *
 * This module is a single logical token bucket shared by every worker:
 *
 *   1. Cross-worker counter — one row in `ruijie_api_quota` is incremented with
 *      a single atomic UPSERT, so the limit holds across the whole cluster
 *      (not per process, which is what a plain in-memory limiter would give).
 *   2. Conservative in-memory fallback — if Postgres is slow or unavailable we
 *      fall back to a per-process fixed window derived from the cluster budget
 *      divided by the expected worker count. Worst case 4 workers × 3 = 12/min,
 *      still under the 15/min ceiling this module enforces.
 *   3. Denial is a `RuijieApiError(RATE_LIMIT_CODE)` — i.e. exactly the error
 *      Ruijie itself returns when throttled. Every existing resilience path
 *      (write retry → pre-minted pool → 429 with `retryable: true`, read
 *      cooldown, circuit breaker, serve-stale cache) already handles it, so
 *      nothing new can 5xx a request.
 *
 * Defaults are deliberately below the hard Ruijie limits (20/min, 5000/day):
 * `RUIJIE_MAX_CALLS_PER_MIN=15`, `RUIJIE_MAX_CALLS_PER_DAY=5000`.
 */

function positiveInt(raw: string | undefined, fallback: number, min = 1): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.trunc(n);
}

/** Cluster-wide ceiling per rolling fixed minute window. */
export const MINUTE_LIMIT = positiveInt(process.env.RUIJIE_MAX_CALLS_PER_MIN, 15);

/** Cluster-wide ceiling per calendar day (server-local date, matching Ruijie). */
export const DAY_LIMIT = positiveInt(process.env.RUIJIE_MAX_CALLS_PER_DAY, 5000);

/**
 * How many worker processes share the quota. Used only to divide the budget for
 * the in-memory fallback (the DB path is inherently cluster-wide).
 */
const WORKER_COUNT = positiveInt(process.env.RUIJIE_QUOTA_WORKERS ?? process.env.WEB_CONCURRENCY, 4);

/** Fraction of the budget a single worker may spend when the DB is unreachable. */
const FALLBACK_MINUTE_LIMIT = Math.max(1, Math.floor(MINUTE_LIMIT / WORKER_COUNT));
const FALLBACK_DAY_LIMIT = Math.max(1, Math.floor(DAY_LIMIT / WORKER_COUNT));

export interface RuijieQuotaReservation {
  /** Always true when returned — a denial throws instead. */
  allowed: true;
  /** Where the decision was made. `memory` means the DB was unavailable. */
  source: 'db' | 'memory';
  minuteCount: number;
  minuteLimit: number;
  dayCount: number;
  dayLimit: number;
}

export interface RuijieQuotaStatus {
  minuteCount: number;
  minuteLimit: number;
  dayCount: number;
  dayLimit: number;
  minuteResetAt: Date | null;
  dayResetAt: Date | null;
  source: 'db' | 'memory';
  /** True when the next call would be refused. */
  exhausted: boolean;
}

/**
 * Build the "throttled" error with the exact shape Ruijie uses, so every
 * existing resilience path (write retry → pre-minted pool → 429, read cooldown,
 * circuit breaker, serve-stale cache) treats a local refusal identically.
 */
function quotaError(minuteCount: number, dayCount: number): Error {
  const detail = `minute=${minuteCount}/${MINUTE_LIMIT} day=${dayCount}/${DAY_LIMIT}`;
  return new RuijieApiError(
    RATE_LIMIT_CODE,
    `Too many requests (local Ruijie quota guard exhausted: ${detail})`
  );
}

// ── In-memory fallback window ────────────────────────────────────────────────

interface MemoryWindow {
  minuteKey: number;
  minuteCount: number;
  dayKey: string;
  dayCount: number;
}

let memory: MemoryWindow = { minuteKey: -1, minuteCount: 0, dayKey: '', dayCount: 0 };

function minuteKeyOf(now: Date): number {
  return Math.floor(now.getTime() / 60_000);
}

function dayKeyOf(now: Date): string {
  // Local calendar day, matching `CURRENT_DATE` on the portal database host.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function reserveInMemory(now: Date): RuijieQuotaReservation {
  const mk = minuteKeyOf(now);
  const dk = dayKeyOf(now);
  if (memory.minuteKey !== mk) {
    memory = { ...memory, minuteKey: mk, minuteCount: 0 };
  }
  if (memory.dayKey !== dk) {
    memory = { ...memory, dayKey: dk, dayCount: 0 };
  }
  if (memory.minuteCount >= FALLBACK_MINUTE_LIMIT || memory.dayCount >= FALLBACK_DAY_LIMIT) {
    throw quotaError(memory.minuteCount, memory.dayCount);
  }
  memory.minuteCount += 1;
  memory.dayCount += 1;
  return {
    allowed: true,
    source: 'memory',
    minuteCount: memory.minuteCount,
    minuteLimit: FALLBACK_MINUTE_LIMIT,
    dayCount: memory.dayCount,
    dayLimit: FALLBACK_DAY_LIMIT,
  };
}

// ── Cross-worker (database) window ───────────────────────────────────────────

let warnedAboutQuotaTable = false;

function warnQuotaTableOnce(err: unknown): void {
  if (warnedAboutQuotaTable) return;
  warnedAboutQuotaTable = true;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    '[ruijie-quota] quota table unavailable, falling back to in-memory window:',
    msg
  );
}

const RESERVE_SQL = `
  INSERT INTO ruijie_api_quota (id, minute_start, minute_count, day_key, day_count, updated_at)
  VALUES (1, date_trunc('minute', NOW()), 1, CURRENT_DATE, 1, NOW())
  ON CONFLICT (id) DO UPDATE SET
    minute_count = CASE
      WHEN ruijie_api_quota.minute_start = date_trunc('minute', NOW())
        THEN ruijie_api_quota.minute_count + 1
      ELSE 1 END,
    day_count = CASE
      WHEN ruijie_api_quota.day_key = CURRENT_DATE
        THEN ruijie_api_quota.day_count + 1
      ELSE 1 END,
    minute_start = date_trunc('minute', NOW()),
    day_key      = CURRENT_DATE,
    updated_at   = NOW()
  WHERE (CASE
           WHEN ruijie_api_quota.minute_start = date_trunc('minute', NOW())
             THEN ruijie_api_quota.minute_count + 1
           ELSE 1 END) <= $1
    AND (CASE
           WHEN ruijie_api_quota.day_key = CURRENT_DATE
             THEN ruijie_api_quota.day_count + 1
           ELSE 1 END) <= $2
  RETURNING minute_count, day_count
`;

const STATUS_SQL = `
  SELECT
    CASE WHEN minute_start = date_trunc('minute', NOW()) THEN minute_count ELSE 0 END AS minute_count,
    CASE WHEN day_key = CURRENT_DATE THEN day_count ELSE 0 END AS day_count,
    date_trunc('minute', NOW()) + INTERVAL '1 minute' AS minute_reset_at,
    (CURRENT_DATE + INTERVAL '1 day') AS day_reset_at
  FROM ruijie_api_quota
  WHERE id = 1
`;

/**
 * Reserve one outbound call. Throws `RuijieApiError(RATE_LIMIT_CODE)` when the
 * cluster (or the fallback worker budget) is out of quota.
 *
 * Never throws for infrastructure reasons: a broken quota table degrades to the
 * conservative in-memory window instead of failing the sale.
 */
export async function reserveRuijieCall(): Promise<RuijieQuotaReservation> {
  const now = new Date();
  try {
    const { rows } = await pool.query(RESERVE_SQL, [MINUTE_LIMIT, DAY_LIMIT]);
    if (rows.length > 0) {
      const minuteCount = Number(rows[0].minute_count) || 0;
      const dayCount = Number(rows[0].day_count) || 0;
      // Keep the in-memory mirror roughly in sync so status reporting stays
      // meaningful during a DB blip.
      memory = {
        minuteKey: minuteKeyOf(now),
        minuteCount,
        dayKey: dayKeyOf(now),
        dayCount,
      };
      return {
        allowed: true,
        source: 'db',
        minuteCount,
        minuteLimit: MINUTE_LIMIT,
        dayCount,
        dayLimit: DAY_LIMIT,
      };
    }

    // No row returned: the UPSERT's WHERE clause refused the increment.
    const status = await ruijieQuotaStatus();
    throw quotaError(status.minuteCount, status.dayCount);
  } catch (err) {
    // A rejection from the guard itself must never be swallowed.
    if (isQuotaGuardError(err)) throw err;
    warnQuotaTableOnce(err);
    return reserveInMemory(now);
  }
}

function isQuotaGuardError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'RuijieApiError') return true;
  return /local Ruijie quota guard/.test(err.message);
}

/** Read-only quota snapshot for admin display. Never throws. */
export async function ruijieQuotaStatus(): Promise<RuijieQuotaStatus> {
  try {
    const { rows } = await pool.query(STATUS_SQL);
    if (rows.length > 0) {
      const minuteCount = Number(rows[0].minute_count) || 0;
      const dayCount = Number(rows[0].day_count) || 0;
      return {
        minuteCount,
        minuteLimit: MINUTE_LIMIT,
        dayCount,
        dayLimit: DAY_LIMIT,
        minuteResetAt: rows[0].minute_reset_at ? new Date(rows[0].minute_reset_at) : null,
        dayResetAt: rows[0].day_reset_at ? new Date(rows[0].day_reset_at) : null,
        source: 'db',
        exhausted: minuteCount >= MINUTE_LIMIT || dayCount >= DAY_LIMIT,
      };
    }
  } catch (err) {
    warnQuotaTableOnce(err);
  }
  const now = new Date();
  const minuteCount = memory.minuteKey === minuteKeyOf(now) ? memory.minuteCount : 0;
  const dayCount = memory.dayKey === dayKeyOf(now) ? memory.dayCount : 0;
  return {
    minuteCount,
    minuteLimit: FALLBACK_MINUTE_LIMIT,
    dayCount,
    dayLimit: FALLBACK_DAY_LIMIT,
    minuteResetAt: new Date((minuteKeyOf(now) + 1) * 60_000),
    dayResetAt: null,
    source: 'memory',
    exhausted: minuteCount >= FALLBACK_MINUTE_LIMIT || dayCount >= FALLBACK_DAY_LIMIT,
  };
}

/**
 * Install the guard on an axios instance. Every outbound request reserves a
 * slot first; a refusal rejects with the Ruijie "throttled" error so callers
 * follow their existing degraded paths.
 *
 * The interceptor is attached defensively: unit tests stub `axios.create()`
 * with a bare `{ get, post }` object, and older/partial instances must keep
 * working rather than crash at construction time.
 */
export function attachRuijieQuotaGuard(instance: AxiosInstance): AxiosInstance {
  const interceptors = (instance as unknown as { interceptors?: any }).interceptors;
  if (!interceptors?.request?.use) return instance;
  interceptors.request.use(async (config: any) => {
    await reserveRuijieCall();
    return config;
  });
  return instance;
}

/** Test-only: drop process-local state so a suite can re-run cold. */
export function __resetRuijieQuotaForTests(): void {
  memory = { minuteKey: -1, minuteCount: 0, dayKey: '', dayCount: 0 };
  warnedAboutQuotaTable = false;
}

export const __testing = { FALLBACK_MINUTE_LIMIT, FALLBACK_DAY_LIMIT, WORKER_COUNT };
