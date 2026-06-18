const BASE = '/api/admin';

function getToken(): string | null {
  return localStorage.getItem('admin_token');
}

function setToken(token: string): void {
  localStorage.setItem('admin_token', token);
}

function clearToken(): void {
  localStorage.removeItem('admin_token');
}

async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const json = await res.json();
  if (!res.ok) {
    const err: any = new Error(json.error || `Request failed (${res.status})`);
    if (json.requiresApproval) err.requiresApproval = true;
    if (json.requiresHandover) err.requiresHandover = true;
    if (json.unhandedCount) err.unhandedCount = json.unhandedCount;
    throw err;
  }
  return json;
}

export const api = {
  get: <T = any>(path: string) => request<T>(path),
  post: <T = any>(path: string, body?: any) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T = any>(path: string, body?: any) => request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  del: <T = any>(path: string) => request<T>(path, { method: 'DELETE' }),
  getToken,
  setToken,
  clearToken,
};
