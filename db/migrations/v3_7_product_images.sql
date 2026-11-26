-- ============================================================================
-- v3_7_product_images.sql — real product photography on the till
--
-- `image_url` holds a same-origin /images/... path written by the POS upload
-- endpoint. Products without a photo fall back to the automatic icon resolver
-- in the POS client, so existing catalogues become visual immediately.
--
-- Idempotent: safe to re-run from `npm run migrate`.
-- ============================================================================

BEGIN;

ALTER TABLE pos_products
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMIT;
