-- v7: transparent payment-status tracking for POS + invoice intents.
--
-- failure_reason keeps the human explanation ("Declined by payer", "Payment
-- window expired", "Cancelled at the till") separate from the coarse
-- pending/completed/failed status, so the till can render an honest badge
-- instead of a generic failure.
--
-- last_checked_at + check_count throttle the live gateway reconciliation the
-- status poll performs; without them every 3-second poll would hit Pesepay.

ALTER TABLE pesepay_intents ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE pesepay_intents ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE pesepay_intents ADD COLUMN IF NOT EXISTS check_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pesepay_intents_pending
  ON pesepay_intents (created_at)
  WHERE status = 'pending';

-- Fast lookup of confirmed POS credits that were never attached to a sale
-- (browser closed mid-checkout). The till surfaces these so no money is lost.
CREATE INDEX IF NOT EXISTS idx_pesepay_intents_unapplied_pos
  ON pesepay_intents (tenant_id, completed_at)
  WHERE status = 'completed' AND target_id IS NULL;
