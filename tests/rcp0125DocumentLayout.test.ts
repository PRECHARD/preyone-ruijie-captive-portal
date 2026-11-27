import fs from 'fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => fs.readFileSync(path, 'utf8');

describe('RCP-0125 document edge containment', () => {
  const modal = read('pos/src/components/ReceiptModal.tsx');
  const receiptCss = read('pos/src/styles.css');
  const receiptPdf = read('pos/src/utils/receiptPdf.ts');
  const documentCss = read('invoice/src/document.css');
  const documentSheet = read('invoice/src/DocumentSheet.tsx');
  const invoicePdf = read('invoice/src/pdf.ts');

  it('shows only the green PAID badge on POS receipts', () => {
    expect(modal).toContain('<span className="r-paid-pill">PAID</span>');
    expect(modal).not.toContain('className="r-paid-stamp"');
    // The historical declaration survives for parity checks, but is hidden.
    expect(receiptCss).toContain('rotate(-15.87deg)');
    expect(receiptCss).toContain('.r-paid-row .r-paid-stamp { display: none !important; }');
    expect(receiptPdf).toContain('const includeRotatedStamp = false;');
  });

  it('wraps the long POS tagline in both DOM and vector paths', () => {
    expect(modal).toContain('className="receipt-subbrand receipt-tagline"');
    expect(receiptCss).toContain('.receipt-subbrand.receipt-tagline {');
    expect(receiptPdf).toContain('centeredLines(doc, String(opts.company.tagline)');
  });

  it('constrains POS rows and values to the thermal content width', () => {
    expect(receiptCss).toContain('.modal-card .receipt-paper { max-width: 100%; }');
    expect(receiptCss).toContain('.r-table {');
    expect(receiptCss).toContain('table-layout: fixed;');
    expect(receiptCss).toMatch(/\.r-table td \{[^}]*min-width: 0/s);
    expect(receiptCss).toMatch(/\.r-table \.r-num \{[^}]*white-space: normal/s);
    expect(receiptCss).toContain('@page { size: 80mm auto; margin: 0; }');
    expect(receiptCss).toContain('@page { size: 80mm 297mm; margin: 0; }');
    expect(receiptCss).toContain('font-variant-numeric: tabular-nums');
  });

  it('keeps the POS cash/footer/barcode block intact', () => {
    expect(modal).toContain('Cash Tendered: {money(cashTendered)}');
    expect(modal).toContain('<ReceiptPoweredBy website={brandWebsite} />');
    expect(modal).toContain('SCAN TO VERIFY • preyone.com/verify');
    expect(receiptCss).toMatch(/\.r-barcode \{[^}]*width: 100%/s);
  });

  it('keeps exactly one invoice PAID stamp and contains A4 flex/grid children', () => {
    expect(documentSheet.match(/src="\/brand\/PAID\.svg"/g)).toHaveLength(1);
    expect(documentCss).toMatch(/\.a4-doc-head > \*,\s*\.a4-doc-meta > \*,[\s\S]*?min-width: 0/s);
    expect(documentCss).toContain('.a4-meta-grid {');
    expect(documentCss).toContain('grid-template-columns: minmax(0, auto) minmax(0, 1fr);');
    expect(documentCss).toMatch(/\.a4-tagline,[\s\S]*?overflow-wrap: anywhere/s);
    expect(documentCss).toContain('.a4-stamp {');
    expect(documentCss).toContain('max-width: calc(100% - 32mm);');
    expect(documentCss).toContain('@page { size: A4; margin: 0; }');
  });

  it('wraps the invoice tagline in the explicit vector fallback', () => {
    expect(invoicePdf).toContain('pdf.splitTextToSize(tagline, CONTENT_W)');
    expect(documentCss).toContain('.a4-totals .a4-row .a4-val');
    expect(documentCss).toContain('font-variant-numeric: tabular-nums');
  });
});
