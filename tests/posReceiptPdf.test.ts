import fs from 'fs';
import { describe, expect, it } from 'vitest';
import {
  estimateReceiptContentBottom,
  estimateReceiptHeight,
  generateReceiptPdf,
  type ReceiptPdfOptions,
} from '../pos/src/utils/receiptPdf';
import { code128Bars, verificationBarcodePayload } from '../pos/src/utils/code128';

const sample: ReceiptPdfOptions = {
  docNumber: 'RCP-0119',
  docType: 'receipt',
  verifyCode: 'PVN-4H7X-XN6G-VEME-T11B-EDKC',
  date: '27 Nov 2026, 12:19',
  customerName: '',
  cashierName: 'Prechard',
  items: [{ description: 'Rombas - PINK ROMBAS', qty: 1, price: 10, lineTotal: 10, details: [] }],
  subtotal: 10,
  discountPct: 0,
  taxPct: 15.5,
  total: 10,
  cashTendered: 10,
  change: 0,
  balanceDue: 0,
  amountPaid: 10,
  payments: [{ amount: 10, method: 'cash' }],
  company: {
    name: 'FLONIEL BABYWARE',
    phone: '+263 771 327 202',
    website: '',
    email: 'precharddmuvirimi@gmail.com',
    address: '',
    taxId: '',
    registrationNumber: '',
    tagline: '',
    footerText: 'Chenesa Mwana Wedu',
  },
};

function pageContent(): string {
  const doc = generateReceiptPdf(sample);
  return (doc.internal.pages[1] || []).join('\n');
}

describe('RCP-0119 emerald thermal receipt', () => {
  it('cuts the roll immediately after the verification label', () => {
    const height = estimateReceiptHeight(sample);
    const bottom = estimateReceiptContentBottom(sample);
    const doc = generateReceiptPdf(sample);

    expect(doc.getNumberOfPages()).toBe(1);
    expect(doc.internal.pageSize.getHeight()).toBeCloseTo(height, 3);
    expect(height).toBeLessThan(120); // was a fixed 200 mm page
    expect(height - bottom).toBeLessThanOrEqual(2.5);
  });

  it('uses the emerald layout without the old purple/document-id bloat', () => {
    const content = pageContent();
    expect(content).toContain('FLONIEL BABYWARE');
    expect(content).toContain('RCP-0119');
    expect(content).toContain('Served by');
    expect(content).toContain('1 x $10.00');
    expect(content).toContain('VAT \\(15.5%\\) incl.'); // jsPDF escapes PDF literals
    expect(content).toContain('TOTAL');
    expect(content).toContain('Cash Tendered: $10.00');
    expect(content).toContain('Chenesa Mwana Wedu');
    expect(content).not.toContain('PAID IN FULL');
    expect(content).not.toContain('DOCUMENT ID');
    expect(content).not.toContain('Terms & Conditions Apply');
    expect(content).not.toContain('54 17 106'); // old #36116a purple
  });

  it('draws a real Code 128-B barcode with a checksum and quiet zones', () => {
    const payload = verificationBarcodePayload(sample.verifyCode!);
    const bars = code128Bars(payload);

    expect(payload).toBe('preyone.com/verify/PVN-4H7X-XN6G-VEME-T11B-EDKC');
    expect(bars.startsWith('11010010000')).toBe(true); // START B
    expect(bars.endsWith('1100011101011')).toBe(true); // STOP
    expect(bars.length).toBe(552); // 47 chars -> start + data + checksum + stop

    const content = pageContent();
    expect(content).toContain('SCAN TO VERIFY');
    // 552+ modules are drawn as individual vector rectangles at 1.8 mm quiet zones.
    expect((content.match(/re\s+f/g) || []).length).toBeGreaterThan(200);
  });

  it('keeps the thermal React template on the same compact emerald design', () => {
    const modal = fs.readFileSync('pos/src/components/ReceiptModal.tsx', 'utf8');
    const receipt = modal.split('id="receipt-print-area"')[1]?.split('{pdfError &&')[0] || '';

    expect(receipt).toContain('receipt-header');
    expect(receipt).toContain('r-meta');
    expect(receipt).toContain('r-paid-pill');
    expect(receipt).toContain('<ReceiptBarcode');
    expect(receipt).not.toContain('PAID IN FULL');
    expect(receipt).not.toContain('r-verify-code');
    expect(receipt).not.toContain('Terms & Conditions Apply');

    const css = fs.readFileSync('pos/src/styles.css', 'utf8');
    expect(css).toContain('#047857');
    expect(css).toContain('#059669');
    expect(css.toLowerCase()).toContain('#ecfdf5');
    expect(css).toContain('rotate(-15.87deg)');
    expect(css).toContain('pointer-events: none');
  });

  it('writes an inspectable RCP-0119 PDF when requested', () => {
    if (!process.env.WRITE_RCP0119_PDF) return;
    const doc = generateReceiptPdf(sample);
    fs.writeFileSync(process.env.WRITE_RCP0119_PDF, Buffer.from(doc.output('arraybuffer')));
  });
});
