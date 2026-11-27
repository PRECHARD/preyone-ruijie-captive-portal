import fs from 'fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('locked POS receipt powered-by footer', () => {
  const component = read('pos/src/components/ReceiptPoweredBy.tsx');
  const constants = read('pos/src/utils/receiptPoweredBy.ts');
  const modal = read('pos/src/components/ReceiptModal.tsx');
  const pdf = read('pos/src/utils/receiptPdf.ts');
  const transit = read('bus-ticket-app/lib/src/widgets/ticket_preview_card.dart');

  it('copies the transit ticket preview design exactly', () => {
    expect(constants).toContain("label: 'Powered by'");
    expect(constants).toContain("brand: 'PREYONE TECHNOLOGIES'");
    expect(constants).toContain("website: 'www.preyone.com'");
    expect(constants).toContain("muted: '#6E7B8A'");
    expect(constants).toContain("navy: '#26323F'");
    expect(transit).toContain("'Powered by'");
    expect(transit).toContain("'PREYONE TECHNOLOGIES'");
  });

  it('renders inline directly below the thank-you line in the preview', () => {
    expect(modal).toContain("import ReceiptPoweredBy from './ReceiptPoweredBy';");
    expect(modal).toContain('<ReceiptPoweredBy website={brandWebsite} />');
    expect(modal).toMatch(
      /<div className="r-thanks">[^\n]*<\/div>\n\s*<ReceiptPoweredBy website=\{brandWebsite\} \/>/
    );
    expect(component).toContain('data-receipt-footer="preyone"');
    expect(component).toContain('style={wrap}');
    expect(component).toContain('style={label}');
    expect(component).toContain('style={brand}');
    expect(component).toContain('style={websiteStyle}');
  });

  it('keeps the vector PDF fallback on the same locked footer', () => {
    expect(pdf).toContain(
      "import { RECEIPT_POWERED_BY, receiptFooterWebsite } from './receiptPoweredBy.ts';"
    );
    expect(pdf).toContain('RECEIPT_POWERED_BY.label');
    expect(pdf).toContain('RECEIPT_POWERED_BY.brand');
    expect(pdf).toContain('receiptFooterWebsite(opts.company.website)');
  });

  it('is hash-locked with a verifiable npm script', () => {
    expect(fs.existsSync('docs/frozen-pos-receipt-footer.lock.json')).toBe(true);
    expect(fs.existsSync('scripts/verify-pos-receipt-lock.mjs')).toBe(true);
    expect(read('package.json')).toContain(
      '"verify:receipt-lock": "node scripts/verify-pos-receipt-lock.mjs"'
    );
  });
});
