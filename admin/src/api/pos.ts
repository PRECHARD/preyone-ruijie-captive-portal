import { api } from './client';

const BASE = '/api/pos';

async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = api.getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { credentials: 'include', ...options, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json as T;
}

export const posApi = {
  get: <T = any>(path: string) => request<T>(path),
  post: <T = any>(path: string, body?: any) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T = any>(path: string, body?: any) => request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  del: <T = any>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export const money = (n: any): string =>
  `$${(Number(n) || 0).toFixed(2)}`;
