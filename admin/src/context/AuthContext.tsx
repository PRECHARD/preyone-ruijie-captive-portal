import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { getToken, setToken, clearToken, setConsoleLocked } from '../api/client';
import {
  ActivityBus,
  SESSION_EXPIRED_KEY,
  SESSION_LOCKED_EVENT,
  SESSION_EXPIRED_EVENT,
  INACTIVITY_TIMEOUT_MS,
  MAX_SESSION_LIFETIME_MS,
  INACTIVITY_WARNING_MS,
  REFRESH_MIN_INTERVAL_MS,
} from '../sessionPolicy';

export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  role: string;
  companyId?: string | null;
  permissions?: string[];
}

/** Returned by login() when the password was accepted but an emailed OTP is
 *  required before the session is issued. */
export interface LoginChallenge {
  requires2fa: true;
  challengeToken: string;
  maskedEmail: string;
}

/** Both session clocks, as reported by the server. */
export interface SessionInfo {
  authTime: string | null;
  lastActivity: string | null;
  locked?: boolean;
}

type Bootstrap =
  | { state: 'authenticated'; user: AuthUser; session: SessionInfo | null }
  | { state: 'locked'; user: AuthUser | null }
  | { state: 'expired' }
  | { state: 'anonymous' };

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** State A: console is inactivity-locked and the LockScreen is showing. */
  locked: boolean;
  /** ~2 minutes before the lock, show the "Stay signed in" prompt. */
  warning: boolean;
  /** ms until the inactivity lock (Infinity when locked or unknown). */
  msUntilLock: number;
  /** ms until the 10-hour absolute expiry; null when the server never said. */
  msUntilExpiry: number | null;
  login: (email: string, password: string) => Promise<LoginChallenge | null>;
  verify2fa: (challengeToken: string, code: string) => Promise<void>;
  signup: (data: { fullName: string; email: string; phone: string; role: string; password: string }) => Promise<{ pendingApproval?: boolean; message?: string }>;
  /** State A recovery: password only — 2FA is not re-triggered. */
  unlock: (password: string) => Promise<void>;
  /** "Stay signed in" on the warning dialog — slides the clock immediately. */
  staySignedIn: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toAuthUser(data: any): AuthUser | null {
  if (!data?.id) return null;
  return {
    id: data.id,
    fullName: data.full_name || data.fullName,
    email: data.email,
    role: data.role,
    companyId: data.company_id ?? null,
    permissions: data.permissions ?? [],
  };
}

