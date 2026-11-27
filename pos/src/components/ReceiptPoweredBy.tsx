import type { CSSProperties } from 'react';
import { RECEIPT_POWERED_BY, receiptFooterWebsite } from '../utils/receiptPoweredBy';

/*
 * Exact POS rendering of the Preyone transit ticket footer. Inline styles keep
 * modal preview, browser print and the html-to-image PDF capture identical --
 * no separate print-only stylesheet can restyle or hide this block.
 */
const wrap: CSSProperties = {
  textAlign: 'center',
  margin: '3px 0 2px',
  lineHeight: 1.15,
  fontFamily: 'inherit',
};

const label: CSSProperties = {
  color: RECEIPT_POWERED_BY.muted,
  fontSize: '8px',
  fontWeight: 500,
  letterSpacing: RECEIPT_POWERED_BY.labelTracking,
};

const brand: CSSProperties = {
  color: RECEIPT_POWERED_BY.navy,
  fontSize: '11px',
  fontWeight: 800,
  letterSpacing: RECEIPT_POWERED_BY.brandTracking,
};

const websiteStyle: CSSProperties = {
  color: RECEIPT_POWERED_BY.muted,
  fontSize: '9px',
  fontWeight: 500,
};

export default function ReceiptPoweredBy({ website }: { website?: string }) {
  return (
    <div className="r-powered-by" data-receipt-footer="preyone" style={wrap}>
      <div style={label}>{RECEIPT_POWERED_BY.label}</div>
      <div style={brand}>{RECEIPT_POWERED_BY.brand}</div>
      <div style={websiteStyle}>{receiptFooterWebsite(website)}</div>
    </div>
  );
}
