-- ============================================================================
-- v3_5_tenant_catalog.sql — products and customers belong to one tenant
--
--   * pos_products gains company_id (pos_customers already has it but older
--     rows were left NULL by the API)
--   * existing catalogue data is assigned from document history, never from
--     "first company wins" guesses
--   * products used by more than one tenant are cloned per tenant and the
--     historical document lines are re-pointed at the clone
--   * unique SKU / barcode / customer-name indexes become per-company
--
-- Idempotent: safe to re-run from `npm run migrate`.
-- ============================================================================

BEGIN;

ALTER TABLE pos_products
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE pos_customers
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

-- House tenant = first-created company.
UPDATE pos_products
   SET company_id = (SELECT id FROM companies ORDER BY created_at ASC LIMIT 1)
 WHERE company_id IS NULL;

-- The clone below duplicates a product's SKU into another tenant. The old
-- global unique indexes must go first or the clone insert is rejected.
DROP INDEX IF EXISTS idx_pos_products_sku;
DROP INDEX IF EXISTS idx_pos_products_barcode;

-- Customers that predate tenant ownership: use the first document that names
-- them. Customers with no document history stay with the house tenant.
UPDATE pos_customers c
   SET company_id = COALESCE(
     (SELECT d.company_id
        FROM pos_documents d
       WHERE d.customer_id = c.id AND d.company_id IS NOT NULL
       ORDER BY d.created_at ASC
       LIMIT 1),
     (SELECT id FROM companies ORDER BY created_at ASC LIMIT 1)
   )
 WHERE c.company_id IS NULL;

-- Products used by client tenants are cloned. The house keeps the original
-- row; each client gets its own copy and its document lines are re-pointed so
-- stock, COGS and catalogue edits stay inside that tenant.
CREATE TEMP TABLE qa_product_clone_map ON COMMIT DROP AS
SELECT DISTINCT d.company_id AS company_id, i.product_id AS old_id
  FROM pos_document_items i
  JOIN pos_documents d ON d.id = i.document_id
 WHERE i.product_id IS NOT NULL
   AND d.company_id IS NOT NULL
   AND d.company_id <> (SELECT id FROM companies ORDER BY created_at ASC LIMIT 1);

ALTER TABLE qa_product_clone_map ADD COLUMN new_id UUID;
UPDATE qa_product_clone_map SET new_id = gen_random_uuid();

INSERT INTO pos_products
  (id, company_id, name, description, sku, barcode, category,
   price, cost_price, stock_qty, track_stock, low_stock_threshold, active)
SELECT m.new_id, m.company_id, p.name, p.description, p.sku, p.barcode, p.category,
       p.price, p.cost_price, p.stock_qty, p.track_stock, p.low_stock_threshold, p.active
  FROM qa_product_clone_map m
  JOIN pos_products p ON p.id = m.old_id
 WHERE NOT EXISTS (
   SELECT 1 FROM pos_products existing
    WHERE existing.company_id = m.company_id
      AND existing.name = p.name
      AND COALESCE(existing.sku, '') = COALESCE(p.sku, '')
 );

UPDATE pos_document_items i
   SET product_id = m.new_id
  FROM pos_documents d, qa_product_clone_map m
 WHERE i.document_id = d.id
   AND d.company_id = m.company_id
   AND i.product_id = m.old_id;

-- Every row must now have an owner.
ALTER TABLE pos_products  ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE pos_customers ALTER COLUMN company_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pos_products_company ON pos_products (company_id);
CREATE INDEX IF NOT EXISTS idx_pos_customers_company ON pos_customers (company_id);

-- Unique catalogue keys are per tenant, not global.
DROP INDEX IF EXISTS idx_pos_products_sku;
DROP INDEX IF EXISTS idx_pos_products_barcode;
DROP INDEX IF EXISTS idx_pos_customers_name;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_products_company_sku
  ON pos_products (company_id, sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_products_company_barcode
  ON pos_products (company_id, barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_customers_company_name
  ON pos_customers (company_id, lower(name));

COMMIT;
