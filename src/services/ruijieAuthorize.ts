import {
  authorizeRuijieClient,
  isRuijieCloudConfigured,
  type AuthorizeRuijieClientInput,
} from './ruijieCloud';
import {
  RUIJIE_SYNC_MAX_PER_MINUTE,
  getRuijieSyncState,
  isRuijieSyncCircuitOpen,
  isThrottleError,
  throttledRuijieCall,
} from './ruijieSync';

/**
 * Post-redemption MAC authorisation: "unblock this device in Ruijie Cloud now".
 *
 * WHY IT IS FIRE-AND-FORGET
 * -------------------------
 * The gateway authorises the client through ext_login + FreeRADIUS, which is the
 * path that is actually proven in production. This hook is a *shortcut* that can
 * also push the MAC to the cloud, and it must never be able to fail a redemption:
 * the customer is standing at the gateway and the tenant API quota is frequently
 * exhausted (`code 44`).
 *
 * Therefore:
 *   - every failure is swallowed and reported as a degraded outcome;
 *   - the HTTP request is bounded by a 5s axios timeout;
 *   - the call is skipped entirely while the shared circuit breaker is open or
 *     the per-minute pacing window is already full, so a redemption burst cannot
 *     queue hundreds of blocked promises behind one throttled tenant;
 *   - a hard rejection (the tenant does not expose `auth/authorize`, wrong
 *     payload shape, permission denied) parks the hook for 15 minutes instead of
 *     spending one quota unit per redemption on a route that cannot work;
 *   - `RUIJIE_AUTHORIZE_ON_REDEEM=false` disables it without a code change.
 */

export const RUIJIE_AUTHORIZE_TIMEOUT_MS = 5_000;

/** After a non-throttle rejection, stop trying for a while (quota protection). */
export const AUTHORIZE_HARD_FAILURE_BACKOFF_MS = 15 * 60 * 1000;

let hardFailureUntil = 0;

/** Test/ops helper: forget the hard-failure backoff. */
export function __resetAuthorizeBackoffForTests(): void {
  hardFailureUntil = 0;
}

/** Colon-separated, upper-case MAC — the form Ruijie and FreeRADIUS both accept. */
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

export interface AuthorizeTarget {
  macAddress?: string | null;
  ipAddress?: string | null;
  voucherCode?: string | null;
  userGroupId?: string | null;
}

export interface AuthorizeOutcome {
  /** True when an outbound call was actually attempted. */
  attempted: boolean;
  authorized: boolean;
  /** True whenever the customer-visible path may be incomplete (never blocking). */
  degraded: boolean;
  /** Why it was skipped or how it failed. Absent on success. */
  reason?: string;
}

export function isAuthorizeOnRedeemEnabled(): boolean {
  const raw = (process.env.RUIJIE_AUTHORIZE_ON_REDEEM ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

/** Normalise `aa-bb-cc-dd-ee-ff` / `AA:BB:...` to the canonical colon form. */
export function normalizeClientMac(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const hex = raw.trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) return '';
  return hex.match(/.{2}/g)!.join(':');
}

function skipped(reason: string): AuthorizeOutcome {
  return { attempted: false, authorized: false, degraded: true, reason };
}

export interface AuthorizeOptions {
  /** Test/ops seam: replace the outbound push. */
  call?: (input: AuthorizeRuijieClientInput) => Promise<unknown>;
  /** Injected clock/sleep forwarded to the shared pacing queue (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Never throws. Callers may `void` the returned promise.
 */
export async function authorizeClientAfterRedeem(
  target: AuthorizeTarget,
  options: AuthorizeOptions = {}
): Promise<AuthorizeOutcome> {
  if (!isAuthorizeOnRedeemEnabled()) return skipped('disabled');

  const macAddress = normalizeClientMac(target.macAddress);
  if (!macAddress || !MAC_RE.test(macAddress)) return skipped('no_client_mac');
  if (!isRuijieCloudConfigured()) return skipped('not_configured');

  // Cheap local guards first: waiting behind a full pacing window (or an open
  // breaker) for up to a minute is pointless for a best-effort shortcut.
  if (Date.now() < hardFailureUntil) return skipped('backing_off');
  if (isRuijieSyncCircuitOpen()) return skipped('circuit_open');
  if (getRuijieSyncState().callsLastMinute >= RUIJIE_SYNC_MAX_PER_MINUTE) {
    return skipped('quota_window_full');
  }

  const call = options.call ?? authorizeRuijieClient;
  try {
    await throttledRuijieCall(
      () =>
        call({
          macAddress,
          voucherCode: target.voucherCode || undefined,
          userGroupId: target.userGroupId || undefined,
          timeoutMs: RUIJIE_AUTHORIZE_TIMEOUT_MS,
        }),
      { label: `auth:authorize:${macAddress}`, now: options.now, sleep: options.sleep }
    );
    return { attempted: true, authorized: true, degraded: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // A throttle is already handled by the shared breaker; anything else means
    // this route will not work for this tenant, so stop spending quota on it.
    if (!isThrottleError(err)) hardFailureUntil = Date.now() + AUTHORIZE_HARD_FAILURE_BACKOFF_MS;
    console.warn(`[ruijie-authorize] ${macAddress} not authorized in cloud: ${reason}`);
    return { attempted: true, authorized: false, degraded: true, reason };
  }
}
