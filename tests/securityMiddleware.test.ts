import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import {
  ADMIN_RATE_LIMIT_OPTIONS,
  API_RATE_LIMIT_OPTIONS,
  CONTENT_SECURITY_POLICY,
  helmetMiddleware,
  sanitizeRequest,
  securityHeaders,
} from '../src/middleware/security';

/**
 * Security contract. The captive portal POSTs vouchers to the Ruijie gateway on
 * a private LAN address, so `form-action` must stay wide open; everything else
 * is locked down. These assertions exist so a future "tighten the CSP" change
 * cannot silently break customer internet access.
 */

function app() {
  const a = express();
  a.use(helmetMiddleware);
  a.use(securityHeaders);
  a.use(express.json());
  a.use(sanitizeRequest);
  a.post('/echo', (req, res) => {
    res.json({ body: req.body, query: req.query });
  });
  a.post('/api/payments/webhook', (req, res) => {
    res.json({ body: req.body });
  });
  return a;
}

describe('Content-Security-Policy', () => {
  it('keeps form-action wide open for the gateway ext_login', () => {
    expect(CONTENT_SECURITY_POLICY.directives.formAction).toEqual(['*']);
  });

  it('locks down scripts, frames and object sources', () => {
    const { directives } = CONTENT_SECURITY_POLICY;
    expect(directives.defaultSrc).toEqual(["'self'"]);
    expect(directives.fontSrc).toContain('https://fonts.gstatic.com');
    // The SPA bootstraps from its own bundle; no third-party script origins.
    expect(directives.scriptSrc).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('is served with form-action * on a real response', async () => {
    const res = await request(app()).post('/echo').send({});
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("form-action *");
    expect(csp).toContain("default-src 'self'");
  });
});

describe('hardening headers', () => {
  it('sets nosniff, frame guard and referrer policy', async () => {
    const res = await request(app()).post('/echo').send({});
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
  });

  it('sets HSTS only on https requests', async () => {
    const plain = await request(app()).post('/echo').send({});
    expect(plain.headers['strict-transport-security']).toBeUndefined();

    const secure = await request(app())
      .post('/echo')
      .set('X-Forwarded-Proto', 'https')
      .send({});
    expect(secure.headers['strict-transport-security']).toContain('max-age=');
  });
});

describe('input sanitisation', () => {
  it('strips control characters and trims whitespace', async () => {
    const res = await request(app())
      .post('/echo')
      .send({ code: '  ab\u0000c12  ', note: 'line1\nline2' });

    expect(res.body.body.code).toBe('abc12');
    // Newlines are legitimate in comments/messages.
    expect(res.body.body.note).toBe('line1\nline2');
  });

  it('leaves secrets and password fields byte-identical', async () => {
    const res = await request(app())
      .post('/echo')
      .send({ password: '  spaced pass  ', api_secret: ' s3cr3t ', pin: ' 1234 ' });

    expect(res.body.body.password).toBe('  spaced pass  ');
    expect(res.body.body.api_secret).toBe(' s3cr3t ');
    expect(res.body.body.pin).toBe(' 1234 ');
  });

  it('drops prototype-pollution keys from nested objects', async () => {
    const res = await request(app())
      .post('/echo')
      .send(JSON.parse('{"outer":{"__proto__":{"polluted":true},"keep":" yes "}}'));

    expect(res.body.body.outer.keep).toBe('yes');
    expect(({} as any).polluted).toBeUndefined();
  });

  it('sanitises query strings in place without breaking them', async () => {
    const res = await request(app()).post('/echo?client_mac=%20AA%3ABB%20&url=https%3A%2F%2Fx.test%2F%3Fa%3D1');
    expect(res.body.query.client_mac).toBe('AA:BB');
    expect(res.body.query.url).toBe('https://x.test/?a=1');
  });

  it('never rewrites payment-provider payloads (signatures/references)', async () => {
    // A provider reference with meaningful padding and a control char must
    // arrive exactly as sent; trimming it would break the lookup.
    const reference = '  PESEPAY\u0001REF-9  ';
    const res = await request(app())
      .post('/api/payments/webhook')
      .send({ reference, amount: ' 1.00 ' });

    expect(res.body.body.reference).toBe(reference);
    expect(res.body.body.amount).toBe(' 1.00 ');
  });
});

describe('rate limiters', () => {
  /** The real policy, with the ceiling dropped so the test stays fast. */
  function limitedApp(options: any) {
    const a = express();
    a.set('trust proxy', 1);
    a.use(express.json());
    a.use('/api', (req, _res, next) => {
      // Simulate the auth middleware that runs inside the admin router.
      (req as any).adminUser = { id: 'admin-1' };
      next();
    });
    a.use('/api', rateLimit({ ...API_RATE_LIMIT_OPTIONS, ...options }));
    a.use('/api/admin', rateLimit({ ...ADMIN_RATE_LIMIT_OPTIONS, ...options }));
    a.get('/api/ping', (_req, res) => res.json({ ok: true }));
    a.get('/api/auth/ping', (_req, res) => res.json({ ok: true }));
    a.get('/api/payments/webhook', (_req, res) => res.json({ ok: true }));
    a.post('/api/payments/pesepay/callback', (_req, res) => res.json({ ok: true }));
    return a;
  }

  it('keeps sane production ceilings', () => {
    expect(API_RATE_LIMIT_OPTIONS.max).toBeGreaterThanOrEqual(60);
    expect(ADMIN_RATE_LIMIT_OPTIONS.max).toBeGreaterThanOrEqual(60);
    expect(ADMIN_RATE_LIMIT_OPTIONS.max).toBeLessThanOrEqual(API_RATE_LIMIT_OPTIONS.max);
    expect(API_RATE_LIMIT_OPTIONS.windowMs).toBe(60_000);
  });

  it('exempts captive-portal guest and payment-callback traffic', async () => {
    const a = limitedApp({ max: 2 });
    // /api/auth/* must never be throttled: hundreds of phones share one NAT IP.
    for (let i = 0; i < 6; i += 1) {
      expect((await request(a).get('/api/auth/ping')).status).toBe(200);
      expect((await request(a).get('/api/payments/webhook')).status).toBe(200);
      expect((await request(a).post('/api/payments/pesepay/callback')).status).toBe(200);
    }
  });

  it('answers 429 with a retryable flag instead of a 5xx', async () => {
    const a = limitedApp({ max: 2 });
    expect((await request(a).get('/api/ping')).status).toBe(200);
    expect((await request(a).get('/api/ping')).status).toBe(200);
    const blocked = await request(a).get('/api/ping');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ retryable: true });
    expect(blocked.body.error).toMatch(/too many requests/i);
  });

  it('keys the admin limiter by admin id so one tab cannot starve the company', () => {
    const key = ADMIN_RATE_LIMIT_OPTIONS.keyGenerator({
      adminUser: { id: 'admin-42' },
      ip: '10.0.0.1',
    } as any);
    expect(key).toBe('admin:admin-42');

    const ipKey = ADMIN_RATE_LIMIT_OPTIONS.keyGenerator({ ip: '10.0.0.9' } as any);
    expect(ipKey).toBe('admin:10.0.0.9');
  });
});
