-- v3.3 — A4 house invoice templates
--
-- The invoicing workspace now renders every document with the exact A4 sheet
-- from the previous Preyone invoice deployment: brand lockup + wordmark,
-- gradient number bar, bill-to / meta grid, gradient item table with zebra
-- fillers, gradient grand total, payment notes and the full-bleed footer band.
--
-- All 20 rows below share that structure. A template only chooses the
-- gradient stops, the wordmark treatment (legacy SVG vs. coloured text) and
-- the row density (standard / minimal / compact), which keeps the whole set in
-- one visual genre.
--
-- Template 1 is the house default and keeps the literal legacy gradient
-- (#7a0e57 is what the front end keys on for the SVG wordmark + footer band).
--
-- Idempotent: safe to run on every deploy.

BEGIN;

INSERT INTO invoice_templates (id, name, description, layout, accent_color, show_logo) VALUES
  (1,  'Preyone Classic',    'The original A4 sheet — legacy purple gradient, gradient item table and footer band.', 'standard', '#7a0e57', TRUE),
  (2,  'Modern Minimal',     'Same A4 sheet with flat accent bands and airy spacing.',                           'minimal',  '#2563eb', TRUE),
  (3,  'Corporate Elegant',  'A4 sheet with a deep navy gradient and a formal totals block.',                    'standard', '#1e293b', TRUE),
  (4,  'Compact Docket',     'A4 sheet with tighter rows for long item lists.',                                  'compact',  '#334155', FALSE),
  (5,  'Bold Masthead',      'Full-bleed violet masthead and white table headings.',                             'standard', '#7c3aed', TRUE),
  (6,  'Gradient Accent',    'Rose gradient across the masthead, zebra rows and total.',                         'standard', '#db2777', TRUE),
  (7,  'Monochrome Pro',     'Strict black-and-white A4 sheet, ink-efficient for bulk print.',                   'standard', '#000000', TRUE),
  (8,  'Vintage Ledger',     'Warm umber gradient with ledger-style ruled rows.',                                'standard', '#92400e', TRUE),
  (9,  'Neon Digital',       'High-contrast cyan bands for screen-first invoices.',                              'minimal',  '#06b6d4', TRUE),
  (10, 'Studio Creative',    'Orange gradient A4 proof with a bold grand total.',                                'standard', '#f97316', TRUE),
  (11, 'Executive Gold',     'Amber-gold gradient with a formal executive finish.',                              'standard', '#b45309', TRUE),
  (12, 'Fresh Startup',      'Green gradient with flat bands and friendly spacing.',                             'minimal',  '#10b981', TRUE),
  (13, 'Legal Formal',       'Navy A4 sheet tuned for dense, numbered clauses.',                                 'standard', '#1e3a8a', TRUE),
  (14, 'Hospitality Warm',   'Terracotta gradient for hotels and eateries.',                                     'standard', '#c2410c', TRUE),
  (15, 'Retail Bright',      'Vivid rose gradient for shopfront invoices.',                                      'standard', '#e11d48', TRUE),
  (16, 'Tech Sleek',         'Slate gradient with tabular totals for tech resellers.',                           'standard', '#334155', TRUE),
  (17, 'Eco Green',          'Forest gradient on the standard A4 sheet.',                                        'standard', '#15803d', TRUE),
  (18, 'Luxury Black',       'Near-black gradient with restrained gold-leaning accents.',                        'standard', '#111827', TRUE),
  (19, 'Friendly Rounded',   'Violet gradient, flat bands and soft spacing.',                                    'minimal',  '#8b5cf6', TRUE),
  (20, 'Preyone Signature',  'House A4 sheet — signature deep purple gradient and footer band.',                  'standard', '#4a1064', TRUE)
ON CONFLICT (id) DO UPDATE SET
  name         = EXCLUDED.name,
  description  = EXCLUDED.description,
  layout       = EXCLUDED.layout,
  accent_color = EXCLUDED.accent_color,
  show_logo    = EXCLUDED.show_logo,
  is_active    = TRUE;

-- Any tenant pointing at a row that was retired should fall back to the house
-- template rather than render nothing.
UPDATE companies
   SET invoice_template_id = 1
 WHERE invoice_template_id IS NOT NULL
   AND invoice_template_id NOT IN (SELECT id FROM invoice_templates WHERE is_active);

COMMIT;
