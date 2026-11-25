-- ============================================================================
-- v3_4_house_template.sql — Preyone Classic is house-only
--
--   * adds invoice_templates.is_house_only
--   * marks template 1 (Preyone Classic) as the house template
--   * moves every client tenant off the house template so tenants never see
--     (or select) the Preyone identity sheet
--
-- Idempotent: safe to run on every deploy.
-- ============================================================================

BEGIN;

ALTER TABLE invoice_templates
  ADD COLUMN IF NOT EXISTS is_house_only BOOLEAN NOT NULL DEFAULT FALSE;

-- The first-created company is the platform house tenant. Its template 1 is
-- the original Preyone Classic sheet and must never appear in a client list.
UPDATE invoice_templates
   SET is_house_only = (id IN (1, 20))
 WHERE id BETWEEN 1 AND 20;

-- Reassign any client still pointing at the house template. Template 2 is the
-- first public design; clients that already have a non-house template are left
-- untouched.
UPDATE companies c
   SET invoice_template_id = 2
 WHERE c.invoice_template_id = 1
   AND c.id <> (SELECT id FROM companies ORDER BY created_at ASC LIMIT 1)
   AND EXISTS (SELECT 1 FROM invoice_templates WHERE id = 2 AND is_active);

COMMIT;
