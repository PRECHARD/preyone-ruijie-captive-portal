/**
 * Preyone Home belongs to the Preyone 360 suite, so the IoT workspace always
 * wears the house palette instead of the merchant's POS theme. The portal still
 * probes `/api/pos/theme` because a 401/403 there gates access, but the returned
 * palette is intentionally ignored — a merchant repaint would turn the
 * dashboard green and break the Preyone brand.
 */

export const PREYONE_BRAND_VARS: Record<string, string> = {
  '--pos-primary': '#a855f7',
  '--pos-primary-strong': '#6a0dad',
  '--pos-primary-soft': 'rgba(168, 85, 247, 0.18)',
  '--pos-secondary': '#4c1d95',
  '--pos-accent': '#ff00ff',
  '--pos-accent-soft': 'rgba(255, 0, 255, 0.16)',
  '--pos-bg': '#05060e',
  '--pos-bg-elevated': '#0a0e20',
  '--pos-surface': 'rgba(14, 17, 38, 0.72)',
  '--pos-surface-2': 'rgba(26, 28, 58, 0.6)',
  '--pos-border': 'rgba(140, 125, 215, 0.22)',
  '--pos-text': '#eef1ff',
  '--pos-text-muted': '#a4abd0',
  '--pos-on-primary': '#ffffff',
  '--pos-on-accent': '#ffffff',
  '--pos-glow': 'rgba(168, 85, 247, 0.42)',
  '--pos-glow-accent': 'rgba(255, 0, 255, 0.28)',
  '--pos-shadow': '0 24px 60px rgba(0, 0, 0, 0.5)',
  '--pos-radius': '18px',
};

/**
 * Applies a set of `--custom-property` tokens to the document root.
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

/** Pins the document root to the Preyone brand tokens. */
export function applyPreyoneBrand(): void {
  applyCssVars(PREYONE_BRAND_VARS);
}
