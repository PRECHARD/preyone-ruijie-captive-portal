import axios from 'axios';
import { pool } from '../db/pool';
import {
  getRuijieVouchers,
  isRuijieCloudConfigured,
  RuijieApiError,
  withTokenRefresh,
} from './ruijieCloud';

/**
 * Call Ruijie authentication URL to apply WISPr parameters and unlock a MAC
 * Expects ruijieAuthUrl to be a base URL that accepts query parameters
 */
export async function bypassRuijieFirewall(macAddress: string, ruijieAuthUrl: string, speedBits: number | null, dataBytes: number | null): Promise<boolean> {
  if (!ruijieAuthUrl) return false;
  try {
    let authCommandUrl = ruijieAuthUrl;

    // Ensure URL has a query marker
    if (!authCommandUrl.includes('?')) authCommandUrl += '?';
    else if (!authCommandUrl.endsWith('&') && !authCommandUrl.endsWith('?')) authCommandUrl += '&';

    const ruijiePassword = process.env.RUIJIE_PASSWORD || 'PreyoneNetAccess';
    authCommandUrl += `username=${encodeURIComponent(macAddress)}&password=${encodeURIComponent(ruijiePassword)}`;

    if (speedBits && speedBits > 0) {
      authCommandUrl += `&wispr_bandwidth_max_down=${speedBits}&wispr_bandwidth_max_up=${Math.round(speedBits * 0.5)}`;
    }
    if (dataBytes && dataBytes > 0) {
      authCommandUrl += `&wispr_max_bytes=${dataBytes}`;
    }

    await axios.get(authCommandUrl, { timeout: 5000 });
    console.log(`[AUTONOMOUS HARDWARE PROVISION] Network bypass profile loaded for MAC: ${macAddress}`);
    return true;
  } catch (error: any) {
    console.error('Ruijie bridge deployment error:', error?.message || error);
    return false;
  }
}

// ===========================================================================
// Ruijie Cloud maint API — voucher sync, accounting reconciliation, session
// management (kick) and telemetry. ADDITIVE LAYER: bypassRuijieFirewall above
// and everything in ruijieCloud.ts are untouched. Every function degrades to a
// structured no-op when RUIJIE_CLOUD_* keys are missing, so local DB flows
// keep working without unhandled exceptions.
// ===========================================================================

// Live-verified against the tenant (2026-10): Ruijie Cloud Open API exposes
// these three shapes — probe results, not guesses:
//   GET  /service/api/open/v1/dev/user/current-user?group_id&page_index&page_size
//   POST /logbizagent/logbiz/api/sta/sta_users   body {groupId, staType, pageSize, pageIndex}
//   GET  /service/api/maint/devices?common_type&group_id&page&per_page
// There is NO REST disconnect/kick endpoint (console/CLI only), so
// kickRuijieUser() degrades to a structured `unsupported` result.
const ONLINE_USERS_URL = '/service/api/open/v1/dev/user/current-user';
const STA_USERS_URL = '/logbizagent/logbiz/api/sta/sta_users';
const DEVICES_URL = '/service/api/maint/devices';

const VOUCHER_SYNC_COLUMNS_SQL = `
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS holder_name TEXT;
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS holder_phone TEXT;
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS ruijie_sync_status TEXT;
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS ruijie_voucher_id TEXT;
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS data_consumed_mb NUMERIC(12,2);
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS last_accounting_sync TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_vouchers_ruijie_sync_status
    ON vouchers (ruijie_sync_status) WHERE ruijie_sync_status IS NOT NULL;
`;

function maintConfig() {
  return { groupId: process.env.RUIJIE_CLOUD_GROUP_ID || '' };
}

