-- ============================================================================
-- v2_master_upgrade.sql — 3-tier SaaS subscription engine
--
--   Standard  $10/month -> 1 device
--   Growth    $20/month -> 6 devices
--   Unlimited $30/month -> 9999 devices (effectively uncapped)
--
-- Adds the plan / billing columns to `companies`, backfills companies that
-- already exist so NO live tenant is capped or suspended by this migration,
-- and installs the trigger that keeps `max_devices` in step with `plan_type`.
--
-- Every statement below is idempotent: this file is executed by
-- `npm run migrate` (src/db/migrate.ts) and may run against a live database
-- that already has some of these objects. It is additive — no existing column,
-- row or constraint is dropped or rewritten beyond the NULL backfill.
-- ============================================================================

-- ── 1. Plan / billing columns ───────────────────────────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_type              TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_devices             INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_status     TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS reminder_3day_sent      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS reminder_1day_sent      BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. CHECK constraints (idempotent: skip when already present) ───────────
DO $$ BEGIN
  ALTER TABLE companies ADD CONSTRAINT companies_plan_type_check
    CHECK (plan_type IN ('standard_10', 'growth_20', 'unlimited_30'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE companies ADD CONSTRAINT companies_subscription_status_check
    CHECK (subscription_status IS NULL
           OR subscription_status IN ('active', 'trial', 'past_due', 'suspended', 'expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE companies ADD CONSTRAINT companies_max_devices_check
    CHECK (max_devices IS NULL OR max_devices > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. Backfill (only rows that predate this migration: plan_type IS NULL) ──
-- Grandfather existing companies onto the Unlimited tier. They were operating
-- without any device cap before tiering existed, so the first deploy of the
-- subscription engine must not lock a live customer out of registering a
-- device. New companies (post-backfill) fall through to the DEFAULT below and
-- start on Standard. Subscription_status NULL -> active, and
-- subscription_expires_at stays NULL: no expiry recorded means no expiry
-- enforced (the dunning cron only ever looks at rows with an expiry date).
UPDATE companies SET plan_type = 'unlimited_30'         WHERE plan_type IS NULL;
UPDATE companies SET max_devices = 9999                  WHERE max_devices IS NULL;
UPDATE companies SET subscription_status = 'active'      WHERE subscription_status IS NULL;

-- ── 4. Defaults for companies created from now on ───────────────────────────
ALTER TABLE companies ALTER COLUMN plan_type              SET DEFAULT 'standard_10';
ALTER TABLE companies ALTER COLUMN plan_type              SET NOT NULL;
ALTER TABLE companies ALTER COLUMN max_devices             SET DEFAULT 1;
ALTER TABLE companies ALTER COLUMN max_devices             SET NOT NULL;
ALTER TABLE companies ALTER COLUMN subscription_status     SET DEFAULT 'active';
ALTER TABLE companies ALTER COLUMN subscription_status     SET NOT NULL;

-- ── 5. Trigger: max_devices follows plan_type ───────────────────────────────
-- update_company_device_limit() runs BEFORE INSERT and BEFORE UPDATE OF
-- plan_type, so assigning a tier (or changing it) rewrites the device cap in
-- the same statement. Updates that don't touch plan_type leave max_devices
-- alone. CREATE OR REPLACE + DROP TRIGGER IF EXISTS keep re-runs idempotent.
CREATE OR REPLACE FUNCTION update_company_device_limit() RETURNS TRIGGER AS $$
BEGIN
  NEW.max_devices := CASE NEW.plan_type
    WHEN 'standard_10'  THEN 1
    WHEN 'growth_20'    THEN 6
    WHEN 'unlimited_30' THEN 9999
    ELSE COALESCE(NEW.max_devices, 1)
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_company_device_limit ON companies;
CREATE TRIGGER update_company_device_limit
  BEFORE INSERT OR UPDATE OF plan_type ON companies
  FOR EACH ROW EXECUTE FUNCTION update_company_device_limit();
