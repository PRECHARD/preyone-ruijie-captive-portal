/** Fetch wrapper for the home-automation dashboard. */

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getToken(): string | null {
  return localStorage.getItem('gateway_token') || localStorage.getItem('admin_token');
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { credentials: 'include', ...opts, headers: { ...headers, ...(opts.headers as Record<string, string> | undefined) } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(
      (data as { error?: string }).error || `Request failed (${res.status})`,
      res.status,
      (data as { code?: string }).code
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export type DeviceKind = 'switch' | 'dimmer' | 'sensor' | 'thermostat' | 'camera' | 'gateway' | 'meter' | 'lock';

export interface IotDevice {
  id: string;
  name: string;
  kind: DeviceKind | string;
  room: string | null;
  transport: string;
  vendor?: string | null;
  model?: string | null;
  online: boolean;
  state: Record<string, unknown>;
  last_seen_at: string | null;
  metrics?: Record<string, number> | null;
}

export interface Trigger {
  id: string;
  device_id: string;
  device_name?: string;
  name: string;
  metric: string;
  operator: string;
  threshold: string | number;
  action: string;
  enabled: boolean;
  last_fired_at: string | null;
}

export interface UptimeSample {
  recorded_at: string;
  online: boolean;
  latency_ms: number | string | null;
  down_mbps: number | string | null;
  up_mbps: number | string | null;
}

export interface UptimeSummary {
  samples: number;
  uptimePct: number;
  latencyMs: number;
  downMbps: number;
  upMbps: number;
  lastSampleAt: string | null;
  series: UptimeSample[];
}

export interface IotEvent {
  id: number;
  device_id: string | null;
  device_name?: string | null;
  event: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface Summary {
  company: { id: string; name: string };
  devices: { total: number; online: number; offline: number; gateways: number; healthPct: number };
  energy: { kwhToday: number; currency: string; ratePerKwh: number };
  starlink: { uptimePct: number; latencyMs: number; lastSampleAt: string | null };
  triggers: { active: number; firedToday: number };
  events: IotEvent[];
  hub: { companies: number; sockets: number };
  updatedAt: string;
}

export interface StreamEvent {
  type: 'hello' | 'device_state' | 'telemetry' | 'trigger' | 'alert' | 'pong';
  companyId?: string;
  at: string;
  payload: Record<string, unknown>;
}

export interface ThemeResponse {
  theme: { id?: number; name?: string; primary: string; secondary: string; accent: string; bg: string; text: string };
  css: Record<string, string>;
  cssBlock: string;
}

export function streamUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getToken();
  const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${proto}//${window.location.host}/api/homeautomate/stream${suffix}`;
}
