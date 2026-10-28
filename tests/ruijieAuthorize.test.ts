import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Post-redemption cloud MAC authorisation.
 *
 * The customer-visible path is ext_login + FreeRADIUS, so this hook is strictly
 * best-effort: it must never throw, never block, and must stay out of the way
 * when Ruijie is unconfigured, throttled, or has an open circuit breaker.
 */

vi.mock('../src/services/ruijieCloud', () => ({
  isRuijieCloudConfigured: vi.fn(() => true),
  authorizeRuijieClient: vi.fn(),
}));

import { isRuijieCloudConfigured, authorizeRuijieClient } from '../src/services/ruijieCloud';
import { RuijieApiError } from '../src/services/ruijieErrors';
import {
  AUTHORIZE_HARD_FAILURE_BACKOFF_MS,
  authorizeClientAfterRedeem,
  normalizeClientMac,
  RUIJIE_AUTHORIZE_TIMEOUT_MS,
  __resetAuthorizeBackoffForTests,
} from '../src/services/ruijieAuthorize';
import { __resetRuijieSyncForTests } from '../src/services/ruijieSync';

// Real clock (the shared circuit breaker timestamps with Date.now) plus a
// no-op sleeper, so pacing never actually waits in a unit test.
const sleep = async () => undefined;

function authorize(target: Parameters<typeof authorizeClientAfterRedeem>[0]) {
  return authorizeClientAfterRedeem(target, { sleep });
}

describe('normalizeClientMac', () => {
  it('accepts colons, dashes and bare hex', () => {
    expect(normalizeClientMac('aa:bb:cc:dd:ee:ff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeClientMac('aa-bb-cc-dd-ee-ff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeClientMac('aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('rejects anything that is not 12 hex digits', () => {
    expect(normalizeClientMac('aa:bb:cc')).toBe('');
    expect(normalizeClientMac('')).toBe('');
    expect(normalizeClientMac(null)).toBe('');
    expect(normalizeClientMac(12345)).toBe('');
  });
});

describe('authorizeClientAfterRedeem', () => {
  const originalFlag = process.env.RUIJIE_AUTHORIZE_ON_REDEEM;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetRuijieSyncForTests();
    __resetAuthorizeBackoffForTests();
    (isRuijieCloudConfigured as any).mockReturnValue(true);
    delete process.env.RUIJIE_AUTHORIZE_ON_REDEEM;
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.RUIJIE_AUTHORIZE_ON_REDEEM;
    else process.env.RUIJIE_AUTHORIZE_ON_REDEEM = originalFlag;
  });

  it('pushes the normalised MAC with a 5s request timeout', async () => {
    (authorizeRuijieClient as any).mockResolvedValue({ macAddress: 'AA:BB:CC:DD:EE:FF', code: 0 });

    const result = await authorize({ macAddress: 'aa-bb-cc-dd-ee-ff', voucherCode: 'e7wj7w' });

    expect(result).toEqual({ attempted: true, authorized: true, degraded: false });
    expect(authorizeRuijieClient).toHaveBeenCalledWith(
      expect.objectContaining({
        macAddress: 'AA:BB:CC:DD:EE:FF',
        voucherCode: 'e7wj7w',
        timeoutMs: RUIJIE_AUTHORIZE_TIMEOUT_MS,
      })
    );
    expect(RUIJIE_AUTHORIZE_TIMEOUT_MS).toBe(5_000);
  });

  it('skips (without a call) when the gateway supplied no usable MAC', async () => {
    const result = await authorize({ macAddress: null });

    expect(result).toMatchObject({ attempted: false, degraded: true, reason: 'no_client_mac' });
    expect(authorizeRuijieClient).not.toHaveBeenCalled();
  });

  it('skips when Ruijie Cloud is not configured', async () => {
    (isRuijieCloudConfigured as any).mockReturnValue(false);

    const result = await authorize({ macAddress: 'AA:BB:CC:DD:EE:FF' });

    expect(result).toMatchObject({ attempted: false, reason: 'not_configured' });
    expect(authorizeRuijieClient).not.toHaveBeenCalled();
  });

  it('can be switched off per deployment without a code change', async () => {
    process.env.RUIJIE_AUTHORIZE_ON_REDEEM = 'false';

    const result = await authorize({ macAddress: 'AA:BB:CC:DD:EE:FF' });

    expect(result).toMatchObject({ attempted: false, reason: 'disabled' });
    expect(authorizeRuijieClient).not.toHaveBeenCalled();
  });

  it('never throws when Ruijie throttles (code 44)', async () => {
    (authorizeRuijieClient as any).mockRejectedValue(new RuijieApiError(44, 'Too many requests'));

    const result = await authorize({ macAddress: 'AA:BB:CC:DD:EE:FF' });

    expect(result.attempted).toBe(true);
    expect(result.authorized).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toMatch(/too many requests/i);
  });

  it('never throws when the HTTP call times out', async () => {
    (authorizeRuijieClient as any).mockRejectedValue(new Error('timeout of 5000ms exceeded'));

    const result = await authorize({ macAddress: 'AA:BB:CC:DD:EE:FF' });

    expect(result).toMatchObject({ attempted: true, authorized: false, degraded: true });
    expect(result.reason).toMatch(/timeout/i);
  });

  it('parks the hook after a hard rejection instead of spending quota per redemption', async () => {
    // A tenant that does not expose auth/authorize rejects every time; retrying
    // on each redemption would silently burn the API quota.
    (authorizeRuijieClient as any).mockRejectedValue(new Error('route not found'));
    await authorize({ macAddress: 'AA:BB:CC:DD:EE:FF' });
    (authorizeRuijieClient as any).mockClear();

    const result = await authorize({ macAddress: 'AA:BB:CC:DD:EE:FF' });

    expect(result).toMatchObject({ attempted: false, reason: 'backing_off' });
    expect(authorizeRuijieClient).not.toHaveBeenCalled();
    expect(AUTHORIZE_HARD_FAILURE_BACKOFF_MS).toBe(15 * 60 * 1000);
  });

  it('stops hammering once the shared circuit breaker is open', async () => {
    (authorizeRuijieClient as any).mockRejectedValue(new RuijieApiError(44, 'Too many requests'));
    // Three consecutive throttles open the breaker for every background caller.
    await authorize({ macAddress: 'AA:BB:CC:DD:EE:FF' });
    await authorize({ macAddress: 'AA:BB:CC:DD:EE:FF' });
    await authorize({ macAddress: 'AA:BB:CC:DD:EE:FF' });
    (authorizeRuijieClient as any).mockClear();

    const result = await authorize({ macAddress: 'AA:BB:CC:DD:EE:FF' });

    expect(result).toMatchObject({ attempted: false, reason: 'circuit_open' });
    expect(authorizeRuijieClient).not.toHaveBeenCalled();
  });
});
