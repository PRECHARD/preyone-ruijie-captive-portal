import type { ThemeResponse } from './api';

/**
 * Runtime theming for the till.
 *
 * The server returns the derived `--pos-*` token set (surfaces, borders, ink,
 * glows) for the merchant's selected palette. This module applies those and
 * also aliases the legacy POS accent variables (`--violet`, `--navy-700`,
 * `--grad-brand`, `--line-soft`) that the existing till stylesheet was written
 * against. That way one theme choice restyles the POS, invoicing and home
 * automation surfaces without a second build.
 */

function hexToRgb(value: string): [number, number, number] {
  const hex = String(value || '').replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (full.length !== 6) return [5, 150, 105];
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** Linear blend: weight 0 → a, weight 1 → b. */
function mix(a: string, b: string, weight: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const w = Math.min(1, Math.max(0, weight));
  const channel = (x: number, y: number) => Math.round(x + (y - x) * w).toString(16).padStart(2, '0');
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

export function applyCssVars(vars: Record<string, string> | null | undefined): void {
  if (!vars) return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith('--') && typeof value === 'string') root.style.setProperty(key, value);
  }
}

export function applyPosTheme(response: ThemeResponse | null | undefined): void {
  if (!response?.css) return;
  const css = response.css;
  applyCssVars(css);

  const primary = css['--pos-primary'] || response.theme?.primary || '#059669';
  const primaryStrong = css['--pos-primary-strong'] || primary;
  const secondary = css['--pos-secondary'] || primary;
  const accent = css['--pos-accent'] || primary;
  const root = document.documentElement.style;

  // Legacy aliases used by pos/src/styles.css.
  root.setProperty('--violet', primary);
  root.setProperty('--navy-700', primaryStrong);
  root.setProperty('--navy-800', secondary);
  root.setProperty('--pos-accent-ink', accent);
  root.setProperty('--grad-brand', `linear-gradient(100deg, ${primary} 0%, ${secondary} 48%, ${accent} 100%)`);
  // The till is a light surface; keep hairlines and muted text readable on it.
  root.setProperty('--line-soft', mix(primary, '#ffffff', 0.86));
  root.setProperty('--muted', mix(secondary, '#ffffff', 0.42));
}
