import { RATE_LIMIT_CODE, RuijieApiError, isRateLimitError } from './ruijieErrors';

/**
 * Throttled Ruijie synchronisation queue + circuit breaker.
 *
 * Ruijie's tenant API quota is tiny and its failure mode is unhelpful: HTTP 200
 * with `{ code: 44, msg: "Too many requests" }`, or a 429/503 when the gateway
 * in front of it gives up. Every background job that talks to Ruijie therefore
 * has to answer three questions:
 *
 *   1. how fast may I ask?          → a pacing queue, one call every 6-10s and
 *                                    never more than 11 per rolling minute;
 *   2. when should I stop asking?   → a circuit breaker that opens for a couple
 *                                    of minutes after repeated throttles;
 *   3. what does a throttle mean?   → nothing fatal: the pool already holds
 *                                    pre-minted stock, so the caller degrades
 *                                    instead of throwing a 5xx at a customer.
 *
 * Deliberately dependency-free (only `ruijieErrors`), so `voucherPool.ts` can
 * import it without an import cycle, and so it can be unit-tested with an
 * injected clock/sleep — no test ever waits seven real seconds.
 */

function intFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Spacing enforced between two outbound Ruijie calls (default 7s). */
export const RUIJIE_SYNC_MIN_GAP_MS = intFromEnv(process.env.RUIJIE_SYNC_MIN_GAP_MS, 7_000, 6_000, 10_000);
/** Rolling-window ceiling; hard-capped below 12/min by spec. */
export const RUIJIE_SYNC_MAX_PER_MINUTE = intFromEnv(process.env.RUIJIE_SYNC_MAX_PER_MINUTE, 10, 1, 11);
/** Consecutive throttles that trip the breaker. */
export const RUIJIE_SYNC_BREAKER_THRESHOLD = intFromEnv(process.env.RUIJIE_SYNC_BREAKER_THRESHOLD, 3, 1, 20);
/** How long the breaker stays open once tripped (default 2 minutes). */
export const RUIJIE_SYNC_BREAKER_COOLDOWN_MS = intFromEnv(
  process.env.RUIJIE_SYNC_BREAKER_COOLDOWN_MS,
  120_000,
  10_000,
  30 * 60_000
);

const WINDOW_MS = 60_000;

export interface RuijieSyncState {
  lastCallAt: number;
  callsLastMinute: number;
  consecutiveThrottles: number;
  circuitOpen: boolean;
  circuitRetryInMs: number;
  totalCalls: number;
  totalThrottles: number;
  totalWaitMs: number;
  lastError: string | null;
}

interface SyncState {
  lastCallAt: number;
  callTimes: number[];
  consecutiveThrottles: number;
  openUntil: number;
  totalCalls: number;
  totalThrottles: number;
  totalWaitMs: number;
  lastError: string | null;
}

function freshState(): SyncState {
  return {
    lastCallAt: 0,
    callTimes: [],
    consecutiveThrottles: 0,
    openUntil: 0,
    totalCalls: 0,
    totalThrottles: 0,
    totalWaitMs: 0,
    lastError: null,
  };
}

let state: SyncState = freshState();

export class RuijieCircuitOpenError extends RuijieApiError {
  readonly retryInMs: number;
  constructor(retryInMs: number) {
    super(
      RATE_LIMIT_CODE,
      `Ruijie sync paused for ${Math.max(1, Math.ceil(retryInMs / 1000))}s after repeated throttling`
    );
    this.name = 'RuijieCircuitOpenError';
    this.retryInMs = retryInMs;
  }
}

/**
 * Anything that means "stop asking for a while": Ruijie's code 44, an HTTP 429,
 * an HTTP 503, or a message that says so. Broader than
 * `isRateLimitError()` (which only knows `RuijieApiError`) because axios
 * surfaces gateway 429/503 as plain errors.
 */
export function isThrottleError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  const anyErr = err as { status?: number; response?: { status?: number }; message?: string } | null;
  const status = anyErr?.response?.status ?? anyErr?.status;
  if (status === 429 || status === 503) return true;
  return /too many requests|rate.?limit|quota exhausted/i.test(String(anyErr?.message ?? ''));
}

function pruneWindow(now: number): void {
  const cutoff = now - WINDOW_MS;
  if (state.callTimes.length > 0 && state.callTimes[0] <= cutoff) {
    state.callTimes = state.callTimes.filter((t) => t > cutoff);
  }
}

