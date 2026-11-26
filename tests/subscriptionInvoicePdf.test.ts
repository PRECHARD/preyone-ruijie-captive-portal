import { describe, expect, it } from 'vitest';
import { buildSubscriptionInvoicePdf } from '../src/services/subscriptionInvoicePdf';

const base = {
  invoiceNumber: 'PINV-TEST-0001',
  issuedAt: new Date('2026-11-26T10:00:00Z'),
  companyName: 'Floniel (Pty) Ltd',
  accountNumber: 'PRY-001002',
  billingName: 'Prechard Muvirimi',
  billingEmail: 'billing@example.com',
  billingPhone: '+263771327202',
  planName: 'PreUnlimited',
  amount: 30,
  currency: 'USD',
  paymentMethod: 'EcoCash',
  reference: 'PREYONE-SUB-ABC-123',
  expiresAt: new Date('2026-12-26T10:00:00Z'),
  devices: 9999,
};

function objects(pdf: string): string[] {
  return [...pdf.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)].map((m) => m[2]);
}

describe('subscription invoice PDF', () => {
  it('builds a structurally valid one-page PDF', () => {
    const pdf = buildSubscriptionInvoicePdf(base).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf).toContain('%%EOF');
    expect(pdf).toContain('/Type /Catalog');
    expect(pdf).toContain('/Type /Page ');
    expect(objects(pdf)).toHaveLength(7); // catalog, pages, page, stream, 2 fonts, logo image

    const xref = pdf.slice(pdf.indexOf('xref\n'));
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(7);
    offsets.forEach((offset, index) => {
      expect(pdf.slice(offset, offset + 12)).toContain(`${index + 1} 0 obj`);
    });
  });

  it('prints the package, price, payment method and account number', () => {
    const pdf = buildSubscriptionInvoicePdf(base).toString('latin1');
    const stream = objects(pdf)[3];
    expect(stream).toContain('PINV-TEST-0001');
    expect(stream).toContain('PRY-001002');
    expect(stream).toContain('PreUnlimited');
    expect(stream).toContain('USD 30.00');
    expect(stream).toContain('EcoCash');
    expect(stream).toContain('billing@example.com');
    expect(stream).toContain('TAX INVOICE');
    expect(stream).toContain('PAID');
  });

  it('embeds the Preyone voucher logo and a gradient header, with no solid green masthead', () => {
    const pdf = buildSubscriptionInvoicePdf(base).toString('latin1');
    expect(pdf).toContain('/Subtype /Image');
    expect(pdf).toContain('/Filter /DCTDecode');
    expect(pdf).toContain('/Im1 Do');
    // Gradient strips: several distinct emerald/cyan fills across the header.
    const fills = [...objects(pdf)[3].matchAll(/826 \d+\.?\d* 16 re f/g)];
    expect(fills.length).toBeGreaterThanOrEqual(4);
  });

  it('escapes parentheses in customer names', () => {
    const pdf = buildSubscriptionInvoicePdf({ ...base, companyName: 'Test (Branch) Ltd' }).toString('latin1');
    expect(objects(pdf)[3]).toContain('Test \\(Branch\\) Ltd');
  });
});
