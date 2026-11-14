import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const pub = (f: string) => readFileSync(path.join(process.cwd(), 'public', f), 'utf8');
const html = pub('data.html');
const sw = pub('sw.js');
const index = pub('index.html');

/**
 * /data is served straight off disk (no bundler — see portalAssets.test.ts),
 * so its alerting, purchase CTA and unlimited-bundle rendering can only be
 * guarded by asserting the shipped markup/JS. These are the contracts from
 * the 2026-10-15 alerting work: tell the customer when a voucher ends, push
 * them to buy at 80%/exhaustion, and never render an unlimited bundle as a
 * percentage.
 */
describe('/data PWA — advisory, alerting and unlimited rendering', () => {
  it('shows the advisory banner wired to the purchase section', () => {
    expect(html).toContain('id="usageAlert"');
    expect(html).toContain('id="alertTitle"');
    expect(html).toContain('id="alertBody"');
    expect(html).toContain('href="/#packages-section"');
    expect(html).toContain('ENTER NEW PIN');
    // the fragment must actually exist or the buy link lands nowhere
    expect(index).toContain('id="packages-section"');
  });

  it('warns at 80% and on exhaustion, once per voucher, in ULTRANET copy', () => {
    expect(html).toContain('WARN_PCT = 80');
    expect(html).toContain('pct >= WARN_PCT');
    expect(html).toContain('ULTRANET // DATA THRESHOLD');
    expect(html).toContain('ULTRANET // BUNDLE EXHAUSTED');
    expect(html).toContain('ULTRANET // VOUCHER ENDED');
    expect(html).toContain("markSeen(kind)");
    expect(html).toContain("'preyone_seen_' + kind + '_' + state.voucher");
    // system notification only after permission; toast always fires
    expect(html).toContain("Notification.permission === 'granted'");
    expect(html).toContain('reg.showNotification(title');
  });

  it('offers the alert-permission opt-in as an explicit tap', () => {
    expect(html).toContain('id="alertsBtn"');
    expect(html).toContain('ENABLE DATA ALERTS');
    expect(html).toContain('DATA ALERTS: ON');
  });

  it('blanks stale figures when a stored PIN dies so a new PIN can be checked', () => {
    expect(html).toContain('function handleNotFound');
    expect(html).toContain('handleNotFound()');
    // dead PIN stops the 15s poll; a fresh manual entry restarts it
    expect(html).toContain('stopPolling()');
    expect(html).toContain('startPolling()');
    // a just-typed PIN is kept for editing (typo), a stored one is cleared
    expect(html).toContain("state.lastEntry = 'manual'");
    expect(html).toContain("state.lastEntry === 'manual'");
    // old numbers must never sit next to the new-PIN form
    expect(html).toContain("$('dataUsageNumbers').textContent = '— / —'");
  });

  it('renders unlimited bundles as Unlimited, never a percentage', () => {
    expect(html).toContain("isUncapped ? 'Unlimited' : fmtMBOnly(remaining)");
    expect(html).toContain("isUncapped ? 'Unlimited' : fmtMBOnly(total)");
    expect(html).toContain("fmtMB(used) + ' / ' + (isUncapped ? 'Unlimited'");
    expect(html).toContain("isUncapped ? 'UNLIMITED' : pct.toFixed(1) + '%'");
    expect(html).toContain('data-bar-fill--unlimited');
    expect(html).toContain('data-usage-pct--unlimited');
    // the exhausted state can only happen on a capped bundle
    expect(html).toContain('exhausted = !isUncapped');
  });

  it('arms the OS notification channel from the service worker', () => {
    expect(sw).toContain("VERSION = 'v2'");
    expect(sw).toContain("addEventListener('notificationclick'");
    expect(sw).toContain("addEventListener('push'");
    expect(sw).toContain('self.registration.showNotification');
    // tapping an alert must land on /data, not a blank window
    expect(sw).toContain("event.notification.data.url");
    expect(sw).toContain("'/data'");
  });
});

/**
 * Hybrid channel contracts (2026-10-15): the backend sweep owns the 80/95
 * thresholds; /data subscribes the browser to Web Push inside the opt-in
 * click and renders server-pending events; the captive landing page shows
 * the same pending alerts so a bounced customer sees them even with push
 * off. The payload keys asserted here are the exact ones the SW consumes.
 */
describe('/data + captive portal — hybrid alert channel', () => {
  it('aligns /data client thresholds with the 80/95 tiers', () => {
    expect(html).toContain('var CRIT_PCT = 95');
    expect(html).toContain('pct >= CRIT_PCT');
    expect(html).toContain('ULTRANET // RUNNING DRY');
    expect(html).toContain("notify('low95'");
  });

  it('subscribes to Web Push from the alerts opt-in click', () => {
    expect(html).toContain('function ensurePushSubscription');
    expect(html).toContain('/api/alerts/public-key');
    expect(html).toContain('reg.pushManager.subscribe');
    expect(html).toContain('/api/alerts/subscribe');
    expect(html).toContain('urlBase64ToUint8Array');
    // iOS/Android: subscription must be created inside the click gesture
    expect(html).toContain('ensurePushSubscription();');
  });

  it('renders server-pending alerts with ack-backed dismiss on /data', () => {
    expect(html).toContain('function fetchPendingAlerts');
    expect(html).toContain('/api/alerts/pending');
    expect(html).toContain('function ackAlert');
    expect(html).toContain('/api/alerts/ack');
    expect(html).toContain("'preyone_evt_' + top.id");
  });

  it('injects the same pending-alert banner into the captive landing page', () => {
    expect(index).toContain('portalAlertBanner');
    expect(index).toContain('/api/alerts/pending');
    expect(index).toContain('/api/alerts/ack');
    expect(index).toContain("localStorage.getItem('user_voucher')");
    // buy path from the captive banner lands on the packages section
    expect(index).toContain("buy.href = '/#packages-section'");
  });

  it('shows the install button on iOS where beforeinstallprompt never fires', () => {
    expect(html).toContain('id="installBtn"');
    expect(html).toContain('var isIOS');
    expect(html).toContain('navigator.standalone');
    // iOS has no programmatic install: button up front + Share steps
    expect(html).toContain('Add to Home Screen');
    expect(html).toContain("installBtn').hidden = false");
    // the Android path still rides the deferred prompt
    expect(html).toContain("addEventListener('beforeinstallprompt'");
    // once installed, the button disappears again
    expect(html).toContain('function hideInstall');
  });

  it('renders unlimited usage as "used / Unlimited" dynamically on /data', () => {
    expect(html).toContain("fmtMB(used) + ' / ' + (isUncapped ? 'Unlimited'");
    expect(html).toContain("isUncapped ? 'Unlimited' : fmtMBOnly(remaining)");
  });
});
