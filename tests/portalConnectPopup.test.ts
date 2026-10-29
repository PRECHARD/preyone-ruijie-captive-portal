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
 *
 * The hero no longer carries a static voucher card — the PIN box lives in the
 * popup only, and the hero shows "Connect Now" beside "Sign Up Now".
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

function connectModalMarkup(): string {
  const start = html.indexOf('id="connect-form-modal"');
  expect(start, 'connect popup missing from index.html').toBeGreaterThan(-1);
  const end = html.indexOf('</form>', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('index.html — hero CTA pair', () => {
  it('places Connect Now side by side with Sign Up Now in one flex group', () => {
    const group = heroButtonGroup();
    expect(group).toContain('id="connect-now-btn"');
    expect(group).toContain('id="signup-now-btn"');
    expect(group).toMatch(/class="btn btn-primary"[^>]*id="connect-now-btn"/);
    expect(group).toMatch(/class="btn btn-secondary"[^>]*id="signup-now-btn"/);
    // Both are direct children of the same group, so they share one line.
    expect(group).not.toContain('<div');
  });

  it('labels the popup trigger and points it at the dialog', () => {
    expect(html).toMatch(
      /id="connect-now-btn"[\s\S]{0,200}aria-expanded="false"[\s\S]{0,200}aria-controls="connect-form-modal"/
    );
    // Rendered label is uppercase: Bebas Neue is caps-only anyway, and the
    // markup now matches the CTA labels used elsewhere on the portal.
    expect(html).toContain('aria-controls="connect-form-modal">CONNECT NOW</button>');
  });

  it('no longer ships the static voucher card in the hero', () => {
    expect(html).not.toContain('id="quick-card"');
    expect(html).not.toContain('id="quick-form"');
    expect(html).not.toContain('id="accessCode"');
    expect(html).not.toContain('hero-card--quick');
  });

  it('ships the hidden popup with the exact brief copy', () => {
    const modal = connectModalMarkup();

    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain('>Connect Now To Preyone WiFi</h2>');
    expect(modal).toContain('>Preyone Voucher code</label>');
    expect(modal).toContain('placeholder="xxxxxx"');

    // Field hook stays stable so setFieldError('connectVoucherCode', …) works.
    expect(modal).toContain('id="connect-form"');
    expect(modal).toContain('id="connectVoucherCode"');
    expect(modal).toContain('id="err-connectVoucherCode"');

    // Submit + both close paths + the request-level error slot.
    expect(modal).toContain('id="quick-submit-btn"');
    expect(modal).toContain('id="connect-form-close"');
    expect(modal).toContain('id="connect-cancel-btn"');
    expect(modal).toContain('id="form-error"');
  });

  it('accepts lowercase voucher PINs instead of forcing caps', () => {
    const modal = connectModalMarkup();
    // Preyone PINs are lowercase (`vnq4wx`); the field must not auto-capitalise
    // or visually uppercase what the customer types.
    expect(modal).toContain('autocapitalize="none"');
    expect(modal).not.toContain('autocapitalize="characters"');

    const inputBlock = portalCss.match(/\.connect-field input \{([^}]*)\}/);
    expect(inputBlock, '.connect-field input rule missing').not.toBeNull();
    expect(inputBlock![1]).not.toContain('text-transform: uppercase');
    expect(inputBlock![1]).toContain('text-transform: none');
  });

  it('normalises typed voucher codes to lowercase in portal.js', () => {
    expect(portalJs).toContain('lowercaseVoucherInput.addEventListener');
    expect(portalJs).toMatch(/String\(this\.value \|\| ''\)\.toLowerCase\(\)/);
  });

  it('cache-busts the assets that changed', () => {
    expect(html).toMatch(/portal\.css\?v=4[89]|portal\.css\?v=[5-9]\d/);
    expect(html).toMatch(/portal\.js\?v=3[2-9]|portal\.js\?v=[4-9]\d/);
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
    // Frosted glass: the popup must actually blur what is behind it.
    expect(portalCss).toMatch(/backdrop-filter: blur\(12px\)/);
  });

  it('lays the hero CTA pair out as a flex row with a 12px gap', () => {
    expect(portalCss).toMatch(
      /\.hero-btn-group \{[^}]*display: flex;[^}]*flex-direction: row;[^}]*gap: 12px;/,
    );
    expect(portalCss).toMatch(/\.hero-btn-group \.btn-primary \{[\s\S]{0,400}rgba\(0, 204, 255, 0\.55\)/);
    expect(portalCss).toMatch(/\.hero-btn-group \.btn-secondary \{/);
  });

  it('stacks the pair on narrow screens without dropping the flex container', () => {
    expect(portalCss).toMatch(
      /@media \(max-width: 420px\) \{[\s\S]{0,500}\.hero-btn-group \{[^}]*flex-direction: column;/,
    );
  });

  it('locks page scroll while the popup is open and respects reduced motion', () => {
    expect(portalCss).toMatch(/body\.connect-modal-open \{[^}]*overflow: hidden;/);
    expect(portalCss).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('portal.js — popup wiring and gateway context', () => {
  it('toggles the popup from the button, the close/cancel buttons, Escape and click-outside', () => {
    expect(portalJs).toContain("getElementById('connect-now-btn')");
    expect(portalJs).toContain("getElementById('connect-form-modal')");
    expect(portalJs).toContain("['connect-form-close', 'connect-cancel-btn']");
    expect(portalJs).toContain('event.target === connectModal');
    expect(portalJs).toMatch(/event\.key === 'Escape'/);
  });

  it('binds the popup submit button and its error slot from the new ids', () => {
    expect(portalJs).toContain("getElementById('quick-submit-btn')");
    expect(portalJs).toContain("getElementById('form-error')");
    expect(portalJs).toContain("setFieldError('connectVoucherCode'");
  });

  it('does not reference the removed quick-connect card ids', () => {
    expect(portalJs).not.toContain("getElementById('quick-form')");
    expect(portalJs).not.toContain("getElementById('accessCode')");
    expect(portalJs).not.toContain("getElementById('quick-buy-btn')");
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
    expect(portalJs).toContain("'Connected! Redirecting\\u2026'");
    // redirectToSuccess() stays the single navigation point (never rebuilt here).
    expect(portalJs).toMatch(/location\.href = data\.redirectUrl \|\| data\.authUrl \|\| '\/success\.html'/);
  });

  it('no longer double-binds Connect Now through the old scroll handler', () => {
    expect(portalJs).not.toMatch(/Connect Now button — scroll to quick form/);
  });
});
