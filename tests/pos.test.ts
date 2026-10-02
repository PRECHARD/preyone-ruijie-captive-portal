import { describe, it, expect } from 'vitest';
import { computeTotals, statusForPaid, DOC_PREFIX } from '../src/routes/pos';

describe('POS computeTotals', () => {
  it('sums line totals into subtotal', () => {
    const { lines, subtotal } = computeTotals(
      [
        { description: 'Print A4', price: 0.5, qty: 10 },
        { description: 'Laminate', price: 1.25, qty: 2 },
      ],
      0,
      0
    );
    expect(lines).toHaveLength(2);
    expect(subtotal).toBeCloseTo(7.5, 2);
    expect(lines[0].lineTotal).toBeCloseTo(5.0, 2);
    expect(lines[1].lineTotal).toBeCloseTo(2.5, 2);
  });

  it('defaults missing qty to 1 and coerces strings', () => {
    const { lines, subtotal } = computeTotals([{ description: 'Photo', price: '3.335' }], 0, 0);
    expect(lines[0].qty).toBe(1);
    expect(lines[0].price).toBeCloseTo(3.34, 2); // round2 applied per unit price
    expect(subtotal).toBeCloseTo(3.34, 2);
  });

  it('applies discount then tax on the discounted base', () => {
    // subtotal 100, discount 10% → base 90, tax 15% → 13.5, total 103.5
    const { discountAmount, taxAmount, total } = computeTotals([{ price: 100, qty: 1 }], 10, 15);
    expect(discountAmount).toBeCloseTo(10, 2);
    expect(taxAmount).toBeCloseTo(13.5, 2);
    expect(total).toBeCloseTo(103.5, 2);
  });

  it('handles empty carts safely', () => {
    const { subtotal, total } = computeTotals([], 0, 0);
    expect(subtotal).toBe(0);
    expect(total).toBe(0);
  });
});

describe('POS statusForPaid', () => {
  it('marks paid when payments cover the total (within rounding tolerance)', () => {
    expect(statusForPaid('invoice', 100, 100)).toBe('paid');
    expect(statusForPaid('sale', 99.99, 99.995)).toBe('paid');
    expect(statusForPaid('quotation', 50, 50)).toBe('paid');
  });

  it('marks partial when some but not all is paid', () => {
    expect(statusForPaid('invoice', 100, 40)).toBe('partial');
  });

  it('falls back to sent for unpaid quotations, unpaid otherwise', () => {
    expect(statusForPaid('quotation', 100, 0)).toBe('sent');
    expect(statusForPaid('invoice', 100, 0)).toBe('unpaid');
    expect(statusForPaid('sale', 100, 0)).toBe('unpaid');
  });
});

describe('POS document numbering prefixes', () => {
  it('maps doc types to brand prefixes', () => {
    expect(DOC_PREFIX.sale).toBe('RCP');
    expect(DOC_PREFIX.invoice).toBe('INV');
    expect(DOC_PREFIX.quotation).toBe('QUO');
  });
});
