import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * "Connect Now" popup on the captive portal.
 *
 * The portal has no bundler: index.html, portal.css and portal.js are served
 * straight off disk, so a renamed id or a dropped CSS block is a silent 404 in
 * production and nothing else in the suite would notice. These assertions pin
 * the contract between the three files.
 */

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

const html = read('public/index.html');
const portalCss = read('public/css/portal.css');
const portalJs = read('public/js/portal.js');

function heroButtonGroup(): string {
  const match = html.match(/<div class="hero-btn-group">([\s\S]*?)<\/div>/);
  expect(match, 'hero button group missing from index.html').not.toBeNull();
  return match![1];
}

describe('index.html — hero CTA pair', () => {
  it('places Connect Now side by side with Sign Up Now in one flex group', () => {
    const group = heroButtonGroup();
    expect(group).toContain('id="connectNowBtn"');
    expect(group).toContain('id="signUpBtn"');
    // Both are direct children of the same group, so they share one line.
    expect(group).not.toContain('<div');
  });

  it('labels the popup trigger and points it at the dialog', () => {
    expect(html).toMatch(
      /id="connectNowBtn"[\s\S]{0,200}aria-expanded="false"[\s\S]{0,200}aria-controls="connect-form-modal"/
    );
  });

  it('ships the hidden popup form with a labelled voucher input and both close paths', () => {
    expect(html).toContain('id="connect-form-modal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('id="connect-form"');
    expect(html).toContain('id="connectVoucherCode"');
    expect(html).toContain('id="err-connectVoucherCode"');
    expect(html).toContain('id="connect-submit-btn"');
    expect(html).toContain('id="connect-form-close"');
    expect(html).toContain('id="connect-cancel-btn"');
    expect(html).toContain('id="connect-form-error"');
  });

  it('keeps the legacy quick-connect card so nothing regresses if the popup is unused', () => {
    expect(html).toContain('id="quick-form"');
    expect(html).toContain('id="accessCode"');
  });

  it('cache-busts the assets that changed', () => {
    expect(html).toMatch(/portal\.css\?v=4[89]|portal\.css\?v=[5-9]\d/);
    expect(html).toMatch(/portal\.js\?v=3[1-9]|portal\.js\?v=[4-9]\d/);
  });
});

describe('portal.css — Preyone dark glassmorphism', () => {
  it('hides the popup by default and shows it only with .is-open', () => {
    expect(portalCss).toMatch(/#connect-form-modal \{[^}]*display: none;/);
    expect(portalCss).toMatch(/#connect-form-modal\.is-open \{[^}]*display: flex;/);
  });

  it('uses the exact theme values from the brief', () => {
    expect(portalCss).toContain('rgba(10, 15, 29, 0.95)');
    expect(portalCss).toContain('1px solid rgba(0, 204, 255, 0.3)');
    expect(portalCss).toContain('#00ccff');
    expect(portalCss).toContain("'Plus Jakarta Sans'");
    // Frosted glass: the card must actually blur what is behind it.
    expect(portalCss).toMatch(/\.connect-modal-card \{[\s\S]{0,900}backdrop-filter: blur\(/);
  });

  it('styles the Connect Now button as a neon-cyan glass CTA beside Sign Up Now', () => {
    expect(portalCss).toMatch(/\.hero-btn-group \.hero-connect-btn--connect \{[\s\S]{0,400}rgba\(0, 204, 255, 0\.55\)/);
    expect(portalCss).toMatch(/\.hero-btn-group \.hero-connect-btn--connect:hover/);
  });

  it('locks page scroll while the popup is open and respects reduced motion', () => {
    expect(portalCss).toMatch(/body\.connect-modal-open \{[^}]*overflow: hidden;/);
    expect(portalCss).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('portal.js — popup wiring and gateway context', () => {
  it('toggles the popup from the button, the close/cancel buttons, Escape and click-outside', () => {
    expect(portalJs).toContain("getElementById('connectNowBtn')");
    expect(portalJs).toContain("getElementById('connect-form-modal')");
    expect(portalJs).toContain("['connect-form-close', 'connect-cancel-btn']");
    expect(portalJs).toContain("event.target === connectModal");
    expect(portalJs).toMatch(/event\.key === 'Escape'/);
  });

  it('extracts the client MAC and IP from every gateway alias, never from nas_ip', () => {
    expect(portalJs).toContain('function extractGatewayContext');
    expect(portalJs).toContain("'clientmac', 'mac', 'macaddress', 'stamac'");
    expect(portalJs).toContain("'clientip', 'ip', 'ipaddress', 'wlanuserip'");
    expect(portalJs).toContain('extractGatewayContext(location.search)');
    // The gateway address must never be mistaken for the station address.
    expect(portalJs).not.toMatch(/GATEWAY_IP_KEYS[^\n]*nasip/);
  });

  it('posts the PIN plus the resolved device identity to the local redemption route', () => {
    expect(portalJs).toContain("fetch('/api/portal/redeem?' + query");
    expect(portalJs).toMatch(/clientMac: gatewayContext\.mac/);
    expect(portalJs).toMatch(/clientIp: gatewayContext\.ip/);
    // Gateway params must ride in the query string (a POST body loses them).
    expect(portalJs).toContain("qs.set('client_mac', gatewayContext.mac)");
    expect(portalJs).toContain("qs.set('client_ip', gatewayContext.ip)");
  });

  it('shows a loading state, an inline error, and hands the server URL straight over', () => {
    expect(portalJs).toContain('function setConnectLoading');
    expect(portalJs).toContain('function showConnectError');
    expect(portalJs).toContain("'Connected \\u2014 redirecting\\u2026'");
    // redirectToSuccess() stays the single navigation point (never rebuilt here).
    expect(portalJs).toMatch(/location\.href\s*=\s*json\.redirectUrl/);
  });

  it('no longer double-binds Connect Now through the old scroll handler', () => {
    expect(portalJs).not.toMatch(/Connect Now button — scroll to quick form/);
  });
});
