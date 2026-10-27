import { pool } from '../db/pool';
import { isRateLimitError, isRuijieCloudConfigured, ruijieReadCooldownMsRemaining } from './ruijieCloud';
import { listRuijieOnlineUsers } from './ruijieService';
import type { RuijieOnlineUser } from './ruijieService';

/**
 * Resilient live-session feed (GET /api/ruijie/sessions).
 *
 * Why this exists
 * ---------------
 * Ruijie's Open API has a tiny per-tenant quota. `/dev/user/current-user` used
 * to be fetched by every open admin tab, every 30s, from every PM2 worker —
 * so the quota was permanently pinned at zero (`{ code: 44, msg: "Too many
 * requests" }`) and the Sessions view 502'd. Voucher sales and lookups then
 * degraded with it even though nothing about a sale needs a live socket count.
 *
 * This module is the single sanctioned reader of the live session list:
 *
 *   1. TTL cache — 5 minutes by default (`RUIJIE_SESSION_TTL_MS`). One row in
 *      `ruijie_session_cache` is the cross-worker rendezvous point, mirrored in
 *      process memory so a worker answers without a DB round-trip.
 *   2. Circuit breaker — after `RUIJIE_SESSION_BREAKER_FAILURES` consecutive
 *      failures (a rate-limit trips it immediately) the breaker opens for
 *      `RUIJIE_SESSION_BREAKER_MS` and every caller is served the last good
 *      snapshot without touching upstream. This is what stops a background
 *      sweep from re-arming the throttle the moment it clears.
 *   3. Stale-with-a-warning — a failed refresh never throws. The previous
 *      snapshot is returned with `stale: true` so the admin UI keeps rendering
 *      the last known clients instead of an error page.
 *   4. Cold start — if Ruijie has never answered we return an empty, degraded
 *      snapshot instead of a 5xx. Callers can tell the two apart via `reason`.
 *
 * Concurrency: PM2 runs 4 workers, so the DB row keeps them from each pulling
 * the same feed. Within a worker, in-flight refreshes are deduplicated.
 */

export interface RuijieSessionSnapshot {
  users: RuijieOnlineUser[];
  /** When this list was actually pulled from Ruijie; null when never. */
  fetchedAt: Date | null;
  /** True when Ruijie is unavailable/throttling and this is the last good read. */
  stale: boolean;
  /** True when there is no cached data at all (cold start, upstream down). */
  degraded: boolean;
  reason: RuijieSessionDegradeReason | null;
  /** True while the circuit breaker is suppressing upstream calls. */
  breakerOpen: boolean;
  /** TTL actually in force (ms) — surfaced for the admin tooltip. */
  ttlMs: number;
}

export type RuijieSessionDegradeReason =
  | 'ruijie_cloud_not_configured'
  | 'rate_limited'
  | 'unavailable';

