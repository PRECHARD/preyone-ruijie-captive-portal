-- ============================================================================
-- v4_plan_entitlements.sql — one plan decides POS and Invoice access
--
--   PreTill       standard_10      $10/month  POS only            1 device
--   PreBiz        pos_invoice_15   $15/month  POS + Invoice       3 devices
--   PrePro        growth_20        $20/month  POS + Invoice       6 devices
--   PreUnlimited  unlimited_30     $30/month  POS + Invoice       9999 devices
--
-- companies.plan_type is the source of truth. This file:
--   * lets the new $15 id through the CHECK constraint
--   * teaches the device-cap trigger about 3 devices
--   * creates `subscriptions` if a fresh database does not have it
--   * rewrites only the pos and invoice rows so they match plan_type
--
-- Existing plan_type values are not changed. A company already on
-- unlimited_30 (the v2 grandfather for rows that had no plan) keeps
-- POS and Invoice. Wifi subscription rows are not touched.
--
-- Idempotent: safe to re-run from `npm run migrate`.
-- ============================================================================

-- ── 1. Accept both $15 ids, then keep only pos_invoice_15 (PreBiz) ─────────
-- A database that already ran the first v5 file may store invoicing_15.
-- The CHECK cannot drop that value until those rows are renamed.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_plan_type_check;
ALTER TABLE companies ADD CONSTRAINT companies_plan_type_check
  CHECK (plan_type IN ('standard_10', 'invoicing_15', 'pos_invoice_15', 'growth_20', 'unlimited_30'));

UPDATE companies SET plan_type = 'pos_invoice_15' WHERE plan_type = 'invoicing_15';

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_plan_type_check;
ALTER TABLE companies ADD CONSTRAINT companies_plan_type_check
  CHECK (plan_type IN ('standard_10', 'pos_invoice_15', 'growth_20', 'unlimited_30'));

-- ── 2. Device cap follows the plan (3 devices on PreBiz) ────────────────────
CREATE OR REPLACE FUNCTION update_company_device_limit() RETURNS TRIGGER AS $$
BEGIN
  NEW.max_devices := CASE NEW.plan_type
    WHEN 'standard_10'     THEN 1
    WHEN 'invoicing_15'    THEN 3
    WHEN 'pos_invoice_15'  THEN 3
    WHEN 'growth_20'       THEN 6
    WHEN 'unlimited_30'    THEN 9999
    ELSE COALESCE(NEW.max_devices, 1)
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_company_device_limit ON companies;
CREATE TRIGGER update_company_device_limit
  BEFORE INSERT OR UPDATE OF plan_type ON companies
  FOR EACH ROW EXECUTE FUNCTION update_company_device_limit();

-- Companies created before this trigger knew about pos_invoice_15 keep the
-- cap they already have. Only rows already on the new id are aligned, which
-- is a no-op until somebody buys PreBiz.
UPDATE companies
   SET max_devices = 3
 WHERE plan_type = 'pos_invoice_15'
   AND max_devices IS DISTINCT FROM 3;

-- ── 3. subscriptions table (fresh databases; production already has it) ────
CREATE TABLE IF NOT EXISTS subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module      TEXT NOT NULL CHECK (module IN ('pos', 'invoice', 'wifi')),
  plan_tier   TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, module)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_company_module_key ON subscriptions (company_id, module);

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_tier TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── 4. pos + invoice rows follow plan_type. Wifi is left as it is. ─────────
INSERT INTO subscriptions (company_id, module, plan_tier, status)
SELECT c.id, 'pos', c.plan_type, 'active'
  FROM companies c
ON CONFLICT (company_id, module) DO UPDATE
  SET status = 'active',
      plan_tier = EXCLUDED.plan_tier,
      updated_at = NOW();

INSERT INTO subscriptions (company_id, module, plan_tier, status)
SELECT c.id,
       'invoice',
       c.plan_type,
       CASE WHEN c.plan_type = 'standard_10' THEN 'suspended' ELSE 'active' END
  FROM companies c
ON CONFLICT (company_id, module) DO UPDATE
  SET status = EXCLUDED.status,
      plan_tier = EXCLUDED.plan_tier,
      updated_at = NOW();

-- ── 5. Desktop shells register as device_type electron ──────────────────────
ALTER TABLE pos_devices DROP CONSTRAINT IF EXISTS pos_devices_device_type_check;
ALTER TABLE pos_devices ADD CONSTRAINT pos_devices_device_type_check
  CHECK (device_type IN ('desktop', 'web', 'android', 'phone', 'tablet', 'electron'));
