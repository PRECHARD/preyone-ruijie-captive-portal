import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('portal mobile package grid', () => {
  it('keeps small-phone package cards in a 2-up layout and keeps headings compact', () => {
    const css = readFileSync(path.join(process.cwd(), 'public', 'css', 'portal.css'), 'utf8');

    expect(css).toContain('@media (max-width: 480px)');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(css).toContain('line-height: 1.05');
    expect(css).toContain('font-size: clamp(1.3rem, 5vw, 2rem)');
    expect(css).toContain('flex-direction: column');
    expect(css).toContain('overflow-wrap: anywhere');
  });
});