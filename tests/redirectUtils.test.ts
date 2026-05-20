import { describe, it, expect } from 'vitest';
import { isSafeSameOriginUrl, buildRuijieSuccessUrlLegacy } from '../src/utils/redirect';

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
