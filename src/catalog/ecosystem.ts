// Static reference data for the Global Settings Hub. These mirror the seed rows
// in db/migrations/v3_master_ecosystem.sql exactly. The live catalogue is read
// from the invoice_templates / pos_themes tables; these arrays are the fallback
// used when the tables are empty or unavailable (e.g. before the migration runs).

export interface InvoiceTemplate {
  id: number;
  name: string;
  description: string;
  layout: 'standard' | 'minimal' | 'compact';
  accentColor: string;
  showLogo: boolean;
}

export interface PosTheme {
  id: number;
  name: string;
  description: string;
  primary: string;
  secondary: string;
  accent: string;
  bg: string;
  text: string;
}

export interface BusinessProfile {
  id: string;
  name: string;
  description: string;
  /** Drives the Fast Food & KDS tab grouping: general retail vs QSR vs fine dining. */
  kind: 'general' | 'qsr' | 'restaurant';
}

export const BUSINESS_PROFILES: BusinessProfile[] = [
  { id: 'retail', name: 'Retail', description: 'General shopfront with barcode sales and stock.', kind: 'general' },
  { id: 'mobile_computer', name: 'Mobile & Computer', description: 'Devices, repairs and accessory sales.', kind: 'general' },
  { id: 'auto_spares', name: 'Auto Spares', description: 'Parts counter with part-number lookups.', kind: 'general' },
  { id: 'small_trader', name: 'Small Trader', description: 'Lean till for market and informal traders.', kind: 'general' },
  { id: 'fast_food_qsr', name: 'Fast Food / QSR', description: 'Quick-service: colour tiles, modifier popups, KOT routing.', kind: 'qsr' },
  { id: 'restaurant_dine_in', name: 'Restaurant / Fine Dining', description: 'Dine-in: floor plan, table management, bill splitting.', kind: 'restaurant' },
];

export const CURRENCIES = [
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'ZWG', name: 'Zimbabwe Gold (ZiG)', symbol: 'ZiG' },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
] as const;

/**
 * The 20 invoice templates all render the same A4 house sheet ported from the
 * previous Preyone invoice deployment. A template only changes the gradient,
 * the wordmark treatment and the row density — never the document structure.
 *
 * Template 1 keeps the literal legacy purple gradient and is the default.
 */
export const INVOICE_TEMPLATES: InvoiceTemplate[] = [
  { id: 1, name: 'Preyone Classic', description: 'The original A4 sheet — legacy purple gradient, gradient item table and footer band.', layout: 'standard', accentColor: '#7a0e57', showLogo: true },
  { id: 2, name: 'Modern Minimal', description: 'Same A4 sheet with flat accent bands and airy spacing.', layout: 'minimal', accentColor: '#2563eb', showLogo: true },
  { id: 3, name: 'Corporate Elegant', description: 'A4 sheet with a deep navy gradient and a formal totals block.', layout: 'standard', accentColor: '#1e293b', showLogo: true },
  { id: 4, name: 'Compact Docket', description: 'A4 sheet with tighter rows for long item lists.', layout: 'compact', accentColor: '#334155', showLogo: false },
  { id: 5, name: 'Bold Masthead', description: 'Full-bleed violet masthead and white table headings.', layout: 'standard', accentColor: '#7c3aed', showLogo: true },
  { id: 6, name: 'Gradient Accent', description: 'Rose gradient across the masthead, zebra rows and total.', layout: 'standard', accentColor: '#db2777', showLogo: true },
  { id: 7, name: 'Monochrome Pro', description: 'Strict black-and-white A4 sheet, ink-efficient for bulk print.', layout: 'standard', accentColor: '#000000', showLogo: true },
  { id: 8, name: 'Vintage Ledger', description: 'Warm umber gradient with ledger-style ruled rows.', layout: 'standard', accentColor: '#92400e', showLogo: true },
  { id: 9, name: 'Neon Digital', description: 'High-contrast cyan bands for screen-first invoices.', layout: 'minimal', accentColor: '#06b6d4', showLogo: true },
  { id: 10, name: 'Studio Creative', description: 'Orange gradient A4 proof with a bold grand total.', layout: 'standard', accentColor: '#f97316', showLogo: true },
  { id: 11, name: 'Executive Gold', description: 'Amber-gold gradient with a formal executive finish.', layout: 'standard', accentColor: '#b45309', showLogo: true },
  { id: 12, name: 'Fresh Startup', description: 'Green gradient with flat bands and friendly spacing.', layout: 'minimal', accentColor: '#10b981', showLogo: true },
  { id: 13, name: 'Legal Formal', description: 'Navy A4 sheet tuned for dense, numbered clauses.', layout: 'standard', accentColor: '#1e3a8a', showLogo: true },
  { id: 14, name: 'Hospitality Warm', description: 'Terracotta gradient for hotels and eateries.', layout: 'standard', accentColor: '#c2410c', showLogo: true },
  { id: 15, name: 'Retail Bright', description: 'Vivid rose gradient for shopfront invoices.', layout: 'standard', accentColor: '#e11d48', showLogo: true },
  { id: 16, name: 'Tech Sleek', description: 'Slate gradient with tabular totals for tech resellers.', layout: 'standard', accentColor: '#334155', showLogo: true },
  { id: 17, name: 'Eco Green', description: 'Forest gradient on the standard A4 sheet.', layout: 'standard', accentColor: '#15803d', showLogo: true },
  { id: 18, name: 'Luxury Black', description: 'Near-black gradient with restrained gold-leaning accents.', layout: 'standard', accentColor: '#111827', showLogo: true },
  { id: 19, name: 'Friendly Rounded', description: 'Violet gradient, flat bands and soft spacing.', layout: 'minimal', accentColor: '#8b5cf6', showLogo: true },
  { id: 20, name: 'Preyone Signature', description: 'House A4 sheet — signature deep purple gradient and footer band.', layout: 'standard', accentColor: '#4a1064', showLogo: true },
];

