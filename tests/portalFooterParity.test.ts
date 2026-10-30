import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * One footer design across every WiFi page.
 *
 * The footer on wifi.preyone.com (public/index.html) is the reference: the
 * Quick Links column stacks vertically, the Secure Payments rail shows
 * EcoCash / InnBucks / O'mari artwork, and the copyright year is filled in.
 * /data and /terms must ship the same block, only re-indented to their nesting
 * depth, so a change on the landing page can never silently drift away from the
 * pages customers actually see mid-session.
 */

const read = (p: string) => readFileSync(path.join(process.cwd(), 'public', p), 'utf8');

const FOOTER_OPEN = '<footer class="portal-footer main-footer">';

function footerLines(file: string): string[] {
  const lines = read(file).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === FOOTER_OPEN);
  expect(start, `<footer> missing from ${file}`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > start && line.trim() === '</footer>');
  expect(end, '</footer> missing from ' + file).toBeGreaterThan(-1);
  return lines.slice(start, end + 1);
}

/** Remove the page's nesting indentation so blocks are comparable. */
function dedent(lines: string[]): string {
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)![0].length);
  const min = Math.min(...indents);
  return lines.map((line) => line.slice(min)).join('\n');
}

/**
 * /data and /terms have no packages section, so their "View Packages" link has
 * to be absolute; everything else must match byte for byte.
 */
function normalize(block: string): string {
  return block.replace(
    'href="https://wifi.preyone.com/#packages-heading"',
    'href="#packages-heading"',
  );
}

const indexFooter = normalize(dedent(footerLines('index.html')));

const EVERY_PAGE = [
  'data.html',
  'terms.html',
  'account-login.html',
  'forgot-password.html',
  'manage-account.html',
  'reset-password.html',
  'success.html',
  'verify-email.html',
];

describe('footer parity across WiFi pages', () => {
  for (const page of EVERY_PAGE) {
    it(`${page} ships the same footer block as index.html`, () => {
      const block = normalize(dedent(footerLines(page)));
      expect(block).toBe(indexFooter);
    });

    it(`${page} carries the quick links + payment rail the design uses`, () => {
      const html = read(page);
      expect(html).toContain('class="footer-col footer-col--links"');
      expect(html).toContain('pay-logos pay-logos--footer');
      for (const badge of ['ecocash.png', 'innbucks.png', 'omari.webp']) {
        expect(html).toContain(`/img/pay/${badge}?v=41`);
      }
      expect(html).toContain('QUICK LINKS');
      expect(html).toContain('GET IN TOUCH');
      expect(html).toContain('FOLLOW US');
    });

    it(`${page} loads the portal CSS that styles that footer`, () => {
      // v52 is the build that added .footer-col--links and .pay-logos--footer;
      // an older query string pins these pages to the pre-redesign stylesheet.
      expect(read(page)).toMatch(/\/css\/portal\.css\?v=(5[2-9]|[6-9]\d)/);
    });
  }

  // Pages that load portal.js / account.js get the year from those bundles;
  // these ones carry the inline filler so the shared footer never renders blank.
  for (const page of [
    'data.html',
    'terms.html',
    'forgot-password.html',
    'reset-password.html',
    'success.html',
    'verify-email.html',
  ]) {
    it(`${page} fills the copyright year even without portal.js`, () => {
      expect(read(page)).toContain("querySelectorAll('#current-year')");
    });
  }

  it('does not render the footer inside the features grid on /terms', () => {
    // .features-strip is a 3-up card grid; the footer was being squeezed into a
    // single cell, which is why it looked nothing like the landing page.
    const html = read('terms.html');
    const strip = html.indexOf('<div class="features-strip">');
    const footer = html.indexOf(FOOTER_OPEN);
    expect(strip).toBe(-1);
    expect(footer).toBeGreaterThan(-1);
  });

  it('keeps /data and /terms mounting the footer inside .portal-shell', () => {
    for (const page of ['data.html', 'terms.html']) {
      const html = read(page);
      const footer = html.indexOf(FOOTER_OPEN);
      const shellBefore = html.lastIndexOf('<div class="portal-shell">', footer);
      expect(shellBefore, `${page} footer is not inside .portal-shell`).toBeGreaterThan(-1);

      // Walk the tags between the shell and the footer: depth 1 means the
      // footer is a direct child (the page's own card has closed by then),
      // which is what makes it span the page instead of sitting in a card.
      const between = html.slice(shellBefore, footer);
      let depth = 0;
      for (const tag of between.match(/<\/?div\b[^>]*>/g) || []) {
        depth += tag.startsWith('</') ? -1 : 1;
      }
      expect(depth, `${page} footer is nested deeper than .portal-shell`).toBe(1);
    }
  });
});
