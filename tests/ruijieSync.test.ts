import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __resetRuijieSyncForTests,
  getRuijieSyncState,
  isRuijieSyncCircuitOpen,
  isThrottleError,
  nextRuijieSyncDelayMs,
  noteRuijieSyncSuccess,
  RUIJIE_SYNC_BREAKER_COOLDOWN_MS,
  RUIJIE_SYNC_BREAKER_THRESHOLD,
  RUIJIE_SYNC_MAX_PER_MINUTE,
  RUIJIE_SYNC_MIN_GAP_MS,
  RuijieCircuitOpenError,
  throttledRuijieCall,
} from '../src/services/ruijieSync';
import { RuijieApiError } from '../src/services/ruijieErrors';

/**
 * Pacing queue + circuit breaker around every outbound Ruijie call.
 *
 * Ruijie's tenant quota is tiny and its failure mode is `{ code: 44 }`, so the
 * background pool refill must (a) never ask more than ~10 times a minute and
 * (b) stop asking altogether for a while once it is being throttled. Every test
 * drives an injected clock, so nothing here waits a real seven seconds.
 */

const START = 1_700_000_000_000;

function makeClock() {
  let t = START;
  const now = () => t;
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  const advance = (ms: number) => {
    t += ms;
  };
  return { now, sleep, advance };
}

const throttle = () => {
  throw new RuijieApiError(44, 'Too many requests');
};

beforeEach(() => {
  __resetRuijieSyncForTests();
  vi.restoreAllMocks();
});

