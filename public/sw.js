/*
 * Preyone UltraNet WiFi — service worker for the /data PWA usage portal.
 *
 * Scope discipline (read before editing)
 * --------------------------------------
 * This worker is registered ONLY by /data, but because it is served from the
 * origin root its default scope is "/". It deliberately does NOT intercept the
 * whole origin. The fetch handler touches exactly two things:
 *
 *   1. Navigations to /data           -> network-first, cached shell as fallback
 *   2. The explicit APP_SHELL assets  -> cache-first
 *
 * Everything else falls straight through to the network untouched:
 *
 *   - Captive-portal detection probes (/generate_204, /hotspot-detect.html,
 *     /ncsi.txt, /connecttest.txt, /wispr). The OS and the Ruijie gateway hit
 *     these to decide whether the phone is still captive. Serving them from
 *     cache keeps the device in a permanent "Sign in to network" loop.
 *   - Every /api/* response. Usage figures must never be shown stale.
 *   - The portal's own index.html and all other portal pages.
 */

const VERSION = 'v2';
const SHELL_CACHE = `preyone-shell-${VERSION}`;
const ASSET_CACHE = `preyone-assets-${VERSION}`;
const ACTIVE_CACHES = [SHELL_CACHE, ASSET_CACHE];

// App shell for the offline usage view. Everything here is same-origin,
// cacheable, and small. Items are fetched individually at install so a single
// 404 (e.g. an image not yet promoted) cannot fail the whole install.
const APP_SHELL = [
  '/data',
  '/manifest.json',
  '/css/portal.css',
  '/favicon/web-app-manifest-192x192.png',
  '/favicon/web-app-manifest-512x512.png',
  '/favicon/apple-touch-icon.png',
  '/favicon/favicon.svg',
];

// Paths that must ALWAYS reach the network. Never cached, never served from
// cache — see the header note on captive-portal detection.
const NETWORK_ONLY_PREFIXES = [
  '/api/',
  '/generate_204',
  '/hotspot-detect.html',
  '/ncsi.txt',
  '/connecttest.txt',
  '/wispr',
  '/downloads/',
];

function isNetworkOnly(pathname) {
  return NETWORK_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

// Only the usage portal is handled; any other navigation passes through so the
// captive portal keeps loading live from the server.
function isUsageNavigation(pathname) {
  return pathname === '/data' || pathname.startsWith('/data/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // allSettled, not all: one missing asset must not abort installation.
      await Promise.allSettled(APP_SHELL.map((url) => cache.add(url).catch(() => null)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Drop caches from older VERSIONs only; never touch other origins' work.
      await Promise.all(
        keys
          .filter((key) => key.startsWith('preyone-') && !ACTIVE_CACHES.includes(key))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

// ── Threshold notifications (the /data PWA alert channel) ──────────────────
// /data shows its advisory in-page too, so nothing here is load-bearing for
// correctness — this is what makes the alert land in the OS notification tray
// and what tapping it does: focus a running /data, else open one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/data';
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of open) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })()
  );
});

// Reserved for server-sent pushes (Web Push + VAPID) — until those are wired,
// the payload simply never arrives and this changes nothing.
self.addEventListener('push', (event) => {
  let payload = { title: 'Preyone UltraNet', body: 'Check your data balance.', url: '/data' };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (e) {
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/favicon/web-app-manifest-192x192.png',
      badge: '/favicon/web-app-manifest-192x192.png',
      data: { url: payload.url || '/data' },
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never touch non-GET (form POSTs to the gateway ext_login live here).
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin (fonts, WhatsApp, analytics) — leave entirely alone.
  if (url.origin !== self.location.origin) return;

  // APIs and gateway/detection paths go straight to the network, uncached.
  if (isNetworkOnly(url.pathname)) return;

  const isNavigation = req.mode === 'navigate';

  // ── 1. /data navigations: network-first, cached shell when offline ──
  if (isNavigation && isUsageNavigation(url.pathname)) {
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  // Any other navigation (the captive portal itself) — do not intercept.
  if (isNavigation) return;

  // ── 2. App-shell assets: cache-first ──
  if (APP_SHELL.includes(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Everything else: browser default (network), uncached by this worker.
});

async function networkFirstNavigation(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put('/data', fresh.clone());
    return fresh;
  } catch (err) {
    const cached = (await cache.match('/data')) || (await caches.match('/data'));
    if (cached) return cached;
    // Last resort: a minimal offline notice rather than a browser error page.
    return new Response(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Offline — Preyone WiFi</title></head>' +
        '<body style="margin:0;background:#000;color:#fff;font-family:system-ui,sans-serif;' +
        'display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center">' +
        '<div style="padding:2rem"><h1 style="color:#00d4ff;font-size:1.4rem;margin:0 0 .5rem">You are offline</h1>' +
        '<p style="color:#94a3b8;margin:0">Reconnect to Preyone UltraNet WiFi to check your data usage.</p></div>' +
        '</body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) {
    // Refresh in the background so the next load is current (stale-while-revalidate).
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const url = new URL(req.url);
          const cacheName = url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')
            ? ASSET_CACHE
            : SHELL_CACHE;
          caches.open(cacheName).then((c) => c.put(req, res.clone()));
        }
      })
      .catch(() => null);
    return cached;
  }

  const res = await fetch(req);
  if (res && res.ok) {
    const url = new URL(req.url);
    const cacheName = url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')
      ? ASSET_CACHE
      : SHELL_CACHE;
    const cache = await caches.open(cacheName);
    cache.put(req, res.clone());
  }
  return res;
}
