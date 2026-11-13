/**
 * Thin fetch wrapper for the invoicing workspace.
 *
 * Auth is inherited from the console: a Bearer token from localStorage when the
 * page is opened inside the admin shell, otherwise the httpOnly
 * `preyone_token` wildcard cookie that a sign-in on any *.preyone.com host sets.
 * `credentials: 'include'` is always on for that reason.
 */
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

/** Drop only the local bearer, keeping any other workspace state intact. */
export function clearToken(): void {
  try {
    localStorage.removeItem('gateway_token');
    localStorage.removeItem('admin_token');
  } catch {
    /* private mode: the wildcard cookie is still the source of truth */
  }
}

/**
 * App-level auth signals. The client emits these when the shared admin session
 * changes underneath the SPA, so a locked or revoked session can never leave the
 * workspace on a half-rendered screen (which is what a 423 used to do).
 */
export const SESSION_EVENT = 'preyone:session';
export type SessionSignal = 'locked' | 'expired';

function signalSession(state: SessionSignal): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<SessionSignal>(SESSION_EVENT, { detail: state }));
  }
}

/**
 * Raised when the browser cannot reach the API at all (offline, DNS, TLS or a
 * dropped connection mid-request). Chromium reports this as the opaque
 * `TypeError: Failed to fetch`, which is useless in a banner, so it is
 * normalised into an actionable ApiError with status 0.
 */
export const NETWORK_ERROR =
  'Cannot reach the Preyone server. Check your connection, then try again.';

function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && /failed to fetch|networkerror|load failed/i.test(err.message));
}

/** fetch that turns transport failures into status-0 ApiErrors. */
export async function send(path: string, opts: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(path, opts);
  } catch (err) {
    if (isNetworkFailure(err)) throw new ApiError(NETWORK_ERROR, 0, 'NETWORK');
    throw err;
  }
}

export async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const base: Record<string, string> = { 'Content-Type': 'application/json' };
  const override = (opts.headers as Record<string, string> | undefined) ?? {};
  const token = getToken();
  const headers = { ...base, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...override };

  let res = await send(path, { credentials: 'include', ...opts, headers });

  // A stale bearer token must never shadow a fresh wildcard cookie. That
  // combination is common: sign in on admin.preyone.com, then open the invoice
  // tab where an older `gateway_token` is still in localStorage. The cookie is
  // valid, so retry once without the bearer and keep the working credential.
  const authEndpoint = path.startsWith('/api/admin/auth/');
  if (res.status === 401 && token && !authEndpoint && !override.Authorization) {
    const retry = await send(path, { credentials: 'include', ...opts, headers: { ...base, ...override } });
    if (retry.ok) {
      clearToken();
      res = retry;
    }
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    const code = data.code;
    if (res.status === 423 && code === 'SESSION_LOCKED') signalSession('locked');
    else if (res.status === 401 && code !== 'UNLOCK_FAILED') signalSession('expired');
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  // Guard against SPA/HTML fallbacks masquerading as success (DOCTYPE parse
  // failures used to surface as "Unexpected token '<'" on the boot screen).
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('text/html')) {
    throw new ApiError('API returned HTML instead of JSON. The invoice API route is missing or misrouted.', res.status, 'HTML_INSTEAD_OF_JSON');
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('API returned a non-JSON body. Retry, or check invoice API routing.', res.status, 'INVALID_JSON');
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Download an authenticated binary/text response (UBL XML, PDF, …). */
export async function download(path: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await send(path, { credentials: 'include', headers });
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface Company {
  id: string;
  name: string;
  tagline?: string | null;
  address?: string | null;
  email?: string | null;
  support_phone?: string | null;
  website?: string | null;
  logo_url?: string | null;
  logo_path?: string | null;
  currency?: string;
  tax_pct?: number | string;
  business_profile?: string | null;
  invoice_template_id?: number | null;
  pos_theme_id?: number | null;
  kds_enabled?: boolean;
  table_service_enabled?: boolean;
  terms_text?: string | null;
  receipt_footer?: string | null;
  invoice_prefix?: string | null;
  quote_prefix?: string | null;
  invoice_settings?: Record<string, unknown> | null;
}

export interface InvoiceTemplate {
  id: number;
  name: string;
  description: string;
  layout: 'standard' | 'minimal' | 'compact' | string;
  accentColor: string;
  showLogo: boolean;
}

export interface DocType {
  type: string;
  label: string;
  prefix: string;
  ar: boolean;
  credit: boolean;
}

export interface ThemeTokens {
  id?: number;
  name?: string;
  primary: string;
  secondary: string;
  accent: string;
  bg: string;
  text: string;
}

export interface Catalog {
  company: Company;
  templates: InvoiceTemplate[];
  themes: ThemeTokens[];
  currencies: Array<{ code: string; name: string; symbol: string }>;
  documentTypes: DocType[];
  modules: { kds: boolean; tables: boolean };
}

export interface PosDocument {
  id: string;
  doc_number: string;
  doc_type: string;
  status: string;
  subtotal?: string | number;
  total: string | number;
  amount_paid: string | number;
  currency?: string;
  exchange_rate?: string | number;
  issue_date: string;
  due_date?: string | null;
  customer_name?: string | null;
  customer_id?: string | null;
  notes?: string | null;
  template_id?: number | null;
  doc_meta?: Record<string, unknown>;
  item_count?: number;
  created_at: string;
}

export interface DocumentLine {
  id?: string;
  description: string;
  price: string | number;
  qty: string | number;
  line_total?: string | number;
  product_name?: string | null;
}

export interface DocumentDetail extends PosDocument {
  items: DocumentLine[];
  payments: Array<{ id: string; amount: string | number; method: string; paid_at: string }>;
  customer?: { id: string; name: string; email?: string | null; address?: string | null } | null;
  cashier_name?: string | null;
}

export interface DocumentEvent {
  id: number;
  event: string;
  detail: Record<string, unknown>;
  actor_name?: string | null;
  created_at: string;
}

export interface ArAging {
  buckets: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };
  detail: Array<PosDocument & { balance: number; daysOverdue: number; bucket: string }>;
  total: number;
}

export interface ThemeResponse {
  theme: ThemeTokens;
  css: Record<string, string>;
  cssBlock: string;
}