describe('pacing queue', () => {
  it('lets the first call through immediately', async () => {
    const clock = makeClock();
    await expect(
      throttledRuijieCall(async () => 'ok', { now: clock.now, sleep: clock.sleep })
    ).resolves.toBe('ok');
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('enforces the minimum gap between two calls', async () => {
    const clock = makeClock();
    await throttledRuijieCall(async () => 1, { now: clock.now, sleep: clock.sleep });
    await throttledRuijieCall(async () => 2, { now: clock.now, sleep: clock.sleep });

    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(clock.sleep.mock.calls[0][0]).toBe(RUIJIE_SYNC_MIN_GAP_MS);
    expect(RUIJIE_SYNC_MIN_GAP_MS).toBeGreaterThanOrEqual(6_000);
    expect(RUIJIE_SYNC_MIN_GAP_MS).toBeLessThanOrEqual(10_000);
  });

  it('never exceeds the per-minute ceiling, even when asked back-to-back', async () => {
    const clock = makeClock();
    // `immediate` behaves like an explicit operator action: it skips the wait
    // but is still recorded against the rolling window.
    for (let i = 0; i < RUIJIE_SYNC_MAX_PER_MINUTE; i += 1) {
      await throttledRuijieCall(async () => i, { immediate: true, now: clock.now });
    }
    expect(getRuijieSyncState(clock.now()).callsLastMinute).toBe(RUIJIE_SYNC_MAX_PER_MINUTE);

    await throttledRuijieCall(async () => 'next', { now: clock.now, sleep: clock.sleep });

    // The queue had to wait for the oldest call to age out of the window.
    expect(clock.sleep).toHaveBeenCalled();
    expect(clock.sleep.mock.calls[0][0]).toBeGreaterThan(0);
    expect(RUIJIE_SYNC_MAX_PER_MINUTE).toBeLessThanOrEqual(11);
    expect(nextRuijieSyncDelayMs(clock.now())).toBeGreaterThanOrEqual(0);
    expect(getRuijieSyncState(clock.now()).callsLastMinute).toBeLessThanOrEqual(RUIJIE_SYNC_MAX_PER_MINUTE);
  });
});

describe('throttle detection', () => {
  it('recognises Ruijie code 44', () => {
    expect(isThrottleError(new RuijieApiError(44, 'Too many requests'))).toBe(true);
    expect(isThrottleError(new RuijieApiError(1, 'invalid params'))).toBe(false);
  });

  it('recognises HTTP 429 and 503 surfaced by the HTTP client', () => {
    expect(isThrottleError({ response: { status: 429 }, message: 'Request failed' })).toBe(true);
    expect(isThrottleError({ status: 503, message: 'Service Unavailable' })).toBe(true);
    expect(isThrottleError({ response: { status: 500 }, message: 'boom' })).toBe(false);
  });

  it('recognises throttle wording in a plain error', () => {
    expect(isThrottleError(new Error('Too Many Requests'))).toBe(true);
    expect(isThrottleError(new Error('quota exhausted for tenant'))).toBe(true);
    expect(isThrottleError(new Error('socket hang up'))).toBe(false);
  });
});

describe('circuit breaker', () => {
  it('opens after consecutive throttles and refuses to call again', async () => {
    const clock = makeClock();

    for (let i = 0; i < RUIJIE_SYNC_BREAKER_THRESHOLD; i += 1) {
      await expect(
        throttledRuijieCall(throttle, { immediate: true, now: clock.now, sleep: clock.sleep })
      ).rejects.toBeInstanceOf(RuijieApiError);
      clock.advance(RUIJIE_SYNC_MIN_GAP_MS);
    }

    expect(isRuijieSyncCircuitOpen(clock.now())).toBe(true);
    expect(getRuijieSyncState(clock.now()).consecutiveThrottles).toBe(RUIJIE_SYNC_BREAKER_THRESHOLD);

    const fn = vi.fn(async () => 'never');
    await expect(
      throttledRuijieCall(fn, { immediate: true, now: clock.now, sleep: clock.sleep })
    ).rejects.toBeInstanceOf(RuijieCircuitOpenError);
    // The whole point: no request left the process while the breaker is open.
    expect(fn).not.toHaveBeenCalled();
  });

  it('inherits RuijieApiError/code 44 so every existing isRateLimitError branch handles it', () => {
    const err = new RuijieCircuitOpenError(5_000);
    expect(err).toBeInstanceOf(RuijieApiError);
    expect(Number(err.code)).toBe(44);
  });

  it('closes again after the cooldown', async () => {
    const clock = makeClock();
    for (let i = 0; i < RUIJIE_SYNC_BREAKER_THRESHOLD; i += 1) {
      await expect(
        throttledRuijieCall(throttle, { immediate: true, now: clock.now, sleep: clock.sleep })
      ).rejects.toBeInstanceOf(RuijieApiError);
    }
    expect(isRuijieSyncCircuitOpen(clock.now())).toBe(true);

    clock.advance(RUIJIE_SYNC_BREAKER_COOLDOWN_MS + 1);
    expect(isRuijieSyncCircuitOpen(clock.now())).toBe(false);

    await expect(
      throttledRuijieCall(async () => 'recovered', { immediate: true, now: clock.now })
    ).resolves.toBe('recovered');
  });

  it('a success resets the consecutive-throttle counter', async () => {
    const clock = makeClock();
    await expect(
      throttledRuijieCall(throttle, { immediate: true, now: clock.now })
    ).rejects.toBeInstanceOf(RuijieApiError);
    expect(getRuijieSyncState(clock.now()).consecutiveThrottles).toBe(1);

    await throttledRuijieCall(async () => 'ok', { immediate: true, now: clock.now });
    noteRuijieSyncSuccess();
    expect(getRuijieSyncState(clock.now()).consecutiveThrottles).toBe(0);
    expect(isRuijieSyncCircuitOpen(clock.now())).toBe(false);
  });

  it('re-throws non-throttle errors without tripping the breaker', async () => {
    const clock = makeClock();
    const boom = new Error('socket hang up');
    await expect(
      throttledRuijieCall(
        async () => {
          throw boom;
        },
        { immediate: true, now: clock.now }
      )
    ).rejects.toBe(boom);

    const state = getRuijieSyncState(clock.now());
    expect(state.consecutiveThrottles).toBe(0);
    expect(state.circuitOpen).toBe(false);
  });
});

describe('telemetry', () => {
  it('counts calls, throttles and total wait', async () => {
    const clock = makeClock();
    await throttledRuijieCall(async () => 1, { now: clock.now, sleep: clock.sleep });
    await throttledRuijieCall(async () => 2, { now: clock.now, sleep: clock.sleep });
    await expect(
      throttledRuijieCall(throttle, { now: clock.now, sleep: clock.sleep })
    ).rejects.toBeInstanceOf(RuijieApiError);

    const state = getRuijieSyncState(clock.now());
    expect(state.totalCalls).toBe(3);
    expect(state.totalThrottles).toBe(1);
    expect(state.totalWaitMs).toBeGreaterThanOrEqual(RUIJIE_SYNC_MIN_GAP_MS);
    expect(state.lastError).toContain('Too many requests');
  });
});