interface StoredSnapshot {
  users: RuijieOnlineUser[];
  fetchedAt: Date;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const ttlFromEnv = Number(process.env.RUIJIE_SESSION_TTL_MS ?? DEFAULT_TTL_MS);
/** Never poll upstream more than once a minute, even if misconfigured. */
export const SESSION_TTL_MS =
  Number.isFinite(ttlFromEnv) && ttlFromEnv >= 60_000 ? ttlFromEnv : DEFAULT_TTL_MS;

const BREAKER_FAILURES = (() => {
  const n = Number(process.env.RUIJIE_SESSION_BREAKER_FAILURES ?? 3);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 3;
})();

const BREAKER_MS = (() => {
  const n = Number(process.env.RUIJIE_SESSION_BREAKER_MS ?? 120_000);
  return Number.isFinite(n) && n >= 10_000 ? n : 120_000;
})();

let memory: StoredSnapshot | null = null;
let pendingRefresh: Promise<StoredSnapshot> | null = null;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;
let warnedAboutCacheTable = false;

function warnCacheTableOnce(err: unknown): void {
  if (warnedAboutCacheTable) return;
  warnedAboutCacheTable = true;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn('[ruijie-session-cache] cache table unavailable, using in-memory snapshot:', msg);
}

function toSnapshot(payload: unknown, fetchedAt: unknown): StoredSnapshot | null {
  if (!Array.isArray(payload)) return null;
  const at = fetchedAt instanceof Date ? fetchedAt : new Date(String(fetchedAt));
  if (Number.isNaN(at.getTime())) return null;
  return { users: payload as RuijieOnlineUser[], fetchedAt: at };
}

async function readSnapshot(): Promise<StoredSnapshot | null> {
  try {
    const { rows } = await pool.query(
      'SELECT payload, fetched_at FROM ruijie_session_cache WHERE id = 1'
    );
    const stored = rows.length > 0 ? toSnapshot(rows[0].payload, rows[0].fetched_at) : null;
    if (stored) {
      // Prefer the row when it is newer than this worker's copy (another worker
      // refreshed while we were idle).
      if (!memory || stored.fetchedAt.getTime() >= memory.fetchedAt.getTime()) {
        memory = stored;
      }
      return stored;
    }
  } catch (err) {
    warnCacheTableOnce(err);
  }
  return memory;
}

async function writeSnapshot(users: RuijieOnlineUser[]): Promise<StoredSnapshot> {
  const snapshot: StoredSnapshot = { users, fetchedAt: new Date() };
  memory = snapshot;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ruijie_session_cache (id, payload, fetched_at)
       VALUES (1, $1::jsonb, $2)
       ON CONFLICT (id) DO UPDATE
         SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at
       RETURNING fetched_at`,
      [JSON.stringify(users), snapshot.fetchedAt]
    );
    const stored = rows[0]?.fetched_at ? new Date(rows[0].fetched_at) : null;
    if (stored && !Number.isNaN(stored.getTime())) {
      snapshot.fetchedAt = stored;
      memory = snapshot;
    }
  } catch (err) {
    warnCacheTableOnce(err);
  }
  return snapshot;
}

function isFresh(at: Date): boolean {
  return Date.now() - at.getTime() < SESSION_TTL_MS;
}

export function isRuijieSessionBreakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

function tripBreaker(err: unknown): void {
  consecutiveFailures += 1;
  const rateLimited = isRateLimitError(err);
  if (rateLimited || consecutiveFailures >= BREAKER_FAILURES) {
    breakerOpenUntil = Date.now() + (rateLimited ? Math.max(BREAKER_MS, 60_000) : BREAKER_MS);
    const secs = Math.ceil((breakerOpenUntil - Date.now()) / 1000);
    console.warn(
      `[ruijie-session-cache] circuit breaker OPEN for ${secs}s` +
      (rateLimited ? ' (Ruijie rate limit)' : ` (${consecutiveFailures} consecutive failures)`) +
      ' — serving cached sessions.'
    );
  }
}

function resetBreaker(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

function degradedSnapshot(
  stored: StoredSnapshot | null,
  reason: RuijieSessionDegradeReason
): RuijieSessionSnapshot {
  if (stored) {
    return {
      users: stored.users,
      fetchedAt: stored.fetchedAt,
      stale: true,
      degraded: false,
      reason,
      breakerOpen: isRuijieSessionBreakerOpen(),
      ttlMs: SESSION_TTL_MS,
    };
  }
  return {
    users: [],
    fetchedAt: null,
    stale: false,
    degraded: true,
    reason,
    breakerOpen: isRuijieSessionBreakerOpen(),
    ttlMs: SESSION_TTL_MS,
  };
}

/**
 * Live sessions, cached. Never throws: an unreachable upstream degrades to the
 * last good snapshot (or an empty list) instead of failing the request.
 *
 * @param opts.force    bypass the TTL (still respects an open breaker).
 * @param opts.telemetry pass through to `listRuijieOnlineUsers` (default on).
 */
export async function getRuijieSessionSnapshot(
  opts: { force?: boolean; telemetry?: boolean } = {}
): Promise<RuijieSessionSnapshot> {
  if (!isRuijieCloudConfigured()) {
    return degradedSnapshot(null, 'ruijie_cloud_not_configured');
  }

  const stored = await readSnapshot();

  // A fresh snapshot needs no upstream call at all.
  if (!opts.force && stored && isFresh(stored.fetchedAt)) {
    return {
      users: stored.users,
      fetchedAt: stored.fetchedAt,
      stale: false,
      degraded: false,
      reason: null,
      breakerOpen: isRuijieSessionBreakerOpen(),
      ttlMs: SESSION_TTL_MS,
    };
  }

  // Breaker open (or another reader already tripped Ruijie's read cooldown):
  // do not deepen the throttle — answer from cache.
  const cooldownLeft = ruijieReadCooldownMsRemaining();
  if (isRuijieSessionBreakerOpen() || cooldownLeft > 0) {
    return degradedSnapshot(stored, 'rate_limited');
  }

  if (!pendingRefresh) {
    pendingRefresh = (async (): Promise<StoredSnapshot> => {
      try {
        const users = await listRuijieOnlineUsers({ stationTelemetry: opts.telemetry !== false });
        const written = await writeSnapshot(users);
        resetBreaker();
        return written;
      } finally {
        pendingRefresh = null;
      }
    })();
  }
  const pending = pendingRefresh;

  try {
    const fresh = await pending;
    return {
      users: fresh.users,
      fetchedAt: fresh.fetchedAt,
      stale: false,
      degraded: false,
      reason: null,
      breakerOpen: isRuijieSessionBreakerOpen(),
      ttlMs: SESSION_TTL_MS,
    };
  } catch (err) {
    tripBreaker(err);
    const reason: RuijieSessionDegradeReason = isRateLimitError(err) ? 'rate_limited' : 'unavailable';
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ruijie-session-cache] refresh failed (${reason}), serving cache:`, msg);
    // Re-read in case another worker wrote while our pull failed.
    const fallback = memory ?? (await readSnapshot());
    return degradedSnapshot(fallback, reason);
  }
}

/** Test-only: drop process-local state so a suite can re-run cold. */
export function __resetRuijieSessionCacheForTests(): void {
  memory = null;
  pendingRefresh = null;
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
  warnedAboutCacheTable = false;
}
