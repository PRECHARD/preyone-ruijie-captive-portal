import { describe, expect, it } from 'vitest';
import {
  mix,
  parseHex,
  readableInk,
  relativeLuminance,
  rgba,
  themeCssBlock,
  themeCssVariables,
} from '../src/utils/themeVars';
import { POS_THEMES } from '../src/catalog/ecosystem';

describe('themeVars — colour parsing', () => {
  it('expands 3-digit hex and normalises case', () => {
    expect(parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
    expect(parseHex('0D9488')).toEqual({ r: 0x0d, g: 0x94, b: 0x88 });
  });

  it('falls back instead of throwing on invalid input', () => {
    expect(parseHex('not-a-colour')).toEqual(parseHex('#0d9488'));
    expect(parseHex('')).toEqual(parseHex('#0d9488'));
  });

  it('mixes between two colours and clamps the weight', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#000000', '#ffffff', 2)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', -1)).toBe('#000000');
  });

  it('emits rgba with a clamped alpha', () => {
    expect(rgba('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(rgba('#ff0000', 5)).toBe('rgba(255, 0, 0, 1)');
  });
});

describe('themeVars — readable ink', () => {
  it('computes luminance at the extremes', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('chooses dark ink on light backgrounds and light ink on dark ones', () => {
    expect(readableInk('#ffffff')).toBe('#0b1220');
    expect(readableInk('#000000')).toBe('#ffffff');
  });
});

describe('themeVars — variable contract', () => {
  it('derives every custom property the SPAs consume', () => {
    const vars = themeCssVariables(POS_THEMES[0]);
    for (const key of [
      '--pos-primary',
      '--pos-primary-strong',
      '--pos-secondary',
      '--pos-accent',
      '--pos-bg',
      '--pos-surface',
      '--pos-border',
      '--pos-text',
      '--pos-on-primary',
      '--pos-glow',
      '--pos-shadow',
      '--pos-radius',
      '--pos-font',
    ]) {
      expect(vars[key], `missing ${key}`).toBeTruthy();
    }
  });

  it('keeps elevated surfaces lighter than the page on dark themes', () => {
    const vars = themeCssVariables({ primary: '#0d9488', secondary: '#115e59', accent: '#22d3ee', bg: '#0f172a', text: '#f8fafc' });
    expect(relativeLuminance(vars['--pos-surface'])).toBeGreaterThan(relativeLuminance(vars['--pos-bg']));
  });

  it('inverts the surface ramp on light themes', () => {
    const vars = themeCssVariables({ primary: '#0d9488', secondary: '#115e59', accent: '#22d3ee', bg: '#f8fafc', text: '#0f172a' });
    expect(relativeLuminance(vars['--pos-surface'])).toBeLessThan(relativeLuminance(vars['--pos-bg']));
  });

  it('renders a :root block containing the derived variables', () => {
    const block = themeCssBlock(POS_THEMES[0], ':root');
    expect(block.startsWith(':root {')).toBe(true);
    expect(block).toContain('--pos-primary:');
    expect(block.trimEnd().endsWith('}')).toBe(true);
  });
});
