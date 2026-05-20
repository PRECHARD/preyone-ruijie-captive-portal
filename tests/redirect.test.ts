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

  it('uses RUIJIE_SUCCESS_URL when configured and appends token', () => {
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
});
