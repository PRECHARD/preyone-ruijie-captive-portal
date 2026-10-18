function getToken(): string | null {
  return localStorage.getItem('admin_token');
}

function setToken(token: string): void {
  localStorage.setItem('admin_token', token);
}

function clearToken(): void {
  localStorage.removeItem('admin_token');
}

export interface ApiError extends Error {
  requiresApproval?: boolean;
  requiresHandover?: boolean;
  unhandedCount?: number;
  status?: number;
  code?: string;
}

/**
 * Console is in the inactivity-locked state (State A). While true, every
 * protected call is refused LOCALLY as well as by the server, so a busy page
 * with background polling cannot hammer /refresh or keep data flowing behind
 * the lock screen. Only the endpoints needed to leave the locked state are
 * allowed through.
 */
let consoleLocked = false;

export function setConsoleLocked(next: boolean): void {
  consoleLocked = next;
}

/** Endpoints that remain callable while locked (unlock + sign out). */
const LOCK_ALLOWLIST = ['/auth/unlock', '/auth/logout', '/auth/policy'];

function isAllowedWhileLocked(path: string): boolean {
  return LOCK_ALLOWLIST.some((p) => path.endsWith(p));
}

function createClient(base: string) {
  async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    if (consoleLocked && !isAllowedWhileLocked(path)) {
      const err: ApiError = new Error('Session locked after inactivity. Enter your password to continue.');
      err.status = 423;
      err.code = 'SESSION_LOCKED';
      throw err;
    }

    const token = getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${base}${path}`, { ...options, headers });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err: ApiError = new Error(json.error || `Request failed (${res.status})`);
      if (json.requiresApproval) err.requiresApproval = true;
      if (json.requiresHandover) err.requiresHandover = true;
      if (json.unhandedCount) err.unhandedCount = json.unhandedCount;
      err.status = res.status;
      err.code = typeof json.code === 'string' ? json.code : undefined;
      // The server rejected the session clocks: tell AuthContext which state
      // we are in so it can lock the console (423) or force a re-login (401).
      if (typeof window !== 'undefined') {
        if (res.status === 423 && json.code === 'SESSION_LOCKED') {
          window.dispatchEvent(new CustomEvent('admin:session-locked'));
        } else if (res.status === 401 && (json.code === 'SESSION_EXPIRED' || json.code === 'SESSION_REVOKED')) {
          window.dispatchEvent(new CustomEvent('admin:session-expired', { detail: { code: json.code } }));
        }
      }
      throw err;
    }
    return json;
  }

  return {
    get: <T = any>(path: string) => request<T>(path),
    post: <T = any>(path: string, body?: any) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
    put: <T = any>(path: string, body?: any) => request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
    patch: <T = any>(path: string, body?: any) => request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
    del: <T = any>(path: string) => request<T>(path, { method: 'DELETE' }),
    getToken,
    setToken,
    clearToken,
  };
}

/** WiFi portal admin API (existing). */
export const api = createClient('/api/admin');
/** Level 0 platform / tenant / gateway API. */
export const systemApi = createClient('/api/v1/admin');
/** Transit company web-admin API (devices, staff, trips, tickets, financials). */
export const transitApi = createClient('/api/v1/transit');
/** Ruijie Cloud telemetry (sessions, devices, accounting, kick). Admin auth required. */
export const ruijieApi = createClient('/api/ruijie');
/** Subscription plans + checkout (settings hub plan rail). */
export const subscriptionApi = createClient('/api/subscription');

export { getToken, setToken, clearToken };
