import { describe, expect, it } from 'vitest';
import { productVisual } from '../pos/src/productVisuals';

describe('POS product visuals', () => {
  it('shows chicken for a chicken product', () => {
    const v = productVisual({ name: 'Grilled Chicken', category: 'Fast food' });
    expect(v.emoji).toBe('🍗');
    expect(v.tone).toBe('amber');
    expect(v.kind).toBe('chicken');
  });

  it('shows a laptop for the live computer catalogue', () => {
    for (const name of [
      'Lenovo Yoga Slim 7',
      'Touchscreen ASUS Vivobook 14 Flip TP3407',
      'Touchscreen HP EliteBook 840 G10 Notebook',
    ]) {
      const v = productVisual({ name });
      expect(v.kind, name).toBe('laptop');
      expect(v.emoji, name).toBe('💻');
    }
  });

  it('shows a dish for Starlink kits and a dress for Rombas', () => {
    expect(productVisual({ name: 'Starlink Mini Kit', sku: 'SL-MINI-01' }).kind).toBe('router');
    expect(productVisual({ name: 'Rombas', category: 'Rombas', sku: 'SDSD2' }).kind).toBe('dress');
  });

  it('uses the description only when the name has no match', () => {
    expect(productVisual({ name: 'Model X1' }).kind).toBe('general');
    const v = productVisual({ name: 'Model X1', description: 'Core U7 laptop, 16GB RAM' });
    expect(v.kind).toBe('laptop');
  });

  it('prefers the product name over a misleading description', () => {
    const v = productVisual({
      name: 'Laptop bag',
      description: 'Fits a 14-inch laptop and charger',
    });
    expect(v.kind).toBe('bag');
  });

  it('falls back to a plain parcel with a neutral tone', () => {
    const v = productVisual({ name: 'Mystery item' });
    expect(v.emoji).toBe('📦');
    expect(v.tone).toBe('slate');
  });
});
