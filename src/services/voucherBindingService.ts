import { pool } from '../db/pool';

// ===========================================================================
// Shared MAC → voucher resolver.
//
// Why this exists: Ruijie reports clients by MAC, never by voucher code, so
// every consumer (session enrichment, accounting attribution, usage rollup)
// needs the same join. It was previously written twice — once in
// routes/ruijie.ts and once in services/ruijieService.ts — and both copies
// carried the same bug:
//
//   voucher_devices.mac_norm and users.mac_address store UPPERCASE 12-hex
//   (see deviceBinding.normalizeMac), but normalizeRuijieMac() returns
//   lowercase, so `mac_norm = ANY($1)` never matched the primary indexed
//   source. Measured live: lowercase lookup = 0 rows, uppercase = 1 row,
//   which is exactly why session PIN coverage sat at ~3% (only the lower()
//   -wrapped users fallback could ever hit).
//
// All key handling below is done ONCE, here, in `bindingMacKey()`.
// ===========================================================================

export type BindingSource =
  | 'voucher_devices'
  | 'voucher_redemptions'
  | 'wispr_profiles'
  | 'users'
  | 'ruijie_user_name'
  | 'ip_session';

export interface VoucherBinding {
  /** Lowercased voucher code, or null when nothing resolved. */
  code: string | null;
  holderName: string | null;
  holderPhone: string | null;
  source: BindingSource | null;
}

export const UNBOUND: Readonly<VoucherBinding> = Object.freeze({
  code: null,
  holderName: null,
  holderPhone: null,
  source: null,
});

/**
 * Canonical MAC key: 12 lowercase hex chars, or null when unusable.
 * Accepts any spelling Ruijie or Postgres may hand us — colon, dash, dot
 * (macaddr style `0cb5.27ed.fef4`), uppercase, or bare.
 */
