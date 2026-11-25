-- ============================================================================
-- v3_6_shift_close_receipts.sql — immutable shift-close proof
--
-- A closed shift keeps the exact cash-up snapshot plus the recipients the
-- emailed proof was sent to. Reports and staff history can read this without
-- recomputing anything from live payments.
-- ============================================================================

BEGIN;

ALTER TABLE pos_shifts
  ADD COLUMN IF NOT EXISTS close_snapshot JSONB;
ALTER TABLE pos_shifts
  ADD COLUMN IF NOT EXISTS close_receipt_recipients TEXT[];
ALTER TABLE pos_shifts
  ADD COLUMN IF NOT EXISTS close_receipt_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pos_shifts_company_closed
  ON pos_shifts (company_id, closed_at DESC);

COMMIT;
