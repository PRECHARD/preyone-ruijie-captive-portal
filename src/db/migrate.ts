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
    pesepay_reference       TEXT,
    merchant_reference      TEXT,
    pesepay_poll_url        TEXT,
    ruijie_auth_url         TEXT,
    client_mac              TEXT,
    status                  TEXT NOT NULL DEFAULT 'pending',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMPTZ,
    error_message           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
  CREATE INDEX IF NOT EXISTS idx_payments_pesepay_ref ON payments (pesepay_reference);
  CREATE INDEX IF NOT EXISTS idx_payments_merchant_ref ON payments (merchant_reference);

  -- ContiPay online purchases: minted voucher is attached to the completed payment
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS voucher_code TEXT;

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

  -- Level 1 company admins belong to a transit company; NULL (Level 0) means platform ops
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES transit_companies(id);
  CREATE INDEX IF NOT EXISTS idx_admin_users_company ON admin_users (company_id);

  -- ════════════════ Soft Delete Engine ════════════════
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
  ALTER TABLE packages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE packages ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
  ALTER TABLE transit_companies ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE transit_users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

  -- ════════════════ Payment / Transaction Constraints ════════════════
  DROP INDEX IF EXISTS idx_payments_pesepay_ref;
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
`;

(async () => {
  const client = await pool.connect();
  try {
    await client.query(SQL);
    
    // Seed packages table (idempotent upsert — updates existing tiers, inserts new ones)
    const packages = [
      // Orange band
      ['PreLite', 'Daily Basic', 0.99, 'USD', 'daily', 1440, 5, false, 5, 5, 1],
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
    ];
    for (const [role, permission] of rolePermissionMap) {
      await client.query(
        'INSERT INTO role_permissions (role, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [role, permission]
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

    console.log('Migration complete. Packages + transit + RBAC seeded.');
  } finally {
    client.release();
    await pool.end();
  }
})();
