/**
 * Client mirror of src/sessionPolicy.ts.
 *
 * The server owns these numbers (GET /api/admin/auth/policy returns them, and
 * AuthContext adopts that response at boot). The literals here are only the
 * offline/bootstrap fallback — never treat them as authoritative.
 */
export const INACTIVITY_TIMEOUT_MS = 900_000; // 15 minutes
export const MAX_SESSION_LIFETIME_MS = 36_000_000; // 10 hours
/** Warn this many ms before the inactivity lock lands. */
export const INACTIVITY_WARNING_MS = 120_000; // 2 minutes
/** Throttle for the sliding /refresh call so mousemove can't hammer the API. */
export const REFRESH_MIN_INTERVAL_MS = 15_000;

export interface SessionPolicy {
  inactivityTimeoutSec: number;
  maxSessionLifetimeSec: number;
}

/** localStorage key holding the newest activity stamp shared across tabs. */
export const ACTIVITY_STAMP_KEY = 'admin_session_activity';
/** Set when the 10-hour absolute cap force-signs the user out (State B). */
export const SESSION_EXPIRED_KEY = 'admin_session_expired';

export const SESSION_LOCKED_EVENT = 'admin:session-locked';
export const SESSION_EXPIRED_EVENT = 'admin:session-expired';

const CHANNEL_NAME = 'preyone-auth';

type ActivityMessage = { type: 'activity'; at: number } | { type: 'lock' } | { type: 'unlock' } | { type: 'signout' };

/**
 * Cross-tab activity bus.
 *
 * Two tabs of the same browser each run their own idle timer; without
 * coordination, an idle tab would lock while the user is actively working in
 * the other. Every tab publishes its activity timestamp here, and each tab
 * arms its timers against the NEWEST stamp it has seen — so activity in any
 * tab keeps every tab alive.
 *
 * BroadcastChannel is primary (fast, no storage writes); the `storage` event
 * on localStorage is the fallback for browsers without it.
 */
export class ActivityBus {
  private channel: BroadcastChannel | null = null;
  /** Newest activity stamp seen across this tab and every sibling tab. */
  latest = Date.now();
  private readonly listeners = new Set<(at: number) => void>();
  private readonly controlListeners = new Set<(msg: ActivityMessage) => void>();

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (ev: MessageEvent<ActivityMessage>) => this.receive(ev.data);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (ev) => {
        if (ev.key !== ACTIVITY_STAMP_KEY || !ev.newValue) return;
        const at = Number(ev.newValue);
        if (Number.isFinite(at)) this.receive({ type: 'activity', at });
      });
    }
  }

  private receive(msg: ActivityMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'activity') {
      if (msg.at > this.latest) this.latest = msg.at;
      this.listeners.forEach((fn) => fn(this.latest));
      return;
    }
    this.controlListeners.forEach((fn) => fn(msg));
  }

  /** Publish local activity so sibling tabs re-arm too. */
  touch(): number {
    const at = Date.now();
    if (at > this.latest) this.latest = at;
    try {
      this.channel?.postMessage({ type: 'activity', at } satisfies ActivityMessage);
    } catch { /* channel closed during teardown */ }
    try {
      localStorage.setItem(ACTIVITY_STAMP_KEY, String(at));
    } catch { /* private mode / quota */ }
    return this.latest;
  }

  publishControl(msg: ActivityMessage): void {
    try {
      this.channel?.postMessage(msg);
    } catch { /* channel closed during teardown */ }
  }

  onActivity(fn: (at: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onControl(fn: (msg: ActivityMessage) => void): () => void {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
  }
}

/** mm:ss countdown label for lock/expiry timers. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
