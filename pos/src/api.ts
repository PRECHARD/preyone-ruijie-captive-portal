export interface StaffUser {
  id: string;
  email: string;
  role: string;
  fullName: string;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  category: string | null;
  price: number;
  cost_price: number;
  stock_qty: number;
  track_stock: boolean;
  low_stock_threshold: number;
  active: boolean;
  /** Optional real photo; when absent the till draws an automatic product icon. */
  image_url?: string | null;
}

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
}

export interface Shift {
  id: string;
  cashier_id: string;
  opening_float: number;
  opened_at: string;
  closed_at: string | null;
  expected_cash: number | null;
  counted_cash: number | null;
  variance: number | null;
  status: 'open' | 'closed';
}

export interface MethodTotal {
  method: string;
  total: number;
  count: number;
}

export interface CartLine {
  productId: string | null;
  description: string;
  details: string[];
  price: number;
  qty: number;
}

export interface PaymentInput {
  amount: number;
  method: string;
  reference?: string;
}

export interface CheckoutResult {
  id: string;
  doc_number: string;
  doc_type: string;
  status: string;
  verify_code?: string | null;
  subtotal: number;
  discount_pct: number;
  tax_pct: number;
  total: number;
  amount_paid: number;
  balanceDue: number;
  items: Array<{ description: string; details?: string[]; price: number; qty: number; lineTotal: number }>;
  payments: Array<{ amount: number; method: string; reference?: string }>;
  customer_name?: string;
  customer_phone?: string;
}

export interface PosDocument {
  id: string;
  doc_number: string;
  doc_type: string;
  status: string;
  verify_code?: string | null;
  subtotal: number;
  discount_pct: number;
  tax_pct: number;
  total: number;
  amount_paid: number;
  balanceDue: number;
  created_at: string;
  cashier_name: string | null;
  customer_name?: string | null;
  item_count?: number;
  doc_meta?: Record<string, unknown>;
  items?: Array<{
    description: string;
    details?: string[];
    price: number;
    qty: number;
    lineTotal?: number;
    line_total?: number;
  }>;
  payments?: Array<{ amount: number; method: string; reference?: string }>;
}

export interface CurrencyRate {
  base_currency: string;
  target_currency: string;
  rate: number;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  price: number;
  devices: number;
  tagline: string;
}

export interface SubscriptionPlans {
  tenantId: string;
  current: {
    plan_type: string;
    max_devices: number;
    subscription_status: string;
    subscription_expires_at: string | null;
  } | null;
  tiers: SubscriptionPlan[];
  currency: string;
}

export interface CheckoutSession {
  success: boolean;
  tier: string;
  name: string;
  amount: number;
  currencyCode: string;
  paymentMethod: string;
  reference: string;
  redirectUrl?: string;
  pollUrl?: string;
  instructions?: string;
  tenantId: string;
}

const TOKEN_KEY = 'pos_token';
const USER_KEY = 'pos_user';

