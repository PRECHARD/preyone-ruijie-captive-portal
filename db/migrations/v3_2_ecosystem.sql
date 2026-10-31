-- ============================================================================
-- v3_2_ecosystem.sql — v3.2.0 "master ecosystem" add-ons
--
-- Purely additive and idempotent: `npm run migrate` runs this against a live
-- database that may already contain some of these objects.
--
-- Adds the persistence behind four shipped surfaces:
--
--   * Invoicing workspace   — per-document currency, FX rate, template and
--                             structured metadata; companies.logo_url already
--                             exists from v3_master_ecosystem.sql.
--   * POS module toggles    — kds_enabled / table_service_enabled so a merchant
--                             can turn QSR routing and the floor plan on without
--                             changing their whole business profile.
--   * Hardware security     — pos_devices.fingerprint_hash (hardware-bound
--                             token) and lease_expires_at (7-day offline lease).
--   * Home automation       — iot_devices, iot_telemetry, iot_triggers and the
--                             immutable iot_events audit trail.
-- ============================================================================

-- ── 1. Invoicing workspace ────────────────────────────────────────────────
ALTER TABLE pos_documents ADD COLUMN IF NOT EXISTS currency       TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE pos_documents ADD COLUMN IF NOT EXISTS exchange_rate  NUMERIC(14,6) NOT NULL DEFAULT 1;
ALTER TABLE pos_documents ADD COLUMN IF NOT EXISTS template_id    INTEGER REFERENCES invoice_templates(id) ON DELETE SET NULL;
ALTER TABLE pos_documents ADD COLUMN IF NOT EXISTS doc_meta       JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pos_documents ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;
ALTER TABLE pos_documents ADD COLUMN IF NOT EXISTS sent_at        TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pos_documents_currency ON pos_documents (currency);
CREATE INDEX IF NOT EXISTS idx_pos_documents_due      ON pos_documents (due_date) WHERE status IN ('unpaid', 'partial');

-- Document-level audit trail: every status transition, void, send and payment
-- gets a row. Append-only by convention (no UPDATE/DELETE paths in the app).
CREATE TABLE IF NOT EXISTS pos_document_events (
  id           BIGSERIAL PRIMARY KEY,
  document_id  UUID NOT NULL REFERENCES pos_documents(id) ON DELETE CASCADE,
  company_id   UUID REFERENCES companies(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id     UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_document_events_doc ON pos_document_events (document_id, created_at DESC);

-- ── 2. POS module toggles ─────────────────────────────────────────────────
-- Business profile still sets the DEFAULT, but these booleans let a merchant
-- enable QSR KDS routing or the dine-in floor plan independently.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS kds_enabled            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS table_service_enabled  BOOLEAN NOT NULL DEFAULT FALSE;

-- Free-form settings blobs for the Global Settings Hub tabs (POS hardware
-- layout, invoicing/tax defaults). JSONB keeps forward-compatible extras
-- without a migration per toggle.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pos_settings      JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_settings  JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE companies SET kds_enabled = TRUE
 WHERE business_profile IN ('fast_food_qsr') AND kds_enabled = FALSE;
UPDATE companies SET table_service_enabled = TRUE
 WHERE business_profile IN ('restaurant_dine_in') AND table_service_enabled = FALSE;

-- ── 3. Hardware-bound device tokens + offline lease ───────────────────────
-- fingerprint_hash: SHA-256 of the machine fingerprint presented at enrolment.
-- A stolen token replayed from another machine fails the hash check.
-- lease_expires_at: last lease mint meant for OFFLINE use. The server refuses
-- to extend a lease for a device that has not checked in inside the window.
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS fingerprint_hash  TEXT;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS lease_expires_at  TIMESTAMPTZ;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS lease_days        INTEGER NOT NULL DEFAULT 7;
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS enrolled_at       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pos_devices_fingerprint ON pos_devices (fingerprint_hash) WHERE fingerprint_hash IS NOT NULL;

-- ── 4. Home automation ────────────────────────────────────────────────────
-- One row per controllable thing. `kind` drives the card renderer:
--   switch | dimmer | sensor | thermostat | camera | gateway | meter | lock
-- `transport` records how telemetry arrives: mqtt (bridge), http (device
-- push), starlink (Ruijie/Starlink gateway poll) or manual.
CREATE TABLE IF NOT EXISTS iot_devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'switch'
                 CHECK (kind IN ('switch', 'dimmer', 'sensor', 'thermostat', 'camera', 'gateway', 'meter', 'lock')),
  room           TEXT,
  transport      TEXT NOT NULL DEFAULT 'http'
                 CHECK (transport IN ('mqtt', 'http', 'starlink', 'manual')),
  vendor         TEXT,
  model          TEXT,
  external_id    TEXT,
  online         BOOLEAN NOT NULL DEFAULT FALSE,
  state          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_iot_devices_company ON iot_devices (company_id, name);

-- Rolling telemetry. `metric` keeps the schema open (power_w, kwh, temp_c,
-- uptime_pct, signal_dbm…) without a column per sensor type.
CREATE TABLE IF NOT EXISTS iot_telemetry (
  id          BIGSERIAL PRIMARY KEY,
  device_id   UUID NOT NULL REFERENCES iot_devices(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  metric      TEXT NOT NULL,
  value       NUMERIC(18,4) NOT NULL,
  unit        TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_iot_telemetry_device ON iot_telemetry (device_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_iot_telemetry_metric ON iot_telemetry (company_id, metric, recorded_at DESC);

-- Automation rules: when `metric` crosses `threshold` for a device, fire the
-- action. Actions are intentionally simple (webhook / set state) so the runner
-- stays auditable.
CREATE TABLE IF NOT EXISTS iot_triggers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id       UUID NOT NULL REFERENCES iot_devices(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  metric          TEXT NOT NULL,
  operator        TEXT NOT NULL DEFAULT '>'
                  CHECK (operator IN ('>', '>=', '<', '<=', '==', '!=')),
  threshold       NUMERIC(18,4) NOT NULL,
  action          TEXT NOT NULL DEFAULT 'notify'
                  CHECK (action IN ('notify', 'webhook', 'set_state')),
  action_payload  JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_iot_triggers_device ON iot_triggers (device_id) WHERE enabled;

-- Append-only audit trail for device commands, trigger firings and enrolment.
CREATE TABLE IF NOT EXISTS iot_events (
  id          BIGSERIAL PRIMARY KEY,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id   UUID REFERENCES iot_devices(id) ON DELETE SET NULL,
  event       TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_iot_events_company ON iot_events (company_id, created_at DESC);

-- StarLink gateway uptime samples. Kept separate from iot_telemetry because the
-- dashboard renders a continuous uptime meter for the gateway specifically and
-- must survive telemetry pruning.
CREATE TABLE IF NOT EXISTS starlink_uptime_samples (
  id            BIGSERIAL PRIMARY KEY,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id     UUID REFERENCES iot_devices(id) ON DELETE SET NULL,
  online        BOOLEAN NOT NULL DEFAULT TRUE,
  latency_ms    INTEGER,
  down_mbps     NUMERIC(10,2),
  up_mbps       NUMERIC(10,2),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_starlink_uptime_company ON starlink_uptime_samples (company_id, recorded_at DESC);