export function normalizeMac(raw: unknown): string | null {
  const hex = String(raw ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(hex) ? hex : null;
}

/** Back-compat alias — both names are the same canonical lowercase 12-hex key. */
export function bindingMacKey(raw: unknown): string | null {
  return normalizeMac(raw);
}

/** voucher_devices.mac_norm is stored UPPERCASE — keep that spelling for the indexed lookup. */
function macNormUpper(key: string): string {
  return key.toUpperCase();
}

/** regexp used inline for the macaddr-style columns (redemptions/users/wispr). */
const MAC_SQL = (col: string) => `lower(regexp_replace(${col}, '[^0-9a-fA-F]', '', 'g'))`;

/**
 * Cheap shape filter so obviously-not-a-code labels never reach the database.
 *
 * Codes are generated from a no-vowel/digit alphabet with no spaces
 * (routes/admin.ts `${slug}-${rand}`, payments.ts `CT-` + 8 chars, and 6-char
 * Ruijie mints) — so anything containing whitespace, or longer than any of
 * those shapes, is a device/person label and can be dropped outright. Passing
 * the filter only buys a lookup; `vouchers.code` is still the thing that
 * decides, so a false positive can never surface as a PIN.
 */
function looksLikeVoucherCode(raw: unknown): boolean {
  return /^[a-z0-9][a-z0-9-]{3,23}$/.test(String(raw ?? '').trim().toLowerCase());
}

interface CodeRow {
  code: string;
}

/**
 * Resolve a batch of client MACs to voucher codes.
 *
 * Source precedence (first hit wins):
 *   1. voucher_devices     — explicit per-device binding (indexed, authoritative)
 *   2. voucher_redemptions — MAC captured at redemption time
 *   3. wispr_profiles      — MAC captured on the live WISPr gateway session
 *   4. users               — profile MAC written at signup
 *
 * Returned keys are canonical (`bindingMacKey`). MACs that resolve to nothing
 * are simply absent from the map — callers fall back to `UNBOUND`.
 * A single failing query degrades that source only; the rest still answer.
 */
export async function resolveVoucherBindings(
  macs: Iterable<unknown>
): Promise<Map<string, VoucherBinding>> {
  const out = new Map<string, VoucherBinding>();
  const keys = [...new Set([...macs].map(bindingMacKey).filter((k): k is string => k !== null))];
  if (keys.length === 0) return out;

  const assign = (key: string, code: unknown, source: BindingSource) => {
    if (out.has(key)) return;
    const normalized = String(code ?? '').trim().toLowerCase();
    if (!normalized) return;
    out.set(key, { code: normalized, holderName: null, holderPhone: null, source });
  };

  // 1) voucher_devices — UPPERCASE mac_norm, uppercase keys keep the index usable.
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (mac_norm) mac_norm, voucher_code
         FROM voucher_devices
        WHERE is_active = TRUE AND mac_norm = ANY($1::text[])`,
      [keys.map(macNormUpper)]
    );
    for (const row of rows) {
      const key = bindingMacKey(row.mac_norm);
      if (key) assign(key, row.voucher_code, 'voucher_devices');
    }
  } catch (err) {
    console.error('[VoucherBinding] voucher_devices lookup failed:', err);
  }

  // 2) voucher_redemptions — macaddr-style (`0cb5.27ed.fef4`).
  const unresolved = keys.filter((k) => !out.has(k));
  if (unresolved.length > 0) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (${MAC_SQL('mac_address')}) ${MAC_SQL('mac_address')} AS mac_key, voucher_code
           FROM voucher_redemptions
          WHERE ${MAC_SQL('mac_address')} = ANY($1::text[])`,
        [unresolved]
      );
      for (const row of rows) {
        const key = bindingMacKey(row.mac_key);
        if (key) assign(key, row.voucher_code, 'voucher_redemptions');
      }
    } catch (err) {
      console.error('[VoucherBinding] voucher_redemptions lookup failed:', err);
    }
  }

  // 3) wispr_profiles → users.voucher_code (wispr has no code column of its own).
  const stillUnresolved = keys.filter((k) => !out.has(k));
  if (stillUnresolved.length > 0) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (k) k AS mac_key, voucher_code
           FROM (
             SELECT ${MAC_SQL('wp.mac_address')} AS k, u.voucher_code
               FROM wispr_profiles wp
               JOIN users u ON u.id = wp.user_id
              WHERE u.voucher_code IS NOT NULL
           ) AS w
          WHERE k = ANY($1::text[])`,
        [stillUnresolved]
      );
      for (const row of rows) {
        const key = bindingMacKey(row.mac_key);
        if (key) assign(key, row.voucher_code, 'wispr_profiles');
      }
    } catch (err) {
      console.error('[VoucherBinding] wispr_profiles lookup failed:', err);
    }
  }

  // 4) users — last resort.
  const lastResort = keys.filter((k) => !out.has(k));
  if (lastResort.length > 0) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (mac_key) mac_key, voucher_code
           FROM (
             SELECT ${MAC_SQL('mac_address')} AS mac_key, voucher_code
               FROM users
              WHERE voucher_code IS NOT NULL
           ) AS u
          WHERE mac_key = ANY($1::text[])`,
        [lastResort]
      );
      for (const row of rows) {
        const key = bindingMacKey(row.mac_key);
        if (key) assign(key, row.voucher_code, 'users');
      }
    } catch (err) {
      console.error('[VoucherBinding] users lookup failed:', err);
    }
  }

  await attachHolderDetails(out);
  return out;
}

/** Convenience wrapper for a single MAC. */
export async function resolveVoucherBinding(mac: unknown): Promise<VoucherBinding> {
  const key = bindingMacKey(mac);
  if (!key) return { ...UNBOUND };
  const map = await resolveVoucherBindings([key]);
  return map.get(key) ?? { ...UNBOUND };
}

/**
 * Holder details for every code already resolved in the map (mutates in place).
 * Never throws — a missing holder just leaves the name/phone null.
 */
async function attachHolderDetails(bindings: Map<string, VoucherBinding>): Promise<void> {
  const codes = [...new Set([...bindings.values()].map((b) => b.code).filter((c): c is string => !!c))];
  if (codes.length === 0) return;
  const holders = await loadHolders(codes);
  for (const binding of bindings.values()) {
    if (!binding.code) continue;
    const holder = holders.get(binding.code);
    if (holder) {
      binding.holderName = holder.name;
      binding.holderPhone = holder.phone;
    }
  }
}

/** Holder name/phone per (lowercased) voucher code. One query, never throws. */
export async function loadHolders(
  codes: Iterable<unknown>
): Promise<Map<string, { name: string | null; phone: string | null }>> {
  const wanted = [...new Set(
    [...codes].map((c) => String(c ?? '').trim().toLowerCase()).filter(Boolean)
  )];
  const out = new Map<string, { name: string | null; phone: string | null }>();
  if (wanted.length === 0) return out;
  try {
    const { rows } = await pool.query(
      `SELECT lower(code) AS code, holder_name, holder_phone
         FROM vouchers
        WHERE lower(code) = ANY($1::text[]) AND deleted_at IS NULL`,
      [wanted]
    );
    for (const row of rows) {
      out.set(String(row.code), { name: row.holder_name ?? null, phone: row.holder_phone ?? null });
    }
  } catch (err) {
    console.error('[VoucherBinding] holder lookup failed:', err);
  }
  return out;
}

