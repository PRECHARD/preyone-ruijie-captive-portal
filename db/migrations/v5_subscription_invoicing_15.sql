-- v5: $15 plan (3 devices, POS + Invoice).
--
-- Production first shipped this tier as plan_type invoicing_15. The canonical
-- id is pos_invoice_15 (display name PreBiz), shared with v4_plan_entitlements.
-- This file is safe whether or not the older invoicing_15 constraint already
-- ran: it widens the check, renames any invoicing_15 rows, then tightens the
-- check to the canonical ids. Re-running it is a no-op after the rename.

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_plan_type_check;
ALTER TABLE companies ADD CONSTRAINT companies_plan_type_check
  CHECK (plan_type IN ('standard_10', 'invoicing_15', 'pos_invoice_15', 'growth_20', 'unlimited_30'));

UPDATE companies SET plan_type = 'pos_invoice_15' WHERE plan_type = 'invoicing_15';

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_plan_type_check;
ALTER TABLE companies ADD CONSTRAINT companies_plan_type_check
  CHECK (plan_type IN ('standard_10', 'pos_invoice_15', 'growth_20', 'unlimited_30'));

CREATE OR REPLACE FUNCTION update_company_device_limit() RETURNS TRIGGER AS $$
BEGIN
  NEW.max_devices := CASE NEW.plan_type
    WHEN 'standard_10'    THEN 1
    WHEN 'invoicing_15'   THEN 3
    WHEN 'pos_invoice_15' THEN 3
    WHEN 'growth_20'      THEN 6
    WHEN 'unlimited_30'   THEN 9999
    ELSE COALESCE(NEW.max_devices, 1)
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_company_device_limit ON companies;
CREATE TRIGGER update_company_device_limit
  BEFORE INSERT OR UPDATE OF plan_type ON companies
  FOR EACH ROW EXECUTE FUNCTION update_company_device_limit();
