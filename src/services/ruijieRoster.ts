import { pool } from '../db/pool';
import { getAllRuijieVouchers, isRuijieCloudConfigured } from './ruijieCloud';
import type { RuijieVoucher } from './ruijieCloud';

/**
 * Shared Ruijie voucher roster.
 *
 * Ruijie's open API enforces a very small quota and answers
 * `{ code: 44, msg: "Too many requests" }` long before our own traffic looks
 * heavy. Pulling the roster separately from every PM2 worker, on every open
 * admin tab (the consumption tab used to poll every 30s) and on every alert
 * sweep exhausted it, which is what made voucher creation fail and the
 * consumption tab show "ruijie_unavailable".
 *
 * One snapshot row in Postgres is the rendezvous point:
 *   - fresh (< TTL)   → serve it, no upstream call at all;
 *   - stale           → refresh once, and if the API is throttled keep
 *                       serving the last good snapshot marked `stale`;
 *   - no snapshot yet → propagate the error so callers can fall back to local
 *                       voucher rows.
 *
 * The in-memory copy keeps the exchange cheap within a worker and is the
 * fallback if the cache table has not been migrated yet.
 */

export interface RuijieRoster {
  vouchers: RuijieVoucher[];
  /** When the snapshot was actually pulled from Ruijie; null when never. */
  fetchedAt: Date | null;
  /** True when this answer comes from the cache because the pull failed. */
  stale: boolean;
}

const DEFAULT_TTL_MS = 120_000;
const parsedTtl = Number(process.env.RUIJIE_ROSTER_TTL_MS ?? DEFAULT_TTL_MS);
/** Never hammer upstream more than once every 15s even if misconfigured. */
const TTL_MS = Number.isFinite(parsedTtl) && parsedTtl >= 15_000 ? parsedTtl : DEFAULT_TTL_MS;

let memory: { vouchers: RuijieVoucher[]; fetchedAt: Date } | null = null;
let pendingFetch: Promise<RuijieRoster> | null = null;
let warnedAboutCacheTable = false;

function snapshotFrom(payload: unknown, fetchedAt: unknown): { vouchers: RuijieVoucher[]; fetchedAt: Date } | null {
  if (!Array.isArray(payload)) return null;
  const at = fetchedAt instanceof Date ? fetchedAt : new Date(String(fetchedAt));
  if (Number.isNaN(at.getTime())) return null;
  return { vouchers: payload as RuijieVoucher[], fetchedAt: at };
}

async function readSnapshot(): Promise<{ vouchers: RuijieVoucher[]; fetchedAt: Date } | null> {
  try {
    const { rows } = await pool.query(
      'SELECT payload, fetched_at FROM ruijie_roster_cache WHERE id = 1'
    );
    const stored = rows.length > 0 ? snapshotFrom(rows[0].payload, rows[0].fetched_at) : null;
    if (stored) return stored;
  } catch (err) {
    if (!warnedAboutCacheTable) {
      warnedAboutCacheTable = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[ruijie-roster] cache table unavailable, using in-memory snapshot:', msg);
    }
  }
  return memory;
}

async function writeSnapshot(vouchers: RuijieVoucher[]): Promise<Date> {
  const fetchedAt = new Date();
  memory = { vouchers, fetchedAt };
  try {
    const { rows } = await pool.query(
      `INSERT INTO ruijie_roster_cache (id, payload, fetched_at)
       VALUES (1, $1::jsonb, $2)
       ON CONFLICT (id) DO UPDATE
         SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at
       RETURNING fetched_at`,
      [JSON.stringify(vouchers), fetchedAt]
    );
    const stored = rows[0]?.fetched_at ? new Date(rows[0].fetched_at) : null;
    if (stored && !Number.isNaN(stored.getTime())) return stored;
  } catch (err) {
    if (!warnedAboutCacheTable) {
      warnedAboutCacheTable = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[ruijie-roster] cache table unavailable, using in-memory snapshot:', msg);
    }
  }
  return fetchedAt;
}

function isFresh(at: Date): boolean {
  return Date.now() - at.getTime() < TTL_MS;
}

/**
 * Current roster, from cache when possible. Throws only when Ruijie is
 * unreachable AND no snapshot has ever been stored — callers then fall back
 * to local voucher rows.
 */
export async function getRuijieRoster(): Promise<RuijieRoster> {
  if (!isRuijieCloudConfigured()) {
    return { vouchers: [], fetchedAt: null, stale: false };
  }

  const cached = await readSnapshot();
  if (cached && isFresh(cached.fetchedAt)) {
    return { vouchers: cached.vouchers, fetchedAt: cached.fetchedAt, stale: false };
  }

  if (!pendingFetch) {
    pendingFetch = (async (): Promise<RuijieRoster> => {
      try {
        const vouchers = await getAllRuijieVouchers();
        const fetchedAt = await writeSnapshot(vouchers);
        return { vouchers, fetchedAt, stale: false };
      } finally {
        pendingFetch = null;
      }
    })();
  }
  const pending = pendingFetch;

  try {
    return await pending;
  } catch (err) {
    if (cached) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[ruijie-roster] refresh failed, serving cached snapshot:', msg);
      return { vouchers: cached.vouchers, fetchedAt: cached.fetchedAt, stale: true };
    }
    throw err;
  }
}

/** Test-only: drop the process-local snapshot and any in-flight pull. */
export function __resetRuijieRosterForTests(): void {
  memory = null;
  pendingFetch = null;
  warnedAboutCacheTable = false;
}
