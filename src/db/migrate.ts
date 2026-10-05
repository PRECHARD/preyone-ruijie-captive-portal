import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool';
import { formatZimPhone } from '../utils/phone';

const SQL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE TABLE IF NOT EXISTS packages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tier_name           TEXT UNIQUE NOT NULL,
    display_name        TEXT NOT NULL,
    price_amount        NUMERIC(10,2) NOT NULL,
    price_currency      TEXT NOT NULL DEFAULT 'USD',
    billing_period      TEXT NOT NULL,
    duration_min        INTEGER NOT NULL,
    data_limit_gb       NUMERIC(10,2),
    is_uncapped         BOOLEAN NOT NULL DEFAULT FALSE,
    bandwidth_mbps_up   INTEGER NOT NULL DEFAULT 2,
    bandwidth_mbps_down INTEGER NOT NULL DEFAULT 2,
    max_devices         INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       TEXT NOT NULL,
    phone           TEXT NOT NULL,
    voucher_code    TEXT,
    package_id      UUID REFERENCES packages(id) ON DELETE SET NULL,
    accepted_tos    BOOLEAN NOT NULL DEFAULT FALSE,
    mac_address     TEXT,
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_token   TEXT UNIQUE,
    session_expires_at TIMESTAMPTZ
  );

  ALTER TABLE users ADD COLUMN IF NOT EXISTS package_id UUID REFERENCES packages(id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_password_token TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_password_expires_at TIMESTAMPTZ;

  CREATE INDEX IF NOT EXISTS idx_users_voucher_code  ON users (voucher_code);
  CREATE INDEX IF NOT EXISTS idx_users_session_token ON users (session_token);
  CREATE INDEX IF NOT EXISTS idx_users_package_id    ON users (package_id);

  -- packages/vouchers: optional multi-device allowance (display/metadata only for now)
  ALTER TABLE packages ADD COLUMN IF NOT EXISTS max_devices INTEGER;

  CREATE TABLE IF NOT EXISTS vouchers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code              TEXT UNIQUE NOT NULL,
    duration_min      INTEGER NOT NULL DEFAULT 60,
    max_uses          INTEGER NOT NULL DEFAULT 1,
    used_count        INTEGER NOT NULL DEFAULT 0,
    expires_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS data_limit_gb       NUMERIC(10,2);
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_uncapped         BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS bandwidth_mbps_up   INTEGER NOT NULL DEFAULT 2;
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS bandwidth_mbps_down INTEGER NOT NULL DEFAULT 5;
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS max_devices INTEGER;

  CREATE TABLE IF NOT EXISTS payments (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_id              UUID NOT NULL REFERENCES packages(id),
    phone_number            TEXT NOT NULL,
    amount                  NUMERIC(10,2) NOT NULL,
    currency                TEXT NOT NULL DEFAULT 'USD',
    payment_method          TEXT NOT NULL DEFAULT 'EcoCash',
    pesepay_reference      TEXT,
    pesepay_poll_url       TEXT,
    merchant_reference      TEXT,
    client_mac              TEXT,
    status                  TEXT NOT NULL DEFAULT 'pending',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMPTZ,
    error_message           TEXT
  );

  -- ════════════════ ContiPay → Pesepay rollback ════════════════
  -- ContiPay was not approved, so the online gateway is Pesepay again. A brief
  -- ContiPay deployment renamed pesepay_reference to contipay_transaction_index
  -- and dropped pesepay_poll_url, so put both back.
  --
  -- This REPLACES the forward ContiPay rename rather than being added after it.
  -- Both cannot coexist: the forward block is conditional on pesepay_reference
  -- existing while contipay_transaction_index does not, so it would rename the
  -- column straight back on the next migration run and the two would flip-flop.
  DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'payments' AND column_name = 'contipay_transaction_index'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'payments' AND column_name = 'pesepay_reference'
    ) THEN
      ALTER TABLE payments RENAME COLUMN contipay_transaction_index TO pesepay_reference;
    END IF;
  END $$;

  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_payments_contipay_txn_index') THEN
      ALTER INDEX idx_payments_contipay_txn_index RENAME TO idx_payments_pesepay_ref;
    END IF;
  END $$;

  -- pesepay_poll_url holds the hosted Pesepay page the customer is redirected
  -- to in order to approve the EcoCash push; it is written on every initiate.
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS pesepay_poll_url TEXT;

  CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
  CREATE INDEX IF NOT EXISTS idx_payments_pesepay_ref ON payments (pesepay_reference);
  CREATE INDEX IF NOT EXISTS idx_payments_merchant_ref ON payments (merchant_reference);

  -- Online purchases: the minted voucher is attached to the completed payment
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS voucher_code TEXT;

  -- Per-payment secret appended to the resultUrl we hand Pesepay and echoed
  -- back on its callback. Primary authentication is the AES-CBC payload; this
  -- token is an additional check whenever the gateway sends it back, so it must
  -- be unique per payment for that check to be meaningful.
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS webhook_token TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_webhook_token
    ON payments (webhook_token) WHERE webhook_token IS NOT NULL;

  CREATE TABLE IF NOT EXISTS wispr_profiles (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mac_address           TEXT NOT NULL,
    bandwidth_up_kbps     INTEGER NOT NULL,
    bandwidth_down_kbps   INTEGER NOT NULL,
    data_quota_bytes      BIGINT,
    data_used_bytes       BIGINT NOT NULL DEFAULT 0,
    is_uncapped           BOOLEAN NOT NULL DEFAULT FALSE,
    session_start         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_end           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_wispr_user_id ON wispr_profiles (user_id);
  CREATE INDEX IF NOT EXISTS idx_wispr_mac_address ON wispr_profiles (mac_address);

  CREATE TABLE IF NOT EXISTS access_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    event       TEXT NOT NULL,
    mac_address TEXT,
    ip_address  INET,
    detail      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS voucher_redemptions (
    id            BIGSERIAL PRIMARY KEY,
    voucher_id    UUID NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    voucher_code  TEXT NOT NULL,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    full_name     TEXT,
    mac_address   TEXT,
    ip_address    INET,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_voucher_id ON voucher_redemptions (voucher_id);
  CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_user_id ON voucher_redemptions (user_id);

  CREATE TABLE IF NOT EXISTS admin_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name     TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    phone         TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('CEO', 'Manager', 'Staff')) DEFAULT 'Staff',
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reset_token TEXT;
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS email_verification_token TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users (email);

  CREATE TABLE IF NOT EXISTS transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      UUID REFERENCES payments(id) ON DELETE SET NULL,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_tier    TEXT NOT NULL,
    amount          NUMERIC(10,2) NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'USD',
    payment_method  TEXT NOT NULL DEFAULT 'EcoCash',
    voucher_code    TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions (user_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions (status);
  CREATE INDEX IF NOT EXISTS idx_transactions_package_tier ON transactions (package_tier);

  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  UUID REFERENCES admin_users(id) ON DELETE SET NULL
  );

  INSERT INTO settings (key, value) VALUES ('tos_text', 'By using this service you agree to our terms.') ON CONFLICT (key) DO NOTHING;
  INSERT INTO settings (key, value) VALUES ('session_timeout_min', '1440') ON CONFLICT (key) DO NOTHING;
  INSERT INTO settings (key, value) VALUES ('welcome_message', 'Welcome to Preyone WiFi') ON CONFLICT (key) DO NOTHING;

  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    admin_id    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    admin_name  TEXT,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    detail      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_id ON admin_audit_log (admin_id);
  CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log (created_at);

  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS sold_by      UUID REFERENCES admin_users(id);
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS price_amount NUMERIC(10,2);

  CREATE TABLE IF NOT EXISTS sales (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_id    UUID NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    voucher_code  TEXT NOT NULL,
    sold_by       UUID REFERENCES admin_users(id),
    sold_by_name  TEXT,
    amount        NUMERIC(10,2) NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'USD',
    sold_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_sales_sold_by ON sales (sold_by);
  CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales (sold_at);

  CREATE TABLE IF NOT EXISTS staff_time_logs (
    id            BIGSERIAL PRIMARY KEY,
    admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    clock_in      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    clock_out     TIMESTAMPTZ,
    duration_min  INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_staff_time_logs_user_id ON staff_time_logs (admin_user_id);
  CREATE INDEX IF NOT EXISTS idx_staff_time_logs_clock_in ON staff_time_logs (clock_in);

  -- ── AP Devices (for Ruijie hardware monitoring) ──
  CREATE TABLE IF NOT EXISTS ap_devices (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL,
    model             TEXT,
    mac_address       TEXT UNIQUE NOT NULL,
    ip_address        TEXT,
    location          TEXT,
    status            TEXT NOT NULL DEFAULT 'offline',
    firmware_version  TEXT,
    uptime_seconds    BIGINT DEFAULT 0,
    clients_count     INTEGER DEFAULT 0,
    last_seen         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- ── Alerts / Notifications ──
  CREATE TABLE IF NOT EXISTS alerts (
    id              BIGSERIAL PRIMARY KEY,
    type            TEXT NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'warning',
    title           TEXT NOT NULL,
    message         TEXT,
    target_type     TEXT,
    target_id       TEXT,
    acknowledged    BOOLEAN NOT NULL DEFAULT FALSE,
    acknowledged_by UUID REFERENCES admin_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS admin_id UUID REFERENCES admin_users(id);
  CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts (acknowledged);
  CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts (severity);
  CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_admin_id ON alerts (admin_id);

  -- ── MAC Blacklist / Whitelist ──
  CREATE TABLE IF NOT EXISTS mac_blacklist (
    id          BIGSERIAL PRIMARY KEY,
    mac_address TEXT NOT NULL,
    reason      TEXT,
    blocked_by  UUID REFERENCES admin_users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_mac_blacklist_mac ON mac_blacklist (mac_address);

  CREATE TABLE IF NOT EXISTS mac_whitelist (
    id          BIGSERIAL PRIMARY KEY,
    mac_address TEXT NOT NULL,
    label       TEXT,
    added_by    UUID REFERENCES admin_users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_mac_whitelist_mac ON mac_whitelist (mac_address);

  -- ── AP Bandwidth Snapshots (for real-time bandwidth monitor) ──
  CREATE TABLE IF NOT EXISTS ap_bandwidth_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    ap_id           UUID REFERENCES ap_devices(id) ON DELETE CASCADE,
    bytes_up        BIGINT NOT NULL DEFAULT 0,
    bytes_down      BIGINT NOT NULL DEFAULT 0,
    clients_count   INTEGER DEFAULT 0,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_ap_bw_snapshots_ap_id ON ap_bandwidth_snapshots (ap_id);
  CREATE INDEX IF NOT EXISTS idx_ap_bw_snapshots_recorded_at ON ap_bandwidth_snapshots (recorded_at);

  -- ── Gateway Heartbeats (EG105G-P health check tracking) ──
  CREATE TABLE IF NOT EXISTS gateway_heartbeats (
    id              BIGSERIAL PRIMARY KEY,
    gw_sn           TEXT UNIQUE NOT NULL,
    gw_id           TEXT,
    dev_model       TEXT,
    dev_softversion TEXT,
    sys_uptime      TEXT,
    ip_address      INET,
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Ensure package_tier column on vouchers
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS package_tier TEXT;

  -- Voucher approval requests (Staff → Manager/CEO)
  CREATE TABLE IF NOT EXISTS voucher_approvals (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by      UUID NOT NULL REFERENCES admin_users(id),
    requested_by_name VARCHAR(255) NOT NULL,
    approved_by       UUID REFERENCES admin_users(id),
    approved_by_name  VARCHAR(255),
    approved_at       TIMESTAMPTZ,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    request_type      TEXT NOT NULL CHECK (request_type IN ('single', 'bulk')),
    package_tier      TEXT NOT NULL,
    voucher_count     INTEGER NOT NULL DEFAULT 1,
    price_amount      NUMERIC(10,2),
    max_uses          INTEGER DEFAULT 1,
    voucher_data      JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_voucher_approvals_status ON voucher_approvals (status);
  CREATE INDEX IF NOT EXISTS idx_voucher_approvals_requested_by ON voucher_approvals (requested_by);

  -- Cash handovers (Staff → Manager/CEO)
  CREATE TABLE IF NOT EXISTS cash_handovers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id          UUID NOT NULL REFERENCES admin_users(id),
    staff_name        VARCHAR(255) NOT NULL,
    total_amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
    sale_count        INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    approved_by       UUID REFERENCES admin_users(id),
    approved_by_name  VARCHAR(255),
    approved_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_cash_handovers_status ON cash_handovers (status);
  CREATE INDEX IF NOT EXISTS idx_cash_handovers_staff_id ON cash_handovers (staff_id);

  ALTER TABLE sales ADD COLUMN IF NOT EXISTS handover_id UUID REFERENCES cash_handovers(id);
  ALTER TABLE sales ADD COLUMN IF NOT EXISTS handover_status TEXT NOT NULL DEFAULT 'pending' CHECK (handover_status IN ('pending', 'handed_over'));

  -- POS payment method (Cash vs ContiPay mobile money) + provider reference
  ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'Cash';
  ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_reference TEXT;

  -- ── CEO-only features: Retention Policies ──
  CREATE TABLE IF NOT EXISTS retention_policies (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_days      INTEGER NOT NULL DEFAULT 90,
    access_log_days   INTEGER NOT NULL DEFAULT 30,
    audit_log_days    INTEGER NOT NULL DEFAULT 365,
    updated_by        UUID REFERENCES admin_users(id),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO retention_policies (session_days, access_log_days, audit_log_days)
  SELECT 90, 30, 365 WHERE NOT EXISTS (SELECT 1 FROM retention_policies);

  -- ── CEO-only features: Staff Commissions ──
  CREATE TABLE IF NOT EXISTS staff_commissions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id        UUID UNIQUE NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    commission_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
    updated_by      UUID REFERENCES admin_users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- ── CEO-only features: Broadcast Notifications ──
  CREATE TABLE IF NOT EXISTS broadcast_notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    message         TEXT NOT NULL,
    created_by      UUID REFERENCES admin_users(id),
    created_by_name TEXT,
    read_by         JSONB NOT NULL DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE broadcast_notifications ADD COLUMN IF NOT EXISTS read_by JSONB NOT NULL DEFAULT '[]';

  -- ── CEO-only features: Branding ──
  CREATE TABLE IF NOT EXISTS branding (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    portal_title    TEXT NOT NULL DEFAULT 'Preyone WiFi',
    logo_path       TEXT,
    favicon_path    TEXT,
    voucher_header  TEXT DEFAULT 'Preyone WiFi',
    voucher_footer  TEXT DEFAULT 'Thank you for choosing Preyone',
    primary_color   TEXT NOT NULL DEFAULT '#ff00ff',
    accent_color    TEXT NOT NULL DEFAULT '#6a0dad',
    updated_by      UUID REFERENCES admin_users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO branding (portal_title) SELECT 'Preyone WiFi' WHERE NOT EXISTS (SELECT 1 FROM branding);

  -- ── CEO-only features: Backup Logs ──
  CREATE TABLE IF NOT EXISTS backup_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name       TEXT NOT NULL,
    file_size       BIGINT,
    created_by      UUID REFERENCES admin_users(id),
    created_by_name TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- ── CEO-only features: Report Schedules ──
  CREATE TABLE IF NOT EXISTS report_schedules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    frequency       TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
    recipients      TEXT NOT NULL DEFAULT '[]',
    enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    last_sent_at    TIMESTAMPTZ,
    created_by      UUID REFERENCES admin_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- ════════════════ Preyone Transit — Ticketing Platform ════════════════
  -- Companies own all transit data (multi-tenant). Everything else scopes to company_id.

  CREATE TABLE IF NOT EXISTS transit_companies (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL,
    slug             TEXT UNIQUE NOT NULL,
    tagline          TEXT NOT NULL DEFAULT '',
    address          TEXT NOT NULL DEFAULT '',
    email            TEXT NOT NULL DEFAULT '',
    website          TEXT NOT NULL DEFAULT '',
    customer_care    TEXT NOT NULL DEFAULT '',
    currency         TEXT NOT NULL DEFAULT 'USD',
    default_receipt_prefix TEXT NOT NULL DEFAULT 'AGJ',
    offline_lease_days INTEGER NOT NULL DEFAULT 7,
    min_app_version  TEXT NOT NULL DEFAULT '',
    company_code     TEXT NOT NULL DEFAULT '',
    contact_email    TEXT NOT NULL DEFAULT '',
    commission_rate  NUMERIC(5,2) NOT NULL DEFAULT 0,
    payment_gateway  TEXT NOT NULL DEFAULT 'contipay',
    gateway_merchant_id TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS offline_lease_days INTEGER NOT NULL DEFAULT 7;
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS min_app_version TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS company_code TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS contact_email TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0;
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS payment_gateway TEXT NOT NULL DEFAULT 'contipay';
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS gateway_merchant_id TEXT NOT NULL DEFAULT '';

  CREATE TABLE IF NOT EXISTS transit_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID NOT NULL REFERENCES transit_companies(id) ON DELETE CASCADE,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'TICKET_SELLER',
    status        TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_transit_users_company ON transit_users (company_id);

  CREATE TABLE IF NOT EXISTS transit_devices (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID NOT NULL REFERENCES transit_companies(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES transit_users(id) ON DELETE CASCADE,
    device_uuid   TEXT NOT NULL UNIQUE,
    device_key    TEXT NOT NULL,
    device_model  TEXT NOT NULL DEFAULT '',
    app_version   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'ACTIVE',
    last_sync     TIMESTAMPTZ,
    last_seen     TIMESTAMPTZ,
    last_location TEXT,
    battery_pct   INTEGER,
    active_trip   TEXT,
    offline_authorization_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reset_by      UUID REFERENCES transit_users(id),
    min_app_version TEXT NOT NULL DEFAULT '',
    revoked_at    TIMESTAMPTZ
  );
  ALTER TABLE transit_devices ADD COLUMN IF NOT EXISTS min_app_version TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_devices ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_transit_devices_company ON transit_devices (company_id);
  CREATE INDEX IF NOT EXISTS idx_transit_devices_user ON transit_devices (user_id);
  CREATE INDEX IF NOT EXISTS idx_transit_devices_uuid ON transit_devices (device_uuid);
  CREATE INDEX IF NOT EXISTS idx_transit_devices_status ON transit_devices (status);

  CREATE TABLE IF NOT EXISTS blocked_devices (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hardware_id   TEXT NOT NULL,
    hardware_type TEXT NOT NULL DEFAULT 'UUID' CHECK (hardware_type IN ('MAC', 'UUID', 'SERIAL')),
    device_name   TEXT NOT NULL DEFAULT '',
    reason        TEXT NOT NULL DEFAULT '',
    blocked_by    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    blocked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_devices_hardware ON blocked_devices (hardware_id);
  CREATE INDEX IF NOT EXISTS idx_blocked_devices_blocked_at ON blocked_devices (blocked_at);

  CREATE TABLE IF NOT EXISTS transit_trips (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id         UUID NOT NULL REFERENCES transit_companies(id) ON DELETE CASCADE,
    user_id            UUID NOT NULL REFERENCES transit_users(id),
    device_id          UUID NOT NULL REFERENCES transit_devices(id),
    trip_no            TEXT NOT NULL,
    bus_reg            TEXT NOT NULL DEFAULT '',
    route_code         TEXT NOT NULL DEFAULT '',
    route_name         TEXT NOT NULL DEFAULT '',
    departure_time     TEXT NOT NULL DEFAULT '',
    driver             TEXT NOT NULL DEFAULT '',
    driver_phone       TEXT NOT NULL DEFAULT '',
    conductor1         TEXT NOT NULL DEFAULT '',
    conductor2         TEXT NOT NULL DEFAULT '',
    conductor_phone    TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at          TIMESTAMPTZ,
    UNIQUE (company_id, trip_no)
  );
  CREATE INDEX IF NOT EXISTS idx_transit_trips_company ON transit_trips (company_id);
  CREATE INDEX IF NOT EXISTS idx_transit_trips_trip_no ON transit_trips (company_id, trip_no);

  -- Trip module: add route origin/destination + seat + staff-id columns
  ALTER TABLE transit_trips ADD COLUMN IF NOT EXISTS route_from TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_trips ADD COLUMN IF NOT EXISTS route_to TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_trips ADD COLUMN IF NOT EXISTS total_seats INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE transit_trips ADD COLUMN IF NOT EXISTS seats_sold INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE transit_trips ADD COLUMN IF NOT EXISTS driver_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_trips ADD COLUMN IF NOT EXISTS conductor_id TEXT NOT NULL DEFAULT '';

  -- Expand transit_trips status CHECK to include SCHEDULED / ACTIVE / COMPLETED (keeps OPEN / CLOSED for legacy devices)
  DO $$ BEGIN
    EXECUTE format('ALTER TABLE transit_trips DROP CONSTRAINT IF EXISTS %I', (
      SELECT conname FROM pg_constraint WHERE conrelid = 'transit_trips'::regclass AND contype = 'c' LIMIT 1
    ));
  END $$;
  DO $$ BEGIN
    ALTER TABLE transit_trips ADD CONSTRAINT transit_trips_status_check CHECK (status IN ('OPEN', 'CLOSED', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  -- Cancel/audit support: a touches-timestamp for optimistic concurrency and
  -- a CANCELLED lifecycle state for soft-cancelled schedules.
  ALTER TABLE transit_trips ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

  CREATE INDEX IF NOT EXISTS idx_transit_trips_status ON transit_trips (company_id, status);

  -- Admin web-scheduled trips have no device/user context yet; relax NOT NULL so the
  -- Trip Schedules page can create trips without a POS device. Re-runs are safe (no-op).
  ALTER TABLE transit_trips ALTER COLUMN user_id DROP NOT NULL;
  ALTER TABLE transit_trips ALTER COLUMN device_id DROP NOT NULL;

  -- Base ticket fare (in cents) set by the admin when scheduling a trip; the POS uses it
  -- as the default starting fare. Defaults to 0 for legacy/device-created trips.
  ALTER TABLE transit_trips ADD COLUMN IF NOT EXISTS base_fare_cents INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS transit_promotions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES transit_companies(id) ON DELETE CASCADE,
    code         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL DEFAULT 'PERCENT' CHECK (type IN ('PERCENT', 'FLAT')),
    value        INTEGER NOT NULL DEFAULT 0,
    minimum_cents INTEGER NOT NULL DEFAULT 0,
    max_value_cents INTEGER NOT NULL DEFAULT 0,
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    usage_count  INTEGER NOT NULL DEFAULT 0,
    created_by   UUID REFERENCES transit_users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, code)
  );
  CREATE INDEX IF NOT EXISTS idx_transit_promotions_company ON transit_promotions (company_id, active);

  -- ── Master route templates ────────────────────────────────────────────────
  -- A company-owned, reusable stage list + stage-to-stage fare matrix that a
  -- conductor uses to open an UNSCHEDULED on-the-go run. Deliberately NOT a
  -- trip: it never appears in the trip picker, never receives tickets and is
  -- never scheduled. Mirrors the POS local tables (route_templates /
  -- route_template_stages / route_template_fares) so the device can cache the
  -- whole set for offline selling and reconcile by id.
  CREATE TABLE IF NOT EXISTS transit_route_templates (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES transit_companies(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    code         TEXT NOT NULL DEFAULT '',
    description  TEXT NOT NULL DEFAULT '',
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by   UUID REFERENCES transit_users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_transit_route_templates_company
    ON transit_route_templates (company_id, active);

  CREATE TABLE IF NOT EXISTS transit_route_template_stages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES transit_route_templates(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    name        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trts_template
    ON transit_route_template_stages (template_id, seq);

  -- Fare matrix leg, always stored in forward order (from_seq < to_seq) to match
  -- the POS: a return leg looks the pair up swapped. price_cents of 0 means
  -- "not priced yet" and the sale falls back to the standard tariff.
  CREATE TABLE IF NOT EXISTS transit_route_template_fares (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES transit_route_templates(id) ON DELETE CASCADE,
    from_seq    INTEGER NOT NULL,
    to_seq      INTEGER NOT NULL,
    price_cents INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_trtf_template
    ON transit_route_template_fares (template_id);

  CREATE TABLE IF NOT EXISTS transit_tickets (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       UUID NOT NULL REFERENCES transit_companies(id) ON DELETE CASCADE,
    user_id          UUID NOT NULL REFERENCES transit_users(id),
    device_id        UUID NOT NULL REFERENCES transit_devices(id),
    trip_id          UUID REFERENCES transit_trips(id),
    tx_id            TEXT NOT NULL UNIQUE,
    client_receipt_no TEXT NOT NULL,
    trip_no          TEXT NOT NULL DEFAULT '',
    route_code       TEXT NOT NULL DEFAULT '',
    route_name       TEXT NOT NULL DEFAULT '',
    bus_reg          TEXT NOT NULL DEFAULT '',
    driver           TEXT NOT NULL DEFAULT '',
    driver_phone     TEXT NOT NULL DEFAULT '',
    conductor1       TEXT NOT NULL DEFAULT '',
    conductor2       TEXT NOT NULL DEFAULT '',
    conductor_phone  TEXT NOT NULL DEFAULT '',
    seat_number      TEXT NOT NULL DEFAULT '',
    customer_name    TEXT NOT NULL DEFAULT '',
    customer_mobile  TEXT NOT NULL DEFAULT '',
    items_json       TEXT NOT NULL DEFAULT '[]',
    total_cents      INTEGER NOT NULL DEFAULT 0,
    cash_cents       INTEGER NOT NULL DEFAULT 0,
    change_cents     INTEGER NOT NULL DEFAULT 0,
     status           TEXT NOT NULL DEFAULT 'SYNCED' CHECK (status IN ('SYNCED', 'SEAT_CONFLICT', 'INVALID_SIGNATURE', 'CANCELLED')),
    payload_signature TEXT,
    sale_time        TEXT NOT NULL DEFAULT '',
    synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_transit_tickets_company ON transit_tickets (company_id);
  CREATE INDEX IF NOT EXISTS idx_transit_tickets_tx ON transit_tickets (tx_id);
  CREATE INDEX IF NOT EXISTS idx_transit_tickets_trip_seat ON transit_tickets (trip_no, seat_number);
  CREATE INDEX IF NOT EXISTS idx_transit_tickets_created ON transit_tickets (synced_at);

  -- transit_tickets: store the trip_id the ticket belongs to (idempotent)
  -- ALTERs run AFTER CREATE so a fresh database never hits "relation does not exist"
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS trip_id UUID;
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cash';
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS bus_reg TEXT NOT NULL DEFAULT '';

  CREATE TABLE IF NOT EXISTS transit_audit_log (
    id         BIGSERIAL PRIMARY KEY,
    company_id UUID REFERENCES transit_companies(id),
    user_id    UUID REFERENCES transit_users(id),
    device_id  UUID REFERENCES transit_devices(id),
    action     TEXT NOT NULL,
    entity     TEXT NOT NULL DEFAULT '',
    entity_id  TEXT NOT NULL DEFAULT '',
    metadata   JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_transit_audit_company ON transit_audit_log (company_id);
  CREATE INDEX IF NOT EXISTS idx_transit_audit_created ON transit_audit_log (created_at);

  CREATE TABLE IF NOT EXISTS transit_security_events (
    id         BIGSERIAL PRIMARY KEY,
    company_id UUID REFERENCES transit_companies(id),
    user_id    UUID REFERENCES transit_users(id),
    device_id  UUID REFERENCES transit_devices(id),
    event      TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_transit_security_company ON transit_security_events (company_id);
  CREATE INDEX IF NOT EXISTS idx_transit_security_created ON transit_security_events (created_at);

  -- ════════════════ RBAC Engine ════════════════
  CREATE TABLE IF NOT EXISTS permissions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code          TEXT UNIQUE NOT NULL,
    description   TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS role_permissions (
    role            TEXT NOT NULL,
    permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (role, permission_code)
  );

  -- user_permissions: polymorphic user_id (admin_users.id OR transit_users.id)
  CREATE TABLE IF NOT EXISTS user_permissions (
    user_id         UUID NOT NULL,
    permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, permission_code)
  );

  -- company_permissions: capability granted to EVERY user of a transit company,
  -- regardless of role. Used to hand a narrow capability (e.g. route template
  -- management) to a company whose owner is field staff, without inventing a
  -- new role or widening the holder's role_permissions.
  CREATE TABLE IF NOT EXISTS company_permissions (
    company_id      UUID NOT NULL REFERENCES transit_companies(id) ON DELETE CASCADE,
    permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, permission_code)
  );
  CREATE INDEX IF NOT EXISTS idx_company_permissions_company ON company_permissions (company_id);

  -- Level 1 company admins belong to a transit company; NULL (Level 0) means platform ops
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES transit_companies(id);
  CREATE INDEX IF NOT EXISTS idx_admin_users_company ON admin_users (company_id);
  -- Two-realm split: company_id is transit-owned; the portal realm (POS/invoice/WiFi)
  -- gets its own FK. Both are nullable; NULL means "unassigned" and is resolved
  -- by the existing singleton fallbacks in middleware/company.ts and /me.
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS portal_company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_admin_users_portal_company ON admin_users (portal_company_id);

  -- Repair: if an earlier release pointed company_id at the portal companies table,
  -- move it back to transit_companies. Idempotent.
  DO $$
  DECLARE current_def text;
  BEGIN
    SELECT pg_get_constraintdef(oid) INTO current_def FROM pg_constraint
     WHERE conrelid = 'admin_users'::regclass AND contype = 'f'
       AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'admin_users'::regclass
                              AND attname = 'company_id')];
    IF current_def IS NOT NULL
       AND current_def LIKE '%companies(id)%'
       AND current_def NOT LIKE '%transit_companies%' THEN
      ALTER TABLE admin_users DROP CONSTRAINT admin_users_company_id_fkey;
      ALTER TABLE admin_users ADD CONSTRAINT admin_users_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES transit_companies(id);
    END IF;
  END $$;

  -- ════════════════ Soft Delete Engine ════════════════
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
  ALTER TABLE packages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE packages ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE transit_users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

  -- ════════════════ Payment / Transaction Constraints ════════════════
  DROP INDEX IF EXISTS idx_payments_contipay_txn_index;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_pesepay_ref ON payments (pesepay_reference) WHERE pesepay_reference IS NOT NULL;
  DROP INDEX IF EXISTS idx_payments_merchant_ref;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_merchant_ref ON payments (merchant_reference) WHERE merchant_reference IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_payment_id_unique ON transactions (payment_id) WHERE payment_id IS NOT NULL;
  DO $$ BEGIN
    ALTER TABLE payments ADD CONSTRAINT chk_payments_status CHECK (status IN ('pending','completed','failed','refunded'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  -- ════════════════ Users Email Unique ════════════════
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users (email) WHERE email IS NOT NULL AND email != '';

  -- ════════════════ Transit Seat Lock ════════════════
  -- Seats are locked per TRIP INSTANCE (trip_id) per company so a repeated
  -- label like "600-20260918" across different actual trips never falsely
  -- conflicts. Modern /tickets/sync rows always carry trip_id once resolved.
  DROP INDEX IF EXISTS idx_transit_tickets_seat_lock;
  CREATE UNIQUE INDEX idx_transit_tickets_seat_lock ON transit_tickets
    (company_id, trip_id, seat_number)
    WHERE trip_id IS NOT NULL AND seat_number != '' AND status != 'CANCELLED';
  -- Legacy /sync inserts (and any old rows) have no trip_id — keep the old
  -- trip_no-keyed lock for exactly those so history's behavior is preserved.
  DROP INDEX IF EXISTS idx_transit_tickets_seat_lock_legacy;
  CREATE UNIQUE INDEX idx_transit_tickets_seat_lock_legacy ON transit_tickets
    (company_id, trip_no, seat_number)
    WHERE trip_id IS NULL AND seat_number != '' AND status != 'CANCELLED';

  -- Expand transit_tickets CHECK to include CANCELLED for existing DBs
  DO $$ BEGIN
    ALTER TABLE transit_tickets DROP CONSTRAINT IF EXISTS transit_tickets_status_check;
    ALTER TABLE transit_tickets ADD CONSTRAINT transit_tickets_status_check CHECK (status IN ('SYNCED', 'SEAT_CONFLICT', 'INVALID_SIGNATURE', 'CANCELLED'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  -- ════════════════ Transit Ticket Number Uniqueness ════════════════
  -- A printed ticket number must identify exactly one sale, otherwise the same
  -- number can be traced back to two different passengers.
  --
  -- The index covers ONLY tagged numbers (PREFIX-ABC-NNNN, where ABC is a
  -- 3-character per-device tag). That format is what the app now issues; it
  -- embeds a device discriminator so two handsets sharing a plate prefix
  -- cannot both mint AGJ0001.
  --
  -- Untagged numbers are deliberately EXCLUDED, not cleaned up. Production
  -- issued 364 tickets in the older untagged format with no device component,
  -- and 80 of those rows share a number with another row (19 distinct numbers,
  -- 4 handsets, ~$583 of genuinely real sales across 9 trips). Those are real
  -- paid sales, so demoting or deleting them to satisfy a constraint would
  -- rewrite the company's history and would not change the paper already in
  -- passengers' hands. They are grandfathered here and need business-led
  -- reconciliation, not a migration.
  --
  -- CANCELLED rows are excluded so voiding a ticket releases its number.
  DROP INDEX IF EXISTS idx_transit_tickets_receipt_unique;
  CREATE UNIQUE INDEX idx_transit_tickets_receipt_unique ON transit_tickets
    (company_id, client_receipt_no)
    WHERE status <> 'CANCELLED'
      AND client_receipt_no ~ '^[A-Z0-9]+-[0-9A-Z]{3}-[0-9]+$';

  -- ════════════════ Transit Ticket Sync (idempotency + origin/destination) ════════════════
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS ticket_id TEXT;
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS route_from TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS route_to TEXT NOT NULL DEFAULT '';
  -- Must be a FULL (non-partial) unique index: the /tickets/sync upsert targets
  -- ON CONFLICT (ticket_id), which PostgreSQL can only infer from an index whose
  -- predicate the INSERT satisfies. A partial index blows up with "there is no
  -- unique or exclusion constraint matching the ON CONFLICT specification" and
  -- rolls back every sync batch.
  DROP INDEX IF EXISTS idx_transit_tickets_ticket_id;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_transit_tickets_ticket_id
    ON transit_tickets (ticket_id);

  -- ════════════════ Transit Ticket v3 (manual fare / departure / luggage link) ════════════════
  -- custom_fare: total cents charged on manually-overridden fare lines (0 = no override).
  -- departure_time: scheduled departure shown on the receipt (e.g. "06:30").
  -- luggage_linked_ticket_id: for luggage tickets, the bus-fare tx_id they upsell from.
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS custom_fare INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS departure_time TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS luggage_linked_ticket_id TEXT NOT NULL DEFAULT '';
  CREATE INDEX IF NOT EXISTS idx_transit_tickets_luggage_link
    ON transit_tickets (luggage_linked_ticket_id) WHERE luggage_linked_ticket_id != '';

  -- ════════════════ Transit Company Profile (receipt branding) ════════════════
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS logo_url TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS receipt_header TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS receipt_footer TEXT NOT NULL DEFAULT '';

  -- ════════════════ Transit Driver Shifts ════════════════
  CREATE TABLE IF NOT EXISTS transit_shifts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID NOT NULL REFERENCES transit_companies(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES transit_users(id) ON DELETE CASCADE,
    device_id     UUID REFERENCES transit_devices(id),
    driver_id     TEXT NOT NULL DEFAULT '',
    driver_name   TEXT NOT NULL DEFAULT '',
    -- Crew details are pushed by the conductor's handset at shift start so the
    -- admin trip schedule shows who was actually on the bus, and so the server
    -- has the contacts needed to reach the crew.
    driver_phone    TEXT NOT NULL DEFAULT '',
    conductor_name  TEXT NOT NULL DEFAULT '',
    conductor_phone TEXT NOT NULL DEFAULT '',
    vehicle_reg   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'OPEN',
    ticket_count  INTEGER NOT NULL DEFAULT 0,
    total_cents   INTEGER NOT NULL DEFAULT 0,
    notes         TEXT NOT NULL DEFAULT '',
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_shift_per_user
    ON transit_shifts (user_id) WHERE status = 'OPEN';
  CREATE INDEX IF NOT EXISTS idx_transit_shifts_company ON transit_shifts (company_id);
  CREATE INDEX IF NOT EXISTS idx_transit_shifts_status ON transit_shifts (company_id, status);

  -- Link trips and tickets to the shift they sold under (additive upgrade)
  ALTER TABLE transit_trips ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES transit_shifts(id);
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES transit_shifts(id);
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS driver_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_tickets ADD COLUMN IF NOT EXISTS conductor_id TEXT NOT NULL DEFAULT '';
  CREATE INDEX IF NOT EXISTS idx_transit_tickets_shift ON transit_tickets (shift_id);

  -- ════════════════ Company Profile v2 (contact / tax / branding) ════════════════
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS contact_phone TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS tax_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS reg_no TEXT NOT NULL DEFAULT '';

  -- ════════════════ Transit Staff Registry (driver & conductor profiles) ════════════════
  -- Web-admin managed profiles (name / phone / licence / status). These drive the
  -- roster the field app pulls so admin-created drivers & conductors appear in
  -- the app's selection drop-downs. Not login accounts (that stays transit_users).
  CREATE TABLE IF NOT EXISTS transit_staff (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID NOT NULL REFERENCES transit_companies(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('DRIVER', 'CONDUCTOR')),
    full_name     TEXT NOT NULL,
    phone         TEXT NOT NULL DEFAULT '',
    license_no    TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ON_LEAVE')),
    created_by    UUID REFERENCES admin_users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_transit_staff_company ON transit_staff (company_id, role);

  -- Web-admin staff profile contact detail (printed on tickets, shown on shifts)
  ALTER TABLE transit_users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';

  -- Staff device unbind + hard delete support.
  -- transit_devices.user_id is nullable so an admin can clear a terminal's user
  -- binding (status -> UNBOUND) instead of destroying the device row.
  ALTER TABLE transit_devices ALTER COLUMN user_id DROP NOT NULL;

  -- Historical references may outlive a deleted profile: make them ON DELETE
  -- SET NULL so administrative history is preserved while transit_users rows
  -- with zero linked shifts/tickets/trips can be hard-deleted at the API layer
  -- (the API guards the shift/ticket/trip references with a 409 first).
  DO $$ BEGIN
    ALTER TABLE transit_audit_log DROP CONSTRAINT IF EXISTS transit_audit_log_user_id_fkey;
    ALTER TABLE transit_audit_log ADD CONSTRAINT transit_audit_log_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES transit_users(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;
  DO $$ BEGIN
    ALTER TABLE transit_security_events DROP CONSTRAINT IF EXISTS transit_security_events_user_id_fkey;
    ALTER TABLE transit_security_events ADD CONSTRAINT transit_security_events_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES transit_users(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;
  DO $$ BEGIN
    ALTER TABLE transit_devices DROP CONSTRAINT IF EXISTS transit_devices_reset_by_fkey;
    ALTER TABLE transit_devices ADD CONSTRAINT transit_devices_reset_by_fkey
      FOREIGN KEY (reset_by) REFERENCES transit_users(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;
  DO $$ BEGIN
    ALTER TABLE transit_promotions DROP CONSTRAINT IF EXISTS transit_promotions_created_by_fkey;
    ALTER TABLE transit_promotions ADD CONSTRAINT transit_promotions_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES transit_users(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  -- ════════════════ POS (Preyone Point of Sale) ════════════════
  -- Allow Cashier role on admin users + PIN login support
  ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_role_check;
  ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check
    CHECK (role IN ('CEO', 'Manager', 'Staff', 'Cashier'));
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS pin_hash TEXT;

  -- Product catalogue / stock
  CREATE TABLE IF NOT EXISTS pos_products (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    sku                 TEXT,
    barcode             TEXT,
    category            TEXT,
    price               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    cost_price          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    stock_qty           NUMERIC(12,2) NOT NULL DEFAULT 0,
    track_stock         BOOLEAN NOT NULL DEFAULT TRUE,
    low_stock_threshold NUMERIC(12,2) NOT NULL DEFAULT 0,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_products_sku     ON pos_products (sku)     WHERE sku IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_products_barcode ON pos_products (barcode) WHERE barcode IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_pos_products_name   ON pos_products (lower(name));
  CREATE INDEX IF NOT EXISTS idx_pos_products_active ON pos_products (active);

  -- Client book
  CREATE TABLE IF NOT EXISTS pos_customers (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    phone      TEXT,
    email      TEXT,
    address    TEXT,
    notes      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_customers_name ON pos_customers (lower(name));

  -- Till shifts (cash-up sessions)
  CREATE TABLE IF NOT EXISTS pos_shifts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cashier_id    UUID NOT NULL REFERENCES admin_users(id),
    opening_float NUMERIC(12,2) NOT NULL DEFAULT 0,
    opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at     TIMESTAMPTZ,
    expected_cash NUMERIC(12,2),
    counted_cash  NUMERIC(12,2),
    variance      NUMERIC(12,2),
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    notes         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pos_shifts_cashier ON pos_shifts (cashier_id);
  CREATE INDEX IF NOT EXISTS idx_pos_shifts_status  ON pos_shifts (status);
  CREATE INDEX IF NOT EXISTS idx_pos_shifts_opened  ON pos_shifts (opened_at);

  -- Documents: till receipts (sale), invoices, quotations
  CREATE SEQUENCE IF NOT EXISTS pos_doc_number_seq;

  CREATE TABLE IF NOT EXISTS pos_documents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_number   TEXT UNIQUE NOT NULL,
    doc_type     TEXT NOT NULL CHECK (doc_type IN ('sale', 'invoice', 'quotation')),
    channel      TEXT NOT NULL DEFAULT 'till' CHECK (channel IN ('till', 'online', 'office')),
    status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'unpaid', 'partial', 'paid', 'sent', 'void')),
    customer_id  UUID REFERENCES pos_customers(id) ON DELETE SET NULL,
    cashier_id   UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    shift_id     UUID REFERENCES pos_shifts(id) ON DELETE SET NULL,
    issue_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date     DATE,
    subtotal     NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount_pct NUMERIC(5,2)  NOT NULL DEFAULT 0,
    tax_pct      NUMERIC(5,2)  NOT NULL DEFAULT 0,
    total        NUMERIC(12,2) NOT NULL DEFAULT 0,
    amount_paid  NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_pos_documents_number   ON pos_documents (doc_number);
  CREATE INDEX IF NOT EXISTS idx_pos_documents_customer ON pos_documents (customer_id);
  CREATE INDEX IF NOT EXISTS idx_pos_documents_status   ON pos_documents (status);
  CREATE INDEX IF NOT EXISTS idx_pos_documents_type     ON pos_documents (doc_type);
  CREATE INDEX IF NOT EXISTS idx_pos_documents_shift    ON pos_documents (shift_id);
  CREATE INDEX IF NOT EXISTS idx_pos_documents_created  ON pos_documents (created_at);

  CREATE TABLE IF NOT EXISTS pos_document_items (
    id            BIGSERIAL PRIMARY KEY,
    document_id   UUID NOT NULL REFERENCES pos_documents(id) ON DELETE CASCADE,
    product_id    UUID REFERENCES pos_products(id) ON DELETE SET NULL,
    description   TEXT NOT NULL,
    price         NUMERIC(12,2) NOT NULL DEFAULT 0,
    qty           NUMERIC(12,2) NOT NULL DEFAULT 1,
    line_total    NUMERIC(12,2) NOT NULL DEFAULT 0,
    position      INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_pos_doc_items_document ON pos_document_items (document_id);
  CREATE INDEX IF NOT EXISTS idx_pos_doc_items_product  ON pos_document_items (product_id);

  CREATE TABLE IF NOT EXISTS pos_document_payments (
    id            BIGSERIAL PRIMARY KEY,
    document_id   UUID NOT NULL REFERENCES pos_documents(id) ON DELETE CASCADE,
    amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method        TEXT NOT NULL DEFAULT 'cash'
                  CHECK (method IN ('cash', 'card', 'ecocash', 'bank', 'pesepay', 'other')),
    reference     TEXT,
    paid_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_by   UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    shift_id      UUID REFERENCES pos_shifts(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pos_doc_pay_document ON pos_document_payments (document_id);
  CREATE INDEX IF NOT EXISTS idx_pos_doc_pay_method   ON pos_document_payments (method);
  CREATE INDEX IF NOT EXISTS idx_pos_doc_pay_paid_at  ON pos_document_payments (paid_at);

  -- Company profile (single source of truth for receipts/notifications)
  CREATE TABLE IF NOT EXISTS companies (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT NOT NULL DEFAULT 'Preyone',
    tagline        TEXT,
    address        TEXT,
    email          TEXT,
    support_phone  TEXT,
    website        TEXT,
    logo_path      TEXT,
    currency       TEXT NOT NULL DEFAULT 'USD',
    tax_pct        NUMERIC(5,2) NOT NULL DEFAULT 0,
    invoice_prefix TEXT NOT NULL DEFAULT 'INV',
    quote_prefix   TEXT NOT NULL DEFAULT 'QT',
    receipt_footer TEXT,
    terms_text     TEXT,
    updated_by     UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  INSERT INTO companies (name, tagline, email, support_phone, currency, tax_pct)
  SELECT 'Preyone', 'Connecting People. Powering Business.', 'info@preyone.com', '+263771327202', 'USD', 0
  WHERE NOT EXISTS (SELECT 1 FROM companies);

  -- Company scoping for POS documents and shifts. pos.ts writes company_id on
  -- every checkout, but the columns were originally added by hand, so they are
  -- declared here to keep a fresh migrate() in step with the live database
  -- (both are NOT NULL in production). The singleton company backfills any
  -- rows created before this ran.
  ALTER TABLE pos_documents ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
  ALTER TABLE pos_shifts    ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
  UPDATE pos_documents SET company_id = (SELECT id FROM companies ORDER BY created_at LIMIT 1) WHERE company_id IS NULL;
  UPDATE pos_shifts    SET company_id = (SELECT id FROM companies ORDER BY created_at LIMIT 1) WHERE company_id IS NULL;
  ALTER TABLE pos_documents ALTER COLUMN company_id SET NOT NULL;
  ALTER TABLE pos_shifts    ALTER COLUMN company_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_pos_documents_company ON pos_documents (company_id);
  CREATE INDEX IF NOT EXISTS idx_pos_shifts_company    ON pos_shifts (company_id);

  -- Pesepay payment intents. Also originally added by hand; the payments
  -- router writes every column below and the callback settles them.
  CREATE TABLE IF NOT EXISTS pesepay_intents (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference            TEXT UNIQUE NOT NULL,
    provider_reference   TEXT,
    tenant_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    amount               NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency             TEXT NOT NULL,
    payment_method       TEXT NOT NULL DEFAULT 'ecocash',
    purpose              TEXT NOT NULL,
    reason_for_payment   TEXT NOT NULL,
    target_type          TEXT NOT NULL CHECK (target_type IN ('invoice', 'shift', 'subscription')),
    target_id            UUID,
    shift_id             UUID REFERENCES pos_shifts(id) ON DELETE SET NULL,
    subscription_module  TEXT,
    plan_tier            TEXT,
    redirect_url         TEXT,
    poll_url             TEXT,
    status               TEXT NOT NULL DEFAULT 'pending',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at         TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_pesepay_intents_ref     ON pesepay_intents (reference);
  CREATE INDEX IF NOT EXISTS idx_pesepay_intents_tenant  ON pesepay_intents (tenant_id);
  CREATE INDEX IF NOT EXISTS idx_pesepay_intents_status  ON pesepay_intents (status);
  CREATE INDEX IF NOT EXISTS idx_pesepay_intents_target  ON pesepay_intents (target_type, target_id);

  -- Website Starlink checkout. One row per customer attempt, which makes the
  -- POST idempotent on idempotency_key and keeps the customer's own details
  -- (plan, account reference, contact) next to the invoice they triggered.
  -- The invoice itself lives in pos_documents, and the Pesepay intent points
  -- back at it, so the gateway callback settles the same document.
  CREATE TABLE IF NOT EXISTS site_invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT UNIQUE NOT NULL,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    document_id     UUID NOT NULL REFERENCES pos_documents(id) ON DELETE CASCADE,
    intent_id       UUID REFERENCES pesepay_intents(id) ON DELETE SET NULL,
    account_ref     TEXT NOT NULL,
    plan_id         TEXT NOT NULL,
    plan_label      TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL,
    phone           TEXT,
    amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency        TEXT NOT NULL DEFAULT 'USD',
    rail            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'success', 'failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_site_invoices_company  ON site_invoices (company_id);
  CREATE INDEX IF NOT EXISTS idx_site_invoices_document ON site_invoices (document_id);
  CREATE INDEX IF NOT EXISTS idx_site_invoices_status   ON site_invoices (status);
  CREATE INDEX IF NOT EXISTS idx_site_invoices_created  ON site_invoices (created_at);
  CREATE INDEX IF NOT EXISTS idx_site_invoices_account  ON site_invoices (lower(account_ref));
  CREATE INDEX IF NOT EXISTS idx_site_invoices_email    ON site_invoices (lower(email));

  -- POS devices & endpoints (desktop / web / android)
  CREATE TABLE IF NOT EXISTS pos_devices (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   TEXT UNIQUE NOT NULL,
    device_type TEXT NOT NULL DEFAULT 'android' CHECK (device_type IN ('desktop', 'web', 'android')),
    name        TEXT NOT NULL,
    branch      TEXT,
    company_id  UUID REFERENCES companies(id) ON DELETE SET NULL,
    app_version TEXT,
    server_url  TEXT,
    status      TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'active', 'suspended')),
    last_seen   TIMESTAMPTZ,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_pos_devices_type     ON pos_devices (device_type);
  CREATE INDEX IF NOT EXISTS idx_pos_devices_status   ON pos_devices (status);
  CREATE INDEX IF NOT EXISTS idx_pos_devices_last_seen ON pos_devices (last_seen);

  -- Demo devices so the Devices & Endpoints console has data to show
  INSERT INTO pos_devices (device_id, device_type, name, branch, app_version, status, last_seen)
  SELECT 'demo-desktop-01', 'desktop', 'Front Desk Desktop', 'Head Office', '1.0.0', 'active', NOW() - INTERVAL '5 minutes'
  WHERE NOT EXISTS (SELECT 1 FROM pos_devices WHERE device_id = 'demo-desktop-01');
  INSERT INTO pos_devices (device_id, device_type, name, branch, app_version, status, last_seen)
  SELECT 'demo-android-01', 'android', 'Till Tablet (Hall)', 'Hall', '2.4.3', 'active', NOW() - INTERVAL '2 minutes'
  WHERE NOT EXISTS (SELECT 1 FROM pos_devices WHERE device_id = 'demo-android-01');

  -- ════════════════ Ruijie Cloud Voucher Integration ════════════════
  -- Maps sellable package tiers to Ruijie Cloud user groups (seed via
  -- scripts/fetch-ruijie-profiles.ts once RUIJIE_CLOUD credentials exist).
  CREATE TABLE IF NOT EXISTS voucher_profiles (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tier_name            TEXT NOT NULL REFERENCES packages(tier_name) ON DELETE CASCADE,
    ruijie_user_group_id TEXT NOT NULL,
    ruijie_profile_uuid  TEXT NOT NULL,
    ruijie_group_name    TEXT,
    time_period_min      INTEGER,
    quota_mb             INTEGER,
    no_of_device         INTEGER,
    rate_limit_kbps      INTEGER,
    active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tier_name)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_profiles_tier ON voucher_profiles (tier_name);
  CREATE INDEX IF NOT EXISTS idx_voucher_profiles_active ON voucher_profiles (active);

  -- Audit trail of every Ruijie Cloud code minted through this portal.
  CREATE TABLE IF NOT EXISTS ruijie_vouchers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code_no       TEXT NOT NULL,
    tier_name     TEXT,
    user_group_id TEXT,
    profile_uuid  TEXT,
    ruijie_expiry BIGINT,
    payment_id    UUID REFERENCES payments(id) ON DELETE SET NULL,
    source        TEXT NOT NULL DEFAULT 'online' CHECK (source IN ('online','staff','pos','seed','manual')),
    comment       TEXT,
    raw_response  JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ruijie_vouchers_code_no ON ruijie_vouchers (code_no);
  CREATE INDEX IF NOT EXISTS idx_ruijie_vouchers_payment ON ruijie_vouchers (payment_id);
  CREATE INDEX IF NOT EXISTS idx_ruijie_vouchers_tier ON ruijie_vouchers (tier_name);

  -- ════════════════ Multi-device Voucher Binding ════════════════
  -- One voucher code can authorize several devices (a phone, a laptop, a TV).
  -- Historically a device could only be attached by redeeming the code again,
  -- which burned another max_uses allocation and created a second user row.
  -- vouchers.max_devices existed but nothing ever read it.
  --
  -- Devices are bound at RADIUS auth time, because that is the only point where
  -- we learn the real client MAC from the gateway. Redemption still works
  -- unchanged; this table is additive.
  CREATE TABLE IF NOT EXISTS voucher_devices (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_id    UUID NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    voucher_code  TEXT NOT NULL,
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    mac_address   TEXT NOT NULL,
    -- 12-hex uppercase, no separators. Stored normalized so RADIUS lookups are
    -- an index hit instead of a REPLACE() on every auth attempt.
    mac_norm      TEXT NOT NULL,
    label         TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    bound_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ,
    unbound_at    TIMESTAMPTZ,
    UNIQUE (voucher_id, mac_norm)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_devices_voucher_mac
    ON voucher_devices (voucher_id, mac_norm);
  CREATE INDEX IF NOT EXISTS idx_voucher_devices_mac_norm ON voucher_devices (mac_norm);
  CREATE INDEX IF NOT EXISTS idx_voucher_devices_user ON voucher_devices (user_id);

  -- Backfill: any user that already has a MAC from a past redemption becomes
  -- that voucher's first bound device, so enabling the device limit never locks
  -- out a device that is working today.
  INSERT INTO voucher_devices (voucher_id, voucher_code, user_id, mac_address, mac_norm, label)
  SELECT v.id, v.code, u.id, u.mac_address,
         REPLACE(REPLACE(UPPER(u.mac_address), ':', ''), '-', ''),
         'existing session'
  FROM users u
  JOIN vouchers v ON v.code = u.voucher_code
  WHERE u.mac_address IS NOT NULL
    AND REPLACE(REPLACE(UPPER(u.mac_address), ':', ''), '-', '') ~ '^[0-9A-F]{12}$'
  ON CONFLICT (voucher_id, mac_norm) DO NOTHING;

  -- ════════════════ Voucher Lifecycle: Activation, Disable, Soft Delete ════════════════
  -- The admin console needs to show and manage a voucher's lifecycle, but a stored
  -- status column would be a second copy of facts we can already derive
  -- (used_count, max_uses, expires_at) and would drift the moment RADIUS accounting
  -- ran. So only genuinely new facts are stored here; status itself is the derived
  -- view below.
  --
  -- activated_at: when this code was FIRST redeemed. Distinct from expires_at,
  -- which is the staff-set shelf life of the code itself and is frequently NULL
  -- (never expires). Session lifetime is duration_min applied to
  -- users.session_expires_at — three different clocks, deliberately not merged.
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

  -- is_disabled: manual kill switch. Deliberately separate from deleted_at so a
  -- disabled voucher stays visible and can be re-enabled, whereas a soft delete
  -- removes it from working views.
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE;

  -- Soft delete. Hard DELETE would cascade through voucher_redemptions and
  -- voucher_devices and destroy the redemption audit trail, so removal is a
  -- tombstone instead.
  ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

  -- Subscriber name parts. users.full_name is the single field the signup flow
  -- already writes and must keep writing; these are an optional split of it for
  -- display, and full_name remains the source of truth.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name  TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS alias       TEXT;

  -- Backfill first/last name from the existing full_name so the admin table is
  -- populated immediately. Only for names that actually contain a space, and only
  -- where the new columns are still empty (never overwrite a real split).
  UPDATE users u
  SET first_name = COALESCE(u.first_name, btrim(split_part(u.full_name, ' ', 1))),
      last_name  = COALESCE(u.last_name, NULLIF(btrim(substr(u.full_name, strpos(u.full_name, ' ') + 1)), ''))
  WHERE u.full_name IS NOT NULL
    AND btrim(u.full_name) <> ''
    AND strpos(u.full_name, ' ') > 0;

  -- Backfill activated_at from the earliest redemption of each voucher, so codes
  -- redeemed before this column existed do not all read as "never activated".
  UPDATE vouchers v
  SET activated_at = r.first_redemption
  FROM (
    SELECT voucher_id, MIN(created_at) AS first_redemption
    FROM voucher_redemptions
    GROUP BY voucher_id
  ) r
  WHERE v.activated_at IS NULL
    AND r.voucher_id = v.id;

  -- vouchers had NO indexes at all apart from the implicit code UNIQUE. The admin
  -- list table now filters and sorts on these columns server-side.
  CREATE INDEX IF NOT EXISTS idx_vouchers_code_lower     ON vouchers (lower(code));
  CREATE INDEX IF NOT EXISTS idx_vouchers_created_at    ON vouchers (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vouchers_package_tier  ON vouchers (package_tier);
  CREATE INDEX IF NOT EXISTS idx_vouchers_activated_at  ON vouchers (activated_at);
  CREATE INDEX IF NOT EXISTS idx_vouchers_lifecycle     ON vouchers (is_disabled, deleted_at);

  -- Derived status. Recomputed by Postgres on every read, so it can never disagree
  -- with used_count/expires_at. Precedence: a disabled or deleted code is Disabled
  -- regardless of how it was used; then expiry; then whether it has been redeemed.
  -- Note this deliberately has no "exhausted" state — a fully-redeemed code reads
  -- as Active, since the requested enum is Unused/Active/Expired/Disabled.
  CREATE OR REPLACE VIEW voucher_status AS
  SELECT
    v.id,
    CASE
      WHEN v.is_disabled OR v.deleted_at IS NOT NULL              THEN 'Disabled'
      WHEN v.expires_at IS NOT NULL AND v.expires_at <= NOW()    THEN 'Expired'
      WHEN v.used_count > 0                                       THEN 'Active'
      ELSE 'Unused'
    END AS status
  FROM vouchers v;
`;

(async () => {
  const client = await pool.connect();
  try {
    await client.query(SQL);
    
    // Seed packages table (idempotent upsert — updates existing tiers, inserts new ones)
    const packages = [
      // Orange band
      ['PreLite', 'Daily Basic', 1.00, 'USD', 'daily', 1440, 5, false, 5, 5, 1],
      ['PreLite Plus', 'Starter', 1.99, 'USD', '2days', 2880, 10, false, 5, 5, 1],
      ['PreLink', 'Weekly Standard', 4.99, 'USD', 'weekly', 10080, 20, false, 5, 5, 1],
      // Cyan band
      ['PreGo', 'PreGo', 7.99, 'USD', 'monthly', 43200, 30, false, 5, 5, 1],
      ['PreFlow', 'PreFlow', 9.99, 'USD', 'monthly', 43200, 40, false, 5, 5, 1],
      ['PreCore', 'PreCore', 14.99, 'USD', 'monthly', 43200, null, true, 5, 5, 1],
      // Blue band
      ['PreBizPlus', 'Business', 19.99, 'USD', 'monthly', 43200, null, true, 10, 10, 1],
      ['PreFam', 'Family Pack', 24.99, 'USD', 'monthly', 43200, null, true, 10, 10, 2],
      ['PreBizPro', 'Business Pro', 29.99, 'USD', 'monthly', 43200, null, true, 10, 10, 3],
      // Purple band
      ['PreMax', 'Monthly Pro', 34.99, 'USD', 'monthly', 43200, null, true, 15, 15, 1],
      ['PreUltra', 'Monthly Unlimited', 44.99, 'USD', 'monthly', 43200, null, true, 15, 15, 1],
      ['PreExecutive', 'VIP Tier', 59.99, 'USD', 'monthly', 43200, null, true, 30, 30, 1],
    ];

    for (const pkg of packages) {
      await client.query(
        `INSERT INTO packages (tier_name, display_name, price_amount, price_currency, billing_period, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, max_devices)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tier_name) DO NOTHING`,
        pkg
      );
    }

    // Remove tiers no longer offered (best-effort — historical payments may FK-lock them)
    const obsoleteTiers = [
      'PreLITE', 'PreLITE PLUS', 'PreLITE Starter',
      'PreLINK', 'PreLINK PLUS', 'PreLINK Student', 'PreLINK Standard',
      'PreBIZ', 'PreBIZ Plus',
      'PreMAX', 'PreULTRA', 'PreEXECUTIVE',
      'PreLink Student', 'PreLink Standard', 'PreBiz',
    ];
    try {
      await client.query(`UPDATE packages SET deleted_at = NOW(), status = 'archived' WHERE tier_name = ANY($1::text[]) AND deleted_at IS NULL`, [obsoleteTiers]);
    } catch (err) {
      console.warn('Could not remove obsolete tiers (likely referenced by historical payments):', (err as Error).message);
    }
    
    // ── Preyone Transit seed (idempotent) ──
    const companySlug = process.env.TRANSIT_COMPANY_SLUG || 'preyone-transit';
    const companyResult = await client.query(
      `INSERT INTO transit_companies (name, slug, tagline, address, email, website, customer_care, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [
        process.env.TRANSIT_COMPANY_NAME || 'Preyone Transit',
        companySlug,
        process.env.TRANSIT_COMPANY_TAGLINE || 'Famba Nyore Nyore',
        process.env.TRANSIT_COMPANY_ADDRESS || '',
        process.env.TRANSIT_COMPANY_EMAIL || '',
        process.env.TRANSIT_COMPANY_WEBSITE || '',
        process.env.TRANSIT_COMPANY_CARE || '',
        process.env.TRANSIT_COMPANY_CURRENCY || 'USD',
      ]
    );
    let companyId = companyResult.rows[0]?.id;
    if (!companyId) {
      const { rows } = await client.query('SELECT id FROM transit_companies WHERE slug = $1', [companySlug]);
      companyId = rows[0].id;
    }
    if (!companyId) throw new Error(`Transit company seed failed for slug: ${companySlug}`);

    if (process.env.TRANSIT_OFFLINE_LEASE_DAYS) {
      await client.query('UPDATE transit_companies SET offline_lease_days = $1 WHERE id = $2', [
        Number(process.env.TRANSIT_OFFLINE_LEASE_DAYS),
        companyId,
      ]);
    }
    if (process.env.TRANSIT_MIN_APP_VERSION) {
      await client.query('UPDATE transit_companies SET min_app_version = $1 WHERE id = $2', [
        process.env.TRANSIT_MIN_APP_VERSION,
        companyId,
      ]);
    }

    const transitAdminUsername = process.env.TRANSIT_ADMIN_USERNAME || 'admin';
    const { rows: transitAdmin } = await client.query(
      'SELECT id FROM transit_users WHERE username = $1',
      [transitAdminUsername]
    );
    if (transitAdmin.length === 0) {
      const transitAdminPassword = process.env.TRANSIT_ADMIN_PASSWORD || 'preyone';
      if (process.env.NODE_ENV === 'production') {
        if (transitAdminUsername === 'admin') {
          throw new Error(
            'FATAL: TRANSIT_ADMIN_USERNAME must not be the insecure default "admin" in production. ' +
              'Set a unique TRANSIT_ADMIN_USERNAME in .env and re-run the migration.'
          );
        }
        if (!process.env.TRANSIT_ADMIN_PASSWORD || transitAdminPassword === 'preyone') {
          throw new Error(
            'FATAL: TRANSIT_ADMIN_PASSWORD must be set to a strong value in production. ' +
              'Refusing to seed the transit admin with a default password.'
          );
        }
      } else if (process.env.NODE_ENV === 'production' && !process.env.TRANSIT_ADMIN_PASSWORD) {
        console.warn(
          'WARNING: TRANSIT_ADMIN_PASSWORD not set in production. Using the default password. ' +
            'Set TRANSIT_ADMIN_USERNAME / TRANSIT_ADMIN_PASSWORD env vars and re-run the migration to rotate.'
        );
      }
      const passwordHash = await bcrypt.hash(transitAdminPassword, 12);
      await client.query(
        `INSERT INTO transit_users (company_id, username, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4, 'SUPER_ADMIN')`,
        [companyId, transitAdminUsername, passwordHash, process.env.TRANSIT_ADMIN_NAME || 'Preyone Administrator']
      );
      console.log(`Transit seeded: company "${companySlug}", SUPER_ADMIN user "${transitAdminUsername}".`);
    }

    // ── RBAC permission seeds (idempotent) ──
    const permissions: Array<[string, string]> = [
      ['system.developer', 'Preyone platform super-admin: tenant creation, gateway keys, global feature flags, all system logs'],
      ['company.admin', 'Company super admin: staff management, approvals, reports, revenue'],
      ['operations.manage', 'Daily operations: routes, trips, assignments'],
      ['finance.view', 'Refunds, audit logs, financials'],
      ['transit.field_app', 'Mobile field app access (CONDUCTOR/DRIVER/TICKET_SELLER)'],
      ['route.templates.manage', 'Create/edit/delete company master route templates. Grantable to a company so a field-staff owner can maintain them without becoming an admin.'],
    ];
    for (const [code, description] of permissions) {
      await client.query(
        'INSERT INTO permissions (code, description) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING',
        [code, description]
      );
    }

    const rolePermissionMap: Array<[string, string]> = [
      // Preyone platform (admin portal)
      ['CEO', 'system.developer'],
      ['CEO', 'company.admin'],
      ['CEO', 'operations.manage'],
      ['CEO', 'finance.view'],
      ['Manager', 'company.admin'],
      ['Manager', 'operations.manage'],
      ['Manager', 'finance.view'],
      ['Staff', 'finance.view'],
      // Transit API
      ['SUPER_ADMIN', 'company.admin'],
      ['SUPER_ADMIN', 'operations.manage'],
      ['SUPER_ADMIN', 'finance.view'],
      ['SUPER_ADMIN', 'transit.field_app'],
      ['COMPANY_ADMIN', 'company.admin'],
      ['COMPANY_ADMIN', 'operations.manage'],
      ['COMPANY_ADMIN', 'finance.view'],
      ['COMPANY_ADMIN', 'transit.field_app'],
      ['MANAGER', 'operations.manage'],
      ['MANAGER', 'finance.view'],
      ['MANAGER', 'transit.field_app'],
      ['OPERATIONS', 'operations.manage'],
      ['OPERATIONS', 'transit.field_app'],
      ['DISPATCHER', 'operations.manage'],
      ['DISPATCHER', 'transit.field_app'],
      ['ACCOUNTANT', 'finance.view'],
      ['ACCOUNTANT', 'transit.field_app'],
      ['CONDUCTOR', 'transit.field_app'],
      ['DRIVER', 'transit.field_app'],
      ['TICKET_SELLER', 'transit.field_app'],
      // Route template management. Field roles (CONDUCTOR/DRIVER/TICKET_SELLER)
      // are deliberately absent: a company whose owner is field staff receives
      // this via company_permissions instead of a role-wide default.
      ['SUPER_ADMIN', 'route.templates.manage'],
      ['COMPANY_ADMIN', 'route.templates.manage'],
      ['MANAGER', 'route.templates.manage'],
      ['OPERATIONS', 'route.templates.manage'],
    ];
    for (const [role, permission] of rolePermissionMap) {
      await client.query(
        'INSERT INTO role_permissions (role, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [role, permission]
      );
    }

    // ── Company capability grants (opt-in) ──
    // The seeded company's owner is field staff (a conductor who bought the
    // product), so they need route template management via a COMPANY grant
    // rather than by being promoted to COMPANY_ADMIN. Every user of the company
    // inherits it; nobody else does, and no other permission widens.
    //
    // This is OPT-IN and refuses to guess. It previously ran unless
    // TRANSIT_GRANT_ROUTE_TEMPLATES=0, which meant any deployment whose
    // TRANSIT_COMPANY_SLUG was unset silently granted the capability to the
    // default 'preyone-transit' tenant — on the live VPS that company is
    // Preyone Freights, so the migration handed an unrelated company the
    // permission. Two explicit settings are now required: which company, and
    // that the grant is wanted at all. Existing grants are untouched (this only
    // ever inserts), so switching the default off cannot revoke a live grant.
    const grantRouteTemplates = process.env.TRANSIT_GRANT_ROUTE_TEMPLATES === '1';
    if (grantRouteTemplates) {
      if (!process.env.TRANSIT_COMPANY_SLUG) {
        throw new Error(
          'TRANSIT_GRANT_ROUTE_TEMPLATES=1 requires TRANSIT_COMPANY_SLUG to name the ' +
            'company that should receive "route.templates.manage". Refusing to guess: ' +
            'the default slug (preyone-transit) belongs to a different tenant.'
        );
      }
      await client.query(
        `INSERT INTO company_permissions (company_id, permission_code)
         VALUES ($1, 'route.templates.manage')
         ON CONFLICT (company_id, permission_code) DO NOTHING`,
        [companyId]
      );
      console.log(
        `Granted "route.templates.manage" to company "${companySlug}" (all company users, incl. field staff).`
      );
    } else {
      console.log(
        'Skipped the "route.templates.manage" company grant ' +
          '(opt-in: set TRANSIT_GRANT_ROUTE_TEMPLATES=1 together with TRANSIT_COMPANY_SLUG).'
      );
    }

    // ════════════════ Data cleanup: customer_care → +263 form ════════════════
    // Normalise already-stored Zimbabwe care lines to E.164 (+263) form in
    // place, matching what the server now does on every create/update. Reads
    // every non-empty row once and rewrites only the ones that change, so it
    // is fully idempotent on re-runs and on clean installs (no-op).
    {
      const { rows: careRows } = await client.query(
        `SELECT id, customer_care FROM transit_companies WHERE customer_care <> ''`
      );
      for (const row of careRows) {
        const normalized = formatZimPhone(row.customer_care);
        if (normalized !== row.customer_care) {
          await client.query('UPDATE transit_companies SET customer_care = $1 WHERE id = $2', [
            normalized,
            row.id,
          ]);
        }
      }
    }

    // Crew contacts on shifts. Additive and idempotent: existing rows keep their
    // values, and new pushes from the handset start filling these in. Without
    // them the admin trip schedule could only show a driver's name, never a
    // contact for the crew actually on the bus.
    await client.query(`
      ALTER TABLE transit_shifts ADD COLUMN IF NOT EXISTS driver_phone TEXT NOT NULL DEFAULT '';
      ALTER TABLE transit_shifts ADD COLUMN IF NOT EXISTS conductor_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE transit_shifts ADD COLUMN IF NOT EXISTS conductor_phone TEXT NOT NULL DEFAULT '';
    `);

    console.log('Migration complete. Packages + transit + RBAC seeded.');
  } finally {
    client.release();
    await pool.end();
  }
})();
