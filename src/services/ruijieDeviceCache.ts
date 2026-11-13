import { pool } from '../db/pool';
import { isRateLimitError, isRuijieCloudConfigured, ruijieReadCooldownMsRemaining } from './ruijieCloud';
import { listRuijieDevices } from './ruijieService';
import type { RuijieDevice } from './ruijieService';

/**
 * Cached AP / switch / gateway inventory (GET /api/ruijie/devices).
 *
 * `listRuijieDevices()` fans out one upstream call per device class (AP, Switch,
 * Gateway), so a single page load costs three slots of the tenant's tiny Ruijie
 * quota. Topology barely changes, so this module keeps the last good inventory
 * in `ruijie_device_cache` (one row shared by every PM2 worker) for
 * `RUIJIE_DEVICE_TTL_MS` (default 10 minutes) and serves it stale whenever
 * upstream throttles or errors — the Devices tab must never 502 because Ruijie
 * is busy.
 */

export interface RuijieDeviceSnapshot {
  devices: RuijieDevice[];
  fetchedAt: Date | null;
  stale: boolean;
  degraded: boolean;
  reason: 'ruijie_cloud_not_configured' | 'rate_limited' | 'unavailable' | null;
  breakerOpen: boolean;
  ttlMs: number;
}

interface StoredDevices {
  devices: RuijieDevice[];
  fetchedAt: Date;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const ttlFromEnv = Number(process.env.RUIJIE_DEVICE_TTL_MS ?? DEFAULT_TTL_MS);

/** Never pull the inventory more than once a minute, even if misconfigured. */
export const DEVICE_TTL_MS =
  Number.isFinite(ttlFromEnv) && ttlFromEnv >= 60_000 ? ttlFromEnv : DEFAULT_TTL_MS;

const BREAKER_MS = (() => {
  const n = Number(process.env.RUIJIE_DEVICE_BREAKER_MS ?? 180_000);
  return Number.isFinite(n) && n >= 10_000 ? n : 180_000;
})();

let memory: StoredDevices | null = null;
let pendingRefresh: Promise<StoredDevices> | null = null;
let breakerOpenUntil = 0;
let warnedAboutCacheTable = false;

function warnCacheTableOnce(err: unknown): void {
  if (warnedAboutCacheTable) return;
  warnedAboutCacheTable = true;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn('[ruijie-device-cache] cache table unavailable, using in-memory snapshot:', msg);
}

function toStored(payload: unknown, fetchedAt: unknown): StoredDevices | null {
  if (!Array.isArray(payload)) return null;
  const at = fetchedAt instanceof Date ? fetchedAt : new Date(String(fetchedAt));
  if (Number.isNaN(at.getTime())) return null;
  return { devices: payload as RuijieDevice[], fetchedAt: at };
}

async function readStored(): Promise<StoredDevices | null> {
  try {
    const { rows } = await pool.query(
      'SELECT payload, fetched_at FROM ruijie_device_cache WHERE id = 1'
    );
    const stored = rows.length > 0 ? toStored(rows[0].payload, rows[0].fetched_at) : null;
    if (stored) {
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

async function writeStored(devices: RuijieDevice[]): Promise<StoredDevices> {
  const snapshot: StoredDevices = { devices, fetchedAt: new Date() };
  memory = snapshot;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ruijie_device_cache (id, payload, fetched_at)
       VALUES (1, $1::jsonb, $2)
       ON CONFLICT (id) DO UPDATE
         SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at
       RETURNING fetched_at`,
      [JSON.stringify(devices), snapshot.fetchedAt]
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

export function isRuijieDeviceBreakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

function result(
  stored: StoredDevices | null,
  reason: RuijieDeviceSnapshot['reason'],
  stale: boolean
): RuijieDeviceSnapshot {
  return {
    devices: stored?.devices ?? [],
    fetchedAt: stored?.fetchedAt ?? null,
    stale,
    degraded: !stored,
    reason,
    breakerOpen: isRuijieDeviceBreakerOpen(),
    ttlMs: DEVICE_TTL_MS,
  };
}

/**
 * Last known device inventory. Never throws: a throttled or unreachable
 * upstream returns the cached snapshot with `stale: true`.
 */
export async function getRuijieDeviceSnapshot(
  opts: { force?: boolean } = {}
): Promise<RuijieDeviceSnapshot> {
  if (!isRuijieCloudConfigured()) {
    return result(null, 'ruijie_cloud_not_configured', false);
  }

  const stored = await readStored();
  const fresh = stored && Date.now() - stored.fetchedAt.getTime() < DEVICE_TTL_MS;

  if (fresh && !opts.force) {
    return result(stored, null, false);
  }

  if (isRuijieDeviceBreakerOpen() || ruijieReadCooldownMsRemaining() > 0) {
    return result(stored, 'rate_limited', Boolean(stored));
  }

  if (!pendingRefresh) {
    pendingRefresh = (async (): Promise<StoredDevices> => {
      try {
        const devices = await listRuijieDevices();
        const written = await writeStored(devices);
        breakerOpenUntil = 0;
        return written;
      } finally {
        pendingRefresh = null;
      }
    })();
  }
  const pending = pendingRefresh;

  try {
    const request = await pending;
    return result(request, null, false);
  } catch (err) {
    const rateLimited = isRateLimitError(err);
    breakerOpenUntil = Date.now() + (rateLimited ? Math.max(BREAKER_MS, 60_000) : BREAKER_MS);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ruijie-device-cache] refresh failed (${rateLimited ? 'rate_limited' : 'unavailable'}), serving cache:`,
      msg
    );
    const fallback = memory ?? (await readStored());
    return result(fallback, rateLimited ? 'rate_limited' : 'unavailable', Boolean(fallback));
  }
}

/** Test-only: drop process-local state so a suite can re-run cold. */
export function __resetRuijieDeviceCacheForTests(): void {
  memory = null;
  pendingRefresh = null;
  breakerOpenUntil = 0;
  warnedAboutCacheTable = false;
}
