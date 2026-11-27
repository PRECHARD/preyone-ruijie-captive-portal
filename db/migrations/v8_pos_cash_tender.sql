-- v8: preserve the cash actually handed over and the change given.
--
-- `amount` remains the value applied to the document (and the ledger). The new
-- columns are additive audit/receipt fields, so a tender of $20 against a $10
-- sale stores amount = 10, cash_tendered = 20 and change_amount = 10. Old
-- payment rows keep NULL values and continue to print exactly as before.

ALTER TABLE pos_document_payments
  ADD COLUMN IF NOT EXISTS cash_tendered NUMERIC(12,2);

ALTER TABLE pos_document_payments
  ADD COLUMN IF NOT EXISTS change_amount NUMERIC(12,2);

ALTER TABLE pos_document_payments
  DROP CONSTRAINT IF EXISTS pos_document_payments_cash_tendered_check;
ALTER TABLE pos_document_payments
  ADD CONSTRAINT pos_document_payments_cash_tendered_check
  CHECK (
    cash_tendered IS NULL
    OR (cash_tendered >= amount AND change_amount >= 0)
  );
