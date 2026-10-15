-- ============================================================================
-- v3_master_ecosystem.sql — industry profiles, invoice templates, POS themes
--
-- Builds on v2_master_upgrade.sql (3-tier plan / billing / device caps). This
-- migration adds the "presentation" layer of the multi-tenant ecosystem:
--
--   * companies.business_profile     — industry hint driving default copy and
--                                      layout (retail, QSR, dine-in restaurant…)
--   * companies.invoice_template_id  — which of the 20 PDF invoice layouts a
--                                      tenant's documents render with
--   * companies.pos_theme_id         — which of the 20 POS colour palettes the
--                                      till applies
--   * companies.logo_url             — tenant branding logo
--   * invoice_templates / pos_themes — the 20-row reference catalogues above
--
-- Re-asserts the update_company_device_limit() trigger from v2 so a database
-- that somehow missed it is repaired here too (idempotent CREATE OR REPLACE).
--
-- Every statement is idempotent: this file is executed by `npm run migrate`
-- (src/db/migrate.ts) and may run against a live database that already has
-- some of these objects. It is purely additive — no existing column, row or
-- constraint is dropped.
-- ============================================================================

-- ── 1. Reference catalogues ────────────────────────────────────────────────
-- 20 professional invoice/PDF layouts. `layout` is a coarse renderer hint
-- (standard grid, compact receipt, minimal…) and `accent_color` themes the
-- header/footer rules. Immutable seed: ids 1-20 are the stable contract that
-- companies.invoice_template_id points at.
CREATE TABLE IF NOT EXISTS invoice_templates (
  id           INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 20),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  layout       TEXT NOT NULL DEFAULT 'standard',
  accent_color TEXT NOT NULL DEFAULT '#0f766e',
  show_logo    BOOLEAN NOT NULL DEFAULT TRUE,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO invoice_templates (id, name, description, layout, accent_color, show_logo) VALUES
  (1,  'Classic Business',   'Traditional two-column invoice with ruled totals.',      'standard', '#0f766e', TRUE),
  (2,  'Modern Minimal',     'Airy single-column layout, generous whitespace.',        'minimal',  '#2563eb', TRUE),
  (3,  'Corporate Elegant',  'Serif headings and a banded subtotal block.',            'standard', '#1e293b', TRUE),
  (4,  'Compact Receipt',    'Thermal-friendly narrow layout for small paper.',        'compact',  '#334155', FALSE),
  (5,  'Bold Header',        'Full-bleed coloured masthead with white text.',          'standard', '#7c3aed', TRUE),
  (6,  'Gradient Accent',    'Soft gradient rule under the company header.',           'standard', '#db2777', TRUE),
  (7,  'Monochrome Pro',     'Strict black-and-white, print-ink efficient.',           'standard', '#000000', TRUE),
  (8,  'Vintage Ledger',     'Warm paper tone with double-rule borders.',              'standard', '#92400e', TRUE),
  (9,  'Neon Digital',       'High-contrast dark theme for screen sharing.',           'minimal',  '#06b6d4', TRUE),
  (10, 'Studio Creative',    'Asymmetric grid for agencies and studios.',              'standard', '#f97316', TRUE),
  (11, 'Executive Gold',     'Gold accent line, formal executive styling.',            'standard', '#b45309', TRUE),
  (12, 'Fresh Startup',      'Rounded cards and a friendly tone.',                     'minimal',  '#10b981', TRUE),
  (13, 'Legal Formal',       'Dense, numbered-clause friendly layout.',                'standard', '#1e3a8a', TRUE),
  (14, 'Hospitality Warm',   'Inviting palette for hotels and eateries.',              'standard', '#c2410c', TRUE),
  (15, 'Retail Bright',      'Colourful item grid for shopfront receipts.',            'standard', '#e11d48', TRUE),
  (16, 'Tech Sleek',         'Cool grays and a monospace totals block.',               'standard', '#334155', TRUE),
  (17, 'Eco Green',          'Natural greens with a leaf mark placeholder.',           'standard', '#15803d', TRUE),
  (18, 'Luxury Black',       'Matte black header with foil-gold totals.',              'standard', '#111827', TRUE),
  (19, 'Friendly Rounded',   'Soft corners and pastel section fills.',                 'minimal',  '#8b5cf6', TRUE),
  (20, 'Preyone Signature',  'House style — brand teal with the Preyone wordmark.',    'standard', '#0d9488', TRUE)
