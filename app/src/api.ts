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

export async function login(email: string, password: string): Promise<GatewayUser> {
  const res = await fetch('/api/admin/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  setToken(data.token);
  return data.user as GatewayUser;
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