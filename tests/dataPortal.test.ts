import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const pub = (f: string) => readFileSync(path.join(process.cwd(), 'public', f), 'utf8');
const html = pub('data.html');
const sw = pub('sw.js');
const index = pub('index.html');
const manifest = JSON.parse(pub('manifest.json'));

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
    expect(sw).toContain("VERSION = 'v3'");
    expect(sw).toContain("addEventListener('notificationclick'");
    expect(sw).toContain("addEventListener('push'");
    expect(sw).toContain('self.registration.showNotification');
    // tapping an alert must land on /data, not a blank window
    expect(sw).toContain("event.notification.data.url");
    expect(sw).toContain("'/data'");
  });

  it('never caches a captive-portal redirect as the offline /data shell', () => {
    expect(sw).toContain('function isSamePath');
    expect(sw).toContain("if (fresh && fresh.ok && isSamePath(fresh, '/data'))");
    expect(sw).toContain('if (!res.ok || !isSamePath(res, url)) return;');
  });

  it('normalizes a partial MAC instead of sending it to the usage API', () => {
    expect(html).toContain('function normalizeMac');
    expect(html).toContain("replace(/[^0-9a-fA-F]/g, '')");
    expect(html).toContain('var qMac = normalizeMac(qMacRaw)');
    expect(html).toContain('state.mac = m');
    expect(html).toContain('else localStorage.removeItem(LS_MAC)');
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

/**
 * 2026-11-22 record-keeping pass. The API now labels an uncapped plan with an
 * explicit `unlimited` flag, so the client must key every balance readout off
 * that flag rather than a null total, and must be able to show a customer the
 * records behind their own PIN (sessions + threshold events) plus an export.
 */
describe('/data PWA — unlimited everywhere and customer records', () => {
  it('treats the API unlimited flag as authoritative in every readout', () => {
    expect(html).toContain('var isUncapped = !!(j.unlimited || j.isUncapped);');
    expect(html).toContain("$('metricRemaining').textContent = isUncapped ? 'Unlimited' : fmtMBOnly(remaining)");
    expect(html).toContain("$('metricTotal').textContent = isUncapped ? 'Unlimited' : fmtMBOnly(total)");
    expect(html).toContain("$('detailCap').textContent = isUncapped ? 'Unlimited' : fmtMB(total)");
    expect(html).toContain("$('dataUsageRemaining').textContent = isUncapped ? 'Unlimited remaining'");
    expect(html).toContain("gv.setAttribute('class', 'gauge-value gauge-value--unlimited')");
    // SVGElement.className is read-only; assigning it throws in strict mode.
    expect(html).not.toContain("gv.className =");
    // The ∞ glyph is missing from several phone fonts; use a drawn icon.
    expect(html).toContain('id="gaugeInfinity"');
    expect(html).toContain("$('gaugeInfinity').removeAttribute('hidden')");
    expect(html).toContain("$('gaugeFigure').setAttribute('hidden', '')");
    // .chip/.btn display rules otherwise defeat the [hidden] attribute.
    expect(html).toContain('.data-body [hidden] { display: none !important; }');
    expect(html).toContain("$('metricExpires').textContent = fmtShortDate(j.expiresAt)");
  });

  it('renders the customer’s own sessions and alert history', () => {
    expect(html).toContain('/api/check-usage/history');
    expect(html).toContain('id="sessionHistory"');
    expect(html).toContain('id="alertHistory"');
    expect(html).toContain('function renderHistory');
    expect(html).toContain('Unlimited plans have no data cap');
    expect(html).toContain("'Unlimited' : fmtMBValue(a.totalMB)");
  });

  it('offers export, copy and print for record keeping', () => {
    expect(html).toContain('id="exportBtn"');
    expect(html).toContain('id="copyBtn"');
    expect(html).toContain('id="printBtn"');
    expect(html).toContain('URL.createObjectURL');
    expect(html).toContain('text/csv;charset=utf-8');
  });

  it('keeps the optional MAC behind an advanced disclosure', () => {
    expect(html).toContain('<details class="manual-adv">');
    expect(html).toContain('Advanced: device MAC (optional)');
    expect(html).toContain('id="manualMac"');
    // the gateway-provided MAC is still normalised and stored
    expect(html).toContain('state.mac = m');
  });

  it('lets the installed app rotate to landscape', () => {
    expect(manifest.orientation).toBe('any');
    expect(manifest.theme_color).toBe('#04060c');
  });
});

/**
 * 2026-11-22 brand-shell pass: the old portal header/footer are back, merged
 * with the PWA status actions and the new records UI. These assertions protect
 * that merge from drifting back to the slim app bar or the compact footer.
 */
describe('/data PWA — restored brand shell', () => {
  it('restores the old brand header with the Wi-Fi success mark', () => {
    expect(html).toContain('class="portal-header data-header"');
    expect(html).toContain('class="brand-logo-img"');
    expect(html).toContain('Fadaya nePreyone UltraNet Wifi');
    expect(html).toContain('class="data-top"');
    expect(html).toContain('id="dataTop"');
    expect(html).toContain('class="data-nav"');
    expect(html).toContain('id="dataNav"');
    expect(html).toContain('class="data-nav-actions"');
    // the little logo/ULTRANET strip the customer rejected is gone
    expect(html).not.toContain('data-nav-brand');
    expect(html).toContain('id="wifiState"');
    expect(html).toContain('wifi-icon--success');
    expect(html).toContain('function setWifi');
    expect(html).toContain('setWifi(j.active === true && j.onlineNow !== false)');
  });

  it('keeps the whole brand header sticky and frosted once scrolled', () => {
    expect(html).toContain('.data-top {');
    expect(html).toContain('position: sticky');
    expect(html).toContain('.data-top.is-scrolled');
    expect(html).toContain('backdrop-filter: blur(20px)');
    expect(html).toContain('function syncNav');
    expect(html).toContain("dataTop.classList.toggle('is-scrolled', y > 8)");
    // the banner compacts while stuck so it does not swallow the viewport
    expect(html).toContain('.data-top.is-scrolled .brand-logo-img { max-height: 64px; }');
  });

  it('gives the Wi-Fi mark a green/purple pulsing halo', () => {
    expect(html).toContain('id="wifi-grad"');
    expect(html).toContain('stroke="url(#wifi-grad)"');
    expect(html).toContain('@keyframes wifi-pulse');
    expect(html).toContain('conic-gradient(from 120deg, #25d366, #00d4ff, #a855f7, #25d366)');
    expect(html).toContain('.wifi-success::before');
  });

  it('restores the full portal footer', () => {
    expect(html).toContain('class="portal-footer main-footer"');
    expect(html).toContain('class="footer-grid"');
    expect(html).toContain('id="current-year"');
    expect(html).toContain('Secure Payments');
    expect(html).toContain('footer-follow-links');
  });

  it('keeps the WhatsApp FAB on the page', () => {
    expect(html).toContain('class="whatsapp-fab"');
    expect(html).not.toContain('.data-body .whatsapp-fab { display: none; }');
  });

  it('uses a six-character small-caps voucher placeholder', () => {
    expect(html).toContain('placeholder="abc123"');
    expect(html).toContain('maxlength="6"');
    expect(html).toContain('font-variant-caps: all-small-caps');
    expect(html).toContain('Voucher PINs are 6 letters or numbers.');
  });

  it('names the counter Preyone Voucher Count', () => {
    expect(html).toContain("ruijie_voucher: 'Preyone Voucher Count'");
    expect(html).not.toContain('Ruijie voucher counter');
  });
});
