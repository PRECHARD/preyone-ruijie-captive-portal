/**
 * Central session policy for the Admin Console and the Gateway SPA.
 *
 * SINGLE SOURCE OF TRUTH — every server-side check, and the public payload
 * the SPAs load at boot, read these values. Do not hardcode 900/36000 anywhere
 * else.
 *
 * Two independent clocks bound an admin session:
 *
 *  1. INACTIVITY  — slides forward on real user interaction (POST /refresh,
 *                   POST /unlock). Exceeding it LOCKS the console (HTTP 423)
 *                   and can be reversed by re-entering the password while
 *                   clock #2 still has budget left.
 *
 *  2. ABSOLUTE    — fixed at the moment 2FA verification succeeds (auth_time).
 *                   Nothing — not refresh, not activity, not unlock — extends
 *                   it. Exceeding it REVOKEs the session (HTTP 401) and forces
 *                   a full re-authentication with password + email OTP.
 */
export const INACTIVITY_TIMEOUT_SEC = 900; // 15 minutes
export const MAX_SESSION_LIFETIME_SEC = 36000; // 10 hours
/** Client shows a "Stay signed in" prompt this many seconds before locking. */
export const INACTIVITY_WARNING_SEC = 120; // 2 minutes

/** Public, non-sensitive slice sent to the SPAs so both clocks agree. */
export interface SessionPolicy {
  inactivityTimeoutSec: number;
  maxSessionLifetimeSec: number;
  inactivityWarningSec: number;
}

export const SESSION_POLICY: SessionPolicy = {
  inactivityTimeoutSec: INACTIVITY_TIMEOUT_SEC,
  maxSessionLifetimeSec: MAX_SESSION_LIFETIME_SEC,
  inactivityWarningSec: INACTIVITY_WARNING_SEC,
};
