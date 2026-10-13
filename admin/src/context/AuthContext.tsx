import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getToken, setToken, clearToken } from '../api/client';

export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  role: string;
  companyId?: string | null;
  permissions?: string[];
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (data: { fullName: string; email: string; phone: string; role: string; password: string }) => Promise<{ pendingApproval?: boolean; message?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchMe(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch('/api/admin/auth/me', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!data.id) return null;
  return {
    id: data.id,
    fullName: data.full_name || data.fullName,
    email: data.email,
    role: data.role,
    companyId: data.company_id ?? null,
    permissions: data.permissions ?? [],
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMe()
      .then(setUser)
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    setToken(data.token);
    const me = await fetchMe();
    setUser(me || { id: data.user.id, fullName: data.user.fullName, email: data.user.email, role: data.user.role, companyId: null, permissions: [] });
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

  const logout = useCallback(() => {
    clearToken();
    localStorage.removeItem('admin_user');
    localStorage.removeItem('admin_token');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}