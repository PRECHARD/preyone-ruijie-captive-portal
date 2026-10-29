import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Request-level error alert inside the Connect Now popup.
 *
 * public/css/portal.css is generated from public/css/portal/*.css by
 * `npm run build:portal-css`, so these assertions read the built file: a rule
 * that only lands in a partial and skips the build never reaches the browser.
 */

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

const html = read('public/index.html');
const portalCss = read('public/css/portal.css');
const portalJs = read('public/js/portal.js');

function formErrorMarkup(): string {
  const start = html.indexOf('id="form-error"');
  expect(start).toBeGreaterThan(-1);
  // The block ends at the closing </div> of the alert, after the text span.
  const end = html.indexOf('</div>', html.indexOf('id="form-error-text"', start));
  return html.slice(start, end);
}

describe('#form-error — alert container', () => {
  it('is a single alert row with an inline warning icon and a text span', () => {
    const markup = formErrorMarkup();

    expect(markup).toContain('class="form-alert hidden"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('class="form-alert__icon"');
    expect(markup).toContain('<svg');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('id="form-error-text"');
    expect(markup).toContain('class="form-alert__text"');
  });

  it('no longer carries .field-error, so the message cannot render twice', () => {
    // `.field-error` is the small inline hint under a single input; sharing it
    // with the request-level alert is what produced stacked duplicate text.
    expect(formErrorMarkup()).not.toContain('field-error');
    expect(html).toMatch(/id="form-error" class="form-alert hidden"/);
  });

  it('keeps the field-level hint hook for the voucher input', () => {
    // The per-field span stays: empty-input validation still reports there.
    expect(html).toContain('<span class="field-error" id="err-connectVoucherCode"></span>');
  });
});

describe('#form-error — high-tech alert styling', () => {
  const rule = () => {
    const block = portalCss.match(/\n\.form-alert \{([^}]*)\}/);
    expect(block, '.form-alert rule missing from portal.css').not.toBeNull();
    return block![1];
  };

  it('uses the crimson glow container from the brief', () => {
    const css = rule();
    expect(css).toContain('background: rgba(255, 59, 48, 0.12)');
    expect(css).toContain('border: 1px solid rgba(255, 59, 48, 0.3)');
    expect(css).toContain('border-radius: 8px');
    expect(css).toContain('padding: 12px 16px');
    expect(css).toContain('color: #ff453a');
    expect(css).toContain('font-size: 0.875rem');
    expect(css).toContain('font-weight: 500');
    expect(css).toContain('display: flex');
    expect(css).toContain('align-items: center');
    expect(css).toContain('gap: 10px');
  });

  it('fades and slides the alert in when it is toggled on', () => {
    expect(rule()).toContain('animation: alert-slide-in');
    expect(portalCss).toMatch(/@keyframes alert-slide-in \{[\s\S]{0,160}translateY\(-6px\)/);
    expect(portalCss).toMatch(/@keyframes alert-slide-in \{[\s\S]{0,240}opacity: 1; transform: translateY\(0\)/);
  });

  it('provides a shake for repeat failures and respects reduced motion', () => {
    expect(portalCss).toMatch(/@keyframes alert-shake \{[\s\S]{0,300}translateX\(-5px\)/);
    expect(portalCss).toMatch(/\.form-alert\.is-shaking \{[^}]*animation: alert-shake/);
    expect(portalCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,160}\.form-alert\.is-shaking \{[\s\S]{0,80}animation: none;/,
    );
  });

  it('hides the alert without leaving a gap', () => {
    expect(portalCss).toMatch(/\.form-alert\.hidden \{[^}]*display: none;/);
  });
});

describe('portal.js — single-source error reporting', () => {
  it('writes the message into the text span, not the container', () => {
    expect(portalJs).toContain("getElementById('form-error-text')");
    expect(portalJs).toMatch(/if \(connectErrorText\) connectErrorText\.textContent = text;/);
  });

  it('re-triggers the shake with a reflow between class toggles', () => {
    expect(portalJs).toContain("connectError.classList.remove('is-shaking')");
    expect(portalJs).toContain('void connectError.offsetWidth');
    expect(portalJs).toContain("connectError.classList.add('is-shaking')");
  });

  it('never duplicates the same sentence in the field hint and the alert', () => {
    // Failure path: clear the field hint, show the alert.
    expect(portalJs).toMatch(
      /setFieldError\('connectVoucherCode', ''\);\s*showConnectError\(message\);/,
    );
    // Required-input path: field hint only, no alert.
    expect(portalJs).not.toMatch(/setFieldError\('connectVoucherCode', 'Voucher code is required\.'\);\s*showConnectError/);
  });

  it('does not blank the container when resetting (that would drop the icon)', () => {
    expect(portalJs).not.toMatch(/connectError\.textContent = ''/);
    expect(portalJs).toMatch(/var feText = document\.getElementById\('form-error-text'\);/);
  });
});

describe('portal.js — redemption handshake', () => {
  it('lowercases and trims the voucher code before the request', () => {
    expect(portalJs).toMatch(
      /var code = \(input && input\.value \? input\.value : ''\)\.replace\(\/\\s\+\/g, ''\)\.toLowerCase\(\)\.trim\(\);/,
    );
  });

  it('posts to the local redemption route with the gateway params', () => {
    expect(portalJs).toContain("fetch('/api/portal/redeem?' + query");
    expect(portalJs).toContain('clientMac: gatewayContext.mac || undefined');
    expect(portalJs).toContain('clientIp: gatewayContext.ip || undefined');
  });

  it('follows redirectUrl, then authUrl, then the success page', () => {
    expect(portalJs).toMatch(
      /location\.href = data\.redirectUrl \|\| data\.authUrl \|\| '\/success\.html';/,
    );
  });

  it('shows a Connected state before navigating away', () => {
    expect(portalJs).toContain("'Connected! Redirecting\\u2026'");
  });
});

describe('asset versions', () => {
  it('cache-busts the CSS and JS that changed', () => {
    expect(html).toContain('/css/portal.css?v=52');
    expect(html).toContain('/js/portal.js?v=34');
  });
});
