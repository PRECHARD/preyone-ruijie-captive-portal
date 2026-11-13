/** Guest pages may only stay on https://preyone.com and https://*.preyone.com. */
export function isAllowedAppUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'preyone.com' || host.endsWith('.preyone.com');
}

/** The shell window itself only loads its own file or the Vite dev server. */
export function isShellUrl(raw: string, devUrl: string | null): boolean {
  if (raw.startsWith('file:')) return true;
  if (!devUrl) return false;
  try {
    return new URL(raw).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}
