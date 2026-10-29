import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Footer layout, payment badges and loading spinner on the captive portal.
 *
 * public/css/portal.css is generated from public/css/portal/*.css by
 * `npm run build:portal-css`, so these assertions read the built file: if a
 * rule only lands in a partial and the build is not re-run, the deployed CSS
 * silently loses it.
 */

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

const html = read('public/index.html');
const portalCss = read('public/css/portal.css');
const portalJs = read('public/js/portal.js');

function footerQuickLinks(): string {
  const match = html.match(/<div class="footer-col footer-col--links">([\s\S]*?)<\/div>/);
  expect(match, 'Quick Links footer column missing').not.toBeNull();
  return match![1];
}

function footerPaymentBadges(): string {
  const start = html.indexOf('<div class="payment-badges">');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('</div>', start);
  return html.slice(start, end);
}

describe('footer — Quick Links layout', () => {
  it('marks the Quick Links column so it can be laid out on its own', () => {
    expect(html).toContain('class="footer-col footer-col--links"');
    expect(footerQuickLinks()).toContain('Check My Data');
    expect(footerQuickLinks()).toContain('View Packages');
  });

  it('stacks the links vertically from mobile-up to desktop', () => {
    expect(portalCss).toMatch(
      /\.footer-col--links \.footer-links \{[^}]*grid-template-columns: 1fr;/,
    );
  });

  it('keeps the links compact and side-by-side on phones', () => {
    expect(portalCss).toMatch(
      /@media \(max-width: 600px\) \{[\s\S]{0,400}\.footer-col--links \.footer-links \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
  });
});

describe('footer — Secure Payments rail badges', () => {
  it('shows EcoCash, InnBucks and O\'mari side by side', () => {
    const badges = footerPaymentBadges();
    expect(badges).toContain('pay-logos pay-logos--footer');
    expect(badges).toContain('/img/pay/ecocash.png?v=41');
    expect(badges).toContain('/img/pay/innbucks.png?v=41');
    expect(badges).toContain('/img/pay/omari.webp?v=41');
    expect(badges).toContain('alt="EcoCash"');
    expect(badges).toContain('alt="InnBucks"');
    expect(badges).toContain('alt="O\'mari"');
  });

  it('gives every rail badge the same box and image size', () => {
    expect(portalCss).toMatch(
      /\.pay-logos--footer \.pay-logo--img \{[^}]*height: 36px;[^}]*min-width: 96px;/,
    );
    expect(portalCss).toMatch(
      /\.pay-logos--footer \.pay-logo--img img \{[^}]*width: 72px;[^}]*height: 18px;[^}]*object-fit: contain;/,
    );
    expect(portalCss).toMatch(/\.pay-logos--footer \{[^}]*flex-wrap: wrap;/);
  });
});

describe('payment modal badges — behind-the-scenes preload', () => {
  it('preloads the exact badge URLs the modal renders', () => {
    for (const url of ['/img/pay/ecocash.png?v=41', '/img/pay/innbucks.png?v=41', '/img/pay/omari.webp?v=41']) {
      expect(html).toMatch(new RegExp(`<link rel="preload" as="image" href="${url.replace(/[?]/g, '\\?')}"`));
      // Same cache key as the markup portal.js injects.
      expect(portalJs).toContain(url);
    }
  });

  it('leaves the modal badge dimensions untouched', () => {
    // Guard rail for "keep their current display size": these are the existing
    // values, not something this change is allowed to edit.
    expect(portalCss).toMatch(/\.pay-method__logo img \{[\s\S]{0,400}max-height: 22px !important;/);
    expect(portalCss).toMatch(/\.pay-method__logo img \{[\s\S]{0,400}max-width: 85% !important;/);
  });
});

describe('Sign Up button matches the Buy Now CTA', () => {
  it('uses the package-card gradient, display font and pill radius', () => {
    const block = portalCss.match(/\.hero-btn-group #signup-now-btn \{([^}]*)\}/);
    expect(block, '#signup-now-btn rule missing').not.toBeNull();
    expect(block![1]).toContain('linear-gradient(90deg, #ff00cc, #3333ff)');
    expect(block![1]).toContain('font-family: var(--display)');
    expect(block![1]).toContain('font-size: 1.3rem');
    expect(block![1]).toContain('border-radius: 50px');
  });

  it('mirrors the Buy Now hover glow and pulse', () => {
    expect(portalCss).toMatch(
      /\.hero-btn-group #signup-now-btn:hover,[\s\S]{0,300}\.hero-btn-group #signup-now-btn:focus-visible \{[^}]*linear-gradient\(90deg, #00d4ff, #ff00ff\)[^}]*animation: pulse-glow/,
    );
    expect(portalCss).toMatch(/@keyframes pulse-glow/);
  });
});

describe('page-load spinner', () => {
  it('shows the branded overlay while a page is loading', () => {
    expect(html).toContain('<div class="body-loading" id="bodyLoading"');
    expect(html).not.toMatch(/id="bodyLoading"[^>]*style="display:\s*none/);
    expect(portalCss).toMatch(/\.body-loading \{[^}]*position: fixed;[^}]*inset: 0;/);
    expect(portalCss).toMatch(/\.body-loading\.is-hidden \{[^}]*visibility: hidden;/);
  });

  it('re-shows the spinner for same-origin navigation and clears it on restore', () => {
    expect(html).toContain("overlay.classList.remove('is-hidden')");
    expect(html).toContain("closest('a[href]')");
    expect(html).toContain("url.origin !== location.origin");
    expect(html).toContain("window.addEventListener('pageshow', hide)");
  });

  it('guards against sideways scrolling on small screens', () => {
    expect(portalCss).toMatch(/body\.portal-body \{[\s\S]{0,700}overflow-x: hidden;/);
  });
});
