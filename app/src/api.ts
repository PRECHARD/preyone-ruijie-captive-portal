export interface GatewayUser {
  id: string;
  fullName: string;
  email: string;
  role: string;
  company_id?: string | null;
  tenant_id?: string | null;
  subscribed_modules?: string[] | null;
}

export interface CompanyProfile {
  id: string;
  name: string;
  tagline: string | null;
  email: string | null;
  support_phone: string | null;
  website: string | null;
  address: string | null;
  logo_path: string | null;
  currency: string;
}

const TOKEN_KEY = 'gateway_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function logout(): Promise<void> {
  await fetch('/api/admin/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
}

/** Returned when the password was accepted but an emailed OTP is still required. */
export interface LoginChallenge {
  requires2fa: true;
  challengeToken: string;
  maskedEmail: string;
}

export type LoginResult = { user: GatewayUser; authTime: string | null } | LoginChallenge;

function isChallenge(data: any): data is LoginChallenge {
  return data?.requires2fa === true && typeof data.challengeToken === 'string';
}

/**
 * Password sign-in. Since 2FA shipped, this resolves EITHER a finished session
 * or an email-OTP challenge — callers must branch on `requires2fa`.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch('/api/admin/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  if (isChallenge(data)) {
    return { requires2fa: true, challengeToken: data.challengeToken, maskedEmail: data.maskedEmail || '' };
  }
  setToken(data.token);
  return { user: data.user as GatewayUser, authTime: data.authTime ?? null };
}

/** Completes the emailed-OTP step and issues the session. */
export async function verify2fa(challengeToken: string, code: string): Promise<{ user: GatewayUser; authTime: string | null }> {
  const res = await fetch('/api/admin/auth/verify-2fa', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken, code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Verification failed');
  setToken(data.token);
  return { user: data.user as GatewayUser, authTime: data.authTime ?? null };
}

/** New OTP for a challenge whose mail never arrived. */
export async function resend2fa(challengeToken: string): Promise<{ message?: string }> {
  const res = await fetch('/api/admin/auth/resend-2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not resend the code');
  return data;
}

/** Password-only recovery from the inactivity lock (no 2FA re-trigger). */
export async function unlockSession(password: string): Promise<void> {
  const token = getToken();
  if (!token) throw new Error('Session no longer exists. Please sign in again.');
  const res = await fetch('/api/admin/auth/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not unlock the session');
}

/** Slides the inactivity clock. Never extends the 10-hour absolute cap. */
export async function refreshSession(): Promise<{ ok: boolean }> {
  const token = getToken();
  if (!token) throw new Error('Not signed in');
  const res = await fetch('/api/admin/auth/refresh', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 423) {
    const err = new Error(res.status === 423 ? 'Session locked' : 'Session expired') as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Server-owned session constants so the client timers cannot drift. */
export async function fetchSessionPolicy(): Promise<{ inactivityTimeoutSec?: number } | null> {
  try {
    const res = await fetch('/api/admin/auth/policy');
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

/** Bootstrap outcome — distinguishes the two lock/expiry states the server can
 *  report so the SPA can offer a password unlock instead of a hard sign-out. */
export type SessionOutcome =
  | { state: 'authenticated'; user: GatewayUser; authTime: string | null }
  | { state: 'locked'; user: GatewayUser | null }
  | { state: 'expired' }
  | { state: 'anonymous' };

async function readMe(res: Response): Promise<SessionOutcome> {
  const data = await res.json().catch(() => ({}));
  if (res.status === 423 && data.code === 'SESSION_LOCKED') {
    return { state: 'locked', user: data.user ?? null };
  }
  if (res.status === 401 && (data.code === 'SESSION_EXPIRED' || data.code === 'SESSION_REVOKED')) {
    return { state: 'expired' };
  }
  if (!res.ok || !data.id) return { state: 'anonymous' };
  return { state: 'authenticated', user: data as GatewayUser, authTime: data.session?.authTime ?? null };
}

export async function me(token: string): Promise<GatewayUser | null> {
  const res = await fetch('/api/admin/auth/me', {
    credentials: 'include',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.id ? (data as GatewayUser) : null;
}

/**
 * SSO session bootstrap: no local token yet — ask /api/admin/auth/me to read the
 * wildcard HTTP-Only cookie (Domain=.preyone.com) left by a login on any subdomain.
 */
export async function session(): Promise<GatewayUser | null> {
  const res = await fetch('/api/admin/auth/me', { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  return res.ok && data.id ? (data as GatewayUser) : null;
}

/** Same endpoint, but surfaces locked/expired so the shell can react. */
export async function sessionOutcome(): Promise<SessionOutcome> {
  const token = getToken();
  const res = await fetch('/api/admin/auth/me', {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return readMe(res);
}

export async function company(): Promise<CompanyProfile | null> {
  try {
    const res = await fetch('/api/pos/company', { credentials: 'include' });
    const data = await res.json();
    if (res.ok && data.id) return data as CompanyProfile;
  } catch {
    return null;
  }
  return null;
}

export interface CompanyAccess {
  company: { id: string; name: string };
  plan_tier?: string | null;
  modules: string[];
}

export async function subscriptions(token: string): Promise<CompanyAccess | null> {
  const res = await fetch('/api/pos/company/subscriptions', {
    credentials: 'include',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.company) return data as CompanyAccess;
  // 401/403 → authenticated but no company entitlement → null modules
  if (res.status === 401 || res.status === 403) return null;
  throw new Error(data.error || 'Subscriptions unavailable');
}