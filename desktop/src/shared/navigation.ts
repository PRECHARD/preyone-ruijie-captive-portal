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

/** http(s) links the operating system may open. file:, smb:, and custom schemes stay closed. */
export function isExternalBrowserUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return url.hostname.length > 0;
}
export function isShellUrl(raw: string, devUrl: string | null): boolean {
  if (raw.startsWith('file:')) return true;
  if (!devUrl) return false;
  try {
    return new URL(raw).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}
