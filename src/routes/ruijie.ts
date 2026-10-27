import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth } from '../middleware/adminAuth';
import { isRuijieCloudConfigured, RuijieApiError } from '../services/ruijieCloud';
import {
  kickRuijieUser,
  syncAccountingData,
  syncVoucherToRuijie,
  type RuijieOnlineUser,
} from '../services/ruijieService';
import { getRuijieSessionSnapshot } from '../services/ruijieSessionCache';
import { getRuijieDeviceSnapshot } from '../services/ruijieDeviceCache';
import { ruijieQuotaStatus } from '../services/ruijieRateLimiter';
import {
  bindingMacKey,
  loadHolders,
  resolveSessionAccounts,
  resolveVoucherBindings,
  verifyVoucherCodes,
  type AccountMatchSource,
  type BindingSource,
} from '../services/voucherBindingService';

export const ruijieRouter = Router();

ruijieRouter.use(requireAdminAuth);

const ruijieOpsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many Ruijie operations. Try again shortly.' },
});
ruijieRouter.use(ruijieOpsLimiter);

function sendRuijieError(res: any, err: unknown, fallback: string): void {
  if (err instanceof RuijieApiError) {
    res.status(502).json({ error: err.message, code: err.code });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/bad_request|required/i.test(msg)) {
    res.status(400).json({ error: msg });
    return;
  }
  console.error(`[RUIJIE API] ${fallback}:`, msg);
  res.status(500).json({ error: fallback });
}