function maintClient(): ReturnType<typeof axios.create> {
  return axios.create({
    baseURL: process.env.RUIJIE_CLOUD_BASE_URL || 'https://cloud.ruijienetworks.com',
    timeout: 20000,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errMsg(err: unknown): string {
  if (err instanceof RuijieApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Lowercase hex-only MAC (colons/dashes/spaces stripped) — matches voucher_devices.mac_norm. */
export function normalizeRuijieMac(raw: unknown): string {
  return String(raw ?? '').toLowerCase().replace(/[^a-f0-9]/g, '');
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Like pick(), but returns the matched KEY together with the value (field-name hints). */
function pickEntry(obj: Record<string, unknown>, keys: string[]): [string, unknown] | null {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return [k, v];
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Ruijie reports flow either as raw bytes or MB depending on endpoint/version. */
function toMb(v: unknown, hint: string): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  const asMb = /mb/i.test(hint);
  const mb = asMb ? n : n / (1024 * 1024);
  return Math.round(Math.max(0, mb) * 100) / 100;
}

function toSeconds(v: unknown): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  // Heuristic: values above ~10^6 are almost certainly milliseconds.
  return n > 1_000_000 ? Math.round(n / 1000) : Math.round(n);
}

/**
 * Pull the array payload out of a maint-API envelope. Non-zero `code`
 * (e.g. "Parameter group_id is null", permission denied) becomes a
 * RuijieApiError so callers can surface it without throwing elsewhere.
 */
function extractMaintList(payload: unknown, context: string): Record<string, unknown>[] {
  const body = payload as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') throw new RuijieApiError('bad_shape', `${context}: empty response`);

  const data = (body.data ?? body) as Record<string, unknown>;
  for (const probe of [
    (data as any).list,
    (data as any).deviceList,
    (data as any).users,
    (data as any).onlineUserList,
    (data as any).records,
    (data as any).accountingList,
    Array.isArray(data) ? data : null,
    Array.isArray(body) ? body : null,
  ]) {
    if (Array.isArray(probe)) return probe as Record<string, unknown>[];
  }

  const code = body.code ?? (typeof data === 'object' ? (data as any).code : undefined);
  if (code !== undefined && code !== null && Number(code) !== 0) {
    const msg = (body.msg || (body as any).message || 'Ruijie maint API error');
    throw new RuijieApiError(Number(code) || 'unknown', `${context}: ${msg}`);
  }
  return [];
}

/** Required group id — throws a structured config error when absent. */
function requireGroupId(): string {
  const groupId = maintConfig().groupId;
  if (!groupId) throw new RuijieApiError('config', 'RUIJIE_CLOUD_GROUP_ID not configured');
  return groupId;
}

/** Narrowed axios error shape (see maintGet note about `declare module 'axios'`). */
function axiosStatus(err: unknown): { status?: number; message?: string } {
  const e = err as { response?: { status?: number }; message?: string };
  return { status: e?.response?.status, message: e?.message };
}

// ---------------------------------------------------------------------------
// Boot schema (additive, idempotent) — same pattern as ensureStarlinkSchema.
// ---------------------------------------------------------------------------

export async function ensureVoucherRuijieSchema(): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.query(VOUCHER_SYNC_COLUMNS_SQL);
      return;
    } catch (err) {
      lastErr = err;
      const { rows } = await pool
        .query(
          `SELECT COUNT(*)::int AS n FROM information_schema.columns
            WHERE table_name = 'vouchers'
              AND column_name IN ('holder_name','holder_phone','ruijie_sync_status',
                                  'ruijie_voucher_id','data_consumed_mb','last_accounting_sync')`
        )
        .catch(() => ({ rows: [{ n: -1 }] }));
      if (Number(rows[0]?.n) >= 6) return;
      await new Promise((r) => setTimeout(r, attempt * 750));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Online users (live session telemetry)
// ---------------------------------------------------------------------------

export interface RuijieOnlineUser {
  mac: string;
  ip: string | null;
  username: string | null;
  sessionId: string | null;
  usedMb: number | null;
  upMb: number | null;
  downMb: number | null;
  onlineTimeSec: number | null;
}

function parseOnlineUser(u: Record<string, unknown>): RuijieOnlineUser {
  const mac = normalizeRuijieMac(pick(u, ['mac', 'MAC', 'macAddress', 'clientMac', 'stationMac']));
  const up = pickEntry(u, ['flowUp', 'upBytes', 'upFlows', 'uploadBytes', 'sentBytes', 'upMb', 'upFlow', 'wifiUp']);
  const down = pickEntry(u, ['flowDown', 'downBytes', 'downFlows', 'downloadBytes', 'recvBytes', 'downMb', 'downFlow', 'wifiDown']);
  // flowUpDown / wifiUpDown are session-cumulative BYTES (verified live).
  const total = pickEntry(u, ['flowUpDown', 'wifiUpDown', 'usedBytes', 'useBytes', 'totalFlow', 'flow', 'usedFlow', 'bytes', 'traffic', 'usedMb']);
  const code = pick(u, ['userName', 'username', 'name', 'account', 'code', 'voucherCode', 'codeNo']);
  const ip = pick(u, ['ip', 'userIp', 'ipAddress', 'hostIp', 'clientIp']);
  const sid = pick(u, ['onlineId', 'sessionId', 'sessionToken', 'id', 'token']);
  // Duration: activeSec is seconds; activeTime is milliseconds. `onlineTime`
  // is an epoch start timestamp, NOT a duration — never treat it as one.
  const activeSec = toNumber(u.activeSec);
  const activeMs = toNumber(u.activeTime);
  const onlineTimeSec = activeSec !== null ? Math.round(activeSec) : activeMs !== null ? Math.round(activeMs / 1000) : null;
  return {
    mac,
    ip: ip != null ? String(ip) : null,
    username: code != null ? String(code) : null,
    sessionId: sid != null ? String(sid) : null,
    usedMb: total ? toMb(total[1], total[0]) : null,
    upMb: up ? toMb(up[1], up[0]) : null,
    downMb: down ? toMb(down[1], down[0]) : null,
    onlineTimeSec,
  };
}

export async function listRuijieOnlineUsers(): Promise<RuijieOnlineUser[]> {
  if (!isRuijieCloudConfigured()) return [];
  const groupId = requireGroupId();
  return withTokenRefresh(async (accessToken) => {
    try {
      const res = await maintClient().get(ONLINE_USERS_URL, {
        params: {
          group_id: groupId,
          page_index: '1',
          page_size: '1000',
          access_token: accessToken,
        },
      });
      return extractMaintList(res.data, 'open/v1/dev/user/current-user').map(parseOnlineUser);
    } catch (err) {
      const { status, message } = axiosStatus(err);
      if (err instanceof RuijieApiError) throw err;
      throw new RuijieApiError('http', `current-user: ${status ?? 'network error'}${message ? ` ${message}` : ''}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Accounting records (cumulative usage per MAC → attributed to vouchers)
// ---------------------------------------------------------------------------

export interface RuijieAccountingRecord {
  code: string | null;
  mac: string;
  ip: string | null;
  usedMb: number | null;
  onlineTimeSec: number | null;
}

function parseAccountingRecord(r: Record<string, unknown>): RuijieAccountingRecord {
  // No voucher-code field exists on sta_users records (verified live) — the
  // code stays null and syncAccountingData attributes via MAC lookup instead.
  const usage = pickEntry(r, ['wifiUpDown', 'wifiUp', 'wifiDown', 'flowUpDown', 'usedBytes', 'usage', 'flow', 'totalUsedBytes', 'usedFlow', 'bytes', 'usedMb', 'totalFlow']);
  const ip = pick(r, ['userIp', 'ip', 'ipAddress', 'hostIp']);
  const activeMs = toNumber(r.activeTime);
  return {
    code: null,
    mac: normalizeRuijieMac(pick(r, ['mac', 'MAC', 'macAddress', 'clientMac'])),
    ip: ip != null && ip !== '0.0.0.0' ? String(ip) : null,
    usedMb: usage ? toMb(usage[1], usage[0]) : null,
    onlineTimeSec: activeMs !== null ? Math.round(activeMs / 1000) : null,
  };
}

export async function fetchRuijieAccountingRecords(opts: { pageSize?: number } = {}): Promise<RuijieAccountingRecord[]> {
  if (!isRuijieCloudConfigured()) return [];
  const groupId = requireGroupId();
  return withTokenRefresh(async (accessToken) => {
    const post = async (staType: string, pageSize: number): Promise<Record<string, unknown>[]> => {
      try {
        const res = await maintClient().post(`${STA_USERS_URL}?access_token=${encodeURIComponent(accessToken)}`, {
          groupId: Number(groupId),
          staType,
          pageSize,
          pageIndex: 1,
        });
        return extractMaintList(res.data, `sta_users/${staType}`);
      } catch (err) {
        if (err instanceof RuijieApiError) throw err;
        const { status, message } = axiosStatus(err);
        throw new RuijieApiError('http', `sta_users/${staType}: ${status ?? 'network error'}${message ? ` ${message}` : ''}`);
      }
    };

    const size = opts.pageSize ?? 500;
    const results = await post('currentUser', size);
    // Recent offline sessions add history the live list can no longer see.
    // Permission/shape failures on history must never lose the live data.
    try {
      const history = await post('onofflineUserHistory', 200);
      results.push(...history);
    } catch (err) {
      console.warn('[RUIJIE ACCT] sta_users history unavailable:', errMsg(err));
    }
    return results.map(parseAccountingRecord);
  });
}

// ---------------------------------------------------------------------------
// AP/switch/gateway telemetry — GET /service/api/maint/devices (verified
// live). One call per common_type, per Ruijie's API contract.
// ---------------------------------------------------------------------------

export interface RuijieDevice {
  sn: string;
  name: string | null;
  alias: string | null;
  commonType: string | null;
  productClass: string | null;
  softwareVersion: string | null;
  onlineStatus: string | null;
  ip: string | null;
}

function parseDevice(d: Record<string, unknown>): RuijieDevice {
  const sn = pick(d, ['serialNumber', 'sn', 'snNumber']);
  const name = pick(d, ['name', 'aliasName', 'alias']);
  const alias = pick(d, ['aliasName', 'alias', 'name']);
  const commonType = pick(d, ['commonType', 'common_type', 'type']);
  const productClass = pick(d, ['productClass', 'productType', 'model']);
  const softwareVersion = pick(d, ['softwareVersion', 'firmwareVersion', 'version']);
  const onlineStatus = pick(d, ['onlineStatus', 'status']);
  const ip = pick(d, ['managementIp', 'ip', 'localIp', 'mgmtIp']);
  return {
    sn: sn != null ? String(sn) : '',
    name: name != null ? String(name) : null,
    alias: alias != null ? String(alias) : null,
    commonType: commonType != null ? String(commonType) : null,
    productClass: productClass != null ? String(productClass) : null,
    softwareVersion: softwareVersion != null ? String(softwareVersion) : null,
    onlineStatus: onlineStatus != null ? String(onlineStatus) : null,
    ip: ip != null ? String(ip) : null,
  };
}

export async function listRuijieDevices(commonTypes: string[] = ['AP', 'Switch', 'Gateway']): Promise<RuijieDevice[]> {
  if (!isRuijieCloudConfigured()) return [];
  const groupId = requireGroupId();
  return withTokenRefresh(async (accessToken) => {
    const out: RuijieDevice[] = [];
    for (const commonType of commonTypes) {
      try {
        const res = await maintClient().get(DEVICES_URL, {
          params: {
            access_token: accessToken,
            common_type: commonType,
            group_id: groupId,
            page: '1',
            per_page: '200',
          },
        });
        for (const d of extractMaintList(res.data, `maint/devices/${commonType}`)) {
          const dev = parseDevice(d);
          if (dev.sn) out.push(dev);
        }
      } catch (err) {
        // A type the tenant doesn't own (no switches, etc.) must not sink the rest.
        if (err instanceof RuijieApiError && err.code === 'config') throw err;
        console.warn(`[RUIJIE DEV] ${commonType} listing unavailable:`, errMsg(err));
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Accounting reconciliation → vouchers (data_consumed_mb + last_accounting_sync)
//
// Writes ONLY the two accounting columns (+ ruijie_sync_status when matched).
// used_count / activated_at / expires_at / is_disabled — the session state —
// are never touched, so RADIUS decisions stay exactly as they were.
// ---------------------------------------------------------------------------

export interface AccountingSyncResult {
  skipped: boolean;
  reason?: string;
  onlineUsers: number;
  accountingRecords: number;
  matchedVouchers: number;
  updated: number;
  errors: string[];
}

export async function syncAccountingData(): Promise<AccountingSyncResult> {
  const result: AccountingSyncResult = {
    skipped: false,
    onlineUsers: 0,
    accountingRecords: 0,
    matchedVouchers: 0,
    updated: 0,
    errors: [],
  };

  if (!isRuijieCloudConfigured()) {
    result.skipped = true;
    result.reason = 'ruijie_cloud_not_configured';
    return result;
  }

  let online: RuijieOnlineUser[] = [];
  let records: RuijieAccountingRecord[] = [];

  try {
    online = await listRuijieOnlineUsers();
    result.onlineUsers = online.length;
  } catch (err) {
    result.errors.push(`online/users: ${errMsg(err)}`);
  }
  try {
    records = await fetchRuijieAccountingRecords();
    result.accountingRecords = records.length;
  } catch (err) {
    result.errors.push(`accounting/records: ${errMsg(err)}`);
  }

  if (online.length === 0 && records.length === 0) {
    // Offline or empty — leave local data exactly as-is (graceful fallback).
    return result;
  }

  // usage attribution: best (max) MB per local voucher code, keyed lowercase.
  const usageByCode = new Map<string, number>();
  const bump = (code: string, mb: number | null) => {
    if (mb === null) return;
    usageByCode.set(code, Math.max(usageByCode.get(code) ?? 0, mb));
  };

  for (const rec of records) {
    if (rec.code) bump(rec.code, rec.usedMb);
  }
  for (const u of online) {
    if (u.username) bump(u.username.trim().toLowerCase(), u.usedMb);
  }

  // MAC-based attribution: Ruijie reports the station MAC, not the voucher
  // code. Resolve MAC → voucher through voucher_devices (preferred, has
  // mac_norm) then through portal users (mac_address → voucher_code).
  const macTargets = [...new Set([...records.map((r) => r.mac), ...online.map((u) => u.mac)].filter((m) => m.length >= 12))];
  const macUsage = new Map<string, number>();
  for (const rec of records) if (rec.mac && rec.usedMb !== null) macUsage.set(rec.mac, Math.max(macUsage.get(rec.mac) ?? 0, rec.usedMb));
  for (const u of online) if (u.mac && u.usedMb !== null) macUsage.set(u.mac, Math.max(macUsage.get(u.mac) ?? 0, u.usedMb));

  if (macTargets.length > 0) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (mac_norm) mac_norm, voucher_code
           FROM voucher_devices
          WHERE is_active = TRUE AND mac_norm = ANY($1)`,
        [macTargets]
      );
      for (const row of rows) {
        const code = String(row.voucher_code || '').trim().toLowerCase();
        if (code) bump(code, macUsage.get(String(row.mac_norm)) ?? null);
      }

      const unresolved = macTargets.filter((m) => !rows.some((r: any) => String(r.mac_norm) === m));
      if (unresolved.length > 0) {
        const { rows: userRows } = await pool.query(
          `SELECT DISTINCT ON (lower(regexp_replace(mac_address, '[^a-fA-F0-9]', '', 'g')))
             regexp_replace(mac_address, '[^a-fA-F0-9]', '', 'g') AS mac_norm, voucher_code
           FROM users
          WHERE voucher_code IS NOT NULL
            AND lower(regexp_replace(mac_address, '[^a-fA-F0-9]', '', 'g')) = ANY($1)`,
          [unresolved]
        );
        for (const row of userRows) {
          const code = String(row.voucher_code || '').trim().toLowerCase();
          if (code) bump(code, macUsage.get(String(row.mac_norm)) ?? null);
        }
      }
    } catch (err) {
      result.errors.push(`mac attribution: ${errMsg(err)}`);
    }
  }

  if (usageByCode.size === 0) return result;

  for (const [code, mb] of usageByCode) {
    try {
      const { rowCount } = await pool.query(
        `UPDATE vouchers
            SET data_consumed_mb = GREATEST(COALESCE(data_consumed_mb, 0), $2),
                last_accounting_sync = NOW(),
                ruijie_sync_status = COALESCE(ruijie_sync_status, 'synced')
          WHERE lower(code) = $1
            AND deleted_at IS NULL`,
        [code, mb]
      );
      if (rowCount && rowCount > 0) {
        result.updated += rowCount;
        result.matchedVouchers += 1;
      }
    } catch (err) {
      result.errors.push(`update ${code}: ${errMsg(err)}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Client disconnect controller.
//
// Verified live (2026-10): Ruijie Cloud's Open API has NO REST disconnect
// endpoint — probe attempts at /service/api/maint/user/kick,
// /service/api/open/v1/dev/user/kick and .../user/offline all return 404 SPA
// HTML, and the official docs expose disconnect only through the Ruijie Cloud
// console ("Auth Client → Disconnect") or device CLI ("clear web-auth user").
// So this degrades to a structured `unsupported` result instead of hammering
// guessed URLs. The route layer forwards it verbatim so operators get a clear,
// actionable answer rather than a 502.
// ---------------------------------------------------------------------------

export interface KickResult {
  skipped: boolean;
  reason?: string;
  kicked: boolean;
  mac: string | null;
  sessionId: string | null;
  message?: string;
}

export async function kickRuijieUser(target: { mac?: string; sessionToken?: string }): Promise<KickResult> {
  const mac = target.mac ? normalizeRuijieMac(target.mac) : '';
  const sessionId = String(target.sessionToken ?? '').trim();

  if (!mac && !sessionId) {
    throw new RuijieApiError('bad_request', 'A client MAC address or session token is required');
  }
  if (!isRuijieCloudConfigured()) {
    return { skipped: true, reason: 'ruijie_cloud_not_configured', kicked: false, mac: mac || null, sessionId: sessionId || null };
  }

  return {
    skipped: true,
    reason: 'no_rest_kick_endpoint',
    kicked: false,
    mac: mac || null,
    sessionId: sessionId || null,
    message:
      'Ruijie Cloud Open API exposes no disconnect endpoint (console: Auth Client → Disconnect; device CLI: clear web-auth user).',
  };
}

// ---------------------------------------------------------------------------
// Voucher synchronization — verify a local voucher exists on Ruijie Cloud and
// record the outcome. NEVER fabricates or re-mints a code: if Ruijie does not
// have it, the row is flagged 'missing' for an operator to decide.
// ---------------------------------------------------------------------------

export interface VoucherSyncResult {
  skipped: boolean;
  reason?: string;
  code: string;
  existsLocally: boolean;
  foundOnRuijie: boolean;
  status: 'synced' | 'missing' | 'not_found_local' | 'skipped';
  ruijieVoucherId: string | null;
  expiryTime: number | null;
  updated: boolean;
}

export async function syncVoucherToRuijie(rawCode: string): Promise<VoucherSyncResult> {
  const code = String(rawCode ?? '').trim().toLowerCase();
  const base: VoucherSyncResult = {
    skipped: false,
    code,
    existsLocally: false,
    foundOnRuijie: false,
    status: 'skipped',
    ruijieVoucherId: null,
    expiryTime: null,
    updated: false,
  };

  if (!code) throw new RuijieApiError('bad_request', 'A voucher code is required');

  const { rows: localRows } = await pool
    .query(`SELECT id, code, ruijie_sync_status FROM vouchers WHERE lower(code) = $1 AND deleted_at IS NULL`, [code])
    .catch(() => ({ rows: [] as any[] }));
  const local = localRows[0];
  base.existsLocally = !!local;

  if (!local) {
    base.status = 'not_found_local';
    return base;
  }

  if (!isRuijieCloudConfigured()) {
    base.skipped = true;
    base.reason = 'ruijie_cloud_not_configured';
    base.status = 'skipped';
    return base;
  }

  // Search the first pages of the Ruijie voucher list for this code.
  let match: { codeNo: string; expiryTime?: number } | null = null;
  for (const start of [0, 200, 400]) {
    const list = await getRuijieVouchers({ start, pageSize: 200 });
    const hit = list.find((v) => String(v.codeNo ?? v.voucherCode ?? '').trim().toLowerCase() === code);
    if (hit) { match = { codeNo: hit.codeNo || String(hit.voucherCode ?? ''), expiryTime: hit.expiryTime }; break; }
    if (list.length < 200) break;
  }

  if (match) {
    await pool.query(
      `UPDATE vouchers SET ruijie_sync_status = 'synced', ruijie_voucher_id = $2 WHERE id = $1`,
      [local.id, match.codeNo]
    );
    base.foundOnRuijie = true;
    base.status = 'synced';
    base.ruijieVoucherId = match.codeNo;
    base.expiryTime = match.expiryTime ?? null;
    base.updated = true;
  } else {
    await pool.query(`UPDATE vouchers SET ruijie_sync_status = 'missing' WHERE id = $1`, [local.id]);
    base.status = 'missing';
    base.updated = true;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Periodic accounting poll (autonomous telemetry). Opt-out with
// RUIJIE_ACCOUNTING_INTERVAL_MIN=0; skipped entirely when not configured.
// ---------------------------------------------------------------------------

let accountingTimer: NodeJS.Timeout | null = null;

export function startRuijieAccountingPolling(): void {
  if (accountingTimer) return;

  const raw = process.env.RUIJIE_ACCOUNTING_INTERVAL_MIN;
  const minutes = raw === undefined || raw === '' ? 5 : Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log('[RUIJIE ACCT] Periodic accounting sync disabled (RUIJIE_ACCOUNTING_INTERVAL_MIN<=0).');
    return;
  }
  if (!isRuijieCloudConfigured()) {
    console.log('[RUIJIE ACCT] Ruijie Cloud not configured — accounting polling idle (local DB unaffected).');
    return;
  }

  const tick = async () => {
    try {
      const r = await syncAccountingData();
      if (!r.skipped && (r.updated > 0 || r.errors.length > 0)) {
        console.log(
          `[RUIJIE ACCT] synced=${r.updated} online=${r.onlineUsers} records=${r.accountingRecords}` +
          (r.errors.length ? ` errors=${r.errors.length}` : '')
        );
      }
    } catch (err) {
      console.warn('[RUIJIE ACCT] periodic sync failed:', errMsg(err));
    }
  };

  accountingTimer = setInterval(tick, minutes * 60_000);
  accountingTimer.unref?.();
  // First reconciliation shortly after boot (staggered past DB warm-up).
  setTimeout(tick, 30_000).unref?.();
  console.log(`[RUIJIE ACCT] Periodic accounting sync enabled (every ${minutes} min).`);
}