/**
 * Strict contract: confirm a reported identifier really IS a voucher code
 * before it is ever shown as one.
 *
 * Ruijie's `userName` is a device/person label (live sample: "M2003J15SC-
 * 636333004", 15-18 chars with letters and spaces) — NOT a voucher PIN. This
 * returns the stored code only when it matches `vouchers.code` case-
 * insensitively, otherwise null so the UI can render an em-dash.
 */
export async function verifyVoucherCode(raw: unknown): Promise<string | null> {
  const map = await verifyVoucherCodes([raw]);
  const candidate = String(raw ?? '').trim().toLowerCase();
  return map.get(candidate) ?? null;
}

/**
 * Batch form — one query for a whole page of sessions.
 * Map key = the candidate as sent in (trimmed, lowercased); value = the code
 * actually stored on `vouchers` (also lowercased).
 */
export async function verifyVoucherCodes(
  candidates: Iterable<unknown>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(
    [...candidates].map((c) => String(c ?? '').trim().toLowerCase()).filter(looksLikeVoucherCode)
  )];
  if (wanted.length === 0) return out;
  try {
    const { rows } = await pool.query<CodeRow>(
      `SELECT lower(code) AS code
         FROM vouchers
        WHERE lower(code) = ANY($1::text[]) AND deleted_at IS NULL`,
      [wanted]
    );
    for (const row of rows) {
      if (row.code) out.set(row.code, row.code);
    }
  } catch (err) {
    console.error('[VoucherBinding] code verification failed:', err);
  }
  return out;
}

// ===========================================================================
// Session identity resolution — direct code → MAC binding → IP/portal.
//
// Active Sessions already knew a client's MAC and (usually) an IP, but the
// resolver only ever consulted MAC sources. Ruijie can report the voucher PIN
// itself in `userName`/`account`; when it does, that is the strongest signal
// and must win over any stale MAC binding. Portal signups also leave an IP on
// `users`/`access_log`, which covers clients whose MAC was never bound.
// ===========================================================================

export type AccountMatchSource = 'code' | 'mac' | 'ip';

export interface SessionIdentityInput {
  mac?: unknown;
  ip?: unknown;
  /** Ruijie `userName`/`account` labels — verified against vouchers.code. */
  codeCandidates?: unknown[];
}

export interface SessionAccount {
  code: string | null;
  holderName: string | null;
  holderPhone: string | null;
  bindingSource: BindingSource | null;
  matchedBy: AccountMatchSource | null;
  accountName: string | null;
  accountPhone: string | null;
  accountSessionExpiresAt: string | null;
  dataLimitBytes: number | null;
  dataUsedBytes: number | null;
  dataLeftBytes: number | null;
  isUncapped: boolean | null;
  activeDeviceCount: number;
  deviceMacs: string[];
  authMethod: 'VOUCHER' | 'MAC_AUTO';
  macWhitelisted: boolean;
}

function emptyAccount(): SessionAccount {
  return {
    code: null,
    holderName: null,
    holderPhone: null,
    bindingSource: null,
    matchedBy: null,
    accountName: null,
    accountPhone: null,
    accountSessionExpiresAt: null,
    dataLimitBytes: null,
    dataUsedBytes: null,
    dataLeftBytes: null,
    isUncapped: null,
    activeDeviceCount: 0,
    deviceMacs: [],
    authMethod: 'MAC_AUTO',
    macWhitelisted: false,
  };
}

/** Canonical IPv4 key; strips the IPv4-mapped IPv6 prefix Ruijie sometimes sends. */
function ipKey(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value || value === '0.0.0.0') return null;
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

interface IpAccountRow {
  ip: string;
  code: string;
  name: string | null;
  phone: string | null;
  expiresAt: string | null;
}

/**
 * Last-resort lookup: recent portal authorizations keyed by client IP.
 * Covers clients that were never MAC-bound (e.g. a gateway that reports a
 * different MAC spelling) while staying inside a 24h window so stale users
 * from another DHCP lease cannot hijack the session.
 */
