/**
 * Starlink telemetry ingestion, usage forecasting and proactive alerting.
 *
 * All writes are confined to starlink_* tables. The sync endpoint is the only
 * ingestion source; it inserts raw snapshots, refreshes the denormalised kit
 * totals, evaluates per-cycle thresholds, and (optionally) debits the wallet
 * for an automatic data purchase. Notifications are inserted inside the same
 * transaction with unique event keys; emails are claimed and sent only after
 * commit so retries can never double-credit or double-send.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import {
  createPaidStarlinkInvoice,
  getStarlinkAlertPreferences,
  getStarlinkKit,
  insertStarlinkUsageSnapshot,
  listStarlinkUsageSnapshots,
  markStarlinkAlertCycleSent,
  queueStarlinkNotification,
  type StarlinkAlertPreferences,
  type StarlinkUsageSnapshot,
  type StarlinkUsageSnapshotInput,
} from '../db/starlink';
import { starlinkBaseUrl } from './starlinkEmailTemplates';
import { dispatchStarlinkQueuedNotice } from './starlinkNoticeDispatch';

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THRESHOLDS = [75, 90, 100] as const;
type Threshold = (typeof THRESHOLDS)[number];
const MAX_SNAPSHOTS_PER_SYNC = 100;

/** Prices mirror the portal's published data bundles; arbitrary sizes use the fallback rate. */
const DATA_BUNDLE_PRICES = [
  { gb: 10, price: 5 },
  { gb: 50, price: 19 },
  { gb: 100, price: 35 },
  { gb: 250, price: 79 },
] as const;
const FALLBACK_USD_PER_GB = 0.35;

export class StarlinkTelemetryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface StarlinkTelemetryDailyPoint {
  date: string;
  priority_gb: number;
  standard_gb: number;
  total_gb: number;
}

export interface StarlinkTelemetryMetrics {
  daily_burn_rate_gb: number;
  days_remaining: number | null;
  projected_exhaustion_date: string | null;
  priority_used_gb: number;
  standard_used_gb: number;
  priority_total_gb: number;
  standard_total_gb: number;
  priority_percent: number;
  standard_percent: number;
  total_percent: number;
  remaining_gb: number;
  sample_count: number;
}

export interface StarlinkTelemetryBundle {
  kit_id: string;
  cycle: string;
  snapshots: StarlinkUsageSnapshot[];
  daily: StarlinkTelemetryDailyPoint[];
  metrics: StarlinkTelemetryMetrics;
  preferences: StarlinkAlertPreferences;
}

export interface StarlinkUsageAlertResult {
  threshold: Threshold;
  eventKey: string;
}

export interface StarlinkAutoTopupResult {
  invoiceNumber: string;
  gb: number;
  amount: number;
  eventKey: string;
}

export interface StarlinkTelemetrySyncResult {
  kitId: string;
  snapshotId: string;
  metrics: StarlinkTelemetryMetrics;
  usageAlerts: StarlinkUsageAlertResult[];
  autoTopup: StarlinkAutoTopupResult | null;
}

