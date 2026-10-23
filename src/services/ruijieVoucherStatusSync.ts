import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { getAllRuijieVouchers, isRuijieCloudConfigured } from './ruijieCloud';
import type { RuijieVoucher } from './ruijieCloud';

/**
 * Universal Ruijie Cloud -> local voucher status reconciliation.
 *
 * Local `vouchers.used_count` is only incremented by the portal signup flow.
 * Codes sold through the admin console or paid online are authorized by the
 * gateway/Ruijie Cloud, so those local rows can stay at used_count=0 forever.
 * The admin list reads status from the `voucher_status` view, which therefore
 * labels a live, remote-voucher as Unused.
 *
 * This sweep is the missing write path: it reads Ruijie's usage counters and
 * mirrors only the lifecycle facts needed by that view. It never touches
 * payment_id, sales, pool_status/assigned_at, holder fields, price, code or
 * package metadata.
 */

const STATUS_SYNC_LOCK = 'preyone:ruijie-voucher-status-sync';
const DEFAULT_INTERVAL_MIN = 5;
const DEFAULT_MIN_INTERVAL_MS = 60_000;

export interface RuijieVoucherState {
  code: string;
  online: boolean;
  activeDevices: number;
  maxClients: number | null;
  hasActivity: boolean;
  expired: boolean;
  depleted: boolean;
  disabled: boolean;
  firstUseAt: Date | null;
  lastActivityAt: Date | null;
  expiresAt: Date | null;
}

export interface LocalVoucherState {
  id: string;
  code: string;
  max_uses: number | null;
  used_count: number | null;
  activated_at: Date | string | null;
  last_seen_at: Date | string | null;
  expires_at: Date | string | null;
  ruijie_sync_status: string | null;
  ruijie_voucher_id: string | null;
  ruijie_active_clients: number | null;
  ruijie_max_clients: number | null;
}

export interface VoucherUpdatePlan {
  usedCount: number;
  activatedAt: Date | null;
  lastSeenAt: Date | null;
  expiresAt: Date | null;
  remoteId: string;
  activeDevices: number;
  maxClients: number | null;
  changed: boolean;
}

export interface RuijieVoucherStatusSyncSummary {
  skipped: boolean;
  reason?: string;
  remoteCount: number;
  matched: number;
  updated: number;
  activated: number;
  expiredOrDepleted: number;
  online: number;
  errors: string[];
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function epochToDate(value: number | undefined): Date | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1_000_000_000_000
    ? value
    : value > 1_000_000_000
      ? value * 1000
      : null;
  return ms == null ? null : new Date(ms);
}

export function isRuijieVoucherOnline(
  voucher: Pick<RuijieVoucher, 'onlineStatus' | 'currentClients'>
): boolean {
  const raw = voucher.onlineStatus;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw > 0;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (['1', 'true', 'online', 'active', 'yes'].includes(value)) return true;
    if (['0', 'false', 'offline', 'inactive', 'no', ''].includes(value)) return false;
  }
  return Number(voucher.currentClients ?? 0) > 0;
}

/** Pure: map Ruijie's counters onto the lifecycle facts the local view uses. */
export function classifyRuijieVoucher(
  voucher: RuijieVoucher,
  nowMs: number = Date.now()
): RuijieVoucherState {
  const code = String(voucher.voucherCode || voucher.codeNo || '').trim().toLowerCase();
  const online = isRuijieVoucherOnline(voucher);
  const usedCount = Number(voucher.usedCount ?? 0);
  const usedTime = Number(voucher.usedTimeMin ?? 0);
  const usedQuota = Number(voucher.usedQuotaMb ?? 0);
  const loginTime = Number(voucher.loginTime ?? 0);
  const quotaMb = Number(voucher.quotaMb);
  const clients = Number(voucher.currentClients);
  const activeDevices = Number.isFinite(clients)
    ? Math.max(0, Math.trunc(clients))
    : online
      ? 1
      : 0;
  const max = Number(voucher.maxClients);
  const maxClients = Number.isFinite(max) && max > 0 ? Math.trunc(max) : null;
  const expiresAt = epochToDate(voucher.expiryTime);
  const firstUseAt = epochToDate(voucher.firstUseTime ?? voucher.loginTime);
  const lastActivityAt = epochToDate(voucher.loginTime ?? voucher.firstUseTime);
  const hasActivity =
    online ||
    usedCount > 0 ||
    usedTime > 0 ||
    usedQuota > 0 ||
    loginTime > 0;
  const depleted =
    Number.isFinite(quotaMb) &&
    quotaMb > 0 &&
    voucher.usedQuotaMb != null &&
    Number.isFinite(Number(voucher.usedQuotaMb)) &&
    Number(voucher.usedQuotaMb) >= quotaMb;

  return {
    code,
    online,
    activeDevices,
    maxClients,
    hasActivity,
    expired: expiresAt != null && expiresAt.getTime() <= nowMs,
    depleted,
    disabled: voucher.disableStatus != null && Number(voucher.disableStatus) !== 0,
    firstUseAt,
    lastActivityAt,
    expiresAt,
  };
}