async function fetchBootstrap(): Promise<Bootstrap> {
  const token = getToken();
  // No local token: still worth asking, because the wildcard HTTP-only SSO
  // cookie may carry a live session (cross-subdomain login).
  const res = await fetch('/api/admin/auth/me', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));

  if (res.status === 423 && data.code === 'SESSION_LOCKED') {
    return { state: 'locked', user: toAuthUser(data.user) };
  }
  if (res.status === 401 && (data.code === 'SESSION_EXPIRED' || data.code === 'SESSION_REVOKED')) {
    return { state: 'expired' };
  }
  if (!res.ok || !data.id) return { state: 'anonymous' };

  const session: SessionInfo | null = data.session
    ? { authTime: data.session.authTime ?? null, lastActivity: data.session.lastActivity ?? null, locked: !!data.session.locked }
    : null;
  const user = toAuthUser(data);
  if (!user) return { state: 'anonymous' };
  return { state: 'authenticated', user, session };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [warning, setWarning] = useState(false);
  const [msUntilLock, setMsUntilLock] = useState(INACTIVITY_TIMEOUT_MS);
  const [msUntilExpiry, setMsUntilExpiry] = useState<number | null>(null);

  // Refs so the 1s tick closure never goes stale, and so the activity bus is
  // created once per provider rather than per render.
  const busRef = useRef<ActivityBus | null>(null);
  if (busRef.current === null && typeof window !== 'undefined') busRef.current = new ActivityBus();
  const lastRefreshRef = useRef(0);
  const absoluteDeadlineRef = useRef<number | null>(null);
  const inactivityMsRef = useRef(INACTIVITY_TIMEOUT_MS);
  const warningMsRef = useRef(INACTIVITY_WARNING_MS);
  const lockedRef = useRef(false);
  const userRef = useRef<AuthUser | null>(null);
  // Mirror of the `warning` state for the 1s tick. Reading the state variable
  // inside the tick closure would go stale (the effect does not re-run on it),
  // leaving the warning dialog stuck open after the user moves the mouse.
  const warningRef = useRef(false);
  userRef.current = user;
  lockedRef.current = locked;

  /** Clears the pre-lock warning and its tick mirror in one place, so the two
   *  can never drift (the tick reads the ref, React renders the state). */
  const hideWarning = useCallback(() => {
    warningRef.current = false;
    setWarning(false);
  }, []);

  const applyLock = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    setLocked(true);
    hideWarning();
    setConsoleLocked(true);
    busRef.current?.publishControl({ type: 'lock' });
  }, [hideWarning]);

  /** State B: absolute cap reached — kill the token entirely. */
  const expireSession = useCallback(() => {
    setConsoleLocked(false);
    lockedRef.current = false;
    setLocked(false);
    hideWarning();
    clearToken();
    localStorage.removeItem('admin_user');
    localStorage.setItem(SESSION_EXPIRED_KEY, '1');
    absoluteDeadlineRef.current = null;
    busRef.current?.publishControl({ type: 'signout' });
    setUser(null);
  }, []);

  useEffect(() => {
    // Adopt the server's constants so the client timers can never drift from
    // what requireAdminAuth enforces (single source: src/sessionPolicy.ts).
    fetch('/api/admin/auth/policy')
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (!p) return;
        if (typeof p.inactivityTimeoutSec === 'number') inactivityMsRef.current = p.inactivityTimeoutSec * 1000;
        // The warning is a client-only concept; keep it capped just under the
        // inactivity window so it can never fire after the lock already did.
        warningMsRef.current = Math.min(INACTIVITY_WARNING_MS, inactivityMsRef.current - 5_000);
        setMsUntilLock(inactivityMsRef.current);
      })
      .catch(() => { /* offline: fall back to the compiled-in defaults */ });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchBootstrap()
      .then((result) => {
        if (cancelled) return;
        if (result.state === 'authenticated') {
          setUser(result.user);
          if (result.session?.authTime) {
            absoluteDeadlineRef.current = new Date(result.session.authTime).getTime() + MAX_SESSION_LIFETIME_MS;
          }
          setConsoleLocked(false);
          localStorage.removeItem(SESSION_EXPIRED_KEY);
          return;
        }
        if (result.state === 'locked') {
          // Preserve session context: no token wipe, just surface the lock.
          if (result.user) setUser(result.user);
          lockedRef.current = true;
          setLocked(true);
          setConsoleLocked(true);
          return;
        }
        if (result.state === 'expired') {
          localStorage.setItem(SESSION_EXPIRED_KEY, '1');
          clearToken();
        }
      })
      .catch(() => clearToken())
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<LoginChallenge | null> => {
    const res = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    if (data.requires2fa) {
      return { requires2fa: true, challengeToken: data.challengeToken, maskedEmail: data.maskedEmail || '' };
    }
    localStorage.removeItem(SESSION_EXPIRED_KEY);
    setToken(data.token);
    // Absolute clock starts at sign-in for password-only accounts (no 2FA step
    // to stamp it); 2FA accounts overwrite it on verify2fa below.
    absoluteDeadlineRef.current = data.authTime
      ? new Date(data.authTime).getTime() + MAX_SESSION_LIFETIME_MS
      : Date.now() + MAX_SESSION_LIFETIME_MS;
    setConsoleLocked(false);
    lockedRef.current = false;
    setLocked(false);
    busRef.current?.touch();
    const boot = await fetchBootstrap();
    if (boot.state === 'authenticated') {
      setUser(boot.user);
      if (boot.session?.authTime) {
        absoluteDeadlineRef.current = new Date(boot.session.authTime).getTime() + MAX_SESSION_LIFETIME_MS;
      }
      return null;
    }
    return null;
  }, []);

  const verify2fa = useCallback(async (challengeToken: string, code: string) => {
    const res = await fetch('/api/admin/auth/verify-2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken, code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Verification failed');
    localStorage.removeItem(SESSION_EXPIRED_KEY);
    setToken(data.token);
    // auth_time is stamped by the server the instant the OTP is accepted; this
    // is the immutable 10-hour anchor.
    absoluteDeadlineRef.current = data.authTime
      ? new Date(data.authTime).getTime() + MAX_SESSION_LIFETIME_MS
      : Date.now() + MAX_SESSION_LIFETIME_MS;
    setConsoleLocked(false);
    lockedRef.current = false;
    setLocked(false);
    busRef.current?.touch();
    const boot = await fetchBootstrap();
    if (boot.state === 'authenticated') setUser(boot.user);
  }, []);

  const signup = useCallback(async (body: { fullName: string; email: string; phone: string; role: string; password: string }) => {
    const res = await fetch('/api/admin/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signup failed');
    return data;
  }, []);

  const unlock = useCallback(async (password: string) => {
    const token = getToken();
    if (!token) throw new Error('Session no longer exists. Please sign in again.');
    const res = await fetch('/api/admin/auth/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not unlock the session');
    // Session context is preserved server-side (same sid, same auth_time) —
    // only the inactivity clock moved, so 2FA is deliberately not re-run.
    setConsoleLocked(false);
    lockedRef.current = false;
    setLocked(false);
    hideWarning();
    lastRefreshRef.current = Date.now();
    busRef.current?.touch();
    busRef.current?.publishControl({ type: 'unlock' });
  }, []);

  const staySignedIn = useCallback(() => {
    lastRefreshRef.current = Date.now();
    busRef.current?.touch();
    hideWarning();
  }, [hideWarning]);

  const logout = useCallback(() => {
    const token = getToken();
    if (token) {
      // Best-effort server-side revocation (kills active_sid + SSO cookie).
      fetch('/api/admin/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
    setConsoleLocked(false);
    lockedRef.current = false;
    setLocked(false);
    hideWarning();
    clearToken();
    localStorage.removeItem('admin_user');
    localStorage.removeItem('admin_token');
    localStorage.removeItem(SESSION_EXPIRED_KEY);
    absoluteDeadlineRef.current = null;
    busRef.current?.publishControl({ type: 'signout' });
    setUser(null);
  }, []);

  // ── The timer loop ───────────────────────────────────────────────────
  // One 1s tick drives both clocks. Activity comes from this tab's input
  // events AND from sibling tabs via the ActivityBus, so a user working in
  // another tab does not get locked here.
  useEffect(() => {
    if (!user) return;

    const bus = busRef.current!;

    const slideServerWindow = () => {
      const now = Date.now();
      if (now - lastRefreshRef.current < REFRESH_MIN_INTERVAL_MS) return;
      lastRefreshRef.current = now;
      const token = getToken();
      if (!token) return;
      fetch('/api/admin/auth/refresh', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
        .then((r) => {
          if (r.status === 423) applyLock();
          else if (r.status === 401) expireSession();
        })
        .catch(() => { /* transient network failure: client timer stays armed */ });
    };

    const onActivity = () => {
      bus.touch();
      slideServerWindow();
    };

    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    const offBus = bus.onActivity(() => {
      // Sibling tab activity: re-arm locally without another network call.
      slideServerWindow();
    });
    const offLockBus = bus.onControl((msg) => {
      if (msg.type === 'lock') {
        setConsoleLocked(true);
        lockedRef.current = true;
        setLocked(true);
        hideWarning();
      } else if (msg.type === 'unlock') {
        setConsoleLocked(false);
        lockedRef.current = false;
        setLocked(false);
        lastRefreshRef.current = Date.now();
      } else if (msg.type === 'signout') {
        setConsoleLocked(false);
        lockedRef.current = false;
        setLocked(false);
        setUser(null);
      }
    });

    const onLockedEvent = () => applyLock();
    const onExpiredEvent = () => expireSession();
    window.addEventListener(SESSION_LOCKED_EVENT, onLockedEvent);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpiredEvent);

    const tick = () => {
      const now = Date.now();

      // State B outranks State A: past the 10-hour anchor nothing is
      // recoverable, so sign out hard regardless of lock state.
      const deadline = absoluteDeadlineRef.current;
      if (deadline !== null && now >= deadline) {
        expireSession();
        return;
      }

      const armedAt = Math.max(bus.latest, lastRefreshRef.current);
      const idle = now - armedAt;
      const inactivityMs = inactivityMsRef.current;
      const remaining = inactivityMs - idle;
      const warningWindow = warningMsRef.current;

      if (lockedRef.current) {
        // Locked: only the countdown on the lock screen needs ticking, and
        // only while the absolute cap is close enough to be worth showing.
        if (deadline !== null) setMsUntilExpiry(deadline - now);
        return;
      }
      if (remaining <= 0) {
        setMsUntilLock(0);
        applyLock();
        return;
      }
      // Publish a countdown only inside the warning window — outside it the
      // whole console tree would re-render every second for a number nobody
      // is looking at.
      if (remaining <= warningWindow) {
        warningRef.current = true;
        setMsUntilLock(remaining);
        setWarning(true);
      } else if (warningRef.current) {
        // Drop the dialog the moment the user is active again. Only flip state
        // on the transition, so an ordinary tick does not re-render the tree.
        hideWarning();
        setMsUntilLock(remaining);
      }
    };

    // Prime the clock immediately so a freshly-authenticated tab does not wait
    // a full tick, then start the loop.
    bus.touch();
    lastRefreshRef.current = Date.now();
    tick();
    const interval = window.setInterval(tick, 1000);

    return () => {
      window.clearInterval(interval);
      events.forEach((e) => window.removeEventListener(e, onActivity));
      offBus();
      offLockBus();
      window.removeEventListener(SESSION_LOCKED_EVENT, onLockedEvent);
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpiredEvent);
    };
  }, [user, applyLock, expireSession, hideWarning]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        locked,
        warning,
        msUntilLock,
        msUntilExpiry,
        login,
        verify2fa,
        signup,
        unlock,
        staySignedIn,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
