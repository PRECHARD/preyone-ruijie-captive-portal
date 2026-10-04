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
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_password_token TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_password_expires_at TIMESTAMPTZ;

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

  -- ----- AP Devices (for Ruijie hardware monitoring) -----
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

  -- ----- Alerts / Notifications -----
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

  -- ----- MAC Blacklist / Whitelist -----
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

  -- ----- AP Bandwidth Snapshots (for real-time bandwidth monitor) -----
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

  -- ----- Gateway Heartbeats (EG105G-P health check tracking) -----
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

  -- Voucher approval requests (Staff -> Manager/CEO)
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

  -- Cash handovers (Staff -> Manager/CEO)
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

  -- ----- CEO-only features: Retention Policies -----
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

  -- ----- CEO-only features: Staff Commissions -----
  CREATE TABLE IF NOT EXISTS staff_commissions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id        UUID UNIQUE NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    commission_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
    updated_by      UUID REFERENCES admin_users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- ----- CEO-only features: Broadcast Notifications -----
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

  -- ----- CEO-only features: Branding -----
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

  -- ----- CEO-only features: Backup Logs -----
  CREATE TABLE IF NOT EXISTS backup_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name       TEXT NOT NULL,
    file_size       BIGINT,
    created_by      UUID REFERENCES admin_users(id),
    created_by_name TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- ----- CEO-only features: Report Schedules -----
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

  -- -----
  --  PREYONE POS SYSTEM (pos.preyone.com)
  --  Additive module: never touches portal/voucher/RADIUS tables.
  -- -----

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

  -- Pesepay rails are recorded individually so "By Payment Method" reports stay meaningful.
  -- Only rails Pesepay actually enables for this merchant are allowed; Zimswitch,
  -- Visa and Mastercard are rejected by the gateway for this account.
  ALTER TABLE pos_document_payments DROP CONSTRAINT IF EXISTS pos_document_payments_method_check;
  ALTER TABLE pos_document_payments ADD CONSTRAINT pos_document_payments_method_check
    CHECK (method IN ('cash', 'card', 'ecocash', 'innbucks', 'paygo', 'omari', 'bank', 'pesepay', 'other'));

  -- ----- Phase A: Provisioned company profile (single source of truth for receipts/notifications) -----
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

  -- Tenant slug for <slug>.preyone.com subdomain routing
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS slug TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_slug ON companies (slug) WHERE slug IS NOT NULL;
  UPDATE companies SET slug = lower(name) WHERE slug IS NULL;

  -- ----- Phase 2 (tenancy): staff + company module subscriptions -----
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_admin_users_company ON admin_users (company_id);

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    module     TEXT NOT NULL CHECK (module IN ('pos', 'invoice', 'wifi')),
    plan_tier  TEXT,
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, module)
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions (company_id);
  -- Seed every existing company with all three modules (idempotent)
  INSERT INTO subscriptions (company_id, module)
  SELECT c.id, m.module
  FROM companies c
  CROSS JOIN (VALUES ('pos'), ('invoice'), ('wifi')) AS m(module)
  WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.company_id = c.id AND s.module = m.module);
  UPDATE subscriptions SET plan_tier = 'enterprise' WHERE plan_tier IS NULL;

  -- ----- Pesepay gateway intents (invoices, POS shifts, subscriptions) -----
  -- Every Pesepay initiation is recorded here so the result-URL callback can apply
  -- the money to the correct record exactly once, keyed by our own reference.
  CREATE TABLE IF NOT EXISTS pesepay_intents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference           TEXT UNIQUE NOT NULL,
    provider_reference  TEXT,
    tenant_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency            TEXT NOT NULL CHECK (currency IN ('USD', 'ZiG')),
    payment_method      TEXT NOT NULL DEFAULT 'ecocash'
                        CHECK (payment_method IN ('ecocash', 'innbucks', 'paygo', 'omari')),
    purpose             TEXT NOT NULL,
    reason_for_payment  TEXT NOT NULL,
    target_type         TEXT NOT NULL
                        CHECK (target_type IN ('invoice', 'shift', 'subscription')),
    target_id           UUID,
    shift_id            UUID REFERENCES pos_shifts(id) ON DELETE SET NULL,
    subscription_module TEXT CHECK (subscription_module IN ('pos', 'invoice', 'wifi')),
    plan_tier           TEXT,
    redirect_url        TEXT,
    poll_url            TEXT,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'completed', 'failed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_pesepay_intents_ref     ON pesepay_intents (reference);
  CREATE INDEX IF NOT EXISTS idx_pesepay_intents_tenant  ON pesepay_intents (tenant_id);
  CREATE INDEX IF NOT EXISTS idx_pesepay_intents_status  ON pesepay_intents (status);
  CREATE INDEX IF NOT EXISTS idx_pesepay_intents_target  ON pesepay_intents (target_type, target_id);

  -- ----- Phase A: POS devices & endpoints (desktop / web / android) -----
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
`;

(async () => {
  const client = await pool.connect();
  try {
    await client.query(SQL);
    
    // Seed packages table (idempotent - skips existing tiers)
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

    // ----- Multi-tenant POS: scope shifts & documents to a company -----
    //
    // pos_shifts / pos_documents had no company linkage at all, so every POS
    // query was global: an authenticated admin of any company could read,
    // void or pay another company's documents by guessing a UUID (IDOR).
    //
    // companies.id is UUID, so company_id must be UUID too -- an INT column
    // cannot reference a UUID primary key.
    //
    // Adding the column as nullable first, backfilling, then setting NOT NULL
    // keeps this safe to run against a table that already holds rows.
    await client.query(`ALTER TABLE pos_shifts ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id)`);
    await client.query(`ALTER TABLE pos_documents ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id)`);

    // Backfill: existing rows belong to the oldest company. Guarded so this is
    // a no-op once every row is assigned.
    const { rows: defaultCo } = await client.query(`SELECT id FROM companies ORDER BY created_at ASC LIMIT 1`);
    if (defaultCo.length > 0) {
      const defaultCompanyId = defaultCo[0].id;
      await client.query(`UPDATE pos_shifts SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
      await client.query(`UPDATE pos_documents SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
      console.log(`Backfilled pos_shifts/pos_documents to default company ${defaultCompanyId}.`);
    } else {
      console.warn('No company row found; skipped POS company backfill (assign company_id before NOT NULL).');
    }

    // Only tighten to NOT NULL when nothing is left unassigned, so a fresh
    // install with zero companies still migrates cleanly.
    const { rows: orphanShifts } = await client.query(
      `SELECT count(*)::int AS n FROM pos_shifts WHERE company_id IS NULL`
    );
    const { rows: orphanDocs } = await client.query(
      `SELECT count(*)::int AS n FROM pos_documents WHERE company_id IS NULL`
    );
    if (orphanShifts[0].n === 0 && orphanDocs[0].n === 0) {
      await client.query(`ALTER TABLE pos_shifts ALTER COLUMN company_id SET NOT NULL`);
      await client.query(`ALTER TABLE pos_documents ALTER COLUMN company_id SET NOT NULL`);
    } else {
      console.warn(
        `Leaving pos company_id nullable: ${orphanShifts[0].n} shift(s), ${orphanDocs[0].n} document(s) unassigned.`
      );
    }

    // Every POS read is "documents of my company, by id", so the composite
    // index is what keeps those lookups from degrading into table scans.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_shifts_company_id ON pos_shifts (company_id, id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_documents_company_id ON pos_documents (company_id, id)`);

    console.log('Migration complete. Packages seeded. POS tenant scoping applied.');
  } finally {
    client.release();
    await pool.end();
  }
})();
