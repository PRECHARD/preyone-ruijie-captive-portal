import { describe, expect, it } from 'vitest';
import { cookieAuthAllowed, isTrustedAppHost } from '../src/utils/ssoCookie';

function req(host: string, origin?: string) {
  return {
    hostname: host,
    headers: { host, ...(origin ? { origin } : {}) },
    get: (name: string) => (name === 'origin' ? origin : undefined),
  } as any;
}

describe('admin SSO cookie hosts', () => {
  it('trusts the signed-in app hosts and local development', () => {
    expect(isTrustedAppHost('invoice.preyone.com')).toBe(true);
    expect(isTrustedAppHost('pos.preyone.com:443')).toBe(true);
    expect(isTrustedAppHost('localhost')).toBe(true);
    expect(isTrustedAppHost('preyone.com')).toBe(false);
    expect(isTrustedAppHost('wifi.preyone.com')).toBe(false);
    expect(isTrustedAppHost('www.preyone.com')).toBe(false);
  });

  it('refuses a cookie presented to an app host from the public site', () => {
    expect(cookieAuthAllowed(req('invoice.preyone.com'))).toBe(true);
    expect(cookieAuthAllowed(req('invoice.preyone.com', 'https://invoice.preyone.com'))).toBe(true);
    expect(cookieAuthAllowed(req('invoice.preyone.com', 'https://preyone.com'))).toBe(false);
    expect(cookieAuthAllowed(req('wifi.preyone.com'))).toBe(false);
  });
});
