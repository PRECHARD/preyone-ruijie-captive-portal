import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth } from '../middleware/adminAuth';
import { isRuijieCloudConfigured, RuijieApiError } from '../services/ruijieCloud';
import {
  kickRuijieUser,
  listRuijieDevices,
  listRuijieOnlineUsers,
  syncAccountingData,
  syncVoucherToRuijie,
} from '../services/ruijieService';

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

// GET /api/ruijie/status — always answers 200 from local DB, even when the
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

// GET /api/ruijie/sessions — live captive-portal session telemetry.
ruijieRouter.get('/sessions', async (_req, res) => {
  try {
    if (!isRuijieCloudConfigured()) {
      res.json({ skipped: true, reason: 'ruijie_cloud_not_configured', count: 0, users: [] });
      return;
    }
    const users = await listRuijieOnlineUsers();
    res.json({ skipped: false, count: users.length, users });
  } catch (err) {
    sendRuijieError(res, err, 'Failed to fetch Ruijie online users');
  }
});

// GET /api/ruijie/devices — AP/switch/gateway telemetry (serial, firmware,
// online status) for the managed group.
ruijieRouter.get('/devices', async (_req, res) => {
  try {
    if (!isRuijieCloudConfigured()) {
      res.json({ skipped: true, reason: 'ruijie_cloud_not_configured', count: 0, devices: [] });
      return;
    }
    const devices = await listRuijieDevices();
    res.json({ skipped: false, count: devices.length, devices });
  } catch (err) {
    sendRuijieError(res, err, 'Failed to fetch Ruijie devices');
  }
});

// POST /api/ruijie/accounting/sync — reconcile cumulative usage into
// vouchers.data_consumed_mb. Never touches session-state columns.
ruijieRouter.post('/accounting/sync', async (_req, res) => {
  try {
    const result = await syncAccountingData();
    res.json({ ok: result.errors.length === 0, ...result });
  } catch (err) {
    sendRuijieError(res, err, 'Accounting sync failed');
  }
});

// POST /api/ruijie/kick — disconnect one client by MAC or session token.
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

// POST /api/ruijie/vouchers/:code/sync — verify a local voucher exists on
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

// GET /api/ruijie/vouchers/:code — local row + Ruijie audit record (local DB
// only, works offline).
ruijieRouter.get('/vouchers/:code', async (req, res) => {
  try {
    const code = String(req.params.code ?? '').trim().toLowerCase();
    const { rows } = await pool.query(
      `SELECT id, code, package_tier, holder_name, holder_phone, ruijie_sync_status,
              ruijie_voucher_id, data_consumed_mb, last_accounting_sync, used_count,
              expires_at, is_disabled, deleted_at
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