export function isRuijieSyncCircuitOpen(now: number = Date.now()): boolean {
  return state.openUntil > now;
}

/** Milliseconds the caller should wait before the next call is allowed. */
export function nextRuijieSyncDelayMs(now: number = Date.now()): number {
  pruneWindow(now);
  const gapWait = Math.max(0, RUIJIE_SYNC_MIN_GAP_MS - (now - state.lastCallAt));
  if (state.callTimes.length < RUIJIE_SYNC_MAX_PER_MINUTE) return gapWait;
  const windowWait = Math.max(0, state.callTimes[0] + WINDOW_MS - now);
  return Math.max(gapWait, windowWait);
}

export function getRuijieSyncState(now: number = Date.now()): RuijieSyncState {
  pruneWindow(now);
  return {
    lastCallAt: state.lastCallAt,
    callsLastMinute: state.callTimes.length,
    consecutiveThrottles: state.consecutiveThrottles,
    circuitOpen: isRuijieSyncCircuitOpen(now),
    circuitRetryInMs: Math.max(0, state.openUntil - now),
    totalCalls: state.totalCalls,
    totalThrottles: state.totalThrottles,
    totalWaitMs: state.totalWaitMs,
    lastError: state.lastError,
  };
}

/** Record the outcome of a completed call. Exported for callers that own their own loop. */
export function noteRuijieSyncSuccess(): void {
  state.consecutiveThrottles = 0;
  state.lastError = null;
}

export function noteRuijieSyncThrottle(err: unknown, now: number = Date.now()): void {
  state.consecutiveThrottles += 1;
  state.totalThrottles += 1;
  state.lastError = err instanceof Error ? err.message : String(err);
  if (state.consecutiveThrottles >= RUIJIE_SYNC_BREAKER_THRESHOLD) {
    state.openUntil = now + RUIJIE_SYNC_BREAKER_COOLDOWN_MS;
    console.warn(
      `[ruijie-sync] circuit OPEN for ${Math.round(RUIJIE_SYNC_BREAKER_COOLDOWN_MS / 1000)}s ` +
        `after ${state.consecutiveThrottles} throttle(s): ${state.lastError}`
    );
  }
}

export interface ThrottledCallOptions {
  /** Free-form label for logs, e.g. `pool:mint:PreLite`. */
  label?: string;
  /** Injected clock (tests). */
  now?: () => number;
  /** Injected sleeper (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Skip the pacing wait (used by explicit admin "send now" actions). */
  immediate?: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` through the pacing queue.
 *
 * Throws `RuijieCircuitOpenError` (a `RuijieApiError` with code 44, so every
 * existing `isRateLimitError()` branch handles it) while the breaker is open,
 * and re-throws the underlying error otherwise — callers are expected to catch
 * and degrade rather than propagate a 5xx.
 */
export async function throttledRuijieCall<T>(
  fn: () => Promise<T>,
  options: ThrottledCallOptions = {}
): Promise<T> {
  const nowFn = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  if (!options.immediate) {
    let waitMs = 0;
    // Two passes: the first wait can land exactly on the window edge, and a
    // millisecond of clock skew must not let a 12th call through.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = nowFn();
      if (isRuijieSyncCircuitOpen(now)) {
        throw new RuijieCircuitOpenError(state.openUntil - now);
      }
      waitMs = nextRuijieSyncDelayMs(now);
      if (waitMs <= 0) break;
      state.totalWaitMs += waitMs;
      await sleep(waitMs);
    }
  }

  const now = nowFn();
  if (isRuijieSyncCircuitOpen(now)) {
    throw new RuijieCircuitOpenError(state.openUntil - now);
  }

  pruneWindow(now);
  state.lastCallAt = now;
  state.callTimes.push(now);
  state.totalCalls += 1;

  try {
    const result = await fn();
    noteRuijieSyncSuccess();
    return result;
  } catch (err) {
    if (isThrottleError(err)) {
      noteRuijieSyncThrottle(err, nowFn());
      if (options.label) {
        console.warn(`[ruijie-sync] ${options.label} throttled: ${(err as Error)?.message ?? err}`);
      }
    }
    throw err;
  }
}

/** Test/ops helper: forget the queue and close the breaker. */
export function __resetRuijieSyncForTests(): void {
  state = freshState();
}