function n(value: unknown, fallback = 0): number {
  const out = Number(value);
  return Number.isFinite(out) ? out : fallback;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nonNegative(value: unknown, fallback = 0): number {
  return Math.max(0, n(value, fallback));
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

function booleanish(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (['false', '0', 'off', 'no', 'down'].includes(token)) return false;
    if (['true', '1', 'on', 'yes', 'up'].includes(token)) return true;
  }
  return fallback;
}

/** Calendar-month cycle key stored in alert_XX_sent_cycle. */
export function currentTelemetryCycle(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Configurable data allowance for the forecast/percentages; GB, not KB. */
export function cycleDataAllowanceGb(): number {
  const configured = n(process.env.STARLINK_CYCLE_DATA_ALLOWANCE_GB, 100);
  return configured > 0 ? configured : 100;
}

export function autoTopupPriceUsd(gb: number): number {
  const size = Math.max(1, n(gb, 10));
  const exact = DATA_BUNDLE_PRICES.find((bundle) => bundle.gb === size);
  if (exact) return exact.price;
  return round(size * FALLBACK_USD_PER_GB);
}

/** Accept a single snapshot, { snapshot }, or { snapshots: [...] } from admin callers. */
export function parseTelemetrySyncBody(body: unknown): StarlinkUsageSnapshotInput[] {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const raw = Array.isArray(root.snapshots)
    ? root.snapshots
    : Array.isArray(body)
      ? body
      : [root.snapshot ?? root];

  if (raw.length === 0 || raw.length > MAX_SNAPSHOTS_PER_SYNC) {
    throw new StarlinkTelemetryError(400, `Provide 1–${MAX_SNAPSHOTS_PER_SYNC} telemetry snapshot(s)`);
  }

  return raw.map((item) => {
    const s = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const kitId = String(s.kitId ?? s.kit_id ?? '').trim();
    if (!UUID_RE.test(kitId)) {
      throw new StarlinkTelemetryError(400, 'A valid kitId is required for every snapshot');
    }
    const recordedAt = s.recordedAt ?? s.recorded_at;
    return {
      kitId,
      recordedAt: recordedAt === undefined || recordedAt === null ? undefined : String(recordedAt),
      priorityUsedGb: nonNegative(s.priorityUsedGb ?? s.priority_used_gb),
      standardUsedGb: nonNegative(s.standardUsedGb ?? s.standard_used_gb),
      downloadMbps: nullableNumber(s.downloadMbps ?? s.download_mbps),
      uploadMbps: nullableNumber(s.uploadMbps ?? s.upload_mbps),
      latencyMs: nullableNumber(s.latencyMs ?? s.latency_ms),
      pingDropRate: nullableNumber(s.pingDropRate ?? s.ping_drop_rate),
      obstructionPercent: nullableNumber(s.obstructionPercent ?? s.obstruction_percent),
      uptimeSeconds: nullableNumber(s.uptimeSeconds ?? s.uptime_seconds),
      onlineStatus: booleanish(s.onlineStatus ?? s.online_status ?? true),
    } as StarlinkUsageSnapshotInput;
  });
}

function dayKey(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** Daily deltas from cumulative counters, padded to the last 30 calendar days. */
export function buildDailyUsage(snapshots: StarlinkUsageSnapshot[], days = 30): StarlinkTelemetryDailyPoint[] {
  const ascending = [...snapshots].sort(
    (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
  );
  const byDay = new Map<string, { priority: number; standard: number }>();
  let previous: StarlinkUsageSnapshot | null = null;

  for (const snapshot of ascending) {
    const key = dayKey(snapshot.recorded_at);
    if (!key) continue;
    const priorityDelta = Math.max(0, n(snapshot.priority_used_gb) - n(previous?.priority_used_gb));
    const standardDelta = Math.max(0, n(snapshot.standard_used_gb) - n(previous?.standard_used_gb));
    const point = byDay.get(key) ?? { priority: 0, standard: 0 };
    point.priority += priorityDelta;
    point.standard += standardDelta;
    byDay.set(key, point);
    previous = snapshot;
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const result: StarlinkTelemetryDailyPoint[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const key = new Date(today.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
    const point = byDay.get(key) ?? { priority: 0, standard: 0 };
    result.push({
      date: key,
      priority_gb: round(point.priority),
      standard_gb: round(point.standard),
      total_gb: round(point.priority + point.standard),
    });
  }
  return result;
}

export function buildTelemetryMetrics(
  snapshots: StarlinkUsageSnapshot[],
  dataCreditGb: number,
  allowanceGb = cycleDataAllowanceGb()
): StarlinkTelemetryMetrics {
  // Callers normally pass newest-first, but never depend on array order: the
  // authoritative counters are those with the greatest recorded_at timestamp.
  const latest = snapshots.reduce<StarlinkUsageSnapshot | null>((best, item) => {
    if (!best) return item;
    return new Date(item.recorded_at).getTime() > new Date(best.recorded_at).getTime() ? item : best;
  }, null);
  const priority = nonNegative(latest?.priority_used_gb);
  const standard = nonNegative(latest?.standard_used_gb);
  const total = priority + standard;
  const credit = nonNegative(dataCreditGb);
  const available = Math.max(0, allowanceGb) + credit;
  const remaining = Math.max(0, available - total);

  const ascending = [...snapshots].sort(
    (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
  );
  let deltaTotal = 0;
  let spanDays = 1;
  if (ascending.length > 1) {
    const first = ascending[0];
    const last = ascending[ascending.length - 1];
    spanDays = Math.max(
      1,
      Math.round((new Date(last.recorded_at).getTime() - new Date(first.recorded_at).getTime()) / DAY_MS)
    );
    for (let i = 1; i < ascending.length; i++) {
      deltaTotal += Math.max(
        0,
        n(ascending[i].priority_used_gb) + n(ascending[i].standard_used_gb)
          - n(ascending[i - 1].priority_used_gb) - n(ascending[i - 1].standard_used_gb)
      );
    }
  } else {
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    spanDays = Math.max(1, Math.floor((now.getTime() - monthStart) / DAY_MS) + 1);
    deltaTotal = total;
  }

  const burn = deltaTotal > 0 ? deltaTotal / spanDays : 0;
  const daysRemaining = remaining <= 0 ? 0 : burn > 0 ? remaining / burn : null;
  const projected = daysRemaining === null
    ? null
    : new Date(Date.now() + Math.ceil(daysRemaining) * DAY_MS).toISOString().slice(0, 10);

  const percent = (part: number, whole: number) => whole > 0 ? round((part / whole) * 100) : 0;
  return {
    daily_burn_rate_gb: round(burn),
    days_remaining: daysRemaining === null ? null : round(daysRemaining),
    projected_exhaustion_date: projected,
    priority_used_gb: round(priority),
    standard_used_gb: round(standard),
    priority_total_gb: round(Math.max(0, allowanceGb)),
    standard_total_gb: round(credit),
    priority_percent: percent(priority, allowanceGb),
    standard_percent: percent(standard, credit),
    total_percent: percent(total, available),
    remaining_gb: round(remaining),
    sample_count: snapshots.length,
  };
}

/** Customer-facing read model. Never exposes snapshots from another customer's kit. */
export async function getStarlinkTelemetryBundle(
  customerId: string,
  kitId: string
): Promise<StarlinkTelemetryBundle> {
  const kit = await getStarlinkKit(kitId, customerId);
  if (!kit) throw new StarlinkTelemetryError(404, 'Kit not found');

  const [snapshots, preferences] = await Promise.all([
    listStarlinkUsageSnapshots(kitId, 30),
    getStarlinkAlertPreferences(customerId, kitId),
  ]);
  const metrics = buildTelemetryMetrics(snapshots, Number(kit.data_credit_gb ?? 0));
  return {
    kit_id: kitId,
    cycle: currentTelemetryCycle(),
    snapshots,
    daily: buildDailyUsage(snapshots),
    metrics,
    preferences,
  };
}

type KitOwnerRow = {
  id: string;
  customer_id: string;
  kit_number: string;
  nickname: string;
};

async function findKitOwner(kitId: string): Promise<KitOwnerRow | null> {
  const { rows } = await pool.query(
    `SELECT id, customer_id, kit_number, nickname FROM starlink_kits WHERE id = $1`,
    [kitId]
  );
  return (rows[0] as KitOwnerRow) ?? null;
}

function topupLink(): string {
  return `${starlinkBaseUrl()}/starlink/portal?topup=1`;
}

function invoiceLink(): string {
  return `${starlinkBaseUrl()}/starlink/portal`;
}

async function syncOneSnapshot(input: StarlinkUsageSnapshotInput): Promise<StarlinkTelemetrySyncResult> {
  const owner = await findKitOwner(input.kitId);
  if (!owner) throw new StarlinkTelemetryError(404, `Kit not found: ${input.kitId}`);

  const client = await pool.connect();
  const dispatchKeys: string[] = [];
  try {
    await client.query('BEGIN');

    const snapshot = await insertStarlinkUsageSnapshot(input, client);
    const usedGb = round(n(snapshot.priority_used_gb) + n(snapshot.standard_used_gb));
    const month = dayKey(snapshot.recorded_at).slice(0, 7) + '-01';

    await client.query('UPDATE starlink_kits SET data_usage_gb = $2 WHERE id = $1', [input.kitId, usedGb]);
    await client.query(
      `INSERT INTO starlink_kit_usage (kit_id, period_month, usage_gb, is_baseline)
       VALUES ($1, $2::date, $3, FALSE)
       ON CONFLICT (kit_id, period_month)
       DO UPDATE SET usage_gb = EXCLUDED.usage_gb, is_baseline = FALSE`,
      [input.kitId, month, usedGb]
    );

    const kitResult = await client.query(
      `SELECT id, kit_number, nickname, customer_id, data_credit_gb
         FROM starlink_kits WHERE id = $1 FOR UPDATE`,
      [input.kitId]
    );
    const kitRow = kitResult.rows[0] as Record<string, unknown>;
    const customerResult = await client.query(
      `SELECT id, full_name, email, wallet_balance, plan_code
         FROM starlink_customers WHERE id = $1 FOR UPDATE`,
      [owner.customer_id]
    );
    const customerRow = customerResult.rows[0] as Record<string, unknown>;
    if (!kitRow || !customerRow) throw new Error('Starlink telemetry owner row is missing');

    let preferences = await getStarlinkAlertPreferences(owner.customer_id, input.kitId, client);
    const snapshots = await listStarlinkUsageSnapshots(input.kitId, 30, client);
    let metrics = buildTelemetryMetrics(snapshots, n(kitRow.data_credit_gb));
    const cycle = currentTelemetryCycle(new Date(snapshot.recorded_at));
    const usageAlerts: StarlinkUsageAlertResult[] = [];

    // Threshold alerts: one row per threshold per calendar-month cycle. The
    // unique event_key and cycle marker survive webhook/sync replays.
    for (const threshold of THRESHOLDS) {
      const alreadySent = preferences[`alert_${threshold}_sent_cycle`] === cycle;
      if (metrics.total_percent < threshold || alreadySent) continue;

      const emailKey = `alert_${threshold}_email_enabled` as keyof StarlinkAlertPreferences;
      const portalKey = `alert_${threshold}_portal_enabled` as keyof StarlinkAlertPreferences;
      const wantsEmail = preferences.email_alerts_enabled && Boolean(preferences[emailKey]);
      const wantsPortal = preferences.portal_alerts_enabled && Boolean(preferences[portalKey]);
      if (!wantsEmail && !wantsPortal) continue;

      const eventKey = `starlink-usage-alert:${input.kitId}:${cycle}:${threshold}`;
      const created = await queueStarlinkNotification({
        customerId: owner.customer_id,
        category: 'USAGE_ALERT',
        eventKey,
        title: `Starlink usage at ${threshold}%`,
        body: `${String(kitRow.nickname || kitRow.kit_number)} has used ${threshold}% of this cycle's data allowance. ${round(metrics.remaining_gb)} GB remains.`,
        linkUrl: topupLink(),
        emailStatus: wantsEmail ? 'PENDING' : 'NOT_APPLICABLE',
        visibleInPortal: wantsPortal,
        meta: {
          threshold,
          cycle,
          kitId: input.kitId,
          kitSerial: kitRow.kit_number,
          kitNickname: kitRow.nickname,
          usedGb: n(kitRow.data_usage_gb),
          allowanceGb: round(metrics.priority_total_gb + metrics.standard_total_gb),
          remainingGb: metrics.remaining_gb,
          projectedExhaustionDate: metrics.projected_exhaustion_date,
        },
      }, client);

      if (created) {
        await markStarlinkAlertCycleSent(owner.customer_id, input.kitId, threshold, cycle, client);
        dispatchKeys.push(eventKey);
        usageAlerts.push({ threshold, eventKey });
        preferences = { ...preferences, [`alert_${threshold}_sent_cycle`]: cycle } as StarlinkAlertPreferences;
      }
    }

    // Auto top-up: wallet debit, invoice and data credit all share the kit/customer
    // row locks, so concurrent syncs cannot purchase twice.
    let autoTopup: StarlinkAutoTopupResult | null = null;
    const autoGb = nonNegative(preferences.auto_topup_gb, 10);
    const minGb = nonNegative(preferences.auto_topup_min_gb, 2);
    if (preferences.auto_topup_enabled && autoGb > 0 && metrics.remaining_gb < minGb) {
      const amount = autoTopupPriceUsd(autoGb);
      const walletBalance = n(customerRow.wallet_balance);
      const eventKey = `starlink-auto-topup:${input.kitId}:${cycle}:${snapshot.id}`;
      const existing = await client.query('SELECT 1 FROM starlink_notifications WHERE event_key = $1', [eventKey]);
      if ((existing.rowCount ?? 0) === 0 && walletBalance >= amount) {
        await client.query(
          'UPDATE starlink_customers SET wallet_balance = wallet_balance - $2 WHERE id = $1',
          [owner.customer_id, amount]
        );
        const invoice = await createPaidStarlinkInvoice({
          customerId: owner.customer_id,
          amount,
          description: `Automatic Starlink ${autoGb}GB Top-Up`,
          kind: 'auto_topup',
          paymentReference: 'wallet-auto-topup',
          meta: {
            kit_id: input.kitId,
            kit_number: kitRow.kit_number,
            gb: autoGb,
            bundle: `${autoGb}GB`,
            trigger: 'remaining_below_minimum',
            cycle,
          },
          client,
        });
        await client.query(
          'UPDATE starlink_kits SET data_credit_gb = data_credit_gb + $2 WHERE id = $1',
          [input.kitId, autoGb]
        );
        const newWallet = round(walletBalance - amount);
        const newCredit = round(n(kitRow.data_credit_gb) + autoGb);
        const wantsEmail = preferences.email_alerts_enabled;
        const wantsPortal = preferences.portal_alerts_enabled;

        const queued = await queueStarlinkNotification({
          customerId: owner.customer_id,
          category: 'AUTO_TOPUP',
          eventKey,
          title: `Auto top-up · ${autoGb}GB added`,
          body: `We added ${autoGb}GB to ${String(kitRow.nickname || kitRow.kit_number)} from your wallet for $${amount.toFixed(2)}.`,
          linkUrl: invoiceLink(),
          emailStatus: wantsEmail ? 'PENDING' : 'NOT_APPLICABLE',
          visibleInPortal: wantsPortal,
          meta: {
            invoiceNumber: invoice.invoice_number,
            gb: autoGb,
            amount,
            walletBalance: newWallet,
            dataBalance: newCredit,
            kitSerial: kitRow.kit_number,
            kitNickname: kitRow.nickname,
            cycle,
          },
        }, client);

        if (queued) {
          dispatchKeys.push(eventKey);
          autoTopup = { invoiceNumber: invoice.invoice_number, gb: autoGb, amount, eventKey };
          metrics = buildTelemetryMetrics(snapshots, newCredit);
        }
      }
    }

    await client.query('COMMIT');

    // Post-commit only: SMTP never blocks the admin sync request.
    for (const key of dispatchKeys) void dispatchStarlinkQueuedNotice(key);

    return {
      kitId: input.kitId,
      snapshotId: snapshot.id,
      metrics,
      usageAlerts,
      autoTopup,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function syncStarlinkTelemetry(
  inputs: StarlinkUsageSnapshotInput[]
): Promise<{ processed: number; results: StarlinkTelemetrySyncResult[] }> {
  const results: StarlinkTelemetrySyncResult[] = [];
  for (const input of inputs) {
    results.push(await syncOneSnapshot(input));
  }
  return { processed: results.length, results };
}
