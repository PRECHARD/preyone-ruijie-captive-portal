import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { marketingRouter } from '../src/routes/marketing';

/**
 * The Home Automation SPA renders each marketing page from these endpoints.
 * If a slug drifts, the nav still works but the page falls into its "signal
 * lost" state, so pin every path the navbar links to.
 */

const app = express();
app.use('/api', marketingRouter);

const PAGES: Array<[string, string]> = [
  ['/api/platform', 'platform'],
  ['/api/scenes', 'scenes'],
  ['/api/security', 'security'],
  ['/api/solutions/lighting', 'solutions/lighting'],
  ['/api/solutions/climate', 'solutions/climate'],
  ['/api/solutions/audio', 'solutions/audio'],
  ['/api/how-it-works', 'how-it-works'],
];

describe('marketing page endpoints', () => {
  it.each(PAGES)('%s returns the %s page', async (path, slug) => {
    const res = await request(app).get(path).expect(200);

    expect(res.body.slug).toBe(slug);
    expect(typeof res.body.eyebrow).toBe('string');
    expect(typeof res.body.title).toBe('string');
    expect(typeof res.body.lede).toBe('string');
    expect(res.body.stats.length).toBeGreaterThan(0);
    expect(res.body.cards.length).toBeGreaterThan(0);
    expect(res.body.cta.label).toBeTruthy();
    expect(res.body.cta.href).toMatch(/^\//);
  });

  it('caches public page JSON at the edge', async () => {
    const res = await request(app).get('/api/platform').expect(200);
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain('max-age=300');
  });

  it('exposes a solutions index with all three links', async () => {
    const res = await request(app).get('/api/solutions').expect(200);
    expect(res.body.solutions.map((solution: { href: string }) => solution.href)).toEqual([
      '/solutions/lighting',
      '/solutions/climate',
      '/solutions/audio',
    ]);
  });

  it('returns contact channels and a call CTA', async () => {
    const res = await request(app).get('/api/contact').expect(200);
    expect(res.body.channels.length).toBeGreaterThanOrEqual(4);
    expect(res.body.channels.some((channel: { href?: string }) => channel.href === 'mailto:support@preyone.com?subject=Preyone%20Home%20automation%20enquiry')).toBe(true);
    expect(res.body.cta.href).toBe('tel:+263771327202');
  });

  it('does not claim unrelated /api paths', async () => {
    await request(app).get('/api/not-a-marketing-page').expect(404);
  });
});