export const POS_THEMES: PosTheme[] = [
  { id: 1, name: 'Preyone Dark', description: 'Preyone Slate: emerald and amber on deep slate.', primary: '#059669', secondary: '#0f172a', accent: '#d97706', bg: '#0f172a', text: '#f8fafc' },
  { id: 2, name: 'Ocean Blue', description: 'Deep navy with bright cyan highlights.', primary: '#0ea5e9', secondary: '#0c4a6e', accent: '#38bdf8', bg: '#082f49', text: '#f0f9ff' },
  { id: 3, name: 'Forest Green', description: 'Earthy greens for grocers and markets.', primary: '#16a34a', secondary: '#14532d', accent: '#4ade80', bg: '#052e16', text: '#f7fee7' },
  { id: 4, name: 'Sunset Orange', description: 'Warm orange for cafes and QSR.', primary: '#ea580c', secondary: '#7c2d12', accent: '#fb923c', bg: '#431407', text: '#fff7ed' },
  { id: 5, name: 'Royal Purple', description: 'Rich purple with violet accents.', primary: '#9333ea', secondary: '#4c1d95', accent: '#c084fc', bg: '#2e1065', text: '#faf5ff' },
  { id: 6, name: 'Crimson Red', description: 'Bold red for high-energy retail.', primary: '#dc2626', secondary: '#7f1d1d', accent: '#f87171', bg: '#450a0a', text: '#fef2f2' },
  { id: 7, name: 'Slate Gray', description: 'Neutral professional slate.', primary: '#475569', secondary: '#1e293b', accent: '#94a3b8', bg: '#0f172a', text: '#f1f5f9' },
  { id: 8, name: 'Teal Wave', description: 'Fresh teal with sea-glass accents.', primary: '#14b8a6', secondary: '#115e59', accent: '#5eead4', bg: '#042f2e', text: '#f0fdfa' },
  { id: 9, name: 'Golden Hour', description: 'Amber and honey tones.', primary: '#f59e0b', secondary: '#78350f', accent: '#fbbf24', bg: '#451a03', text: '#fffbeb' },
  { id: 10, name: 'Midnight', description: 'Near-black with electric blue.', primary: '#3b82f6', secondary: '#1e3a8a', accent: '#60a5fa', bg: '#020617', text: '#e0f2fe' },
  { id: 11, name: 'Coral Punch', description: 'Playful coral for boutiques.', primary: '#f43f5e', secondary: '#881337', accent: '#fb7185', bg: '#4c0519', text: '#fff1f2' },
  { id: 12, name: 'Mint Fresh', description: 'Light mint, easy on the eyes.', primary: '#10b981', secondary: '#065f46', accent: '#6ee7b7', bg: '#022c22', text: '#ecfdf5' },
  { id: 13, name: 'Indigo Night', description: 'Deep indigo with periwinkle.', primary: '#6366f1', secondary: '#312e81', accent: '#a5b4fc', bg: '#1e1b4b', text: '#eef2ff' },
  { id: 14, name: 'Amber Glow', description: 'Golden amber on dark umber.', primary: '#d97706', secondary: '#78350f', accent: '#fcd34d', bg: '#451a03', text: '#fffbeb' },
  { id: 15, name: 'Rose Quartz', description: 'Soft rose with blush accents.', primary: '#e11d48', secondary: '#881337', accent: '#fda4af', bg: '#4c0519', text: '#fff1f2' },
  { id: 16, name: 'Carbon', description: 'True carbon gray, ultra-minimal.', primary: '#374151', secondary: '#111827', accent: '#9ca3af', bg: '#030712', text: '#f9fafb' },
  { id: 17, name: 'Sky Light', description: 'Bright daytime sky palette.', primary: '#0284c7', secondary: '#075985', accent: '#7dd3fc', bg: '#e0f2fe', text: '#0c4a6e' },
  { id: 18, name: 'Emerald', description: 'Classic emerald for finance and sales.', primary: '#059669', secondary: '#064e3b', accent: '#34d399', bg: '#022c22', text: '#ecfdf5' },
  { id: 19, name: 'Fusion Magenta', description: 'Vivid magenta for creative retail.', primary: '#d946ef', secondary: '#701a75', accent: '#e879f9', bg: '#3b0764', text: '#fdf4ff' },
  { id: 20, name: 'Classic Light', description: 'Clean white with slate text and teal link.', primary: '#0f766e', secondary: '#134e4a', accent: '#14b8a6', bg: '#f8fafc', text: '#0f172a' },
];
