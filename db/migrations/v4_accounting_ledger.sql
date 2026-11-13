-- Preyone enterprise accounting ledger + stock_applied flag (idempotent).
-- Applied via src/db/migrate.ts when present.

ALTER TABLE pos_documents
  ADD COLUMN IF NOT EXISTS stock_applied BOOLEAN NOT NULL DEFAULT FALSE;

-- Till and online checkout decrement stock while writing the lines, so those
-- rows are already applied. Office checkout can do the same and sets the flag
-- itself. This file runs on every migrate, so it must not flag unpaid office
-- drafts and must not clear a flag the checkout path already set.
UPDATE pos_documents d
   SET stock_applied = TRUE
 WHERE stock_applied = FALSE
   AND d.channel IN ('till', 'online')
   AND EXISTS (
     SELECT 1 FROM pos_document_items i
      WHERE i.document_id = d.id AND i.product_id IS NOT NULL
   );

CREATE TABLE IF NOT EXISTS accounting_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_type      TEXT NOT NULL
                  CHECK (entry_type IN (
                    'pos_sale', 'invoice_payment', 'credit_note',
                    'expense', 'stock_adjustment', 'pesepay_collection'
                  )),
  rail            TEXT NOT NULL DEFAULT 'cash'
                  CHECK (rail IN (
                    'cash', 'card', 'ecocash', 'innbucks', 'paygo',
                    'omari', 'bank', 'pesepay', 'other'
                  )),
  document_id     UUID REFERENCES pos_documents(id) ON DELETE SET NULL,
  payment_id      BIGINT,
  reference       TEXT,
  description     TEXT,
  gross_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  cogs_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'USD',
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_accounting_ledger_company_time
  ON accounting_ledger (company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounting_ledger_type
  ON accounting_ledger (company_id, entry_type);
CREATE INDEX IF NOT EXISTS idx_accounting_ledger_rail
  ON accounting_ledger (company_id, rail);
CREATE INDEX IF NOT EXISTS idx_accounting_ledger_document
  ON accounting_ledger (document_id);

-- Expand payment method check to cover Pesepay mobile rails used at the till.
DO $$
BEGIN
  ALTER TABLE pos_document_payments DROP CONSTRAINT IF EXISTS pos_document_payments_method_check;
  ALTER TABLE pos_document_payments
    ADD CONSTRAINT pos_document_payments_method_check
    CHECK (method IN (
      'cash', 'card', 'ecocash', 'innbucks', 'paygo', 'omari', 'bank', 'pesepay', 'other'
    ));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'pos_document_payments method check skipped: %', SQLERRM;
END $$;
