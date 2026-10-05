import { describe, it, expect } from 'vitest';
import {
  isSafeSameOriginUrl,
  buildRuijieSuccessUrlLegacy,
  buildRuijieSuccessUrl,
} from '../src/utils/redirect';

describe('isSafeSameOriginUrl', () => {
  it('allows same-origin relative URLs', () => {
    expect(isSafeSameOriginUrl('/success.html', 'http://localhost')).toBe(true);
  });

  it('allows same-origin absolute URLs', () => {
    expect(isSafeSameOriginUrl('http://localhost/success.html', 'http://localhost')).toBe(true);
  });

  it('blocks cross-origin URLs', () => {
    expect(isSafeSameOriginUrl('https://attacker.com', 'http://localhost')).toBe(false);
  });

  it('blocks URLs with different scheme', () => {
    expect(isSafeSameOriginUrl('https://localhost/evil', 'http://localhost')).toBe(false);
  });

  it('blocks URLs with different port', () => {
    expect(isSafeSameOriginUrl('http://localhost:8080/evil', 'http://localhost')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isSafeSameOriginUrl('http://', 'http://localhost')).toBe(false);
  });
});

describe('buildRuijieSuccessUrlLegacy', () => {
  const makeReq = (query: Record<string, string> = {}) =>
    ({ query, protocol: 'http', get: () => 'localhost' }) as any;

  it('returns URL with token appended', () => {
    const url = buildRuijieSuccessUrlLegacy(makeReq(), 'token-abc');
    expect(url).toContain('token=token-abc');
  });
});

describe('buildRuijieSuccessUrl ext_login / WISPr', () => {
  const makeReq = (query: Record<string, string> = {}) =>
    ({ query, protocol: 'http', get: () => 'localhost' }) as any;

  const extConfig = {
    sessionToken: 'tok-1',
    macAddress: 'AA:BB:CC:DD:EE:FF',
    loginUrl: 'http://192.168.1.216:2060/ext_login',
    voucherCode: 'e7wj7w',
    originalUrl: 'https://example.com/page',
  };

  it('includes next_url pointing at the original target URL', () => {
    const url = new URL(buildRuijieSuccessUrl(makeReq(), extConfig));
    expect(url.searchParams.get('next_url')).toBe('https://example.com/page');
  });

  it('keeps next_url consistent with url and redirect', () => {
    const url = new URL(buildRuijieSuccessUrl(makeReq(), extConfig));
    expect(url.searchParams.get('next_url')).toBe(url.searchParams.get('url'));
    expect(url.searchParams.get('next_url')).toBe(url.searchParams.get('redirect'));
  });

  it('falls back to the default host when no original URL is known', () => {
    const url = new URL(
      buildRuijieSuccessUrl(makeReq(), { ...extConfig, originalUrl: undefined })
    );
    expect(url.searchParams.get('next_url')).toBe('http://preyone.com');
  });

  it('derives next_url from req.query.url when config.originalUrl is absent', () => {
    const req = makeReq({ url: 'https://news.example.org/story' });
    const url = new URL(buildRuijieSuccessUrl(req, { ...extConfig, originalUrl: undefined }));
    expect(url.searchParams.get('next_url')).toBe('https://news.example.org/story');
  });

  it('still sends WISPr credentials and MAC params', () => {
    const url = new URL(buildRuijieSuccessUrl(makeReq(), extConfig));
    expect(url.searchParams.get('username')).toBe('e7wj7w');
    expect(url.searchParams.get('password')).toBe('e7wj7w');
    expect(url.searchParams.get('mac')).toBe('AABBCCDDEEFF');
    expect(url.searchParams.get('client_mac')).toBe('AA:BB:CC:DD:EE:FF');
  });
});
