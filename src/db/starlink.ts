/**
 * Starlink customer portal — additive schema + data layer.
 *
 * EVERYTHING in this file is ADDITIVE: four brand-new tables
 * (starlink_customers, starlink_kits, starlink_invoices, starlink_kit_usage)
 * and the queries the portal needs. No existing table is read for writes or
 * altered here — per project guardrails the voucher handlers, transit tables
 * and POS documents stay untouched.
 *
 * The schema is created idempotently at boot via ensureStarlinkSchema()
 * (CREATE TABLE IF NOT EXISTS ...), so no migration of existing objects runs.
 */
import { pool } from './pool';
import { starlinkBaseUrl } from '../services/starlinkEmailTemplates';
import type { PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StarlinkCustomer {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  password_hash: string;
  company_id: string | null;
  wallet_balance: number;
  plan_code: string | null;
  plan_renews_at: string | null;
  email_verified_at: string | null;
  created_at: string;
}

export interface StarlinkKit {
  id: string;
  customer_id: string;
  kit_number: string;
  nickname: string;
  data_usage_gb: number;
  data_credit_gb: number;
  status: string;
  created_at: string;
  /** Fleet metadata — additive; older installs read empty strings/nulls. */
  site_name: string;
  city: string;
  gps_lat: number | null;
  gps_lng: number | null;
  hardware_model: string;
  /** A scheduled active/paused change waiting for its effective time. */
  pending_status: string | null;
  pending_status_at: string | null;
  pending_request_id: string | null;
}

export type StarlinkKitMetadata = {
  siteName?: string | null;
  city?: string | null;
  gpsLat?: number | string | null;
  gpsLng?: number | string | null;
  hardwareModel?: string | null;
};

export type StarlinkAccountMemberRole = 'admin' | 'billing' | 'viewer';

export interface StarlinkAccountMember {
  id: string;
  owner_customer_id: string;
  email: string;
  name: string;
  role: StarlinkAccountMemberRole;
  assigned_kit_ids: string[];
  invite_token: string | null;
  invite_expires_at: string | null;
  password_hash: string | null;
  accepted_at: string | null;
  created_at: string;
}

export interface StarlinkCreditTransfer {
  id: string;
  customer_id: string;
  from_kit_id: string;
  to_kit_id: string;
  gb: number;
  event_key: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface StarlinkServiceStateRequest {
  id: string;
  customer_id: string;
  kit_id: string;
  requested_status: 'active' | 'paused';
  effective_at: string;
  note: string;
  event_key: string;
  actor_member_id: string | null;
  applied_at: string | null;
  created_at: string;
}

export interface StarlinkInvoice {
  id: string;
  customer_id: string;
  invoice_number: string;
  amount: number;
  currency: string;
  description: string;
  kind: string; // wallet_topup | data_topup | kit_purchase | service
  status: string; // PENDING | PAID | FAILED
  pese_reference: string | null;
  meta: Record<string, unknown>;
  issued_date: string;
  due_date: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface StarlinkUsagePoint {
  month: string; // YYYY-MM-01
  usage_gb: number;
  is_baseline: boolean;
}

/** Additive customer-facing feed. Categories are fixed by the DB enum below. */
export type StarlinkNotificationCategory =
  | 'PAYMENT'
  | 'USAGE_ALERT'
  | 'AUTO_TOPUP'
  | 'COMMAND'
  | 'TICKET'
  | 'FLEET';

export interface StarlinkNotification {
  id: string;
  customer_id: string;
  category: StarlinkNotificationCategory;
  event_key: string;
  title: string;
  body: string;
  link_url: string | null;
  meta: Record<string, unknown>;
  is_read: boolean;
  /** Hidden rows still provide an idempotent email claim but never enter the feed. */
  visible_in_portal?: boolean;
  email_status: string;
  email_sent_at: string | null;
  created_at: string;
}

export interface StarlinkPendingIntent {
  intent_id: string;
  invoice_id: string;
  invoice_number: string;
  reference: string;
  amount: number;
  created_at: string;
}

/** Raw terminal telemetry. Cumulative usage counters are GB, not KB. */
export interface StarlinkUsageSnapshot {
  id: string;
  kit_id: string;
  recorded_at: string;
  priority_used_gb: number;
  standard_used_gb: number;
  download_mbps: number | null;
  upload_mbps: number | null;
  latency_ms: number | null;
  ping_drop_rate: number | null;
  obstruction_percent: number | null;
  uptime_seconds: number | null;
  online_status: boolean;
}

export type StarlinkUsageSnapshotInput = {
  kitId: string;
  recordedAt?: string | Date;
  priorityUsedGb: number;
  standardUsedGb?: number;
  downloadMbps?: number | null;
  uploadMbps?: number | null;
  latencyMs?: number | null;
  pingDropRate?: number | null;
  obstructionPercent?: number | null;
  uptimeSeconds?: number | null;
  onlineStatus?: boolean;
};

/** Per-customer/kit alert + auto-top-up configuration. */
export interface StarlinkAlertPreferences {
  kit_id: string;
  customer_id: string;
  alert_75_sent_cycle: string | null;
  alert_90_sent_cycle: string | null;
  alert_100_sent_cycle: string | null;
  alert_75_email_enabled: boolean;
  alert_75_portal_enabled: boolean;
  alert_90_email_enabled: boolean;
  alert_90_portal_enabled: boolean;
  alert_100_email_enabled: boolean;
  alert_100_portal_enabled: boolean;
  email_alerts_enabled: boolean;
  portal_alerts_enabled: boolean;
  offline_alerts_enabled: boolean;
  auto_topup_enabled: boolean;
  auto_topup_gb: number;
  auto_topup_min_gb: number;
}

export type StarlinkAlertPreferencePatch = Partial<Pick<
  StarlinkAlertPreferences,
  | 'alert_75_email_enabled'
  | 'alert_75_portal_enabled'
  | 'alert_90_email_enabled'
  | 'alert_90_portal_enabled'
  | 'alert_100_email_enabled'
  | 'alert_100_portal_enabled'
  | 'email_alerts_enabled'
  | 'portal_alerts_enabled'
  | 'offline_alerts_enabled'
  | 'auto_topup_enabled'
  | 'auto_topup_gb'
  | 'auto_topup_min_gb'
>>;

// ---------------------------------------------------------------------------
// Schema (additive, idempotent)
// ---------------------------------------------------------------------------

const STARLINK_DDL = `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    -- Starlink portal customers. Deliberately SEPARATE from admin_users and
    -- transit_users: these are paying satellite subscribers, not staff.
    CREATE TABLE IF NOT EXISTS starlink_customers (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name       TEXT NOT NULL,
      email           TEXT NOT NULL,
      phone           TEXT NOT NULL,
      password_hash   TEXT NOT NULL,
      company_id      UUID REFERENCES companies(id) ON DELETE SET NULL,
      wallet_balance  NUMERIC(12,2) NOT NULL DEFAULT 0,
      reset_token     TEXT,
      reset_expires_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE starlink_customers ADD COLUMN IF NOT EXISTS plan_code TEXT;
    ALTER TABLE starlink_customers ADD COLUMN IF NOT EXISTS plan_renews_at DATE;
    ALTER TABLE starlink_customers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    ALTER TABLE starlink_customers ADD COLUMN IF NOT EXISTS email_verify_token_hash TEXT;
    ALTER TABLE starlink_customers ADD COLUMN IF NOT EXISTS email_verify_expires_at TIMESTAMPTZ;

    -- Starlink checkouts record their intents as target_type = 'starlink'. The
    -- original constraint (migrate.ts) predates that rail, so widen it here.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'pesepay_intents_target_type_check'
           AND pg_get_constraintdef(oid) LIKE '%starlink%'
      ) THEN
        ALTER TABLE pesepay_intents DROP CONSTRAINT IF EXISTS pesepay_intents_target_type_check;
        ALTER TABLE pesepay_intents ADD CONSTRAINT pesepay_intents_target_type_check
          CHECK (target_type IN ('invoice', 'shift', 'subscription', 'starlink'));
      END IF;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_starlink_customers_email
      ON starlink_customers (lower(email));
    CREATE INDEX IF NOT EXISTS idx_starlink_customers_phone
      ON starlink_customers (phone);

    -- Registered Starlink kits/hardware per customer.
    CREATE TABLE IF NOT EXISTS starlink_kits (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id    UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      kit_number     TEXT NOT NULL,
      nickname       TEXT NOT NULL DEFAULT '',
      data_usage_gb  NUMERIC(10,2) NOT NULL DEFAULT 0,
      data_credit_gb NUMERIC(10,2) NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Fleet metadata. These are additive columns so single-kit accounts keep
    -- their existing kit rows and JSON shape (empty labels, standard model).
    ALTER TABLE starlink_kits ADD COLUMN IF NOT EXISTS site_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE starlink_kits ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT '';
    ALTER TABLE starlink_kits ADD COLUMN IF NOT EXISTS gps_lat NUMERIC(9,6);
    ALTER TABLE starlink_kits ADD COLUMN IF NOT EXISTS gps_lng NUMERIC(9,6);
    ALTER TABLE starlink_kits ADD COLUMN IF NOT EXISTS hardware_model TEXT NOT NULL DEFAULT 'standard';
    ALTER TABLE starlink_kits ADD COLUMN IF NOT EXISTS pending_status TEXT;
    ALTER TABLE starlink_kits ADD COLUMN IF NOT EXISTS pending_status_at TIMESTAMPTZ;
    ALTER TABLE starlink_kits ADD COLUMN IF NOT EXISTS pending_request_id UUID;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_starlink_kits_customer_kit
      ON starlink_kits (customer_id, lower(kit_number));
    CREATE INDEX IF NOT EXISTS idx_starlink_kits_fleet_site
      ON starlink_kits (customer_id, lower(site_name));
    CREATE INDEX IF NOT EXISTS idx_starlink_kits_pending_state
      ON starlink_kits (pending_status_at) WHERE pending_status IS NOT NULL;

    -- Native Preyone invoices for this portal (NOT pos_documents — those stay
    -- POS-owned. This portal bills wallet/data/kit purchases only).
    CREATE TABLE IF NOT EXISTS starlink_invoices (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id    UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      invoice_number TEXT UNIQUE NOT NULL,
      amount         NUMERIC(12,2) NOT NULL,
      currency       TEXT NOT NULL DEFAULT 'USD',
      description    TEXT NOT NULL DEFAULT '',
      kind           TEXT NOT NULL DEFAULT 'service',
      status         TEXT NOT NULL DEFAULT 'PENDING',
      pese_reference TEXT,
      meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
      issued_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      due_date       DATE,
      paid_at        TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_starlink_invoices_customer
      ON starlink_invoices (customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_starlink_invoices_status
      ON starlink_invoices (status) WHERE status <> 'PAID';

    -- Monthly data consumption per kit (feeds the usage bar chart).
    CREATE TABLE IF NOT EXISTS starlink_kit_usage (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kit_id       UUID NOT NULL REFERENCES starlink_kits(id) ON DELETE CASCADE,
      period_month DATE NOT NULL,
      usage_gb     NUMERIC(10,2) NOT NULL DEFAULT 0,
      is_baseline  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_starlink_kit_usage_month
      ON starlink_kit_usage (kit_id, period_month);

    -- Plan switch applications. Submitted by customers, decided by an admin
    -- against the seat capacity of the requested package.
    CREATE TABLE IF NOT EXISTS starlink_plan_capacity (
      plan_code  TEXT PRIMARY KEY,
      capacity   INTEGER NOT NULL DEFAULT 100,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS starlink_plan_applications (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id     UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      from_plan_code  TEXT,
      to_plan_code    TEXT NOT NULL,
      requested_start DATE NOT NULL,
      status          TEXT NOT NULL DEFAULT 'PENDING',
      decided_at      TIMESTAMPTZ,
      decided_by      TEXT,
      decision_note   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_starlink_plan_applications_status
      ON starlink_plan_applications (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_starlink_plan_applications_customer
      ON starlink_plan_applications (customer_id, created_at DESC);

    -- Customer notification feed. The enum type is created defensively: PM2
    -- runs this DDL from every worker, so the advisory lock serialises the
    -- CREATE TYPE before the idempotent IF NOT EXISTS check.
    DO $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('preyone:starlink_notification_category'));
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'starlink_notification_category') THEN
        CREATE TYPE starlink_notification_category AS ENUM
          ('PAYMENT', 'USAGE_ALERT', 'AUTO_TOPUP', 'COMMAND', 'TICKET', 'FLEET');
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS starlink_notifications (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id   UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      category      starlink_notification_category NOT NULL DEFAULT 'PAYMENT',
      event_key     TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL,
      link_url      TEXT,
      meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_read       BOOLEAN NOT NULL DEFAULT FALSE,
      read_at       TIMESTAMPTZ,
      email_status  TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
      email_sent_at TIMESTAMPTZ,
      email_error   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Additive visibility flag: existing rows default to visible, so the
    -- current feed keeps behaving exactly as before.
    ALTER TABLE starlink_notifications ADD COLUMN IF NOT EXISTS visible_in_portal BOOLEAN NOT NULL DEFAULT TRUE;

    CREATE INDEX IF NOT EXISTS idx_starlink_notifications_customer
      ON starlink_notifications (customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_starlink_notifications_unread
      ON starlink_notifications (customer_id) WHERE is_read = FALSE;
    CREATE INDEX IF NOT EXISTS idx_starlink_notifications_mail
      ON starlink_notifications (email_status) WHERE email_status = 'PENDING';

    -- Raw terminal telemetry. One row per kit per timestamp; ON CONFLICT keeps
    -- admin retries idempotent. Usage counters are cumulative GB.
    CREATE TABLE IF NOT EXISTS starlink_usage_snapshots (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kit_id              UUID NOT NULL REFERENCES starlink_kits(id) ON DELETE CASCADE,
      recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      priority_used_gb    NUMERIC(12,2) NOT NULL DEFAULT 0,
      standard_used_gb    NUMERIC(12,2) NOT NULL DEFAULT 0,
      download_mbps       NUMERIC(10,2),
      upload_mbps         NUMERIC(10,2),
      latency_ms          NUMERIC(10,2),
      ping_drop_rate      NUMERIC(6,2),
      obstruction_percent NUMERIC(6,2),
      uptime_seconds      BIGINT,
      online_status       BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_starlink_usage_snapshot_kit_time
      ON starlink_usage_snapshots (kit_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_starlink_usage_snapshot_recent
      ON starlink_usage_snapshots (kit_id, recorded_at DESC);

    -- Alert preferences and per-cycle send markers. Per-threshold switches are
    -- additive to the global email/portal/offline switches.
    CREATE TABLE IF NOT EXISTS starlink_alert_preferences (
      kit_id                    UUID PRIMARY KEY REFERENCES starlink_kits(id) ON DELETE CASCADE,
      customer_id               UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      alert_75_sent_cycle       TEXT,
      alert_90_sent_cycle       TEXT,
      alert_100_sent_cycle      TEXT,
      alert_75_email_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
      alert_75_portal_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
      alert_90_email_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
      alert_90_portal_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
      alert_100_email_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
      alert_100_portal_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
      email_alerts_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      portal_alerts_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
      offline_alerts_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
      auto_topup_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
      auto_topup_gb             NUMERIC(10,2) NOT NULL DEFAULT 10,
      auto_topup_min_gb         NUMERIC(10,2) NOT NULL DEFAULT 2,
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_starlink_alert_prefs_customer
      ON starlink_alert_preferences (customer_id);

    -- Immutable kit-to-kit data credit ledger. Pure data movement: no wallet
    -- balance and no invoice are created by a transfer.
    CREATE TABLE IF NOT EXISTS starlink_credit_transfers (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id  UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      from_kit_id  UUID NOT NULL REFERENCES starlink_kits(id) ON DELETE RESTRICT,
      to_kit_id    UUID NOT NULL REFERENCES starlink_kits(id) ON DELETE RESTRICT,
      gb           NUMERIC(10,2) NOT NULL CHECK (gb > 0),
      event_key    TEXT NOT NULL UNIQUE,
      meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (from_kit_id <> to_kit_id)
    );

    CREATE INDEX IF NOT EXISTS idx_starlink_credit_transfers_customer
      ON starlink_credit_transfers (customer_id, created_at DESC);

    -- Branch managers / accountants / site technicians. These are NOT paying
    -- customers: all money stays with the owner customer row.
    CREATE TABLE IF NOT EXISTS starlink_account_members (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_customer_id UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      email             TEXT NOT NULL,
      name              TEXT NOT NULL,
      role              TEXT NOT NULL CHECK (role IN ('admin', 'billing', 'viewer')),
      assigned_kit_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
      invite_token      TEXT UNIQUE,
      invite_expires_at TIMESTAMPTZ,
      password_hash     TEXT,
      accepted_at       TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_starlink_members_email
      ON starlink_account_members (lower(email));
    CREATE INDEX IF NOT EXISTS idx_starlink_members_owner
      ON starlink_account_members (owner_customer_id, created_at DESC);

    -- Scheduled pause / reactivation requests. A future effective_at is applied
    -- lazily by applyScheduledStarlinkServiceStates() on the next portal read.
    CREATE TABLE IF NOT EXISTS starlink_kit_service_requests (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id      UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      kit_id           UUID NOT NULL REFERENCES starlink_kits(id) ON DELETE CASCADE,
      requested_status TEXT NOT NULL CHECK (requested_status IN ('active', 'paused')),
      effective_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      note             TEXT NOT NULL DEFAULT '',
      event_key        TEXT NOT NULL UNIQUE,
      actor_member_id  UUID,
      applied_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_starlink_service_requests_kit
      ON starlink_kit_service_requests (kit_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_starlink_service_requests_due
      ON starlink_kit_service_requests (effective_at) WHERE applied_at IS NULL;
`;

/**
 * Boot-time, idempotent DDL. PM2 runs this from every cluster worker at once,
 * and concurrent CREATE statements race in Postgres' type catalog (duplicate
 * key on pg_type_typname_nsp_index) even with IF NOT EXISTS. So: on failure,
 * check whether the tables actually landed (another worker won the race) and
 * only retry if they are still missing.
 */
export async function ensureStarlinkSchema(): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await pool.query(STARLINK_DDL);
      return;
    } catch (err) {
      lastErr = err;
      try {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM pg_tables
            WHERE tablename IN (
              'starlink_customers', 'starlink_kits', 'starlink_invoices',
              'starlink_kit_usage', 'starlink_plan_capacity',
              'starlink_plan_applications', 'starlink_notifications',
              'starlink_usage_snapshots', 'starlink_alert_preferences',
              'starlink_credit_transfers', 'starlink_account_members',
              'starlink_kit_service_requests'
            )`
        );
        if (Number(rows[0]?.n) >= 12) return;
      } catch {
        /* connectivity issue — keep retrying */
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Auth / customers
// ---------------------------------------------------------------------------

export async function createStarlinkCustomer(input: {
  fullName: string;
  email: string;
  phone: string;
  passwordHash: string;
  kitSerial?: string | null;
  nickname?: string;
}): Promise<StarlinkCustomer> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO starlink_customers (full_name, email, phone, password_hash)
       VALUES ($1, lower($2), $3, $4)
       RETURNING id, full_name, email, phone, password_hash, company_id, wallet_balance, plan_code, plan_renews_at, email_verified_at, created_at`,
      [input.fullName.trim(), input.email.trim(), input.phone.trim(), input.passwordHash]
    );
    const customer = rows[0] as StarlinkCustomer;
    if (input.kitSerial && input.kitSerial.trim()) {
      await registerKitTx(client, customer.id, input.kitSerial.trim(), input.nickname || 'My Starlink Kit');
    }
    await client.query('COMMIT');
    return customer;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function findStarlinkCustomerByEmail(email: string): Promise<StarlinkCustomer | null> {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, password_hash, company_id, wallet_balance, plan_code, plan_renews_at, email_verified_at, created_at
       FROM starlink_customers WHERE lower(email) = lower($1)`,
    [email.trim()]
  );
  return (rows[0] as StarlinkCustomer) ?? null;
}

/** Sign-in accepts Email OR Phone in one field. */
export async function findStarlinkCustomerByIdentifier(identifier: string): Promise<StarlinkCustomer | null> {
  const v = identifier.trim();
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, password_hash, company_id, wallet_balance, plan_code, plan_renews_at, email_verified_at, created_at
       FROM starlink_customers
      WHERE lower(email) = lower($1) OR phone = $1
      LIMIT 1`,
    [v]
  );
  return (rows[0] as StarlinkCustomer) ?? null;
}

export async function getStarlinkCustomerById(id: string): Promise<StarlinkCustomer | null> {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, password_hash, company_id, wallet_balance, plan_code, plan_renews_at, email_verified_at, created_at
       FROM starlink_customers WHERE id = $1`,
    [id]
  );
  return (rows[0] as StarlinkCustomer) ?? null;
}

export async function updateStarlinkProfile(
  id: string,
  patch: { fullName?: string; phone?: string }
): Promise<void> {
  await pool.query(
    `UPDATE starlink_customers
        SET full_name = COALESCE($2, full_name),
            phone     = COALESCE($3, phone)
      WHERE id = $1`,
    [id, patch.fullName?.trim() || null, patch.phone?.trim() || null]
  );
}

export async function updateStarlinkPassword(id: string, passwordHash: string): Promise<void> {
  await pool.query('UPDATE starlink_customers SET password_hash = $2, reset_token = NULL, reset_expires_at = NULL WHERE id = $1', [
    id,
    passwordHash,
  ]);
}

export async function setStarlinkResetToken(email: string, token: string, expiresAt: Date): Promise<StarlinkCustomer | null> {
  const { rows } = await pool.query(
    `UPDATE starlink_customers
        SET reset_token = $2, reset_expires_at = $3
      WHERE lower(email) = lower($1)
      RETURNING id, full_name, email, phone, password_hash, company_id, wallet_balance, plan_code, plan_renews_at, email_verified_at, created_at`,
    [email.trim(), token, expiresAt]
  );
  return (rows[0] as StarlinkCustomer) ?? null;
}

export async function consumeStarlinkResetToken(token: string, passwordHash: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE starlink_customers
        SET password_hash = $2, reset_token = NULL, reset_expires_at = NULL
      WHERE reset_token = $1 AND reset_expires_at > NOW()`,
    [token, passwordHash]
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Kits
// ---------------------------------------------------------------------------

/** Baseline monthly usage seeded at registration so the chart is meaningful
 *  until live telemetry lands. Rows are flagged is_baseline=TRUE and are
 *  overwritten by real syncs. Disable with STARLINK_BASELINE_USAGE=off. */
function baselineEnabled(): boolean {
  return process.env.STARLINK_BASELINE_USAGE !== 'off';
}

const STARLINK_KIT_COLUMNS = `
  id, customer_id, kit_number, nickname, data_usage_gb, data_credit_gb, status,
  created_at, site_name, city, gps_lat, gps_lng, hardware_model,
  pending_status, pending_status_at, pending_request_id`;

/** pg NUMERIC arrives as a string; keep the portal's JSON numeric contract. */
function normalizeKit(row: any): StarlinkKit {
  return {
    ...(row as StarlinkKit),
    data_usage_gb: Number(row.data_usage_gb ?? 0),
    data_credit_gb: Number(row.data_credit_gb ?? 0),
    gps_lat: row.gps_lat == null ? null : Number(row.gps_lat),
    gps_lng: row.gps_lng == null ? null : Number(row.gps_lng),
    site_name: row.site_name ?? '',
    city: row.city ?? '',
    hardware_model: row.hardware_model ?? 'standard',
    pending_status: row.pending_status ?? null,
    pending_status_at: row.pending_status_at ?? null,
    pending_request_id: row.pending_request_id ?? null,
  };
}

const HARDWARE_MODELS = ['standard', 'mini', 'high_performance'];

function normalizeHardwareModel(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (HARDWARE_MODELS.includes(raw)) return raw;
  return 'standard';
}

function normalizeCoordinate(value: unknown, axis: 'lat' | 'lng'): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  const limit = axis === 'lat' ? 90 : 180;
  return Number.isFinite(n) && n >= -limit && n <= limit ? Math.round(n * 1e6) / 1e6 : null;
}

async function registerKitTx(
  client: PoolClient,
  customerId: string,
  kitNumber: string,
  nickname: string,
  metadata: StarlinkKitMetadata = {}
): Promise<StarlinkKit> {
  const { rows } = await client.query(
    `INSERT INTO starlink_kits
       (customer_id, kit_number, nickname, site_name, city, gps_lat, gps_lng, hardware_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${STARLINK_KIT_COLUMNS}`,
    [
      customerId,
      kitNumber,
      nickname,
      String(metadata.siteName ?? '').trim().slice(0, 120),
      String(metadata.city ?? '').trim().slice(0, 120),
      normalizeCoordinate(metadata.gpsLat, 'lat'),
      normalizeCoordinate(metadata.gpsLng, 'lng'),
      normalizeHardwareModel(metadata.hardwareModel),
    ]
  );
  const kit = normalizeKit(rows[0]);
  if (baselineEnabled()) {
    const now = new Date();
    const seed = (kitNumber.charCodeAt(kitNumber.length - 1) || 7) % 4;
    const values = [1.4 + seed * 0.3, 2.1 + seed * 0.2, 1.9 + seed * 0.4, 1.1 + seed * 0.5];
    let total = 0;
    for (let i = 3; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const gb = Number(values[3 - i].toFixed(2));
      total += gb;
      await client.query(
        `INSERT INTO starlink_kit_usage (kit_id, period_month, usage_gb, is_baseline)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (kit_id, period_month) DO NOTHING`,
        [kit.id, d.toISOString().slice(0, 10), gb]
      );
    }
    await client.query('UPDATE starlink_kits SET data_usage_gb = $2 WHERE id = $1', [kit.id, Number(total.toFixed(2))]);
    kit.data_usage_gb = Number(total.toFixed(2));
  }
  return kit;
}

export async function registerStarlinkKit(
  customerId: string,
  kitNumber: string,
  nickname?: string,
  metadata: StarlinkKitMetadata = {}
): Promise<StarlinkKit> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const kit = await registerKitTx(
      client, customerId, kitNumber.trim(), (nickname || '').trim() || 'My Starlink Kit', metadata
    );
    await client.query('COMMIT');
    return kit;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listStarlinkKits(customerId: string): Promise<StarlinkKit[]> {
  const { rows } = await pool.query(
    `SELECT ${STARLINK_KIT_COLUMNS}
       FROM starlink_kits WHERE customer_id = $1 ORDER BY created_at ASC`,
    [customerId]
  );
  return rows.map(normalizeKit);
}

export async function getStarlinkKit(id: string, customerId: string): Promise<StarlinkKit | null> {
  const { rows } = await pool.query(
    `SELECT ${STARLINK_KIT_COLUMNS}
       FROM starlink_kits WHERE id = $1 AND customer_id = $2`,
    [id, customerId]
  );
  return rows[0] ? normalizeKit(rows[0]) : null;
}

export async function updateStarlinkKit(
  id: string,
  customerId: string,
  patch: { nickname?: string; status?: string } & StarlinkKitMetadata
): Promise<boolean> {
  // Each field carries an explicit "provided" flag so an empty string or null
  // can clear metadata without clearing everything the caller omitted.
  const statusProvided = patch.status !== undefined && patch.status !== null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE starlink_kits
          SET nickname         = CASE WHEN $3::boolean THEN $4 ELSE nickname END,
              status           = CASE WHEN $5::boolean THEN $6 ELSE status END,
              pending_status   = CASE WHEN $5::boolean THEN NULL ELSE pending_status END,
              pending_status_at = CASE WHEN $5::boolean THEN NULL ELSE pending_status_at END,
              pending_request_id = CASE WHEN $5::boolean THEN NULL ELSE pending_request_id END,
              site_name        = CASE WHEN $7::boolean THEN $8 ELSE site_name END,
              city             = CASE WHEN $9::boolean THEN $10 ELSE city END,
              gps_lat          = CASE WHEN $11::boolean THEN $12 ELSE gps_lat END,
              gps_lng          = CASE WHEN $13::boolean THEN $14 ELSE gps_lng END,
              hardware_model   = CASE WHEN $15::boolean THEN $16 ELSE hardware_model END
        WHERE id = $1 AND customer_id = $2`,
      [
        id,
        customerId,
        patch.nickname !== undefined,
        patch.nickname === undefined ? null : patch.nickname.trim() || '',
        statusProvided,
        statusProvided ? patch.status : null,
        patch.siteName !== undefined,
        patch.siteName == null ? null : String(patch.siteName).trim().slice(0, 120),
        patch.city !== undefined,
        patch.city == null ? null : String(patch.city).trim().slice(0, 120),
        patch.gpsLat !== undefined,
        normalizeCoordinate(patch.gpsLat, 'lat'),
        patch.gpsLng !== undefined,
        normalizeCoordinate(patch.gpsLng, 'lng'),
        patch.hardwareModel !== undefined,
        patch.hardwareModel == null || String(patch.hardwareModel).trim() === ''
          ? 'standard'
          : normalizeHardwareModel(patch.hardwareModel),
      ]
    );
    const updated = (result.rowCount ?? 0) > 0;
    if (updated && statusProvided) {
      // A manual status decision wins over any earlier schedule. Closing the
      // request row stops applyScheduledStarlinkServiceStates() from firing it.
      await client.query(
        `UPDATE starlink_kit_service_requests
            SET applied_at = NOW()
          WHERE kit_id = $1 AND customer_id = $2 AND applied_at IS NULL`,
        [id, customerId]
      );
    }
    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getKitUsageHistory(kitId: string, months = 4): Promise<StarlinkUsagePoint[]> {
  const { rows } = await pool.query(
    `SELECT period_month, usage_gb, is_baseline
       FROM starlink_kit_usage
      WHERE kit_id = $1
        AND period_month >= date_trunc('month', NOW()) - (($2::int - 1) * INTERVAL '1 month')
      ORDER BY period_month ASC`,
    [kitId, months]
  );
  return rows.map((r: any) => ({
    month: String(r.period_month).slice(0, 10),
    usage_gb: Number(r.usage_gb),
    is_baseline: !!r.is_baseline,
  }));
}

// ---------------------------------------------------------------------------
// Fleet grouping, sub-accounts and credit movement (additive)
// ---------------------------------------------------------------------------

function normalizeMember(row: any): StarlinkAccountMember {
  const ids = row.assigned_kit_ids;
  return {
    ...(row as StarlinkAccountMember),
    assigned_kit_ids: Array.isArray(ids) ? ids.map((v: unknown) => String(v)) : [],
  };
}

function normalizeTransfer(row: any): StarlinkCreditTransfer {
  return { ...(row as StarlinkCreditTransfer), gb: Number(row.gb ?? 0) };
}

/** Apply any scheduled pause/reactivation whose effective time has arrived. */
export async function applyScheduledStarlinkServiceStates(): Promise<number> {
  const result = await pool.query(
    `WITH due AS (
       UPDATE starlink_kits k
          SET status = r.requested_status,
              pending_status = NULL,
              pending_status_at = NULL,
              pending_request_id = NULL
         FROM starlink_kit_service_requests r
        WHERE r.kit_id = k.id
          AND r.applied_at IS NULL
          AND r.effective_at <= NOW()
        RETURNING r.id
     )
     UPDATE starlink_kit_service_requests SET applied_at = NOW()
      WHERE id IN (SELECT id FROM due)`
  );
  return result.rowCount ?? 0;
}

export async function listStarlinkCreditTransfers(customerId: string, limit = 25): Promise<StarlinkCreditTransfer[]> {
  const { rows } = await pool.query(
    `SELECT id, customer_id, from_kit_id, to_kit_id, gb, event_key, meta, created_at
       FROM starlink_credit_transfers
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [customerId, Math.min(Math.max(Number(limit) || 25, 1), 100)]
  );
  return rows.map(normalizeTransfer);
}

/**
 * Move spendable data credit between two kits on the SAME owner account.
 * Both rows are locked in a deterministic order, the debit is conditional so
 * balances can never go negative, and the ledger + notification are committed
 * with the balance changes.
 */
export async function transferStarlinkKitCredit(input: {
  customerId: string;
  fromKitId: string;
  toKitId: string;
  gb: number;
  eventKey: string;
  actorMemberId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<{
  transfer: StarlinkCreditTransfer;
  fromBalance: number;
  toBalance: number;
  notificationCreated: boolean;
}> {
  const gb = Math.round(Number(input.gb) * 100) / 100;
  if (!Number.isFinite(gb) || gb <= 0) throw new Error('Transfer amount must be greater than zero');
  if (input.fromKitId === input.toKitId) throw new Error('Choose two different kits');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Replay of a previously completed request is a no-op, not a second debit.
    const existing = await client.query(
      `SELECT id, customer_id, from_kit_id, to_kit_id, gb, event_key, meta, created_at
         FROM starlink_credit_transfers WHERE event_key = $1`,
      [input.eventKey]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      const transfer = normalizeTransfer(existing.rows[0]);
      const [from, to] = await Promise.all([
        getStarlinkKit(transfer.from_kit_id, input.customerId),
        getStarlinkKit(transfer.to_kit_id, input.customerId),
      ]);
      return {
        transfer,
        fromBalance: Number(from?.data_credit_gb ?? 0),
        toBalance: Number(to?.data_credit_gb ?? 0),
        notificationCreated: false,
      };
    }

    const kitIds = [input.fromKitId, input.toKitId].sort();
    const locked = await client.query(
      `SELECT id, customer_id FROM starlink_kits WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [kitIds]
    );
    if (locked.rows.length !== 2 || locked.rows.some((r) => r.customer_id !== input.customerId)) {
      throw new Error('Both kits must belong to this account');
    }

    const debit = await client.query(
      `UPDATE starlink_kits
          SET data_credit_gb = data_credit_gb - $3
        WHERE id = $1 AND customer_id = $2 AND data_credit_gb >= $3
        RETURNING data_credit_gb`,
      [input.fromKitId, input.customerId, gb]
    );
    if ((debit.rowCount ?? 0) !== 1) throw new Error('Not enough data credit on the source kit');

    const credit = await client.query(
      `UPDATE starlink_kits
          SET data_credit_gb = data_credit_gb + $3
        WHERE id = $1 AND customer_id = $2
        RETURNING data_credit_gb`,
      [input.toKitId, input.customerId, gb]
    );
    if ((credit.rowCount ?? 0) !== 1) throw new Error('Destination kit not found');

    const inserted = await client.query(
      `INSERT INTO starlink_credit_transfers
         (customer_id, from_kit_id, to_kit_id, gb, event_key, meta)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, customer_id, from_kit_id, to_kit_id, gb, event_key, meta, created_at`,
      [
        input.customerId,
        input.fromKitId,
        input.toKitId,
        gb,
        input.eventKey,
        JSON.stringify(input.meta ?? {}),
      ]
    );

    const notificationCreated = await queueStarlinkNotification({
      customerId: input.customerId,
      category: 'FLEET',
      eventKey: `starlink-fleet-transfer:${input.eventKey}`,
      title: 'Data credit moved between kits',
      body: `${gb.toFixed(2)} GB was transferred to another kit on your account.`,
      linkUrl: `${starlinkBaseUrl()}/starlink/portal`,
      meta: {
        from_kit_id: input.fromKitId,
        to_kit_id: input.toKitId,
        gb,
        actor_member_id: input.actorMemberId ?? null,
      },
    }, client);

    await client.query('COMMIT');
    return {
      transfer: normalizeTransfer(inserted.rows[0]),
      fromBalance: Number(debit.rows[0].data_credit_gb),
      toBalance: Number(credit.rows[0].data_credit_gb),
      notificationCreated,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Create or schedule an active/paused service state change for one kit. */
export async function requestStarlinkKitServiceState(input: {
  customerId: string;
  kitId: string;
  state: 'active' | 'paused';
  effectiveAt?: Date | null;
  note?: string;
  actorMemberId?: string | null;
  eventKey: string;
}): Promise<{ request: StarlinkServiceStateRequest; applied: boolean; notificationCreated: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, customer_id, kit_id, requested_status, effective_at, note,
              event_key, actor_member_id, applied_at, created_at
         FROM starlink_kit_service_requests WHERE event_key = $1`,
      [input.eventKey]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return {
        request: existing.rows[0] as StarlinkServiceStateRequest,
        applied: Boolean(existing.rows[0].applied_at),
        notificationCreated: false,
      };
    }

    const locked = await client.query(
      `SELECT id, customer_id FROM starlink_kits WHERE id = $1 FOR UPDATE`,
      [input.kitId]
    );
    if (!locked.rows[0] || locked.rows[0].customer_id !== input.customerId) {
      throw new Error('Kit not found on this account');
    }

    // Only the newest request is authoritative. Older scheduled changes are
    // closed out here so they cannot fire later and undo this decision.
    await client.query(
      `UPDATE starlink_kit_service_requests
          SET applied_at = NOW()
        WHERE kit_id = $1 AND customer_id = $2 AND applied_at IS NULL`,
      [input.kitId, input.customerId]
    );

    const effectiveAt = input.effectiveAt && input.effectiveAt.getTime() > Date.now()
      ? input.effectiveAt
      : new Date();
    const inserted = await client.query(
      `INSERT INTO starlink_kit_service_requests
         (customer_id, kit_id, requested_status, effective_at, note, event_key, actor_member_id, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 <= NOW() THEN NOW() ELSE NULL END)
       RETURNING id, customer_id, kit_id, requested_status, effective_at, note,
                 event_key, actor_member_id, applied_at, created_at`,
      [
        input.customerId,
        input.kitId,
        input.state,
        effectiveAt.toISOString(),
        String(input.note ?? '').trim().slice(0, 240),
        input.eventKey,
        input.actorMemberId ?? null,
      ]
    );
    const request = inserted.rows[0] as StarlinkServiceStateRequest;

    if (request.applied_at) {
      await client.query(
        `UPDATE starlink_kits
            SET status = $3, pending_status = NULL, pending_status_at = NULL, pending_request_id = NULL
          WHERE id = $1 AND customer_id = $2`,
        [input.kitId, input.customerId, input.state]
      );
    } else {
      await client.query(
        `UPDATE starlink_kits
            SET pending_status = $3, pending_status_at = $4, pending_request_id = $5
          WHERE id = $1 AND customer_id = $2`,
        [input.kitId, input.customerId, input.state, request.effective_at, request.id]
      );
    }

    const when = request.applied_at ? 'now' : `on ${new Date(request.effective_at).toLocaleString('en-GB')}`;
    const notificationCreated = await queueStarlinkNotification({
      customerId: input.customerId,
      category: 'FLEET',
      eventKey: `starlink-service-state:${input.eventKey}`,
      title: request.requested_status === 'paused' ? 'Service pause scheduled' : 'Service reactivation scheduled',
      body: `Your kit was scheduled to be ${request.requested_status} ${when}.`,
      linkUrl: `${starlinkBaseUrl()}/starlink/portal`,
      meta: { kit_id: input.kitId, state: request.requested_status, effective_at: request.effective_at },
    }, client);

    await client.query('COMMIT');
    return { request, applied: Boolean(request.applied_at), notificationCreated };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Sub-account members
// ---------------------------------------------------------------------------

export async function createStarlinkAccountMember(input: {
  ownerCustomerId: string;
  email: string;
  name: string;
  role: 'admin' | 'billing' | 'viewer';
  assignedKitIds: string[];
  inviteTokenHash: string;
  inviteExpiresAt: Date;
}): Promise<StarlinkAccountMember> {
  const { rows } = await pool.query(
    `INSERT INTO starlink_account_members
       (owner_customer_id, email, name, role, assigned_kit_ids, invite_token, invite_expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING id, owner_customer_id, email, name, role, assigned_kit_ids,
               invite_token, invite_expires_at, password_hash, accepted_at, created_at`,
    [
      input.ownerCustomerId,
      input.email,
      input.name,
      input.role,
      JSON.stringify(input.assignedKitIds),
      input.inviteTokenHash,
      input.inviteExpiresAt.toISOString(),
    ]
  );
  return normalizeMember(rows[0]);
}

export async function listStarlinkAccountMembers(ownerCustomerId: string): Promise<StarlinkAccountMember[]> {
  const { rows } = await pool.query(
    `SELECT id, owner_customer_id, email, name, role, assigned_kit_ids,
            invite_token, invite_expires_at, password_hash, accepted_at, created_at
       FROM starlink_account_members
      WHERE owner_customer_id = $1
      ORDER BY created_at ASC`,
    [ownerCustomerId]
  );
  return rows.map(normalizeMember);
}

export async function getStarlinkAccountMemberById(id: string): Promise<StarlinkAccountMember | null> {
  const { rows } = await pool.query(
    `SELECT id, owner_customer_id, email, name, role, assigned_kit_ids,
            invite_token, invite_expires_at, password_hash, accepted_at, created_at
       FROM starlink_account_members WHERE id = $1`,
    [id]
  );
  return rows[0] ? normalizeMember(rows[0]) : null;
}

export async function findAcceptedMemberByEmail(email: string): Promise<StarlinkAccountMember | null> {
  const { rows } = await pool.query(
    `SELECT id, owner_customer_id, email, name, role, assigned_kit_ids,
            invite_token, invite_expires_at, password_hash, accepted_at, created_at
       FROM starlink_account_members
      WHERE lower(email) = lower($1) AND accepted_at IS NOT NULL AND password_hash IS NOT NULL`,
    [email]
  );
  return rows[0] ? normalizeMember(rows[0]) : null;
}

export async function acceptStarlinkAccountMember(input: {
  inviteTokenHash: string;
  passwordHash: string;
  name?: string;
}): Promise<StarlinkAccountMember | null> {
  const { rows } = await pool.query(
    `UPDATE starlink_account_members
        SET password_hash = $2,
            name = COALESCE(NULLIF($3, ''), name),
            accepted_at = NOW(),
            invite_token = NULL,
            invite_expires_at = NULL
      WHERE invite_token = $1
        AND accepted_at IS NULL
        AND invite_expires_at > NOW()
      RETURNING id, owner_customer_id, email, name, role, assigned_kit_ids,
                invite_token, invite_expires_at, password_hash, accepted_at, created_at`,
    [input.inviteTokenHash, input.passwordHash, String(input.name ?? '').trim()]
  );
  return rows[0] ? normalizeMember(rows[0]) : null;
}

/**
 * Reissue an invite (also used to re-invite an expired pending member). Clearing
 * accepted_at/password_hash invalidates any existing sub-account session and
 * forces the member to set a new password through the new token.
 */
export async function rotateStarlinkAccountMemberInvite(input: {
  ownerCustomerId: string;
  memberId: string;
  inviteTokenHash: string;
  inviteExpiresAt: Date;
  name?: string;
  role?: StarlinkAccountMemberRole;
  assignedKitIds?: string[];
}): Promise<StarlinkAccountMember | null> {
  const { rows } = await pool.query(
    `UPDATE starlink_account_members
        SET name = COALESCE(NULLIF($5, ''), name),
            role = COALESCE($6, role),
            assigned_kit_ids = CASE WHEN $7::boolean THEN $8::jsonb ELSE assigned_kit_ids END,
            invite_token = $3,
            invite_expires_at = $4,
            accepted_at = NULL,
            password_hash = NULL
      WHERE id = $1 AND owner_customer_id = $2
      RETURNING id, owner_customer_id, email, name, role, assigned_kit_ids,
                invite_token, invite_expires_at, password_hash, accepted_at, created_at`,
    [
      input.memberId,
      input.ownerCustomerId,
      input.inviteTokenHash,
      input.inviteExpiresAt.toISOString(),
      String(input.name ?? '').trim(),
      input.role ?? null,
      input.assignedKitIds !== undefined,
      JSON.stringify(input.assignedKitIds ?? []),
    ]
  );
  return rows[0] ? normalizeMember(rows[0]) : null;
}

export async function updateStarlinkAccountMemberAccess(input: {
  ownerCustomerId: string;
  memberId: string;
  role: StarlinkAccountMemberRole;
  assignedKitIds: string[];
}): Promise<StarlinkAccountMember | null> {
  const { rows } = await pool.query(
    `UPDATE starlink_account_members
        SET role = $3, assigned_kit_ids = $4::jsonb
      WHERE id = $1 AND owner_customer_id = $2
      RETURNING id, owner_customer_id, email, name, role, assigned_kit_ids,
                invite_token, invite_expires_at, password_hash, accepted_at, created_at`,
    [input.memberId, input.ownerCustomerId, input.role, JSON.stringify(input.assignedKitIds)]
  );
  return rows[0] ? normalizeMember(rows[0]) : null;
}

export async function deleteStarlinkAccountMember(
  ownerCustomerId: string,
  memberId: string
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM starlink_account_members WHERE id = $1 AND owner_customer_id = $2`,
    [memberId, ownerCustomerId]
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Sequential per-month invoice number (SL-202610-0001). Runs inside the
 * caller's transaction when one is open; the advisory lock serialises
 * concurrent checkouts so two customers can never draw the same number.
 */
export async function nextStarlinkInvoiceNumber(client?: PoolClient): Promise<string> {
  const q = client ?? pool;
  const now = new Date();
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  if (client) await client.query(`SELECT pg_advisory_xact_lock(hashtext('starlink_invoice_seq'))`);
  const { rows } = await q.query(
    `SELECT COUNT(*) AS n FROM starlink_invoices WHERE invoice_number LIKE $1`,
    [`SL-${ym}-%`]
  );
  const seq = (Number(rows[0]?.n ?? 0) + 1).toString().padStart(4, '0');
  return `SL-${ym}-${seq}`;
}

export async function createStarlinkInvoice(input: {
  customerId: string;
  amount: number;
  description: string;
  kind: string;
  meta?: Record<string, unknown>;
  dueDate?: string | null;
  client?: PoolClient;
}): Promise<StarlinkInvoice> {
  const q = input.client ?? pool;
  const invoiceNumber = await nextStarlinkInvoiceNumber(input.client);
  const { rows } = await q.query(
    `INSERT INTO starlink_invoices (customer_id, invoice_number, amount, currency, description, kind, status, meta, due_date)
     VALUES ($1, $2, $3, 'USD', $4, $5, 'PENDING', $6::jsonb, $7)
     RETURNING id, customer_id, invoice_number, amount, currency, description, kind, status,
               pese_reference, meta, issued_date, due_date, paid_at, created_at`,
    [
      input.customerId,
      invoiceNumber,
      input.amount,
      input.description,
      input.kind,
      JSON.stringify(input.meta ?? {}),
      input.dueDate ?? null,
    ]
  );
  return rows[0] as StarlinkInvoice;
}

export async function listStarlinkInvoices(customerId: string, status?: string): Promise<StarlinkInvoice[]> {
  if (status && ['PENDING', 'PAID', 'FAILED'].includes(status.toUpperCase())) {
    const { rows } = await pool.query(
      `SELECT id, customer_id, invoice_number, amount, currency, description, kind, status,
              pese_reference, meta, issued_date, due_date, paid_at, created_at
         FROM starlink_invoices
        WHERE customer_id = $1 AND status = $2
        ORDER BY created_at DESC`,
      [customerId, status.toUpperCase()]
    );
    return rows as StarlinkInvoice[];
  }
  const { rows } = await pool.query(
    `SELECT id, customer_id, invoice_number, amount, currency, description, kind, status,
            pese_reference, meta, issued_date, due_date, paid_at, created_at
       FROM starlink_invoices
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [customerId]
  );
  return rows as StarlinkInvoice[];
}

export async function getStarlinkInvoice(id: string, customerId: string): Promise<StarlinkInvoice | null> {
  const { rows } = await pool.query(
    `SELECT id, customer_id, invoice_number, amount, currency, description, kind, status,
            pese_reference, meta, issued_date, due_date, paid_at, created_at
       FROM starlink_invoices WHERE id = $1 AND customer_id = $2`,
    [id, customerId]
  );
  return (rows[0] as StarlinkInvoice) ?? null;
}

export async function getStarlinkInvoiceByNumber(invoiceNumber: string): Promise<StarlinkInvoice | null> {
  const { rows } = await pool.query(
    `SELECT id, customer_id, invoice_number, amount, currency, description, kind, status,
            pese_reference, meta, issued_date, due_date, paid_at, created_at
       FROM starlink_invoices WHERE invoice_number = $1`,
    [invoiceNumber]
  );
  return (rows[0] as StarlinkInvoice) ?? null;
}

export async function getBalanceDue(customerId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS due FROM starlink_invoices WHERE customer_id = $1 AND status = 'PENDING'`,
    [customerId]
  );
  return Number(rows[0]?.due ?? 0);
}

// ---------------------------------------------------------------------------
// Payment settlement — called from the Pesepay webhook (payments.ts) when a
// pesepay_intents row with target_type = 'starlink' completes.
// ---------------------------------------------------------------------------

function starlinkActionLabel(kind: string): string {
  switch (kind) {
    case 'wallet_topup': return 'Wallet top-up';
    case 'data_topup': return 'Data top-up';
    case 'kit_purchase': return 'Starlink kit purchase';
    case 'plan_change': return 'Plan change';
    case 'plan_renewal': return 'Plan renewal';
    case 'auto_topup': return 'Automatic data top-up';
    default: return 'Starlink service payment';
  }
}

export interface StarlinkSettlement {
  invoiceNumber: string;
  kind: string;
  amount: number;
  currency: string;
  walletBalance: number;
  dataBalance?: number;
  kitSerial?: string | null;
  kitNickname?: string | null;
  alreadyPaid: boolean;
  /** Unique notification key for the post-commit receipt dispatch. */
  receiptEventKey?: string;
}

/**
 * Marks the Starlink invoice PAID and applies its effect:
 *   wallet_topup  -> credits starlink_customers.wallet_balance
 *   data_topup    -> credits the target kit's data_credit_gb (meta.gb)
 *   kit_purchase  -> activates/registers the purchased kit (meta.kit_number)
 *
 * MUST be called with an open transaction client (webhook holds the intent
 * row lock). Idempotent: a replayed webhook sees status = 'PAID' and applies
 * nothing, so a retry can never double-credit a wallet.
 */
export async function applyStarlinkPayment(
  client: PoolClient,
  intent: { target_id: string | null; amount: number; provider_reference?: string | null },
  reference: string
): Promise<StarlinkSettlement> {
  if (!intent.target_id) {
    throw new Error('Starlink payment intent has no invoice attached');
  }
  const { rows } = await client.query(
    `SELECT id, customer_id, invoice_number, amount, currency, kind, status, meta
       FROM starlink_invoices WHERE id = $1 FOR UPDATE`,
    [intent.target_id]
  );
  if (rows.length === 0) {
    throw new Error('Starlink invoice not found for payment intent');
  }
  const inv = rows[0];

  if (String(inv.status) === 'PAID') {
    const bal = await client.query('SELECT wallet_balance FROM starlink_customers WHERE id = $1', [inv.customer_id]);
    return {
      invoiceNumber: inv.invoice_number,
      kind: inv.kind,
      amount: Number(inv.amount),
      currency: String(inv.currency || 'USD'),
      walletBalance: Number(bal.rows[0]?.wallet_balance ?? 0),
      alreadyPaid: true,
    };
  }

  await client.query(
    `UPDATE starlink_invoices
        SET status = 'PAID',
            paid_at = NOW(),
            pese_reference = COALESCE($2, pese_reference)
      WHERE id = $1`,
    [inv.id, intent.provider_reference || reference]
  );

  const meta = (inv.meta ?? {}) as Record<string, any>;

  if (inv.kind === 'plan_change' && meta.plan_code) {
    await client.query(
      `UPDATE starlink_customers
          SET plan_code = $2, plan_renews_at = CURRENT_DATE + INTERVAL '30 days'
        WHERE id = $1`,
      [inv.customer_id, String(meta.plan_code)]
    );
  } else if (inv.kind === 'plan_renewal') {
    await client.query(
      `UPDATE starlink_customers
          SET plan_renews_at = GREATEST(COALESCE(plan_renews_at, CURRENT_DATE), CURRENT_DATE) + INTERVAL '30 days'
        WHERE id = $1`,
      [inv.customer_id]
    );
  } else if (inv.kind === 'wallet_topup') {
    await client.query(
      'UPDATE starlink_customers SET wallet_balance = wallet_balance + $2 WHERE id = $1',
      [inv.customer_id, inv.amount]
    );
  } else if (inv.kind === 'data_topup' && meta.kit_id) {
    const gb = Number(meta.gb ?? 0);
    if (gb > 0) {
      await client.query('UPDATE starlink_kits SET data_credit_gb = data_credit_gb + $2 WHERE id = $1 AND customer_id = $3', [
        meta.kit_id,
        gb,
        inv.customer_id,
      ]);
    }
  } else if (inv.kind === 'kit_purchase' && meta.kit_number) {
    await client.query(
      `INSERT INTO starlink_kits (customer_id, kit_number, nickname, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (customer_id, lower(kit_number)) DO UPDATE SET status = 'active'`,
      [inv.customer_id, String(meta.kit_number), String(meta.nickname || 'Starlink Kit')]
    );
  }

  const bal = await client.query(
    'SELECT wallet_balance, plan_code, plan_renews_at FROM starlink_customers WHERE id = $1',
    [inv.customer_id]
  );
  const customer = (bal.rows[0] ?? {}) as Record<string, any>;

  const kitId = meta.kit_id ? String(meta.kit_id) : null;
  const kitNumber = meta.kit_number ? String(meta.kit_number) : null;
  let kitRow: Record<string, any> | null = null;
  if (kitId || kitNumber) {
    const { rows: kitRows } = await client.query(
      `SELECT kit_number, nickname, data_credit_gb FROM starlink_kits
        WHERE customer_id = $1
          AND (($2::uuid IS NOT NULL AND id = $2) OR ($3::text IS NOT NULL AND lower(kit_number) = lower($3)))
        ORDER BY created_at DESC LIMIT 1`,
      [inv.customer_id, kitId, kitNumber]
    );
    kitRow = (kitRows[0] as Record<string, any>) ?? null;
  }

  const receiptEventKey = `starlink-payment:${inv.id}`;
  const noticeMeta = {
    customerId: inv.customer_id,
    invoiceNumber: inv.invoice_number,
    kind: inv.kind,
    amount: Number(inv.amount),
    currency: String(inv.currency || 'USD'),
    providerReference: intent.provider_reference || reference,
    walletBalance: Number(customer.wallet_balance ?? 0),
    dataBalance: kitRow ? Number(kitRow.data_credit_gb ?? 0) : null,
    kitSerial: kitRow?.kit_number ?? kitNumber ?? null,
    kitNickname: (kitRow?.nickname ?? String(meta.nickname || '')) || null,
    planCode: customer.plan_code ?? null,
    planRenewsAt: customer.plan_renews_at ? String(customer.plan_renews_at) : null,
  };
  const portalBase = (process.env.STARLINK_BASE_URL || 'https://starlink.preyone.com').replace(/\/$/, '');

  // Written inside the settlement transaction. The unique event_key plus the
  // invoice row lock make the receipt/notification strictly once-only even
  // when a webhook and a sweep race. Email dispatch happens after commit.
  await client.query(
    `INSERT INTO starlink_notifications
       (customer_id, category, event_key, title, body, link_url, meta, email_status)
     VALUES ($1, 'PAYMENT', $2, $3, $4, $5, $6::jsonb, 'PENDING')
     ON CONFLICT (event_key) DO NOTHING`,
    [
      inv.customer_id,
      receiptEventKey,
      `Payment received · ${inv.invoice_number}`,
      `Your payment of $${Number(inv.amount).toFixed(2)} for ${starlinkActionLabel(inv.kind)} was confirmed.`,
      `${portalBase}/starlink/portal`,
      JSON.stringify(noticeMeta),
    ]
  );

  return {
    invoiceNumber: inv.invoice_number,
    kind: inv.kind,
    amount: Number(inv.amount),
    currency: String(inv.currency || 'USD'),
    walletBalance: Number(customer.wallet_balance ?? 0),
    dataBalance: kitRow ? Number(kitRow.data_credit_gb ?? 0) : undefined,
    kitSerial: kitRow?.kit_number ?? kitNumber ?? null,
    kitNickname: (kitRow?.nickname ?? String(meta.nickname || '')) || null,
    alreadyPaid: false,
    receiptEventKey,
  };
}

// ---------------------------------------------------------------------------
// Notification feed + post-commit receipt claim
// ---------------------------------------------------------------------------

export interface StarlinkReceiptNotification extends StarlinkNotification {
  customer_email: string;
  customer_full_name: string;
}

const RECEIPT_NOTIFICATION_SELECT = `
  SELECT n.id, n.customer_id, n.category, n.event_key, n.title, n.body,
         n.link_url, n.meta, n.is_read, n.visible_in_portal,
         n.email_status, n.email_sent_at, n.created_at,
         c.email AS customer_email, c.full_name AS customer_full_name
    FROM starlink_notifications n
    JOIN starlink_customers c ON c.id = n.customer_id`;

/** Read a queued payment receipt after its settlement transaction committed. */
export async function getStarlinkReceiptNotification(
  eventKey: string
): Promise<StarlinkReceiptNotification | null> {
  const { rows } = await pool.query(
    `${RECEIPT_NOTIFICATION_SELECT} WHERE n.event_key = $1`,
    [eventKey]
  );
  return (rows[0] as StarlinkReceiptNotification) ?? null;
}

/**
 * Atomically take ownership of one PENDING email. Only the worker whose UPDATE
 * returns a row may send, so a webhook, a sweep and a manual verify can never
 * dispatch the same receipt twice.
 */
export async function claimStarlinkNotificationEmail(
  eventKey: string
): Promise<StarlinkReceiptNotification | null> {
  const { rows } = await pool.query(
    `UPDATE starlink_notifications
        SET email_status = 'SENDING', email_error = NULL
      WHERE event_key = $1 AND email_status = 'PENDING'
      RETURNING id, customer_id, category, event_key, title, body, link_url, meta,
                is_read, visible_in_portal, email_status, email_sent_at, created_at`,
    [eventKey]
  );
  if (!rows[0]) return null;
  const claimed = rows[0] as StarlinkNotification;
  const receipt = await getStarlinkReceiptNotification(eventKey);
  if (!receipt) return null;
  return { ...receipt, ...claimed };
}

export async function markStarlinkNotificationEmailSent(eventKey: string): Promise<void> {
  await pool.query(
    `UPDATE starlink_notifications
        SET email_status = 'SENT', email_sent_at = NOW(), email_error = NULL
      WHERE event_key = $1 AND email_status = 'SENDING'`,
    [eventKey]
  );
}

export async function markStarlinkNotificationEmailFailed(eventKey: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE starlink_notifications
        SET email_status = 'FAILED', email_error = $2
      WHERE event_key = $1 AND email_status = 'SENDING'`,
    [eventKey, String(error).slice(0, 500)]
  );
}

export async function listStarlinkNotifications(
  customerId: string,
  limit = 50
): Promise<StarlinkNotification[]> {
  const { rows } = await pool.query(
    `SELECT id, customer_id, category, event_key, title, body, link_url, meta,
            is_read, visible_in_portal, email_status, email_sent_at, created_at
       FROM starlink_notifications
      WHERE customer_id = $1 AND visible_in_portal = TRUE
      ORDER BY created_at DESC
      LIMIT $2`,
    [customerId, Math.min(Math.max(Number(limit) || 50, 1), 100)]
  );
  return rows as StarlinkNotification[];
}

export async function getUnreadStarlinkNotificationCount(customerId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM starlink_notifications
      WHERE customer_id = $1 AND is_read = FALSE AND visible_in_portal = TRUE`,
    [customerId]
  );
  return Number(rows[0]?.n ?? 0);
}

export async function markStarlinkNotificationsRead(customerId: string, ids?: string[]): Promise<number> {
  const result = ids?.length
    ? await pool.query(
        `UPDATE starlink_notifications
            SET is_read = TRUE, read_at = NOW()
          WHERE customer_id = $1 AND is_read = FALSE AND id = ANY($2::uuid[])`,
        [customerId, ids]
      )
    : await pool.query(
        `UPDATE starlink_notifications
            SET is_read = TRUE, read_at = NOW()
          WHERE customer_id = $1 AND is_read = FALSE`,
        [customerId]
      );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Telemetry, alert preferences and queued portal notices (additive)
// ---------------------------------------------------------------------------

const PREF_COLUMNS: Record<keyof StarlinkAlertPreferencePatch, string> = {
  alert_75_email_enabled: 'alert_75_email_enabled',
  alert_75_portal_enabled: 'alert_75_portal_enabled',
  alert_90_email_enabled: 'alert_90_email_enabled',
  alert_90_portal_enabled: 'alert_90_portal_enabled',
  alert_100_email_enabled: 'alert_100_email_enabled',
  alert_100_portal_enabled: 'alert_100_portal_enabled',
  email_alerts_enabled: 'email_alerts_enabled',
  portal_alerts_enabled: 'portal_alerts_enabled',
  offline_alerts_enabled: 'offline_alerts_enabled',
  auto_topup_enabled: 'auto_topup_enabled',
  auto_topup_gb: 'auto_topup_gb',
  auto_topup_min_gb: 'auto_topup_min_gb',
};

const ALERT_CYCLE_COLUMNS: Record<75 | 90 | 100, string> = {
  75: 'alert_75_sent_cycle',
  90: 'alert_90_sent_cycle',
  100: 'alert_100_sent_cycle',
};

export async function getStarlinkAlertPreferences(
  customerId: string,
  kitId: string,
  client?: PoolClient
): Promise<StarlinkAlertPreferences> {
  const q = client ?? pool;
  await q.query(
    `INSERT INTO starlink_alert_preferences (customer_id, kit_id)
     VALUES ($1, $2)
     ON CONFLICT (kit_id) DO NOTHING`,
    [customerId, kitId]
  );
  const { rows } = await q.query(
    `SELECT kit_id, customer_id, alert_75_sent_cycle, alert_90_sent_cycle, alert_100_sent_cycle,
            alert_75_email_enabled, alert_75_portal_enabled,
            alert_90_email_enabled, alert_90_portal_enabled,
            alert_100_email_enabled, alert_100_portal_enabled,
            email_alerts_enabled, portal_alerts_enabled, offline_alerts_enabled,
            auto_topup_enabled, auto_topup_gb, auto_topup_min_gb
       FROM starlink_alert_preferences
      WHERE customer_id = $1 AND kit_id = $2`,
    [customerId, kitId]
  );
  return rows[0] as StarlinkAlertPreferences;
}

export async function updateStarlinkAlertPreferences(
  customerId: string,
  kitId: string,
  patch: StarlinkAlertPreferencePatch
): Promise<StarlinkAlertPreferences> {
  await getStarlinkAlertPreferences(customerId, kitId);
  const entries = Object.entries(patch).filter(
    ([key, value]) => value !== undefined && Object.prototype.hasOwnProperty.call(PREF_COLUMNS, key)
  ) as Array<[keyof StarlinkAlertPreferencePatch, unknown]>;
  if (entries.length > 0) {
    const sets = entries.map(
      ([key], i) => `${PREF_COLUMNS[key]} = $${i + 3}`
    );
    const values = entries.map(([, value]) => value);
    await pool.query(
      `UPDATE starlink_alert_preferences
          SET ${sets.join(', ')}, updated_at = NOW()
        WHERE customer_id = $1 AND kit_id = $2`,
      [customerId, kitId, ...values]
    );
  }
  return getStarlinkAlertPreferences(customerId, kitId);
}

export async function markStarlinkAlertCycleSent(
  customerId: string,
  kitId: string,
  threshold: 75 | 90 | 100,
  cycle: string,
  client?: PoolClient
): Promise<void> {
  const q = client ?? pool;
  const column = ALERT_CYCLE_COLUMNS[threshold];
  await q.query(
    `UPDATE starlink_alert_preferences
        SET ${column} = $3, updated_at = NOW()
      WHERE customer_id = $1 AND kit_id = $2`,
    [customerId, kitId, cycle]
  );
}

function telemetryNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function telemetryNullable(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function insertStarlinkUsageSnapshot(
  input: StarlinkUsageSnapshotInput,
  client?: PoolClient
): Promise<StarlinkUsageSnapshot> {
  const q = client ?? pool;
  const parsed = input.recordedAt ? new Date(input.recordedAt) : new Date();
  const recordedAt = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const { rows } = await q.query(
    `INSERT INTO starlink_usage_snapshots
       (kit_id, recorded_at, priority_used_gb, standard_used_gb, download_mbps,
        upload_mbps, latency_ms, ping_drop_rate, obstruction_percent, uptime_seconds, online_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (kit_id, recorded_at) DO UPDATE SET
       priority_used_gb = EXCLUDED.priority_used_gb,
       standard_used_gb = EXCLUDED.standard_used_gb,
       download_mbps = EXCLUDED.download_mbps,
       upload_mbps = EXCLUDED.upload_mbps,
       latency_ms = EXCLUDED.latency_ms,
       ping_drop_rate = EXCLUDED.ping_drop_rate,
       obstruction_percent = EXCLUDED.obstruction_percent,
       uptime_seconds = EXCLUDED.uptime_seconds,
       online_status = EXCLUDED.online_status
     RETURNING id, kit_id, recorded_at, priority_used_gb, standard_used_gb,
               download_mbps, upload_mbps, latency_ms, ping_drop_rate,
               obstruction_percent, uptime_seconds, online_status`,
    [
      input.kitId,
      recordedAt.toISOString(),
      telemetryNumber(input.priorityUsedGb),
      telemetryNumber(input.standardUsedGb),
      telemetryNullable(input.downloadMbps),
      telemetryNullable(input.uploadMbps),
      telemetryNullable(input.latencyMs),
      telemetryNullable(input.pingDropRate),
      telemetryNullable(input.obstructionPercent),
      telemetryNullable(input.uptimeSeconds),
      input.onlineStatus !== false,
    ]
  );
  return rows[0] as StarlinkUsageSnapshot;
}

export async function listStarlinkUsageSnapshots(
  kitId: string,
  days = 30,
  client?: PoolClient
): Promise<StarlinkUsageSnapshot[]> {
  const q = client ?? pool;
  const window = Math.min(Math.max(Number(days) || 30, 1), 365);
  const { rows } = await q.query(
    `SELECT id, kit_id, recorded_at, priority_used_gb, standard_used_gb,
            download_mbps, upload_mbps, latency_ms, ping_drop_rate,
            obstruction_percent, uptime_seconds, online_status
       FROM starlink_usage_snapshots
      WHERE kit_id = $1 AND recorded_at >= NOW() - ($2::int * INTERVAL '1 day')
      ORDER BY recorded_at DESC`,
    [kitId, window]
  );
  return rows as StarlinkUsageSnapshot[];
}

/** Idempotent portal notice insert. Returns true only when this worker created it. */
export async function queueStarlinkNotification(input: {
  customerId: string;
  category: StarlinkNotificationCategory;
  eventKey: string;
  title: string;
  body: string;
  linkUrl?: string | null;
  meta?: Record<string, unknown>;
  emailStatus?: string;
  visibleInPortal?: boolean;
}, client?: PoolClient): Promise<boolean> {
  const q = client ?? pool;
  const result = await q.query(
    `INSERT INTO starlink_notifications
       (customer_id, category, event_key, title, body, link_url, meta, email_status, visible_in_portal)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     ON CONFLICT (event_key) DO NOTHING`,
    [
      input.customerId,
      input.category,
      input.eventKey,
      input.title,
      input.body,
      input.linkUrl ?? null,
      JSON.stringify(input.meta ?? {}),
      input.emailStatus ?? 'NOT_APPLICABLE',
      input.visibleInPortal !== false,
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Wallet-funded auto top-ups settle immediately, but still get a PAID invoice. */
export async function createPaidStarlinkInvoice(input: {
  customerId: string;
  amount: number;
  description: string;
  kind: string;
  meta?: Record<string, unknown>;
  paymentReference?: string | null;
  client: PoolClient;
}): Promise<StarlinkInvoice> {
  const invoiceNumber = await nextStarlinkInvoiceNumber(input.client);
  const { rows } = await input.client.query(
    `INSERT INTO starlink_invoices
       (customer_id, invoice_number, amount, currency, description, kind,
        status, pese_reference, meta, paid_at)
     VALUES ($1, $2, $3, 'USD', $4, $5, 'PAID', $6, $7::jsonb, NOW())
     RETURNING id, customer_id, invoice_number, amount, currency, description, kind,
               status, pese_reference, meta, issued_date, due_date, paid_at, created_at`,
    [
      input.customerId,
      invoiceNumber,
      input.amount,
      input.description,
      input.kind,
      input.paymentReference ?? 'wallet-auto-topup',
      JSON.stringify(input.meta ?? {}),
    ]
  );
  return rows[0] as StarlinkInvoice;
}

/** Pending Starlink intents still attached to an unpaid invoice (recovery UI). */
export async function listPendingStarlinkIntents(customerId: string): Promise<StarlinkPendingIntent[]> {
  const { rows } = await pool.query(
    `SELECT i.id AS intent_id, i.target_id AS invoice_id, inv.invoice_number,
            i.reference, i.amount, i.created_at
       FROM pesepay_intents i
       JOIN starlink_invoices inv ON inv.id = i.target_id
      WHERE i.target_type = 'starlink'
        AND LOWER(i.status) = 'pending'
        AND inv.customer_id = $1
        AND inv.status = 'PENDING'
      ORDER BY i.created_at DESC
      LIMIT 20`,
    [customerId]
  );
  return rows as StarlinkPendingIntent[];
}

// ---------------------------------------------------------------------------
// Email verification (the raw token only ever lives in the email; we store its SHA-256)
// ---------------------------------------------------------------------------

export async function setStarlinkVerificationToken(customerId: string, tokenHash: string, expiresAt: Date): Promise<void> {
  await pool.query(
    `UPDATE starlink_customers
        SET email_verify_token_hash = $2, email_verify_expires_at = $3
      WHERE id = $1`,
    [customerId, tokenHash, expiresAt]
  );
}

/** Marks the email verified when the token matches and has not expired. Returns the customer or null. */
export async function consumeStarlinkVerificationToken(tokenHash: string): Promise<{ id: string; email: string; full_name: string } | null> {
  const { rows } = await pool.query(
    `UPDATE starlink_customers
        SET email_verified_at = COALESCE(email_verified_at, NOW()),
            email_verify_token_hash = NULL,
            email_verify_expires_at = NULL
      WHERE email_verify_token_hash = $1
        AND email_verify_expires_at > NOW()
      RETURNING id, email, full_name`,
    [tokenHash]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Plan switch applications + seat capacity
// ---------------------------------------------------------------------------

export interface StarlinkPlanApplication {
  id: string;
  customer_id: string;
  from_plan_code: string | null;
  to_plan_code: string;
  requested_start: string;
  status: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
}

export const DEFAULT_PLAN_CAPACITY = 100;

/** Seats available for a package = configured capacity minus active subscribers on it. */
export async function getPlanCapacity(planCode: string, client?: PoolClient): Promise<{ capacity: number; active: number }> {
  const q = client ?? pool;
  const { rows } = await q.query(
    `SELECT COALESCE(
              (SELECT capacity FROM starlink_plan_capacity WHERE plan_code = $1),
              $2
            )::int AS capacity,
            (SELECT COUNT(*)::int FROM starlink_customers WHERE plan_code = $1) AS active`,
    [planCode, DEFAULT_PLAN_CAPACITY]
  );
  return { capacity: Number(rows[0].capacity), active: Number(rows[0].active) };
}

export async function getNextMonthStart(): Promise<string> {
  const { rows } = await pool.query(`SELECT (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date::text AS d`);
  return rows[0].d;
}

export async function getOpenPlanApplication(customerId: string): Promise<StarlinkPlanApplication | null> {
  const { rows } = await pool.query(
    `SELECT * FROM starlink_plan_applications WHERE customer_id = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  return rows[0] ?? null;
}

export async function listPlanApplications(customerId: string): Promise<StarlinkPlanApplication[]> {
  const { rows } = await pool.query(
    `SELECT * FROM starlink_plan_applications WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [customerId]
  );
  return rows;
}