// GET /api/ruijie/status â€” always answers 200 from local DB, even when the
// Ruijie Cloud keys are absent or the remote API is offline.
ruijieRouter.get('/status', async (_req, res) => {
  try {
    const configured = isRuijieCloudConfigured();
    const summary = { synced: 0, missing: 0, pending: 0, never: 0 };
    let lastSync: string | null = null;
    let totalVouchers = 0;

    const { rows: statusRows } = await pool.query(
      `SELECT COALESCE(ruijie_sync_status, 'never') AS status, COUNT(*)::int AS n
         FROM vouchers WHERE deleted_at IS NULL
        GROUP BY 1`
    );
    for (const row of statusRows) {
      const n = Number(row.n);
      totalVouchers += n;
      if (row.status === 'synced') summary.synced += n;
      else if (row.status === 'missing') summary.missing += n;
      else if (row.status === 'pending') summary.pending += n;
      else summary.never += n;
    }

    const { rows: syncRows } = await pool.query(
      `SELECT MAX(last_accounting_sync) AS last_sync FROM vouchers`
    );
    lastSync = syncRows[0]?.last_sync ?? null;

    const { rows: usageRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM vouchers
        WHERE deleted_at IS NULL AND data_consumed_mb IS NOT NULL`
    );

    res.json({
      configured,
      groupId: configured ? (process.env.RUIJIE_CLOUD_GROUP_ID ?? '') : null,
      lastAccountingSync: lastSync,
      vouchers: { total: totalVouchers, bySyncStatus: summary, withUsage: Number(usageRows[0]?.n ?? 0) },
      endpoint: process.env.RUIJIE_CLOUD_BASE_URL || 'https://cloud.ruijienetworks.com',
      pollingIntervalMin: process.env.RUIJIE_ACCOUNTING_INTERVAL_MIN ?? '5',
    });
  } catch (err) {
    sendRuijieError(res, err, 'Failed to read Ruijie status');
  }
});

// GET /api/ruijie/sessions â€” live captive-portal session telemetry,
// enriched server-side with the local voucher record (PIN + holder details)
// so the frontend never has to join two data sources itself.
export interface EnrichedSession extends RuijieOnlineUser {
  code: string | null;
  holderName: string | null;
  holderPhone: string | null;
  /**
   * Portal account matched by the client MAC. Holder fields above come from
   * the voucher; these come from the signed-in users/wispr profile and are
   * what the Accounts column shows when a voucher has no holder name.
   */
  accountName: string | null;
  accountPhone: string | null;
  accountSessionExpiresAt: string | null;
  bindingSource: BindingSource | null;
  /** Which fallback stage matched: direct code, MAC binding, or IP/portal. */
  matchedBy: AccountMatchSource | null;
  /** AUTH column classification: voucher or MAC bypass/whitelist. */
  authMethod: 'VOUCHER' | 'MAC_AUTO';
  macWhitelisted: boolean;
  dataLimitBytes: number | null;
  dataUsedBytes: number | null;
  dataLeftBytes: number | null;
  isUncapped: boolean | null;
  activeDeviceCount: number;
  deviceMacs: string[];
}

interface PortalAccount {
  macKey: string;
  fullName: string | null;
  phone: string | null;
  voucherCode: string | null;
  sessionExpiresAt: string | null;
}

/**
 * Batch-load portal accounts by MAC. Ruijie only reports MACs, while the
 * customer name/phone live on users (and, for live WISPr sessions, on the
 * wispr_profiles MAC). Joining them here keeps the session API as the single
 * place that resolves an online client to an actual person.
 */
async function loadPortalAccounts(macs: Iterable<unknown>): Promise<Map<string, PortalAccount>> {
  const out = new Map<string, PortalAccount>();
  const keys = [...new Set([...macs].map(bindingMacKey).filter((k): k is string => !!k))];
  if (keys.length === 0) return out;

  try {
    const { rows } = await pool.query(
      `WITH accounts AS (
         SELECT lower(regexp_replace(u.mac_address, '[^0-9a-fA-F]', '', 'g')) AS mac_key,
                u.full_name, u.phone, u.voucher_code, u.session_expires_at, u.created_at
           FROM users u
          WHERE u.mac_address IS NOT NULL
         UNION ALL
         SELECT lower(regexp_replace(wp.mac_address, '[^0-9a-fA-F]', '', 'g')) AS mac_key,
                u.full_name, u.phone, u.voucher_code, u.session_expires_at, u.created_at
           FROM wispr_profiles wp
           JOIN users u ON u.id = wp.user_id
          WHERE wp.mac_address IS NOT NULL
       )
       SELECT DISTINCT ON (mac_key)
              mac_key, full_name, phone, voucher_code, session_expires_at
         FROM accounts
        WHERE mac_key = ANY($1::text[])
        ORDER BY mac_key, created_at DESC`,
      [keys]
    );
    for (const row of rows) {
      const key = bindingMacKey(row.mac_key);
      if (!key) continue;
      out.set(key, {
        macKey: key,
        fullName: row.full_name ?? null,
        phone: row.phone ?? null,
        voucherCode: row.voucher_code ?? null,
        sessionExpiresAt: row.session_expires_at ? new Date(row.session_expires_at).toISOString() : null,
      });
    }
  } catch (err) {
    console.error('[RUIJIE API] portal account lookup failed:', err);
  }
  return out;
}

async function enrichSessions(sessions: RuijieOnlineUser[]): Promise<EnrichedSession[]> {
  const out: EnrichedSession[] = sessions.map((s) => ({
    ...s,
    code: null,
    holderName: null,
    holderPhone: null,
    accountName: null,
    accountPhone: null,
    accountSessionExpiresAt: null,
    bindingSource: null,
    matchedBy: null,
    authMethod: 'MAC_AUTO',
    macWhitelisted: false,
    dataLimitBytes: null,
    dataUsedBytes: null,
    dataLeftBytes: null,
    isUncapped: null,
    activeDeviceCount: 0,
    deviceMacs: [],
  }));
  if (out.length === 0) return out;

  try {
    // 1) Direct code -> MAC binding -> IP/portal, plus data/device/auth metadata.
    const resolved = await resolveSessionAccounts(
      out.map((s) => ({ mac: s.mac, ip: s.ip, codeCandidates: [s.username, s.account] }))
    );
    out.forEach((s, index) => {
      const account = resolved[index];
      s.code = account.code;
      s.holderName = account.holderName;
      s.holderPhone = account.holderPhone;
      s.accountName = account.accountName;
      s.accountPhone = account.accountPhone;
      s.accountSessionExpiresAt = account.accountSessionExpiresAt;
      s.bindingSource = account.bindingSource;
      s.matchedBy = account.matchedBy;
      s.authMethod = account.authMethod;
      s.macWhitelisted = account.macWhitelisted;
      s.dataLimitBytes = account.dataLimitBytes;
      s.dataUsedBytes = account.dataUsedBytes;
      s.dataLeftBytes = account.dataLeftBytes;
      s.isUncapped = account.isUncapped;
      s.activeDeviceCount = account.activeDeviceCount;
      s.deviceMacs = account.deviceMacs;
    });

    // 2) Portal account name/phone/expiry by MAC. The resolver already filled
    //    these for IP matches; this adds them for MAC-resolved vouchers and
    //    fills a holder-name gap without overriding a real voucher holder.
    const accounts = await loadPortalAccounts(out.map((s) => s.mac));
    for (const s of out) {
      const key = bindingMacKey(s.mac);
      const account = key ? accounts.get(key) : undefined;
      if (!account) continue;
      s.accountName = s.accountName ?? account.fullName;
      s.accountPhone = s.accountPhone ?? account.phone;
      s.accountSessionExpiresAt = s.accountSessionExpiresAt ?? account.sessionExpiresAt;
      if (!s.holderName && account.fullName) s.holderName = account.fullName;
      if (!s.holderPhone && account.phone) s.holderPhone = account.phone;
    }
  } catch (err) {
    // Holder enrichment must never sink live telemetry - sessions still ship.
    console.error('[RUIJIE API] session holder enrichment failed:', err);
  }
  return out;
}

ruijieRouter.get('/sessions', async (req, res) => {
  try {
    // Cached, circuit-broken feed. Upstream failures degrade to the last good
    // snapshot (with stale/degraded flags) instead of a 502 — the Sessions view
    // must keep rendering while Ruijie's quota recovers.
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const snapshot = await getRuijieSessionSnapshot({ force });
    if (snapshot.reason === 'ruijie_cloud_not_configured') {
      res.json({ skipped: true, reason: 'ruijie_cloud_not_configured', count: 0, users: [] });
      return;
    }
    const enriched = await enrichSessions(snapshot.users);
    res.json({
      skipped: false,
      count: enriched.length,
      users: enriched,
      stale: snapshot.stale,
      degraded: snapshot.degraded,
      breakerOpen: snapshot.breakerOpen,
      rosterFetchedAt: snapshot.fetchedAt,
      ttlMs: snapshot.ttlMs,
      warning: snapshot.stale
        ? 'Ruijie Cloud is temporarily unavailable or rate-limiting us, so this is the last successful reading. Retrying automatically.'
        : snapshot.degraded
          ? 'Ruijie Cloud is unreachable and no reading has been cached yet. Retrying automatically.'
          : null,
    });
  } catch (err) {
    sendRuijieError(res, err, 'Failed to fetch Ruijie online users');
  }
});

// â”€â”€ Historical clients â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/ruijie/history â€” the audit trail behind the console's
// "Historical Clients" view: one row per MAC the portal has ever seen, built
// purely from local logs so it answers even when Ruijie Cloud is offline.
const HISTORY_SQL = `
  WITH raw AS (
    SELECT UPPER(REGEXP_REPLACE(NULLIF(al.mac_address, ''), '[^0-9A-Fa-f]', '', 'g')) AS mac,
           host(al.ip_address) AS ip,
           al.created_at AS at,
           'access_log' AS src,
           u.full_name AS name,
           u.voucher_code AS code,
           u.user_agent AS ua,
           NULL::text AS label
      FROM access_log al
      LEFT JOIN users u ON u.id = al.user_id
     WHERE al.mac_address IS NOT NULL
       AND LENGTH(REGEXP_REPLACE(al.mac_address, '[^0-9A-Fa-f]', '', 'g')) = 12
    UNION ALL
    SELECT UPPER(REGEXP_REPLACE(NULLIF(u.mac_address, ''), '[^0-9A-Fa-f]', '', 'g')),
           host(u.ip_address), u.created_at, 'users',
           u.full_name, u.voucher_code, u.user_agent, u.alias
      FROM users u
     WHERE u.mac_address IS NOT NULL
       AND LENGTH(REGEXP_REPLACE(u.mac_address, '[^0-9A-Fa-f]', '', 'g')) = 12
    UNION ALL
    SELECT UPPER(REGEXP_REPLACE(NULLIF(vr.mac_address, ''), '[^0-9A-Fa-f]', '', 'g')),
           host(vr.ip_address), vr.created_at, 'voucher_redemptions',
           vr.full_name, vr.voucher_code, NULL::text, NULL::text
      FROM voucher_redemptions vr
     WHERE vr.mac_address IS NOT NULL
       AND LENGTH(REGEXP_REPLACE(vr.mac_address, '[^0-9A-Fa-f]', '', 'g')) = 12
    UNION ALL
    SELECT UPPER(REGEXP_REPLACE(NULLIF(vd.mac_address, ''), '[^0-9A-Fa-f]', '', 'g')),
           NULL::text, COALESCE(vd.last_seen_at, vd.bound_at), 'voucher_devices',
           NULL::text, vd.voucher_code, NULL::text, vd.label
      FROM voucher_devices vd
     WHERE vd.mac_address IS NOT NULL
       AND LENGTH(REGEXP_REPLACE(vd.mac_address, '[^0-9A-Fa-f]', '', 'g')) = 12
  )
  SELECT mac,
         MAX(ip) FILTER (WHERE ip IS NOT NULL) AS ip,
         MIN(at) AS first_seen,
         MAX(at) AS last_seen,
         COUNT(*)::int AS events,
         (array_agg(DISTINCT src ORDER BY src)) AS sources,
         COALESCE((array_agg(name  ORDER BY name  NULLS LAST))[1],
                  (array_agg(label ORDER BY label NULLS LAST))[1]) AS name,
         (array_agg(label ORDER BY label NULLS LAST))[1] AS label,
         (array_agg(code  ORDER BY code  NULLS LAST))[1] AS code_raw,
         (array_agg(ua    ORDER BY ua    NULLS LAST))[1] AS user_agent
    FROM raw
   WHERE mac IS NOT NULL AND LENGTH(mac) = 12
   GROUP BY mac
   ORDER BY last_seen DESC NULLS LAST
   LIMIT $1`;

export interface HistoricalClient {
  /** 12-hex uppercase, no separators â€” normalized by the SQL above. */
  mac: string;
  ip: string | null;
  /** Best name available: users.full_name, else voucher_devices.label. */
  name: string | null;
  label: string | null;
  /** Verified voucher code only (same strict contract as /sessions). */
  code: string | null;
  holderName: string | null;
  holderPhone: string | null;
  bindingSource: BindingSource | null;
  userAgent: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Raw event count across every log this MAC appears in. */
  events: number;
  /** Which logs produced rows, e.g. ["users","voucher_devices"]. */
  sources: string[];
}

type HistoricalRow = HistoricalClient & { rawCode: string | null };

function iso(value: unknown): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

ruijieRouter.get('/history', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
    const { rows } = await pool.query(HISTORY_SQL, [limit]);

    const out: HistoricalRow[] = rows.map((r: any) => ({
      mac: String(r.mac),
      ip: r.ip ?? null,
      name: r.name ?? null,
      label: r.label ?? null,
      code: null,
      holderName: null,
      holderPhone: null,
      bindingSource: null,
      userAgent: r.user_agent ?? null,
      firstSeen: iso(r.first_seen),
      lastSeen: iso(r.last_seen),
      events: Number(r.events) || 0,
      sources: Array.isArray(r.sources) ? r.sources.map(String) : [],
      rawCode: r.code_raw ?? null,
    }));

    if (out.length > 0) {
      try {
        // Same precedence chain as the live session feed: MAC-resolved binding
        // first, then a voucher code found verbatim in the local log.
        const byMac = await resolveVoucherBindings(out.map((r) => r.mac));
        const unmatched: HistoricalRow[] = [];
        for (const r of out) {
          const key = bindingMacKey(r.mac);
          const binding = key ? byMac.get(key) : undefined;
          if (binding?.code) {
            r.code = binding.code;
            r.holderName = binding.holderName;
            r.holderPhone = binding.holderPhone;
            r.bindingSource = binding.source;
          } else {
            unmatched.push(r);
          }
        }

        const rawCodes = unmatched.map((r) => r.rawCode).filter((c): c is string => !!c);
        if (rawCodes.length > 0) {
          const verified = await verifyVoucherCodes(rawCodes);
          if (verified.size > 0) {
            const holders = await loadHolders(verified.values());
            for (const r of unmatched) {
              const key = String(r.rawCode ?? '').trim().toLowerCase();
              const code = verified.get(key);
              if (!code) continue;
              r.code = code;
              r.bindingSource = 'ruijie_user_name';
              const holder = holders.get(code);
              if (holder) {
                r.holderName = holder.name;
                r.holderPhone = holder.phone;
              }
            }
          }
        }
      } catch (err) {
        // Holder enrichment must never sink the audit trail.
        console.error('[RUIJIE API] history holder enrichment failed:', err);
      }
    }

    const users = out.map(({ rawCode: _rawCode, ...rest }) => rest);
    res.json({ count: users.length, users });
  } catch (err) {
    sendRuijieError(res, err, 'Failed to fetch historical clients');
  }
});

// GET /api/ruijie/devices â€” AP/switch/gateway telemetry (serial, firmware,
// online status) for the managed group.
ruijieRouter.get('/devices', async (_req, res) => {
  try {
    if (!isRuijieCloudConfigured()) {
      res.json({ skipped: true, reason: 'ruijie_cloud_not_configured', count: 0, devices: [] });
      return;
    }
    // Cached (10 min TTL, stale-serve on throttle) — one page load used to cost
    // three quota slots upstream.
    const snapshot = await getRuijieDeviceSnapshot();
    res.json({
      skipped: false,
      count: snapshot.devices.length,
      devices: snapshot.devices,
      stale: snapshot.stale,
      fetchedAt: snapshot.fetchedAt,
      reason: snapshot.reason,
    });
  } catch (err) {
    sendRuijieError(res, err, 'Failed to fetch Ruijie devices');
  }
});

// GET /api/ruijie/quota â€” outbound Ruijie API budget (read-only). Surfaced so
// operators can see how much of the tenant quota the cluster has spent without
// digging through logs. Never triggers an upstream call.
ruijieRouter.get('/quota', async (_req, res) => {
  try {
    const status = await ruijieQuotaStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    sendRuijieError(res, err, 'Failed to read Ruijie quota');
  }
});

// POST /api/ruijie/accounting/sync â€” reconcile cumulative usage into
// vouchers.data_consumed_mb. Never touches session-state columns.
ruijieRouter.post('/accounting/sync', async (_req, res) => {
  try {
    const result = await syncAccountingData();
    res.json({ ok: result.errors.length === 0, ...result });
  } catch (err) {
    sendRuijieError(res, err, 'Accounting sync failed');
  }
});

// POST /api/ruijie/kick â€” disconnect one client by MAC or session token.
ruijieRouter.post('/kick', async (req, res) => {
  try {
    const { mac, sessionToken } = (req.body ?? {}) as { mac?: string; sessionToken?: string };
    if (!mac && !sessionToken) {
      res.status(400).json({ error: 'A client MAC address or session token is required' });
      return;
    }
    const result = await kickRuijieUser({ mac, sessionToken });
    res.json(result);
  } catch (err) {
    sendRuijieError(res, err, 'Disconnect failed');
  }
});

// POST /api/ruijie/vouchers/:code/sync â€” verify a local voucher exists on
// Ruijie and record 'synced'/'missing'. Never re-mints a code.
ruijieRouter.post('/vouchers/:code/sync', async (req, res) => {
  try {
    const code = String(req.params.code ?? '');
    const result = await syncVoucherToRuijie(code);
    res.json(result);
  } catch (err) {
    sendRuijieError(res, err, 'Voucher sync failed');
  }
});

// GET /api/ruijie/vouchers/:code â€” local row + Ruijie audit record (local DB
// only, works offline).
ruijieRouter.get('/vouchers/:code', async (req, res) => {
  try {
    const code = String(req.params.code ?? '').trim().toLowerCase();
    const { rows } = await pool.query(
      `SELECT id, code, package_tier, holder_name, holder_phone, last_seen_at,
              ruijie_sync_status, ruijie_voucher_id, data_consumed_mb,
              last_accounting_sync, used_count, expires_at, is_disabled, deleted_at
         FROM vouchers WHERE lower(code) = $1`,
      [code]
    );
    const voucher = rows[0] ?? null;
    if (!voucher) {
      res.status(404).json({ error: 'Voucher not found' });
      return;
    }
    const { rows: auditRows } = await pool.query(
      `SELECT code_no, user_group_id, profile_uuid, ruijie_expiry, source,
              created_at, comment
         FROM ruijie_vouchers WHERE lower(code_no) = $1
        ORDER BY created_at DESC LIMIT 1`,
      [code]
    );
    res.json({ voucher, ruijie: auditRows[0] ?? null, configured: isRuijieCloudConfigured() });
  } catch (err) {
    sendRuijieError(res, err, 'Voucher lookup failed');
  }
});
