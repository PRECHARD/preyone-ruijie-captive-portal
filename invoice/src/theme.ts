/**
 * Applies the merchant's palette to `document.documentElement`.
 *
 * The server derives the full variable set (`--pos-*`) from the five base
 * colours of the selected theme, so every Preyone SPA that calls this function
 * changes appearance together without a second stylesheet. The defaults in
 * styles.css double as the Slate/Emerald/Amber house look when the API is not
 * reachable yet.
 */
export function applyCssVars(vars: Record<string, string> | null | undefined): void {
  if (!vars) return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith('--') && typeof value === 'string') {
      root.style.setProperty(key, value);
    }
  }
}

/** True when the palette is light enough to need dark ink on page surfaces. */
export function isLightPalette(bg: string | undefined): boolean {
  const hex = String(bg || '').replace('#', '');
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55;
}
