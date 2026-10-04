function getToken(): string | null {
  return localStorage.getItem('admin_token');
}

function setToken(token: string): void {
  localStorage.setItem('admin_token', token);
}

function clearToken(): void {
  localStorage.removeItem('admin_token');
}

interface ApiError extends Error {
  requiresApproval?: boolean;
  requiresHandover?: boolean;
  unhandedCount?: number;
  status?: number;
}

function createClient(base: string) {
  async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
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

export { getToken, setToken, clearToken };