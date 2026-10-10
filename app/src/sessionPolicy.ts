/**
 * Client mirror of the server's src/sessionPolicy.ts.
 *
 * app.preyone.com is a standalone bundle (no shared package with the admin
 * console), so these literals duplicate the numbers for bootstrap only.
 * AuthContext-equivalent code adopts GET /api/admin/auth/policy at startup so
 * the server stays authoritative.
 */
export const INACTIVITY_TIMEOUT_MS = 900_000; // 15 minutes
export const MAX_SESSION_LIFETIME_MS = 36_000_000; // 10 hours
export const INACTIVITY_WARNING_MS = 120_000; // 2 minutes before the lock
export const REFRESH_MIN_INTERVAL_MS = 15_000;

export const ACTIVITY_STAMP_KEY = 'gw_session_activity';
export const SESSION_EXPIRED_KEY = 'gw_session_expired';

const CHANNEL_NAME = 'preyone-auth';

/**
 * Cross-tab idle coordination.
 *
 * A user with app.preyone.com open in two tabs would otherwise be locked in
 * the idle one while working in the other. Every tab publishes its activity
 * timestamp and arms its timers against the newest stamp seen, so activity in
 * any tab keeps all of them alive.
 */
export class ActivityBus {
  private channel: BroadcastChannel | null = null;
  /** Newest activity stamp seen across this tab and every sibling tab. */
  latest = Date.now();
  private readonly listeners = new Set<(at: number) => void>();

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as { type?: string; at?: number } | null;
        if (msg?.type !== 'activity' || typeof msg.at !== 'number') return;
        if (msg.at > this.latest) this.latest = msg.at;
        this.listeners.forEach((fn) => fn(this.latest));
      };
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (ev) => {
        if (ev.key !== ACTIVITY_STAMP_KEY || !ev.newValue) return;
        const at = Number(ev.newValue);
        if (!Number.isFinite(at)) return;
        if (at > this.latest) this.latest = at;
        this.listeners.forEach((fn) => fn(this.latest));
      });
    }
  }

  touch(): number {
    const at = Date.now();
    if (at > this.latest) this.latest = at;
    try {
      this.channel?.postMessage({ type: 'activity', at });
    } catch { /* channel closed during teardown */ }
    try {
      localStorage.setItem(ACTIVITY_STAMP_KEY, String(at));
    } catch { /* private mode / quota */ }
    return this.latest;
  }

  onActivity(fn: (at: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
  }
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
