/**
 * Preyone Home belongs to the Preyone 360 suite, so the IoT workspace always
 * wears the house palette instead of the merchant's POS theme. The portal still
 * probes `/api/pos/theme` because a 401/403 there gates access, but the returned
 * palette is intentionally ignored — a merchant repaint would turn the
 * dashboard green and break the Preyone brand.
 */

export const PREYONE_BRAND_VARS: Record<string, string> = {
  '--pos-primary': '#b026ff',
  '--pos-primary-strong': '#7c3aed',
  '--pos-primary-soft': 'rgba(176, 38, 255, 0.2)',
  '--pos-secondary': '#2d5bff',
  '--pos-accent': '#00f0ff',
  '--pos-accent-soft': 'rgba(0, 240, 255, 0.16)',
  '--pos-bg': '#0a0612',
  '--pos-bg-elevated': '#120a22',
  '--pos-surface': 'rgba(20, 13, 38, 0.68)',
  '--pos-surface-2': 'rgba(30, 20, 52, 0.55)',
  '--pos-border': 'rgba(176, 38, 255, 0.24)',
  '--pos-text': '#eef1ff',
  '--pos-text-muted': '#a4abd0',
  '--pos-on-primary': '#ffffff',
  '--pos-on-accent': '#ffffff',
  '--pos-glow': 'rgba(176, 38, 255, 0.45)',
  '--pos-glow-accent': 'rgba(0, 240, 255, 0.32)',
  '--pos-navy': '#2d5bff',
  '--pos-cyan': '#00f0ff',
  '--pos-shadow': '0 24px 60px rgba(0, 0, 0, 0.55), 0 0 44px rgba(124, 58, 237, 0.1)',
  '--pos-radius': '20px',
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