async function resolveIpAccounts(ips: string[]): Promise<Map<string, IpAccountRow>> {
  const out = new Map<string, IpAccountRow>();
  if (ips.length === 0) return out;
  try {
    const { rows } = await pool.query(
      `WITH recent AS (
         SELECT host(u.ip_address) AS ip, lower(u.voucher_code) AS code,
                u.full_name AS name, u.phone,
                u.session_expires_at AS expires_at, u.created_at AS seen_at
           FROM users u
          WHERE u.ip_address IS NOT NULL AND u.voucher_code IS NOT NULL
            AND (u.session_expires_at > NOW() OR u.created_at > NOW() - INTERVAL '24 hours')
         UNION ALL
         SELECT host(al.ip_address), lower(u.voucher_code),
                u.full_name, u.phone,
                u.session_expires_at, al.created_at
           FROM access_log al
           JOIN users u ON u.id = al.user_id
          WHERE al.ip_address IS NOT NULL AND u.voucher_code IS NOT NULL
            AND al.created_at > NOW() - INTERVAL '24 hours'
       )
       SELECT DISTINCT ON (ip) ip, code, name, phone, expires_at
         FROM recent
        WHERE ip = ANY($1::text[])
        ORDER BY ip, seen_at DESC`,
      [ips]
    );
    for (const row of rows) {
      const ip = ipKey(row.ip);
      const code = String(row.code ?? '').trim().toLowerCase();
      if (!ip || !code) continue;
      out.set(ip, {
        ip,
        code,
        name: row.name ?? null,
        phone: row.phone ?? null,
        expiresAt: isoOrNull(row.expires_at),
      });
    }
  } catch (err) {
    console.error('[VoucherBinding] ip/portal lookup failed:', err);
  }
  return out;
}

/** Convenience wrapper for accounting attribution: IP → verified voucher code. */
export async function resolveVoucherCodesByIp(ips: Iterable<unknown>): Promise<Map<string, string>> {
  const keys = [...new Set([...ips].map(ipKey).filter((k): k is string => k !== null))];
  const accounts = await resolveIpAccounts(keys);
  const out = new Map<string, string>();
  for (const [ip, account] of accounts) out.set(ip, account.code);
  return out;
}

interface VoucherDataRow {
  code: string;
  holderName: string | null;
  holderPhone: string | null;
  dataLimitBytes: number | null;
  dataUsedBytes: number | null;
  isUncapped: boolean;
}

/**
 * Remaining-data math for a batch of codes. `vouchers.data_consumed_mb` is the
 * accounting authority; when it is still null (never synced) we fall back to
 * the live WISPr profile counters.
 */
async function loadVoucherData(codes: string[]): Promise<Map<string, VoucherDataRow>> {
  const out = new Map<string, VoucherDataRow>();
  if (codes.length === 0) return out;

  const base = new Map<string, Record<string, unknown>>();
  try {
    const { rows } = await pool.query(
      `SELECT lower(code) AS code, holder_name, holder_phone,
              data_limit_gb, is_uncapped, data_consumed_mb
         FROM vouchers
        WHERE lower(code) = ANY($1::text[]) AND deleted_at IS NULL`,
      [codes]
    );
    for (const row of rows) {
      const code = String(row.code ?? '').trim().toLowerCase();
      if (code) base.set(code, row);
    }
  } catch (err) {
    console.error('[VoucherBinding] voucher data lookup failed:', err);
  }

  const usage = new Map<string, { usedBytes: number | null; quotaBytes: number | null }>();
  try {
    const { rows } = await pool.query(
      `SELECT lower(u.voucher_code) AS code,
              COALESCE(SUM(wp.data_used_bytes) FILTER (
                WHERE wp.session_end IS NULL OR wp.session_start > NOW() - INTERVAL '24 hours'
              ), 0)::bigint AS used_bytes,
              MAX(wp.data_quota_bytes)::bigint AS quota_bytes
         FROM users u
         JOIN wispr_profiles wp ON wp.user_id = u.id
        WHERE lower(u.voucher_code) = ANY($1::text[])
        GROUP BY lower(u.voucher_code)`,
      [codes]
    );
    for (const row of rows) {
      const code = String(row.code ?? '').trim().toLowerCase();
      if (!code) continue;
      usage.set(code, {
        usedBytes: row.used_bytes === null || row.used_bytes === undefined ? null : Number(row.used_bytes),
        quotaBytes: row.quota_bytes === null || row.quota_bytes === undefined ? null : Number(row.quota_bytes),
      });
    }
  } catch (err) {
    console.error('[VoucherBinding] voucher usage lookup failed:', err);
  }

  for (const code of codes) {
    const row = base.get(code);
    if (!row) continue;
    const isUncapped = Boolean(row.is_uncapped);
    const limitGb = row.data_limit_gb === null || row.data_limit_gb === undefined ? null : Number(row.data_limit_gb);
    const consumedMb = row.data_consumed_mb === null || row.data_consumed_mb === undefined ? null : Number(row.data_consumed_mb);
    const profile = usage.get(code);
    const limitBytes = isUncapped
      ? null
      : limitGb !== null && Number.isFinite(limitGb)
        ? Math.round(limitGb * 1024 * 1024 * 1024)
        : profile?.quotaBytes ?? null;
    const usedBytes = consumedMb !== null && Number.isFinite(consumedMb)
      ? Math.round(consumedMb * 1024 * 1024)
      : profile?.usedBytes ?? null;
    out.set(code, {
      code,
      holderName: (row.holder_name as string | null) ?? null,
      holderPhone: (row.holder_phone as string | null) ?? null,
      dataLimitBytes: limitBytes,
      dataUsedBytes: usedBytes,
      isUncapped,
    });
  }
  return out;
}

