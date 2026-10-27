/**
 * Ruijie API error vocabulary.
 *
 * Kept in its own module (no imports) so every consumer — including the
 * cluster-wide quota guard in `ruijieRateLimiter.ts` — can share the exact same
 * class and rate-limit code without creating an import cycle through
 * `ruijieCloud.ts`.
 */

export class RuijieApiError extends Error {
  readonly code: string | number;
  readonly status: number = 502;
  constructor(code: string | number, message: string) {
    super(message);
    this.name = 'RuijieApiError';
    this.code = code;
  }
}

/**
 * Ruijie answers HTTP 200 with `{ code: 44, msg: "Too many requests" }` once the
 * tenant's API quota is exhausted. It is transient — the same call succeeds
 * again after the window resets — so it must never surface as an opaque 500,
 * and reads must stop asking for a while instead of deepening the throttle.
 */
export const RATE_LIMIT_CODE = 44;

export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof RuijieApiError)) return false;
  return Number(err.code) === RATE_LIMIT_CODE || /too many requests/i.test(err.message);
}
