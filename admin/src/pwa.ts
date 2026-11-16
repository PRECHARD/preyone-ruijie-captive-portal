/**
 * PWA bootstrap for the Preyone Admin Console (admin.preyone.com).
 *
 * The service worker lives in `public/sw.js` so it is served verbatim from the
 * site root (a service worker's scope cannot exceed its own path). Registration
 * is production-only: during `vite dev` an active worker would keep serving a
 * stale shell and mask HMR updates.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  // admin/dist is also served on starlink.preyone.com; the customer portal there
  // must not inherit the admin PWA's offline shell.
  if (window.location.hostname.startsWith('starlink.')) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      console.warn('[pwa] service worker registration failed', error);
    });
  });
}