ON CONFLICT (id) DO NOTHING;

-- 20 POS colour palettes. The till reads these by companies.pos_theme_id and
-- maps the hex values onto its CSS custom properties.
CREATE TABLE IF NOT EXISTS pos_themes (
  id             INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 20),
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  primary_color  TEXT NOT NULL DEFAULT '#0d9488',
  secondary_color TEXT NOT NULL DEFAULT '#134e4a',
  accent_color   TEXT NOT NULL DEFAULT '#14b8a6',
  bg_color       TEXT NOT NULL DEFAULT '#0f172a',
  text_color     TEXT NOT NULL DEFAULT '#f8fafc',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO pos_themes (id, name, description, primary_color, secondary_color, accent_color, bg_color, text_color) VALUES
  (1,  'Preyone Dark',    'House dark theme with brand teal accents.',  '#0d9488', '#134e4a', '#14b8a6', '#0f172a', '#f8fafc'),
  (2,  'Ocean Blue',      'Deep navy with bright cyan highlights.',     '#0ea5e9', '#0c4a6e', '#38bdf8', '#082f49', '#f0f9ff'),
  (3,  'Forest Green',    'Earthy greens for grocers and markets.',     '#16a34a', '#14532d', '#4ade80', '#052e16', '#f7fee7'),
  (4,  'Sunset Orange',   'Warm orange for cafes and QSR.',            '#ea580c', '#7c2d12', '#fb923c', '#431407', '#fff7ed'),
  (5,  'Royal Purple',    'Rich purple with violet accents.',           '#9333ea', '#4c1d95', '#c084fc', '#2e1065', '#faf5ff'),
  (6,  'Crimson Red',     'Bold red for high-energy retail.',           '#dc2626', '#7f1d1d', '#f87171', '#450a0a', '#fef2f2'),
  (7,  'Slate Gray',      'Neutral professional slate.',                '#475569', '#1e293b', '#94a3b8', '#0f172a', '#f1f5f9'),
  (8,  'Teal Wave',       'Fresh teal with sea-glass accents.',         '#14b8a6', '#115e59', '#5eead4', '#042f2e', '#f0fdfa'),
  (9,  'Golden Hour',     'Amber and honey tones.',                     '#f59e0b', '#78350f', '#fbbf24', '#451a03', '#fffbeb'),
  (10, 'Midnight',        'Near-black with electric blue.',             '#3b82f6', '#1e3a8a', '#60a5fa', '#020617', '#e0f2fe'),
  (11, 'Coral Punch',     'Playful coral for boutiques.',               '#f43f5e', '#881337', '#fb7185', '#4c0519', '#fff1f2'),
  (12, 'Mint Fresh',      'Light mint, easy on the eyes.',              '#10b981', '#065f46', '#6ee7b7', '#022c22', '#ecfdf5'),
  (13, 'Indigo Night',    'Deep indigo with periwinkle.',               '#6366f1', '#312e81', '#a5b4fc', '#1e1b4b', '#eef2ff'),
  (14, 'Amber Glow',      'Golden amber on dark umber.',                '#d97706', '#78350f', '#fcd34d', '#451a03', '#fffbeb'),
  (15, 'Rose Quartz',     'Soft rose with blush accents.',              '#e11d48', '#881337', '#fda4af', '#4c0519', '#fff1f2'),
  (16, 'Carbon',          'True carbon gray, ultra-minimal.',           '#374151', '#111827', '#9ca3af', '#030712', '#f9fafb'),
  (17, 'Sky Light',       'Bright daytime sky palette.',                '#0284c7', '#075985', '#7dd3fc', '#e0f2fe', '#0c4a6e'),
  (18, 'Emerald',         'Classic emerald for finance and sales.',     '#059669', '#064e3b', '#34d399', '#022c22', '#ecfdf5'),
  (19, 'Fusion Magenta',  'Vivid magenta for creative retail.',         '#d946ef', '#701a75', '#e879f9', '#3b0764', '#fdf4ff'),
  (20, 'Classic Light',   'Clean white with slate text and teal link.', '#0f766e', '#134e4a', '#14b8a6', '#f8fafc', '#0f172a')
