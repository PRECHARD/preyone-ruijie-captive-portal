-- ============================================================================
-- v6_company_accounts.sql — stable accounting number for every company
--
-- Provisioned tenants need a human-readable account number for receipts,
-- accounting exports and support. A database sequence/default guarantees one
-- for *every* company row — provisioning, house seed or manual inserts — not
-- just the one route that happens to create tenants today.
--
-- Format: PRY-001001, PRY-001002, … (sequential, unique, never reused).
-- Idempotent: safe to re-run from `npm run migrate`.
-- ============================================================================

BEGIN;

CREATE SEQUENCE IF NOT EXISTS company_account_number_seq START WITH 1001 INCREMENT BY 1;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_number TEXT;

-- Backfill existing companies oldest-first so the numbers follow registration
-- order. Only NULL rows consume a sequence value, so re-runs are no-ops.
UPDATE companies
   SET account_number = 'PRY-' || lpad(nextval('company_account_number_seq')::text, 6, '0')
 WHERE account_number IS NULL;

ALTER TABLE companies
  ALTER COLUMN account_number SET DEFAULT 'PRY-' || lpad(nextval('company_account_number_seq')::text, 6, '0');
ALTER TABLE companies ALTER COLUMN account_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_account_number
  ON companies (account_number);

-- Client billing details captured before an online plan payment. Stored on the
-- intent so the settlement webhook can email the customer the receipt and
-- invoice even when the payment completes after the browser has closed.
ALTER TABLE pesepay_intents ADD COLUMN IF NOT EXISTS client_name TEXT;
ALTER TABLE pesepay_intents ADD COLUMN IF NOT EXISTS client_email TEXT;
ALTER TABLE pesepay_intents ADD COLUMN IF NOT EXISTS client_phone TEXT;
ALTER TABLE pesepay_intents ADD COLUMN IF NOT EXISTS invoice_number TEXT;

COMMIT;
