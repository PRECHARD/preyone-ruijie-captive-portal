import { describe, expect, it } from 'vitest';
import {
  parseHex,
  toHex,
  mix,
  relativeLuminance,
  readableInk,
  rgba,
  themeCssVariables,
  themeCssBlock,
} from '../src/utils/themeVars';

const DARK = { primary: '#10b981', secondary: '#0f766e', accent: '#f59e0b', bg: '#070b12', text: '#e8eefb' };
const LIGHT = { primary: '#2563eb', secondary: '#1d4ed8', accent: '#f97316', bg: '#f8fafc', text: '#0f172a' };

describe('hex helpers', () => {
  it('parses 3- and 6-digit hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('10b981')).toEqual({ r: 16, g: 185, b: 129 });
  });

  it('falls back on invalid input instead of throwing', () => {
    expect(parseHex('nonsense')).toEqual({ r: 5, g: 150, b: 105 });
  });

  it('round-trips through toHex', () => {
    expect(toHex(parseHex('#10b981'))).toBe('#10b981');
    expect(toHex({ r: 300, g: -5, b: 12 })).toBe('#ff000c');
  });

  it('mixes towards the target colour', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('emits rgba with a clamped alpha', () => {
    expect(rgba('#10b981', 0.5)).toBe('rgba(16, 185, 129, 0.5)');
    expect(rgba('#10b981', 9)).toBe('rgba(16, 185, 129, 1)');
    expect(rgba('#10b981', -1)).toBe('rgba(16, 185, 129, 0)');
  });
});

describe('contrast', () => {
  it('ranks white above black', () => {
    expect(relativeLuminance('#ffffff')).toBeGreaterThan(relativeLuminance('#000000'));
  });

  it('picks dark ink on light backgrounds and light ink on dark ones', () => {
    expect(readableInk('#ffffff')).toBe('#0b1220');
    expect(readableInk('#050505')).toBe('#ffffff');
  });
});

describe('themeCssVariables', () => {
  it('derives the full variable contract for a dark palette', () => {
    const vars = themeCssVariables(DARK);
    for (const key of [
      '--pos-primary',
      '--pos-primary-strong',
      '--pos-primary-soft',
      '--pos-secondary',
      '--pos-accent',
      '--pos-accent-soft',
      '--pos-bg',
      '--pos-bg-elevated',
      '--pos-surface',
      '--pos-surface-2',
      '--pos-border',
      '--pos-text',
      '--pos-text-muted',
      '--pos-on-primary',
      '--pos-on-accent',
      '--pos-glow',
      '--pos-glow-accent',
      '--pos-shadow',
      '--pos-radius',
      '--pos-font',
    ]) {
      expect(vars[key], key).toBeTruthy();
    }
    expect(vars['--pos-primary']).toBe('#10b981');
    expect(vars['--pos-bg']).toBe('#070b12');
    expect(vars['--pos-on-primary']).toBe('#ffffff');
  });

  it('uses a light surface ramp and dark ink for a light palette', () => {
    const vars = themeCssVariables(LIGHT);
    // Ink *on the primary button*, not the page: #2563eb is dark enough that
    // white stays the readable choice.
    expect(vars['--pos-on-primary']).toBe('#ffffff');
    expect(vars['--pos-text']).toBe('#0f172a');
    expect(vars['--pos-shadow']).toContain('rgba(15, 23, 42');
    // Light palette: the elevated surface ramp steps *darker* than the page.
    expect(relativeLuminance(vars['--pos-bg-elevated'])).toBeLessThan(relativeLuminance(vars['--pos-bg']));
    expect(relativeLuminance(vars['--pos-surface-2'])).toBeLessThan(relativeLuminance(vars['--pos-surface']));
  });

  it('falls back to house defaults when tokens are missing', () => {
    const vars = themeCssVariables({ primary: '', secondary: '', accent: '', bg: '', text: '' });
    expect(vars['--pos-primary']).toBe('#059669');
    expect(vars['--pos-bg']).toBe('#0f172a');
    expect(vars['--pos-text']).toBe('#f8fafc');
  });

  it('serialises to a :root block usable by any SPA', () => {
    const block = themeCssBlock(DARK, '.theme-scope');
    expect(block.startsWith('.theme-scope {')).toBe(true);
    expect(block).toContain('--pos-primary: #10b981;');
    expect(block.trim().endsWith('}')).toBe(true);
  });
});