ON CONFLICT (id) DO NOTHING;

-- ── 2. companies presentation columns ──────────────────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_profile     TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_template_id  INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pos_theme_id         INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url             TEXT;

-- JSONB config blobs so the Global Settings Hub hardware / invoicing tabs
-- persist without one column per field. pos_hardware: printer pairing, cash
-- drawer kick, barcode scanner. invoice_settings: bank remittance + tax meta.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pos_hardware     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── 3. CHECK constraints (idempotent: skip when already present) ───────────
DO $$ BEGIN
  ALTER TABLE companies ADD CONSTRAINT companies_business_profile_check
    CHECK (business_profile IS NULL
           OR business_profile IN ('retail', 'mobile_computer', 'auto_spares',
                                   'fast_food_qsr', 'restaurant_dine_in', 'small_trader'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE companies ADD CONSTRAINT companies_invoice_template_id_check
    CHECK (invoice_template_id IS NULL OR invoice_template_id BETWEEN 1 AND 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE companies ADD CONSTRAINT companies_pos_theme_id_check
    CHECK (pos_theme_id IS NULL OR pos_theme_id BETWEEN 1 AND 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 4. Backfill (only rows that predate this migration: column IS NULL) ────
-- Grandfather every existing tenant onto the neutral retail profile and the
-- default template/theme so no live document or till renders blank. New
-- companies fall through to the DEFAULTs set below.
UPDATE companies SET business_profile    = 'retail' WHERE business_profile IS NULL;
UPDATE companies SET invoice_template_id = 1        WHERE invoice_template_id IS NULL;
UPDATE companies SET pos_theme_id        = 1        WHERE pos_theme_id IS NULL;

-- ── 5. Defaults for companies created from now on ──────────────────────────
ALTER TABLE companies ALTER COLUMN business_profile    SET DEFAULT 'retail';
ALTER TABLE companies ALTER COLUMN invoice_template_id SET DEFAULT 1;
ALTER TABLE companies ALTER COLUMN pos_theme_id        SET DEFAULT 1;
ALTER TABLE companies ALTER COLUMN logo_url            SET DEFAULT NULL;

-- ── 6. Trigger: max_devices follows plan_type (re-asserted from v2) ────────
-- v2_master_upgrade.sql installs this. Re-asserting with CREATE OR REPLACE +
-- DROP TRIGGER IF EXISTS repairs any database that missed it and keeps this
-- migration self-contained. Identical behaviour to v2.
CREATE OR REPLACE FUNCTION update_company_device_limit() RETURNS TRIGGER AS $$
BEGIN
  NEW.max_devices := CASE NEW.plan_type
    WHEN 'standard_10'  THEN 1
    WHEN 'growth_20'    THEN 6
    WHEN 'unlimited_30' THEN 9999
    ELSE COALESCE(NEW.max_devices, 1)
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_company_device_limit ON companies;
CREATE TRIGGER update_company_device_limit
  BEFORE INSERT OR UPDATE OF plan_type ON companies
  FOR EACH ROW EXECUTE FUNCTION update_company_device_limit();
