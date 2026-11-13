export interface AuthUser {
  id: string;
  email: string;
  role: string;
  fullName: string;
}

const TOKEN_KEY = 'invoice_token';
const USER_KEY = 'invoice_user';

export const auth = {
  token: (): string | null => localStorage.getItem(TOKEN_KEY),
  user: (): AuthUser | null => {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AuthUser;
    } catch {
      return null;
    }
  },
  save: (token: string, user: AuthUser) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = auth.token();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers, credentials: 'include' });
  if (res.status === 401) {
    auth.clear();
    throw new ApiError('Session expired', 401);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((json as { error?: string }).error || `Request failed (${res.status})`, res.status);
  return json as T;
}

export async function login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const data = await request<{ token: string; user: any }>('/api/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const user: AuthUser = {
    id: data.user.id,
    email: data.user.email,
    role: data.user.role,
    fullName: data.user.fullName || data.user.full_name || data.user.email,
  };
  return { token: data.token, user };
}

export const accounting = {
  overview: () => request<Record<string, any>>('/api/accounting/overview'),
  ledger: (limit = 100) => request<{ rows: any[]; total: number }>(`/api/accounting/ledger?limit=${limit}`),
  pnl: () => request<Record<string, any>>('/api/accounting/pnl'),
  taxSummary: () => request<Record<string, any>>('/api/accounting/tax-summary'),
};
