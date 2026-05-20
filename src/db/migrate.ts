import 'dotenv/config';
import { pool } from './pool';

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

  CREATE INDEX IF NOT EXISTS idx_users_voucher_code  ON users (voucher_code);
  CREATE INDEX IF NOT EXISTS idx_users_session_token ON users (session_token);
  CREATE INDEX IF NOT EXISTS idx_users_package_id    ON users (package_id);

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

  -- Seed mock AP devices on first run (idempotent)
  INSERT INTO ap_devices (name, model, mac_address, ip_address, location, status, firmware_version, uptime_seconds, clients_count, last_seen)
  VALUES
    ('RAP-6262G-Lobby', 'Reyee RAP6262G', 'AA:BB:CC:DD:EE:01', '192.168.1.10', 'Main Lobby', 'online', 'v2.1.3', 864000, 12, NOW()),
    ('RAP-6262G-Hall', 'Reyee RAP6262G', 'AA:BB:CC:DD:EE:02', '192.168.1.11', 'Conference Hall', 'online', 'v2.1.3', 432000, 8, NOW()),
    ('RAP-6262G-Cafe', 'Reyee RAP6262G', 'AA:BB:CC:DD:EE:03', '192.168.1.12', 'Cafeteria', 'warning', 'v2.0.9', 72000, 3, NOW()),
    ('RAP-6262G-Outdoor', 'Reyee RAP6262G', 'AA:BB:CC:DD:EE:04', '192.168.1.13', 'Outdoor Patio', 'offline', 'v2.1.0', 0, 0, NOW() - INTERVAL '2 hours')
  ON CONFLICT (mac_address) DO NOTHING;

  -- Seed mock alerts (idempotent)
  INSERT INTO alerts (type, severity, title, message, target_type, target_id)
  SELECT 'ap_down', 'critical', 'AP Offline: Outdoor Patio', 'RAP-6262G-Outdoor has been offline for 2+ hours. No clients connected.', 'ap_device', (SELECT id FROM ap_devices WHERE mac_address = 'AA:BB:CC:DD:EE:04' LIMIT 1)
  WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE type = 'ap_down' AND title LIKE '%Outdoor%');

  INSERT INTO alerts (type, severity, title, message, target_type, target_id)
  SELECT 'ap_warning', 'warning', 'Firmware Update Available', 'RAP-6262G-Cafe is running v2.0.9. Latest is v2.1.3.', 'ap_device', (SELECT id FROM ap_devices WHERE mac_address = 'AA:BB:CC:DD:EE:03' LIMIT 1)
  WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE type = 'ap_warning' AND title LIKE '%Firmware%');

  INSERT INTO alerts (type, severity, title, message, target_type, target_id)
  SELECT 'traffic_spike', 'info', 'Traffic Spike Detected', 'Bandwidth usage on Lobby AP increased 340% in the last hour.', 'ap_device', (SELECT id FROM ap_devices WHERE mac_address = 'AA:BB:CC:DD:EE:01' LIMIT 1)
  WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE type = 'traffic_spike' AND title LIKE '%Traffic Spike%');

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
`;

(async () => {
  const client = await pool.connect();
  try {
    await client.query(SQL);
    
    // Seed packages table (idempotent — skips existing tiers)
    const packages = [
      ['PreLITE', 'Basic', 0.99, 'USD', 'daily', 1440, 2, false, 2, 2],
      ['PreLITE PLUS', 'Power', 1.99, 'USD', 'daily', 1440, 5, false, 3, 3],
      ['PreLINK', 'Entry', 4.99, 'USD', 'weekly', 10080, 10, false, 3, 3],
      ['PreLINK PLUS', 'Power Pack', 9.99, 'USD', 'weekly', 10080, 20, false, 5, 5],
      ['PreBIZ', 'Standard', 19.99, 'USD', 'monthly', 43200, 45, false, 5, 5],
      ['PreMAX', 'Pro', 34.99, 'USD', 'monthly', 43200, 100, false, 10, 10],
      ['PreULTRA', 'True Unlimited', 44.99, 'USD', 'monthly', 43200, null, true, 15, 15],
      ['PreEXECUTIVE', 'VIP Unlimited', 59.99, 'USD', 'monthly', 43200, null, true, 30, 30],
    ];
    
    for (const pkg of packages) {
      await client.query(
        `INSERT INTO packages (tier_name, display_name, price_amount, price_currency, billing_period, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tier_name) DO NOTHING`,
        pkg
      );
    }
    
    console.log('Migration complete. Packages seeded.');
  } finally {
    client.release();
    await pool.end();
  }
})();
