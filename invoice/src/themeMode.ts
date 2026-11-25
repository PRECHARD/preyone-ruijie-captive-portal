/**
 * Day / night mode for the invoice workspace.
 *
 * Stored as `preyone_theme` so POS, invoice and future Preyone SPAs agree on
 * the same choice. With no stored choice the OS preference wins, which is what
 * makes the workspace light during the day for users who run their machine in
 * light mode.
 */
export type ThemeMode = 'dark' | 'light';

const KEY = 'preyone_theme';

function savedMode(): ThemeMode | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function getThemeMode(): ThemeMode {
  const saved = savedMode();
  if (saved) return saved;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.preyoneTheme = mode;
  root.style.colorScheme = mode;
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* private mode: still apply for this tab */
  }
  applyThemeMode(mode);
}

export function toggleThemeMode(): ThemeMode {
  const next: ThemeMode = getThemeMode() === 'light' ? 'dark' : 'light';
  setThemeMode(next);
  return next;
}

export function initThemeMode(): ThemeMode {
  const mode = getThemeMode();
  applyThemeMode(mode);
  return mode;
}
