-- v5: add invoicing_15 ($15/mo, 3 devices) to companies.plan_type
-- Idempotent — safe to re-run via npm run migrate.

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_plan_type_check;

ALTER TABLE companies ADD CONSTRAINT companies_plan_type_check
  CHECK (plan_type IN ('standard_10', 'invoicing_15', 'growth_20', 'unlimited_30'));

CREATE OR REPLACE FUNCTION update_company_device_limit() RETURNS TRIGGER AS $$
BEGIN
  NEW.max_devices := CASE NEW.plan_type
    WHEN 'standard_10'   THEN 1
    WHEN 'invoicing_15'  THEN 3
    WHEN 'growth_20'     THEN 6
    WHEN 'unlimited_30'  THEN 9999
    ELSE COALESCE(NEW.max_devices, 1)
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
