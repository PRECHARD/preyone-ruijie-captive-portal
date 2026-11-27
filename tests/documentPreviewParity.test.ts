import fs from 'fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => fs.readFileSync(path, 'utf8');

describe('invoice preview / print / PDF / email parity', () => {
  const app = read('invoice/src/App.tsx');
  const pdf = read('invoice/src/pdf.ts');
  const css = read('invoice/src/document.css');
  const sheet = read('invoice/src/DocumentSheet.tsx');

  it('renders the same DocumentSheet in the modal and the print host', () => {
    expect(app).toContain(
      '<DocumentSheet doc={drawerSheet} company={company} template={template} />'
    );
    expect(app).toContain(
      '<DocumentSheet doc={drawerSheet} company={company} template={template} printRoot />'
    );
    // One document source, no simplified drawer-only markup.
    expect(app).not.toContain('drawer-only-sheet');
  });

  it('exports and emails the rendered sheet, not a second vector layout', () => {
    expect(app).toContain("querySelector<HTMLElement>('.a4-sheet')");
    expect(app).toContain("import('./pdf')");
    expect(app).toContain('buildDocumentPdf');
    expect(app).toContain('sheet={drawerSheet}');
    expect(app).toContain('template={template}');
    expect(pdf).toContain('sheetToPdf(sheets)');
    expect(pdf).toContain('No silent vector fallback');
  });

  it('keeps the exact A4 sheet geometry and paid stamp in every output', () => {
    expect(sheet).toContain('className="a4-sheet"');
    expect(sheet).toContain('src="/brand/PAID.svg"');
    expect(sheet).toContain('a4-band-verify-code');
    expect(css).toMatch(/\.a4-print \.a4-sheet \{[^}]*width: 210mm[^}]*height: 296\.6mm/s);
    expect(css).toContain('zoom: 1 !important');
    expect(css).toContain('.a4-totals .a4-row .a4-val');
    expect(css).toContain('font-variant-numeric: tabular-nums');
  });

  it('clips and scrolls only the outer modal frame', () => {
    const workspace = read('invoice/src/styles.css');
    expect(workspace).toMatch(/\.sheet \{[^}]*overflow-x: auto[^}]*overflow-y: auto/s);
    expect(css).toMatch(/\.a4-preview-shell \{[^}]*overflow: visible/s);
    expect(css).not.toMatch(/\.a4-preview-shell \{[^}]*overflow: hidden/s);
    expect(app).toContain('className="a4-preview-shell preview-1to1"');
    expect(css).toContain('.a4-preview-shell.preview-1to1 .a4-doc { zoom: 1 !important; }');
  });

  it('prints the same cash tender and change rows captured in the modal sheet', () => {
    expect(sheet).toContain('cashTendered?: number');
    expect(sheet).toContain('cashChange?: number');
    expect(sheet).toContain('Cash Tendered');
    expect(sheet).toContain('a4-cash-row');
    expect(app).toContain('cashTendered: paidCashTendered || undefined');
    expect(app).toContain('cashChange: paidCashChange || undefined');
    expect(app).toContain('Cash tendered {money(tendered');
  });
});

describe('POS receipt preview / print / PDF parity', () => {
  const modal = read('pos/src/components/ReceiptModal.tsx');
  const css = read('pos/src/styles.css');

  it('prints exactly the same receipt card shown in the modal', () => {
    expect(modal).toContain('id="receipt-print-area"');
    expect(modal).toContain('className="receipt-paper"');
    expect(modal).toContain('<ReceiptBarcode');
    expect(modal).toContain('window.print()');
    expect(modal).not.toContain('print-only-receipt');
  });

  it('captures the same receipt card for download and WhatsApp', () => {
    expect(modal).toContain('ref={receiptRef}');
    expect(modal).toContain('const getPdfDoc = useCallback(async () => {');
    expect(modal).toContain('buildReceiptPdfFromElement(element)');
    expect(modal.match(/await getPdfDoc\(\)/g)).toHaveLength(2);
    // The vector renderer remains an explicit compatibility fallback only.
    expect(modal).toContain('generateReceiptPdf({');
    expect(modal).toContain('Exact receipt capture failed; using vector fallback:');
    const capture = read('pos/src/utils/receiptDomPdf.ts');
    expect(capture).toContain('toCanvas(element');
    expect(capture).toContain('format: [widthMm, heightMm]');
  });

  it('prints the receipt at the same geometry shown in the modal', () => {
    expect(css).toMatch(/#receipt-print-area \{[^}]*width: 302px[^}]*padding: 10px 12px !important[^}]*font-size: 11px/s);
    expect(css).toContain('line-height: 1.45;');
    expect(css).toContain('@page { size: 80mm auto; margin: 0; }');
  });

  it('keeps the shared emerald, stamp and full-width barcode styles', () => {
    expect(css).toContain('#047857');
    expect(css).toContain('#059669');
    expect(css.toLowerCase()).toContain('#ecfdf5');
    expect(css).toContain('font-variant-numeric: tabular-nums');
    expect(css).toContain('rotate(-15.87deg)');
    expect(css).toContain('pointer-events: none');
    expect(css).toMatch(/\.r-barcode \{[^}]*width: 100%/s);
    expect(modal).toContain('viewBox={`0 0 ${units} 40`}');
    expect(modal).toContain('preserveAspectRatio="none"');
  });

  it('shows the persisted cash tender and change on the receipt', () => {
    expect(modal).toContain('p.cashTendered ?? p.amount');
    expect(modal).toContain('p.change ?? Math.max(0, tendered - Number(p.amount))');
    const pdf = read('pos/src/utils/receiptPdf.ts');
    expect(pdf).toContain('Cash Tendered:');
    expect(pdf).toContain('Change:');
  });
});