/**
 * Pure: the exact local mutation for one matched voucher. `expires_at` only
 * moves earlier (or fills a NULL), never extends a local shelf life.
 */
export function planVoucherUpdate(
  local: LocalVoucherState,
  remote: RuijieVoucherState,
  now: Date = new Date()
): VoucherUpdatePlan {
  const currentUsed = Number(local.used_count ?? 0);
  const currentActivated = toDate(local.activated_at);
  const maxUses = Math.max(1, Number(local.max_uses ?? 1));
  // Admin renew/reset deliberately writes used_count=0 while keeping the first
  // activation timestamp. Never undo that reset from stale remote usage, or the
  // renewed PIN becomes unredeemable again (auth rejects used_count>=max_uses).
  const renewedOrReset = currentUsed === 0 && currentActivated != null;
  const targetUsed = renewedOrReset
    ? currentUsed
    : remote.depleted
      ? Math.max(currentUsed, maxUses)
      : remote.hasActivity
        ? Math.max(currentUsed, 1)
        : currentUsed;

  const activatedAt = remote.hasActivity
    ? currentActivated ?? remote.firstUseAt ?? now
    : currentActivated;

  const currentSeen = toDate(local.last_seen_at);
  const observedAt = remote.online
    ? now
    : remote.lastActivityAt ?? currentSeen ?? (remote.hasActivity ? now : null);

  const currentExpiry = toDate(local.expires_at);
  // A renewed voucher's local expiry is authoritative; otherwise mirror a
  // remote expiry only when it is earlier (or fill a NULL local value).
  const expiresAt = renewedOrReset
    ? currentExpiry
    : remote.expiresAt
      ? currentExpiry && currentExpiry.getTime() < remote.expiresAt.getTime()
        ? currentExpiry
        : remote.expiresAt
      : currentExpiry;

  const currentActiveDevices = Math.max(0, Math.trunc(Number(local.ruijie_active_clients ?? 0)));
  const currentMaxClients = local.ruijie_max_clients == null
    ? null
    : Number(local.ruijie_max_clients);
  const maxClients = remote.maxClients ?? currentMaxClients;

  const remoteId = remote.code || local.ruijie_voucher_id || local.code;
  const changed =
    targetUsed !== currentUsed ||
    (activatedAt?.getTime() ?? null) !== (currentActivated?.getTime() ?? null) ||
    (observedAt?.getTime() ?? null) !== (currentSeen?.getTime() ?? null) ||
    (expiresAt?.getTime() ?? null) !== (currentExpiry?.getTime() ?? null) ||
    remote.activeDevices !== currentActiveDevices ||
    maxClients !== currentMaxClients ||
    local.ruijie_sync_status !== 'synced' ||
    !local.ruijie_voucher_id;

  return {
    usedCount: targetUsed,
    activatedAt,
    lastSeenAt: observedAt,
    expiresAt,
    remoteId,
    activeDevices: remote.activeDevices,
    maxClients,
    changed,
  };
}

const LOCAL_MATCH_SQL = `
  SELECT id, code, max_uses, used_count, activated_at, last_seen_at, expires_at,
         ruijie_sync_status, ruijie_voucher_id, ruijie_active_clients, ruijie_max_clients
    FROM vouchers
   WHERE deleted_at IS NULL
     AND (lower(code) = ANY($1::text[]) OR lower(ruijie_voucher_id) = ANY($1::text[]))`;

const UPDATE_SQL = `
  UPDATE vouchers
     SET used_count = $2,
         activated_at = $3,
         last_seen_at = $4,
         expires_at = $5,
         ruijie_sync_status = 'synced',
         ruijie_voucher_id = COALESCE(ruijie_voucher_id, $6),
         ruijie_active_clients = $7,
         ruijie_max_clients = $8
   WHERE id = $1
     AND deleted_at IS NULL`;

let lastCompletedAt = 0;
let running = false;