/** All active MACs tied to each code — explicit bindings plus historical profiles. */
async function loadVoucherDevices(codes: string[]): Promise<Map<string, { count: number; macs: string[] }>> {
  const out = new Map<string, { count: number; macs: string[] }>();
  if (codes.length === 0) return out;
  try {
    const { rows } = await pool.query(
      `WITH devices AS (
         SELECT lower(voucher_code) AS code, mac_norm AS mac
           FROM voucher_devices
          WHERE is_active = TRUE
         UNION
         SELECT lower(u.voucher_code), upper(regexp_replace(u.mac_address, '[^0-9a-fA-F]', '', 'g'))
           FROM users u
          WHERE u.voucher_code IS NOT NULL AND u.mac_address IS NOT NULL
         UNION
         SELECT lower(u.voucher_code), upper(regexp_replace(wp.mac_address, '[^0-9a-fA-F]', '', 'g'))
           FROM wispr_profiles wp
           JOIN users u ON u.id = wp.user_id
          WHERE u.voucher_code IS NOT NULL AND wp.mac_address IS NOT NULL
       )
       SELECT code,
              COUNT(DISTINCT mac)::int AS device_count,
              ARRAY_AGG(DISTINCT mac) AS device_macs
         FROM devices
        WHERE code = ANY($1::text[]) AND length(mac) = 12
        GROUP BY code`,
      [codes]
    );
    for (const row of rows) {
      const code = String(row.code ?? '').trim().toLowerCase();
      if (!code) continue;
      const macs = Array.isArray(row.device_macs)
        ? row.device_macs
            .map((mac: unknown) => normalizeMac(mac))
            .filter((mac: string | null): mac is string => mac !== null)
        : [];
      out.set(code, { count: Number(row.device_count) || macs.length, macs });
    }
  } catch (err) {
    console.error('[VoucherBinding] voucher device lookup failed:', err);
  }
  return out;
}

