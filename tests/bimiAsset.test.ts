import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * BIMI sender avatar preparation.
 *
 * Gmail only shows a sender logo when the domain publishes a BIMI record that
 * points at an SVG Tiny PS ("tiny-ps") file plus a Verified Mark Certificate.
 * The logo is therefore a DNS-facing asset, not a page asset: a broken file, a
 * stray raster, a script or an oversized payload silently disables the avatar
 * for every recipient. It is also duplicated on purpose — preyone.com serves
 * `site/dist`, so the copy under `site/public` only reaches
 * https://preyone.com/images/bimi/ after a site build, while the `public` copy
 * is live on https://wifi.preyone.com immediately.
 *
 * See docs/BIMI-SENDER-AVATAR.md for the DNS records and VMC steps.
 */
describe('BIMI avatar asset', () => {
  const root = process.cwd();
  const copies = [
    path.join(root, 'public', 'images', 'bimi', 'preyone-bimi.svg'),
    path.join(root, 'site', 'public', 'images', 'bimi', 'preyone-bimi.svg'),
  ];

  it('ships the same SVG on the portal and the marketing site', () => {
    for (const file of copies) {
      expect(existsSync(file), `${file} is missing`).toBe(true);
    }
    const [a, b] = copies.map((f) => readFileSync(f, 'utf8'));
    expect(a).toBe(b);
  });

  it('stays inside the 32 KB BIMI limit', () => {
    for (const file of copies) {
      expect(statSync(file).size, `${file} is too large for BIMI`).toBeLessThanOrEqual(32 * 1024);
    }
  });

  it('declares the SVG Tiny PS profile with a square viewBox', () => {
    const svg = readFileSync(copies[0], 'utf8');
    const rootTag = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';

    expect(rootTag).toContain('version="1.2"');
    expect(rootTag).toContain('baseProfile="tiny-ps"');

    const viewBox = rootTag.match(/viewBox="([^"]+)"/)?.[1]?.trim().split(/[\s,]+/).map(Number);
    expect(viewBox, 'the SVG needs a viewBox').toBeDefined();
    expect(viewBox).toHaveLength(4);
    const [, , vbWidth, vbHeight] = viewBox as number[];
    expect(vbWidth).toBe(vbHeight);
    expect(vbWidth).toBeGreaterThan(0);

    expect(svg).toMatch(/<title>[^<]+<\/title>/);
  });

  it('contains no raster, script or external reference', () => {
    for (const file of copies) {
      const svg = readFileSync(file, 'utf8');
      const forbidden = [
        '<script',
        '<style',
        '<image',
        '<foreignObject',
        'xlink:href',
        'href=',
        '<use',
        'data:',
        'url(',
        '@import',
        '<iframe',
        '<animate',
        '<!--',
      ];
      for (const token of forbidden) {
        expect(svg.includes(token), `${path.basename(file)} contains ${token}`).toBe(false);
      }
      expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
      // The SVG namespace is the only URL a BIMI file may contain.
      const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
      expect(withoutNamespace).not.toMatch(/https?:\/\//);
    }
  });
});
