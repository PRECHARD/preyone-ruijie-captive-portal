/**
 * Locked POS receipt footer, copied from the Preyone transit ticket preview.
 *
 * The preview renders:
 *   Powered by
 *   PREYONE TECHNOLOGIES
 *   www.preyone.com
 *
 * Keep these values stable. The hash lock in
 * docs/frozen-pos-receipt-footer.lock.json covers this file so unrelated POS
 * edits cannot silently change the transit-matched branding.
 */
export const RECEIPT_POWERED_BY = {
  label: 'Powered by',
  brand: 'PREYONE TECHNOLOGIES',
  website: 'www.preyone.com',
  muted: '#6E7B8A',
  navy: '#26323F',
  labelTracking: '0.4px',
  brandTracking: '1.2px',
  mutedRgb: [110, 123, 138],
  navyRgb: [38, 50, 63],
} as const;

/** Transit behaviour: configured website wins, otherwise the locked default. */
export function receiptFooterWebsite(website?: string): string {
  const normalized = (website || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
  return normalized || RECEIPT_POWERED_BY.website;
}