async function loadWhitelistedMacs(macs: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (macs.length === 0) return out;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT lower(regexp_replace(mac_address, '[^0-9a-fA-F]', '', 'g')) AS mac
         FROM mac_whitelist
        WHERE lower(regexp_replace(mac_address, '[^0-9a-fA-F]', '', 'g')) = ANY($1::text[])`,
      [macs]
    );
    for (const row of rows) {
      const mac = normalizeMac(row.mac);
      if (mac) out.add(mac);
    }
  } catch (err) {
    console.error('[VoucherBinding] mac whitelist lookup failed:', err);
  }
  return out;
}

/**
 * Resolve a batch of live sessions using the required precedence:
 *   1. direct voucher code reported by Ruijie (`userName`/`account`)
 *   2. MAC binding (voucher_devices → redemptions → WISPr → users)
 *   3. IP/portal authorization seen in the last 24h
 *
 * Also attaches holder/account details, remaining data, multi-device links and
 * the AUTH classification. Every stage degrades independently; a failed lookup
 * just leaves that field null instead of failing the whole sessions page.
 */
export async function resolveSessionAccounts(
  sessions: SessionIdentityInput[]
): Promise<SessionAccount[]> {
  const results = sessions.map(() => emptyAccount());
  if (sessions.length === 0) return results;

  const macs = sessions.map((session) => normalizeMac(session.mac));
  const ips = sessions.map((session) => ipKey(session.ip));

  // 1) Direct code match — the PIN reported by Ruijie wins over stale bindings.
  const candidates = sessions.flatMap((session) =>
    (session.codeCandidates ?? []).map((candidate) => String(candidate ?? '').trim()).filter(Boolean)
  );
  if (candidates.length > 0) {
    const verified = await verifyVoucherCodes(candidates);
    sessions.forEach((session, index) => {
      for (const candidate of session.codeCandidates ?? []) {
        const code = verified.get(String(candidate ?? '').trim().toLowerCase());
        if (!code) continue;
        results[index].code = code;
        results[index].bindingSource = 'ruijie_user_name';
        results[index].matchedBy = 'code';
        results[index].authMethod = 'VOUCHER';
        break;
      }
    });
  }

  // 2) MAC binding — explicit device binding, redemption, WISPr, then users.
  const unresolvedMacs = [
    ...new Set(macs.filter((mac, index) => mac !== null && !results[index].code)),
  ] as string[];
  if (unresolvedMacs.length > 0) {
    const bindings = await resolveVoucherBindings(unresolvedMacs);
    sessions.forEach((_, index) => {
      const mac = macs[index];
      if (results[index].code || !mac) return;
      const binding = bindings.get(mac);
      if (!binding?.code) return;
      results[index].code = binding.code;
      results[index].holderName = binding.holderName;
      results[index].holderPhone = binding.holderPhone;
      results[index].bindingSource = binding.source;
      results[index].matchedBy = 'mac';
      results[index].authMethod = 'VOUCHER';
    });
  }

  // 3) IP/portal session — last resort for clients whose MAC was never bound.
  const unresolvedIps = [
    ...new Set(ips.filter((ip, index) => ip !== null && !results[index].code)),
  ] as string[];
  if (unresolvedIps.length > 0) {
    const accounts = await resolveIpAccounts(unresolvedIps);
    sessions.forEach((_, index) => {
      const ip = ips[index];
      if (results[index].code || !ip) return;
      const account = accounts.get(ip);
      if (!account) return;
      results[index].code = account.code;
      results[index].holderName = account.name;
      results[index].holderPhone = account.phone;
      results[index].accountName = account.name;
      results[index].accountPhone = account.phone;
      results[index].accountSessionExpiresAt = account.expiresAt;
      results[index].bindingSource = 'ip_session';
      results[index].matchedBy = 'ip';
      results[index].authMethod = 'VOUCHER';
    });
  }

  // 4) AUTH for remaining clients: MAC bypass/whitelist vs unclassified.
  const unresolvedMacKeys = [
    ...new Set(macs.filter((mac, index) => mac !== null && !results[index].code)),
  ] as string[];
  const whitelisted = await loadWhitelistedMacs(unresolvedMacKeys);
  sessions.forEach((_, index) => {
    if (results[index].code) return;
    const mac = macs[index];
    results[index].authMethod = 'MAC_AUTO';
    results[index].macWhitelisted = !!(mac && whitelisted.has(mac));
  });

  // 5) Data allowance, live usage and multi-device links for every code.
  const codes = [...new Set(results.map((result) => result.code).filter((code): code is string => !!code))];
  if (codes.length > 0) {
    const [data, devices] = await Promise.all([
      loadVoucherData(codes),
      loadVoucherDevices(codes),
    ]);
    results.forEach((result) => {
      if (!result.code) return;
      const row = data.get(result.code);
      if (row) {
        result.holderName = result.holderName ?? row.holderName;
        result.holderPhone = result.holderPhone ?? row.holderPhone;
        result.isUncapped = row.isUncapped;
        result.dataLimitBytes = row.dataLimitBytes;
        result.dataUsedBytes = row.dataUsedBytes;
        result.dataLeftBytes =
          row.isUncapped || row.dataLimitBytes === null || row.dataUsedBytes === null
            ? null
            : Math.max(0, row.dataLimitBytes - row.dataUsedBytes);
      }
      const device = devices.get(result.code);
      if (device) {
        result.activeDeviceCount = device.count;
        result.deviceMacs = device.macs;
      }
    });
  }

  return results;
}
