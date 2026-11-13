/**
 * Applies Settings & Branding CSS variables from GET /api/pos/theme.
 * Same contract as invoice/src/theme.ts so both SPAs stay in step.
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
