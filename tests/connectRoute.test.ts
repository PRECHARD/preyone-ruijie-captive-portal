import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

// Regression coverage for the gateway's "Portal URL" target.
//
// The EG105G-P Portal URL is a single static string, so wherever it points is
// the first screen every captive client sees. It used to be /login, which
// serves the account sign-in form — a dead end for a customer who only has a
// voucher code. /connect serves the voucher box instead.
//
// The gateway's authorization depends on query params (?client_mac, ?login_url,
// ?nas_ip, ?ssid) that arrive with the redirected request. portal.js forwards
// them by appending location.search to the signup URL, so /connect must serve
// the SAME index.html as / rather than a stripped-down page.
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

const PUBLIC_PATHS_THAT_REACH_ROUTES = [
  '/login',
  '/account',
  '/forgot-password',
  '/reset-password',
  '/connect',
];

// Mirrors the wifi.preyone.com branch + page aliases from src/index.ts.
function createWifiApp() {
  const app = express();

  app.use((req, res, next) => {
    const host = String(req.headers.host || '').split(':')[0];
    if (host === 'wifi.preyone.com') {
      res.setHeader('X-Captive-Portal', 'true');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      if (PUBLIC_PATHS_THAT_REACH_ROUTES.includes(req.path)) {
        return next();
      }
      delete req.headers['range'];
      delete req.headers['if-range'];
      return express.static(PUBLIC_DIR)(req, res, () => {
        res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
      });
    }
    return next();
  });

  app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'account-login.html')));
  app.get('/connect', (_req, res) => {
    res.setHeader('X-Captive-Portal', 'true');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  return app;
}

describe('gateway portal URL: /connect', () => {
  let app: express.Express;
  beforeAll(() => {
    app = createWifiApp();
  });

  it('serves the voucher form, not the account sign-in form', async () => {
    const res = await request(app).get('/connect').set('Host', 'wifi.preyone.com');

    expect(res.status).toBe(200);
    // The voucher box lives in index.html; the sign-in form does not.
    expect(res.text).toContain('id="quick-form"');
    expect(res.text).toContain('name="voucherCode"');
    expect(res.text).not.toContain('account-login');
  });

  it('sets captive-portal headers so the OS interception popup fires', async () => {
    const res = await request(app).get('/connect').set('Host', 'wifi.preyone.com');

    expect(res.headers['x-captive-portal']).toBe('true');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('still serves the account sign-in form at /login (no regression)', async () => {
    const res = await request(app).get('/login').set('Host', 'wifi.preyone.com');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('id="quick-form"');
  });

  it('ignores gateway query params when choosing the page', async () => {
    const res = await request(app)
      .get('/connect?client_mac=AA:BB:CC:DD:EE:FF&login_url=http%3A%2F%2F192.168.1.1%3A2060%2Fext_login&ssid=Preyone')
      .set('Host', 'wifi.preyone.com');

    expect(res.status).toBe(200);
    expect(res.text).toContain('id="quick-form"');
  });
});

// Static guarantees the redirect flow depends on. If portal.js ever stops
// forwarding location.search, /connect would render but could never authorize a
// device — a silent, high-cost regression.
describe('gateway param forwarding', () => {
  const portalJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'portal.js'), 'utf8');

  it('appends the current query string to the signup request', () => {
    expect(portalJs).toContain('new URLSearchParams(location.search)');
    expect(portalJs).toMatch(/'\/api\/auth\/signup\?'\s*\+\s*voucherParams\.toString\(\)/);
  });

  it('navigates to the server-built ext_login URL without rewriting it', () => {
    // redirectToSuccess() must hand the URL over untouched — re-encoding the
    // query is what previously produced duplicate/corrupted params.
    expect(portalJs).toMatch(/location\.href\s*=\s*json\.redirectUrl/);
  });

  it('points the sign-in page at /connect', () => {
    const login = fs.readFileSync(path.join(PUBLIC_DIR, 'account-login.html'), 'utf8');
    expect(login).toContain('href="/connect"');
  });
});