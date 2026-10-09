import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildRuijieSuccessUrl } from '../src/utils/redirect';

const makeReq = (query: Record<string, string> = {}, url = 'http://localhost/'): any => ({
  query,
  protocol: 'http',
  get: () => 'localhost',
});

describe('buildRuijieSuccessUrl', () => {
  const originalEnv = process.env.RUIJIE_SUCCESS_URL;

  beforeEach(() => {
    delete process.env.RUIJIE_SUCCESS_URL;
  });

  afterEach(() => {
    process.env.RUIJIE_SUCCESS_URL = originalEnv;
  });

  it('uses RUIJIE_SUCCESS_URL when configured and appends the token', () => {
    process.env.RUIJIE_SUCCESS_URL = 'https://example.com/success';
    const url = buildRuijieSuccessUrl(makeReq(), { sessionToken: 'abc-123' });
    expect(url).toBe('https://example.com/success?token=abc-123');
  });

  it('falls back to success.html for unsafe redirect URLs', () => {
    const url = buildRuijieSuccessUrl(makeReq({ url: 'https://attacker.com' }), { sessionToken: 'abc-123' });
    expect(url).toBe('http://localhost/success.html?token=abc-123');
  });

  it('allows same-origin redirect URLs', () => {
    const url = buildRuijieSuccessUrl(makeReq({ url: '/success.html' }), { sessionToken: 'abc-123' });
    expect(url).toBe('http://localhost/success.html?token=abc-123');
  });

  it('sets only the session params that were supplied', () => {
    const url = buildRuijieSuccessUrl(makeReq(), {
      sessionToken: 'abc-123',
      ssid: 'HomeNet',
      voucherCode: 'PREY-1',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('token')).toBe('abc-123');
    expect(parsed.searchParams.get('ssid')).toBe('HomeNet');
    expect(parsed.searchParams.get('voucher')).toBe('PREY-1');
    expect(parsed.searchParams.has('nas_ip')).toBe(false);
  });

  // iOS CNA does not reliably execute the JS background POST that success.html
  // uses, so when an ext_login URL and a MAC are known the client is sent there
  // directly with the normalized MAC the gateway expects.
  it('redirects straight to ext_login when a login URL and MAC are known', () => {
    const url = buildRuijieSuccessUrl(makeReq(), {
      sessionToken: 'abc-123',
      loginUrl: 'https://gw.example.com/ext_login',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      voucherCode: 'PREY-1',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://gw.example.com/ext_login');
    expect(parsed.searchParams.get('mac')).toBe('AABBCCDDEEFF');
    expect(parsed.searchParams.get('client_mac')).toBe('AA:BB:CC:DD:EE:FF');
    expect(parsed.searchParams.get('username')).toBe('PREY-1');
    expect(parsed.searchParams.get('next_url')).toBeTruthy();
  });
});
