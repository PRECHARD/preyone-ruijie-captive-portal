import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every public page is served straight off disk, so a reference to an asset that
 * is not there is a silent 404 in production — no build step, no bundler to fail.
 * That is how the loading spinner survived as a 105 KB base64-PNG-in-SVG on five
 * separate pages, and how a deleted image can break pages that nothing else tests.
 */
describe('public asset references', () => {
  const publicDir = path.join(process.cwd(), 'public');
  const pages = readdirSync(publicDir).filter((f) => f.endsWith('.html'));

  it('has pages to check', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  for (const page of pages) {
    it(`${page} only references assets that exist`, () => {
      const html = readFileSync(path.join(publicDir, page), 'utf8');
      const refs = new Set<string>();
      for (const m of html.matchAll(/\/(?:images|css|js)\/[A-Za-z0-9._-]+/g)) {
        // Strip cache-busting query strings before hitting the filesystem.
        refs.add(m[0].split('?')[0]);
      }

      const missing = [...refs].filter((r) => !existsSync(path.join(publicDir, r.slice(1))));
      expect(missing, `missing assets referenced by ${page}`).toEqual([]);
    });
  }

  it('serves responsive logo variants rather than one oversized PNG', () => {
    const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');

    // The header logo must offer AVIF + WebP srcsets so phones fetch ~14 KB
    // instead of the 236 KB original, and be preloaded so it is discovered early.
    expect(html).toContain('/images/preyonenoneglow-logo-400.avif 400w');
    expect(html).toContain('/images/preyonenoneglow-logo-800.avif 800w');
    expect(html).toContain('/images/preyonenoneglow-logo-400.webp 400w');
    expect(html).toContain('rel="preload" as="image" type="image/avif"');
    expect(html).not.toMatch(/<img[^>]+src="\/images\/preyonenoneglow-logo-optimized\.png"/);
  });

  it('does not reintroduce the base64-raster loading spinner', () => {
    // faviconloading.svg was a 79 KB PNG base64-encoded inside an SVG, 105 KB on
    // the wire, painted at 40x40 px as the first thing the portal renders.
    for (const page of pages) {
      const html = readFileSync(path.join(publicDir, page), 'utf8');
      expect(html, `${page} still references faviconloading.svg`).not.toContain('faviconloading.svg');
    }
  });
});