export const auth = {
  token: (): string | null => localStorage.getItem(TOKEN_KEY),
  user: (): StaffUser | null => {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StaffUser;
    } catch {
      return null;
    }
  },
  save: (token: string, user: StaffUser): void => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear: (): void => {
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

const HEARTBEAT_THROTTLE_MS = 60_000;
let heartbeatInstalled = false;
let lastActivityPing = 0;

/**
 * Keep an actively used till alive. POS tokens are admin-session tokens with a
 * per-device sid; /refresh slides the inactivity clock so a cashier is never
 * dropped mid-sale. Hidden tabs stop refreshing.
 */
export function installSessionHeartbeat(): void {
  if (heartbeatInstalled || typeof window === 'undefined') return;
  heartbeatInstalled = true;

  const ping = () => {
    if (document.visibilityState !== 'visible') return;
    const token = auth.token();
    if (!token) return;
    const now = Date.now();
    if (now - lastActivityPing < HEARTBEAT_THROTTLE_MS) return;
    lastActivityPing = now;
    void fetch('/api/admin/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  };

  for (const event of ['pointerdown', 'keydown', 'touchstart', 'mousemove', 'scroll'] as const) {
    window.addEventListener(event, ping, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ping();
  });
  window.setInterval(ping, 4 * 60_000);
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = auth.token();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/pos${path}`, { credentials: 'include', ...opts, headers });
  if (res.status === 401) {
    auth.clear();
    throw new ApiError('Session expired — sign in again', 401);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError((data as { error?: string }).error || `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

// Same session rules as req(), but for endpoints outside /api/pos that still
// accept the PIN-session Bearer token (subscription checkout, currency rates).
async function root<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = auth.token();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { credentials: 'include', ...opts, headers });
  if (res.status === 401) {
    auth.clear();
    throw new ApiError('Session expired — sign in again', 401);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError((data as { error?: string }).error || `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export interface TillOperator {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

export interface CashierRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  approved: boolean;
  has_pin: boolean;
}

export interface ShiftHistoryRow {
  id: string;
  opened_at: string;
  closed_at: string | null;
  status: string;
  opening_float: number;
  expected_cash?: number | null;
  counted_cash: number | null;
  variance?: number | null;
  close_receipt_sent_at?: string | null;
  cashier_name: string | null;
}

export interface CompanyBranding {
  name: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  logoUrl: string | null;
  logoPath: string | null;
  taxId: string;
  registrationNumber: string;
  termsText: string;
  footerText: string;
  receipt: Record<string, unknown>;
}

export interface CompanyProfile {
  name: string;
  tagline: string | null;
  address: string | null;
  email: string | null;
  support_phone: string | null;
  website: string | null;
  currency: string;
  tax_pct: number;
  invoice_prefix: string | null;
  quote_prefix: string | null;
  receipt_footer: string | null;
  terms_text: string | null;
  logo_url?: string | null;
  logo_path?: string | null;
  branding?: CompanyBranding | null;
}

export const api = {
  /**
   * Operator picker is pre-auth. A till that has already been linked passes its
   * company id so the server returns only that tenant's roster; an unlinked
   * till gets TENANT_REQUIRED until the setup code is entered.
   */
  tillOperators: (companyId?: string) =>
    req<{ companyId: string; operators: TillOperator[] }>(
      `/auth/operator-roster${companyId ? `?company=${encodeURIComponent(companyId)}` : ''}`
    ),

  company: () => req<CompanyProfile>('/company'),

  loginPin: async (userId: string, pin: string, companyId?: string) =>
    req<{ token: string; user: StaffUser }>('/auth/pin', {
      method: 'POST',
      body: JSON.stringify({ userId, pin, ...(companyId ? { companyId } : {}) }),
    }),

  products: (includeInactive = false) =>
    req<Product[]>(`/products${includeInactive ? '?includeInactive=1' : ''}`),
  createProduct: (p: Partial<Product> & { name: string }) =>
    req<Product>('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: p.name,
        description: p.description || undefined,
        sku: p.sku || undefined,
        barcode: p.barcode || undefined,
        category: p.category || undefined,
        price: Number(p.price) || 0,
        costPrice: Number(p.cost_price) || 0,
        stockQty: Number(p.stock_qty) || 0,
        trackStock: p.track_stock !== false,
        lowStockThreshold: Number(p.low_stock_threshold) || 0,
        imageUrl: p.image_url || undefined,
      }),
    }),
  uploadProductImage: (dataUrl: string) =>
    req<{ imageUrl: string; filename: string; bytes: number }>('/products/image', {
      method: 'POST',
      body: JSON.stringify({ dataUrl }),
    }),
  updateProduct: (id: string, patch: Record<string, unknown>) =>
    req<Product>(`/products/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  archiveProduct: (id: string) => req<{ ok: boolean }>(`/products/${id}`, { method: 'DELETE' }),
  adjustStock: (id: string, delta: number, reason: string) =>
    req<{ id: string; stock_qty: number }>(`/products/${id}/stock`, {
      method: 'POST',
      body: JSON.stringify({ delta, reason }),
    }),

  currentShift: () => req<{ shift: Shift; totalsByMethod: MethodTotal[] } | null>('/shifts/current'),
  openShift: (openingFloat: number) =>
    req<Shift>('/shifts/open', { method: 'POST', body: JSON.stringify({ openingFloat }) }),
  closeShift: (countedCash: number, notes = '') =>
    req<{ shift: Shift; totalsByMethod: MethodTotal[] }>('/shifts/close', {
      method: 'POST',
      body: JSON.stringify({ countedCash, notes }),
    }),

  checkout: (payload: {
    docType: string;
    channel: string;
    customer?: { name?: string; phone?: string };
    items: CartLine[];
    payments: PaymentInput[];
    discountPct?: number;
    taxPct?: number;
    notes?: string;
  }) => req<CheckoutResult>('/checkout', { method: 'POST', body: JSON.stringify(payload) }),

  // No type → every document type (sales, invoices, quotations) in one list.
  documents: (type?: string | null, limit = 100, status?: string) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (type) qs.set('type', type);
    if (status) qs.set('status', status);
    return req<PosDocument[]>(`/documents?${qs.toString()}`);
  },

  document: (id: string) => req<PosDocument>(`/documents/${id}`),
  updateDocument: (id: string, patch: Record<string, unknown>) =>
    req<PosDocument>(`/documents/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteDocument: (id: string) => req<{ ok: boolean }>(`/documents/${id}`, { method: 'DELETE' }),

  // Client book (invoicing / credit customers)
  customers: () => req<CustomerRow[]>('/customers'),
  createCustomer: (c: {
    name: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    notes?: string | null;
  }) =>
    req<CustomerRow>('/customers', { method: 'POST', body: JSON.stringify(c) }),
  updateCustomer: (id: string, patch: Partial<Omit<CustomerRow, 'id'>>) =>
    req<CustomerRow>(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCustomer: (id: string) => req<{ ok: boolean }>(`/customers/${id}`, { method: 'DELETE' }),

  // Installment payment against an existing invoice/quote (office or till issued)
  recordPayment: (id: string, p: { amount: number; method: string; reference?: string }) =>
    req<PosDocument & { balanceDue: number }>(`/documents/${id}/payments`, {
      method: 'POST',
      body: JSON.stringify(p),
    }),

  // Quotation/sale → invoice conversion (one click from document history)
  convertToInvoice: (id: string, docType?: string) =>
    req<PosDocument>(
      `/documents/${id}/${docType === 'sale' ? 'convert-to-invoice' : 'issue-invoice'}`,
      { method: 'POST' }
    ),

  // Cash drawer audit: logs the exact ESC/POS kick bytes against the shift
  drawerAudit: (payload: { event?: 'open' | 'close' | 'test'; shiftId?: string | null }) =>
    req<{ ok: boolean; event: string; command: string }>('/shifts/drawer-audit', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ── Till management (Settings screen) ─────────────────────────────────
  // Change own PIN, or any user's PIN when the session role is Manager/CEO.
  setPin: (pin: string, userId?: string) =>
    req<{ ok: boolean; user: { id: string; full_name: string } }>('/auth/set-pin', {
      method: 'POST',
      body: JSON.stringify({ pin, userId: userId || undefined }),
    }),

  // Manager/CEO: every till operator in the company (has_pin flag included).
  cashiers: () => req<CashierRow[]>('/cashiers'),

  // Recent shifts — own by default, every cashier with ?all=1 (Manager/CEO).
  shiftHistory: (all = false) =>
    req<ShiftHistoryRow[]>(`/shifts${all ? '?all=1' : ''}`),

  // ── Subscription (outside /api/pos, same PIN-session token) ─────────────
  subscriptionPlans: () => root<SubscriptionPlans>('/subscription/plans'),
  subscriptionCheckout: (payload: { tier: string; currencyCode?: string; paymentMethod?: string; phone?: string }) =>
    root<CheckoutSession>('/subscription/checkout', { method: 'POST', body: JSON.stringify(payload) }),
  currencyRates: () => root<{ rates: CurrencyRate[]; fallback: boolean }>('/currency/rates'),

  /** Settings & Branding palette — applies --pos-* CSS vars across the till. */
  theme: () => req<{ theme: { id: number; name: string }; css: Record<string, string> }>('/theme'),
};

/** Enterprise accounting endpoints — same PIN Bearer token as POS. */
export const accountingApi = {
  overview: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const q = qs.toString();
    return root<any>(`/accounting/overview${q ? `?${q}` : ''}`);
  },
  ledger: (params?: { from?: string; to?: string; rail?: string; type?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.rail) qs.set('rail', params.rail);
    if (params?.type) qs.set('type', params.type);
    if (params?.limit) qs.set('limit', String(params.limit));
    return root<{ rows: any[]; total: number }>(`/accounting/ledger?${qs}`);
  },
  pnl: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const q = qs.toString();
    return root<any>(`/accounting/pnl${q ? `?${q}` : ''}`);
  },
  taxSummary: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const q = qs.toString();
    return root<any>(`/accounting/tax-summary${q ? `?${q}` : ''}`);
  },
};