export async function syncRuijieVoucherStatuses(
  options: { force?: boolean; minIntervalMs?: number } = {}
): Promise<RuijieVoucherStatusSyncSummary> {
  const summary: RuijieVoucherStatusSyncSummary = {
    skipped: false,
    remoteCount: 0,
    matched: 0,
    updated: 0,
    activated: 0,
    expiredOrDepleted: 0,
    online: 0,
    errors: [],
  };

  if (!isRuijieCloudConfigured()) {
    return { ...summary, skipped: true, reason: 'ruijie_cloud_not_configured' };
  }
  if (running) {
    return { ...summary, skipped: true, reason: 'already_running' };
  }

  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  if (!options.force && lastCompletedAt > 0 && Date.now() - lastCompletedAt < minIntervalMs) {
    return { ...summary, skipped: true, reason: 'throttled' };
  }

  running = true;
  let client: PoolClient | null = null;
  let locked = false;
  try {
    client = await pool.connect();
    const lock = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked`,
      [STATUS_SYNC_LOCK]
    );
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) {
      return { ...summary, skipped: true, reason: 'another_worker_running' };
    }

    const remote = await getAllRuijieVouchers();
    summary.remoteCount = remote.length;

    const remoteByCode = new Map<string, RuijieVoucher>();
    for (const voucher of remote) {
      const code = String(voucher.voucherCode || voucher.codeNo || '').trim().toLowerCase();
      if (code && !remoteByCode.has(code)) remoteByCode.set(code, voucher);
    }
    if (remoteByCode.size === 0) return summary;

    const codes = [...remoteByCode.keys()];
    const { rows: locals } = await client.query(LOCAL_MATCH_SQL, [codes]);
    const localByCode = new Map<string, LocalVoucherState>();
    const localByRemoteId = new Map<string, LocalVoucherState>();
    for (const row of locals as LocalVoucherState[]) {
      localByCode.set(String(row.code).trim().toLowerCase(), row);
      if (row.ruijie_voucher_id) {
        localByRemoteId.set(String(row.ruijie_voucher_id).trim().toLowerCase(), row);
      }
    }

    const seen = new Set<string>();
    const now = new Date();
    for (const [code, remoteVoucher] of remoteByCode) {
      const local = localByCode.get(code) ?? localByRemoteId.get(code);
      if (!local || seen.has(local.id)) continue;
      seen.add(local.id);
      summary.matched += 1;

      const remoteState = classifyRuijieVoucher(remoteVoucher, now.getTime());
      if (remoteState.hasActivity && !local.activated_at) summary.activated += 1;
      if (remoteState.expired || remoteState.depleted) summary.expiredOrDepleted += 1;
      if (remoteState.online) summary.online += 1;

      const plan = planVoucherUpdate(local, remoteState, now);
      if (!plan.changed) continue;

      const { rowCount } = await client.query(UPDATE_SQL, [
        local.id,
        plan.usedCount,
        plan.activatedAt,
        plan.lastSeenAt,
        plan.expiresAt,
        plan.remoteId,
        plan.activeDevices,
        plan.maxClients,
      ]);
      if ((rowCount ?? 0) > 0) summary.updated += 1;
    }
  } catch (err) {
    summary.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (client) {
      if (locked) {
        await client
          .query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [STATUS_SYNC_LOCK])
          .catch(() => undefined);
      }
      client.release();
    }
    running = false;
  }

  if (summary.errors.length === 0) lastCompletedAt = Date.now();
  return summary;
}

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

export function startRuijieVoucherStatusWorker(): void {
  if (timer || startupTimer) return;
  if (process.env.RUIJIE_VOUCHER_SYNC_DISABLED === '1') {
    console.log('[ruijie-voucher-status] disabled via RUIJIE_VOUCHER_SYNC_DISABLED');
    return;
  }

  const rawMinutes = process.env.RUIJIE_VOUCHER_SYNC_INTERVAL_MIN;
  const minutes = rawMinutes === undefined || rawMinutes === '' ? DEFAULT_INTERVAL_MIN : Number(rawMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log('[ruijie-voucher-status] periodic sync disabled (RUIJIE_VOUCHER_SYNC_INTERVAL_MIN<=0)');
    return;
  }

  const tick = async () => {
    try {
      const result = await syncRuijieVoucherStatuses();
      if (!result.skipped && (result.updated > 0 || result.errors.length > 0)) {
        console.log(
          `[ruijie-voucher-status] matched=${result.matched} updated=${result.updated} ` +
          `activated=${result.activated} expired/depleted=${result.expiredOrDepleted} online=${result.online}` +
          (result.errors.length ? ` errors=${result.errors.length}` : '')
        );
      }
    } catch (err) {
      console.error('[ruijie-voucher-status] sweep failed', err);
    }
  };

  startupTimer = setTimeout(tick, 30_000);
  startupTimer.unref?.();
  timer = setInterval(tick, minutes * 60_000);
  timer.unref?.();
  console.log(`[ruijie-voucher-status] status sync scheduled every ${minutes} minute(s).`);
}

export function stopRuijieVoucherStatusWorker(): void {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
}
