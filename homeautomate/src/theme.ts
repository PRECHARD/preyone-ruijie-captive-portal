/**
 * Applies the merchant palette (shared with the POS and invoice workspaces) to
 * the document root. The server derives every `--pos-*` token from the five
 * base colours of the selected theme.
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
