/**
 * Theme tokens → CSS custom properties.
 *
 * Every Preyone SPA (POS, invoice, home automation) renders from one palette
 * contract: a merchant picks one of the 20 `pos_themes` rows and each surface
 * derives surfaces, borders, glows and readable ink from the five base colours.
 * Deriving instead of hand-writing 20 CSS files is what makes "pick a theme,
 * every app follows" true rather than aspirational.
 *
 * Values are plain hex so they can be injected into `document.documentElement`
 * via style.setProperty and also serialised into a static <style> block.
 */

export interface PosThemeTokens {
  id?: number;
  name?: string;
  primary: string;
  secondary: string;
  accent: string;
  bg: string;
  text: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseHex(value: string, fallback = '#0d9488'): Rgb {
  const raw = String(value || '').trim();
  const match = HEX.exec(raw);
  if (!match) return parseHex(fallback, '#0d9488');
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

const clamp = (n: number): number => Math.min(255, Math.max(0, Math.round(n)));

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => clamp(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Linear blend: weight 0 → a, weight 1 → b. */
export function mix(a: string, b: string, weight: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const w = Math.min(1, Math.max(0, weight));
  return toHex({
    r: ca.r + (cb.r - ca.r) * w,
    g: ca.g + (cb.g - ca.g) * w,
    b: ca.b + (cb.b - ca.b) * w,
  });
}

/** WCAG relative luminance, used only to choose black or white ink. */
export function relativeLuminance(value: string): number {
  const { r, g, b } = parseHex(value);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Black or white text, whichever stays readable on `background`. */
export function readableInk(background: string, dark = '#0b1220', light = '#ffffff'): string {
  return relativeLuminance(background) > 0.45 ? dark : light;
}

export function rgba(value: string, alpha: number): string {
  const { r, g, b } = parseHex(value);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

/**
 * The full variable set consumed by the three SPAs. Keys are CSS custom
 * property names (including the leading `--`).
 */
export function themeCssVariables(theme: PosThemeTokens): Record<string, string> {
  const bg = theme.bg || '#0f172a';
  const text = theme.text || '#f8fafc';
  const primary = theme.primary || '#0d9488';
  const accent = theme.accent || primary;
  const secondary = theme.secondary || mix(bg, primary, 0.35);

  // A light background (themes 17 and 20) needs the inverse surface ramp,
  // otherwise "elevated" cards come out darker than the page.
  const light = relativeLuminance(bg) > 0.45;
  const surfaceStep = light ? -0.06 : 0.07;
  const surface = mix(bg, text, light ? 0.06 : 0.08);
  const surface2 = mix(bg, text, light ? 0.12 : 0.14);

  return {
    '--pos-primary': primary,
    '--pos-primary-strong': mix(primary, light ? '#000000' : '#ffffff', 0.18),
    '--pos-primary-soft': rgba(primary, 0.16),
    '--pos-secondary': secondary,
    '--pos-accent': accent,
    '--pos-accent-soft': rgba(accent, 0.18),
    '--pos-bg': bg,
    '--pos-bg-elevated': surfaceStep < 0 ? mix(bg, '#000000', 0.04) : mix(bg, '#ffffff', 0.04),
    '--pos-surface': surface,
    '--pos-surface-2': surface2,
    '--pos-border': mix(bg, text, light ? 0.18 : 0.22),
    '--pos-text': text,
    '--pos-text-muted': mix(text, bg, 0.42),
    '--pos-on-primary': readableInk(primary),
    '--pos-on-accent': readableInk(accent),
    '--pos-glow': rgba(primary, 0.35),
    '--pos-glow-accent': rgba(accent, 0.3),
    '--pos-shadow': light ? '0 18px 40px rgba(15, 23, 42, 0.12)' : '0 18px 40px rgba(0, 0, 0, 0.45)',
    '--pos-radius': '16px',
    '--pos-font': "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
  };
}

/** Renders the variables as a `:root { … }` stylesheet (server-side preview). */
export function themeCssBlock(theme: PosThemeTokens, selector = ':root'): string {
  const vars = themeCssVariables(theme);
  const body = Object.entries(vars)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}`;
}
