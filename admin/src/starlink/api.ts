/* Starlink customer portal — shared API client, token store and formatters. */

export const SL_TOKEN_KEY = 'starlink_token';

export type SlCustomer = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  walletBalance: number;
  createdAt: string;
};

export type SlUsagePoint = { month: string; usage_gb: number; is_baseline: boolean };

export type SlKit = {
  id: string;
  customer_id: string;
  kit_number: string;
  nickname: string;
  data_usage_gb: number;
  data_credit_gb: number;
  status: string;
  created_at: string;
  usage?: SlUsagePoint[];
};

export type SlInvoice = {
  id: string;
  customer_id: string;
  invoice_number: string;
  amount: number;
  currency: string;
  description: string;
  kind: string;
  status: string;
  pese_reference: string | null;
  meta: Record<string, unknown>;
  issued_date: string;
  due_date: string | null;
  paid_at: string | null;
  created_at: string;
};

export type SlDashboard = {
  customer: SlCustomer;
  balanceDue: number;
  paidThisMonth: number;
  kits: SlKit[];
  invoices: SlInvoice[];
  totals: { kits: number; pending: number; paid: number };
};

export type SlCheckoutResult = {
  success: boolean;
  invoiceNumber: string;
  referenceNumber: string;
  pesepayReference: string;
  intentId: string | null;
  statusToken: string | null;
  redirectUrl: string | null;
  pollUrl: string | null;
  instructions: string | null;
  amount: number;
  currencyCode: string;
  paymentMethod: string;
  kind: string;
};

export type SlCheckoutBody = {
  kind: 'wallet_topup' | 'data_topup' | 'kit_purchase';
  amount: number;
  paymentMethod?: string;
  phone?: string;
  returnUrl?: string;
  kitId?: string;
  gb?: number;
  bundleName?: string;
  kitNumber?: string;
  nickname?: string;
};

/* ── Token store ─────────────────────────────────────────── */

export function getToken(): string | null {
  try {
    return localStorage.getItem(SL_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(SL_TOKEN_KEY, token);
  } catch {
    /* storage unavailable — session stays in memory only */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(SL_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Fired globally when the portal session expires (HTTP 401). */
export const SL_UNAUTH_EVENT = 'starlink:unauthorized';

function notifyUnauthorized(): void {
  clearToken();
  try {
    window.dispatchEvent(new CustomEvent(SL_UNAUTH_EVENT));
  } catch {
    /* ignore */
  }
}

/* ── Fetch helpers ───────────────────────────────────────── */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string' && data.error) return data.error;
  } catch {
    /* body was not JSON */
  }
  return res.statusText || `Request failed (${res.status})`;
}

/** Authenticated GET/POST against /api/starlink/* (customer JWT). */
export async function sfetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api/starlink${path}`, { ...init, headers });
  if (res.status === 401) {
    notifyUnauthorized();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** POST /api/payments/pese/checkout (same customer JWT). */
export async function slCheckout(body: SlCheckoutBody): Promise<SlCheckoutResult> {
  const token = getToken();
  const res = await fetch('/api/payments/pese/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    notifyUnauthorized();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as SlCheckoutResult;
}

export type SlPaymentStatus = {
  status: string;
  referenceNumber: string;
  amount: number;
  currency: string;
  createdAt: string;
  completedAt: string | null;
};

/** Poll a Pese intent's public status with its short-lived status token. */
export async function slPaymentStatus(intentId: string, statusToken: string): Promise<SlPaymentStatus> {
  const res = await fetch(
    `/api/payments/pesepay/status/${encodeURIComponent(intentId)}?token=${encodeURIComponent(statusToken)}`
  );
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as SlPaymentStatus;
}

/* ── Formatters ──────────────────────────────────────────── */

export function fmtMoney(n: number, currency = 'USD'): string {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  const sym = currency === 'USD' || !currency ? '$' : `${currency} `;
  return `${sym}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function monthLabel(month: string): string {
  const d = new Date(`${String(month).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(month).slice(0, 7);
  return d.toLocaleDateString('en-GB', { month: 'short' });
}

export const SL_TABS = [
  'Home',
  'Subscriptions',
  'Billing',
  'Devices',
  'Orders',
  'Support',
  'FAQs',
] as const;

export type SlTab = (typeof SL_TABS)[number];
