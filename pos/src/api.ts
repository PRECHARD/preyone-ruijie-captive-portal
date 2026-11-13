export interface StaffUser {
  id: string;
  email: string;
  role: string;
  fullName: string;
}

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category: string | null;
  price: number;
  cost_price: number;
  stock_qty: number;
  track_stock: boolean;
  low_stock_threshold: number;
  active: boolean;
  track_serial: boolean;
  unit: string;
  allow_fractional: boolean;
  oem_part_number: string | null;
  make: string | null;
  model: string | null;
  year_from: number | null;
  year_to: number | null;
  brand: string | null;
  bin_location: string | null;
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
  price: number;
  qty: number;
  serialNumbers?: string[];
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
  subtotal: number;
  discount_pct: number;
  tax_pct: number;
  total: number;
  amount_paid: number;
  balanceDue: number;
  kdsTicketId?: string | null;
  items: Array<{ description: string; price: number; qty: number; lineTotal: number; serialNumber?: string | null }>;
  payments: Array<{ amount: number; method: string; reference?: string }>;
  customer_name?: string;
  customer_phone?: string;
}

export interface PosDocument {
  id: string;
  doc_number: string;
  doc_type: string;
  status: string;
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
  items?: Array<{ description: string; price: number; qty: number; lineTotal?: number; line_total?: number }>;
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

/**
 * Emitted when the shared admin session behind the till stops being usable.
 * `locked` (HTTP 423) keeps the account but needs a fresh PIN sign-in; `expired`
 * (HTTP 401) means the token is gone. App returns to PinLogin either way instead
 * of leaving the cashier on a screen where every action silently fails.
 */
export const SESSION_EVENT = 'preyone:pos-session';
export type SessionSignal = 'locked' | 'expired';

function signalSession(state: SessionSignal): void {
  auth.clear();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<SessionSignal>(SESSION_EVENT, { detail: state }));
  }
}

/**
 * Chromium reports transport failures as `TypeError: Failed to fetch`, which is
 * meaningless on a till screen. Normalise it to status 0 with a message staff
 * can act on.
 */
const NETWORK_ERROR = 'Cannot reach the Preyone server. Check the connection and try again.';

async function send(url: string, opts: RequestInit): Promise<Response> {
  try {
    return await fetch(url, opts);
  } catch (err) {
    if (err instanceof TypeError || (err instanceof Error && /failed to fetch|networkerror|load failed/i.test(err.message))) {
      throw new ApiError(NETWORK_ERROR, 0);
    }
    throw err;
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = auth.token();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await send(`/api/pos${path}`, { credentials: 'include', ...opts, headers });
  if (res.status === 401) {
    signalSession('expired');
    throw new ApiError('Session expired — sign in again', 401);
  }
  if (res.status === 423) {
    signalSession('locked');
    throw new ApiError('Session locked after inactivity — sign in again', 423);
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
  const res = await send(`/api${path}`, { credentials: 'include', ...opts, headers });
  if (res.status === 401) {
    signalSession('expired');
    throw new ApiError('Session expired — sign in again', 401);
  }
  if (res.status === 423) {
    signalSession('locked');
    throw new ApiError('Session locked after inactivity — sign in again', 423);
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
  counted_cash: number | null;
  cashier_name: string | null;
}

export interface CompanyProfile {
  business_profile?: string;
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
  kds_enabled?: boolean;
  table_service_enabled?: boolean;
}

export interface PosThemeTokens {
  id?: number;
  name?: string;
  primary: string;
  secondary: string;
  accent: string;
  bg: string;
  text: string;
}

export interface ThemeResponse {
  theme: PosThemeTokens;
  css: Record<string, string>;
  cssBlock: string;
}

export interface CatalogResponse {
  company: CompanyProfile & { id?: string; invoice_template_id?: number; pos_theme_id?: number };
  templates: Array<{
    id: number;
    name: string;
    description: string;
    layout: string;
    accentColor: string;
    showLogo: boolean;
  }>;
  themes: PosThemeTokens[];
  currencies: Array<{ code: string; name: string; symbol: string }>;
  documentTypes: Array<{ type: string; label: string; prefix: string; ar: boolean; credit: boolean }>;
  modules: { kds: boolean; tables: boolean };
}

export const api = {
  tillOperators: () => req<TillOperator[]>('/auth/operators'),

  company: () => req<CompanyProfile>('/company'),

  /** Active palette + the derived CSS variables every surface consumes. */
  theme: () => req<ThemeResponse>('/theme'),
  setTheme: (themeId: number) =>
    req<ThemeResponse>('/theme', { method: 'PATCH', body: JSON.stringify({ themeId }) }),

  /** Templates, themes, document types and module toggles in one read. */
  catalog: () => req<CatalogResponse>('/catalog'),
  setModules: (patch: { kds?: boolean; tables?: boolean }) =>
    req<{ kds_enabled: boolean; table_service_enabled: boolean }>('/company/modules', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  loginPin: async (userId: string, pin: string) =>
    req<{ token: string; user: StaffUser }>('/auth/pin', {
      method: 'POST',
      body: JSON.stringify({ userId, pin }),
    }),

  products: () => req<Product[]>('/products'),
  createProduct: (p: Partial<Product> & { name: string }) =>
    req<Product>('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: p.name,
        sku: p.sku || undefined,
        barcode: p.barcode || undefined,
        category: p.category || undefined,
        price: Number(p.price) || 0,
        costPrice: Number(p.cost_price) || 0,
        stockQty: Number(p.stock_qty) || 0,
        trackStock: p.track_stock !== false,
        lowStockThreshold: Number(p.low_stock_threshold) || 0,
        trackSerial: p.track_serial === true,
        unit: p.unit || 'each',
        allowFractional: p.allow_fractional === true,
        oemPartNumber: p.oem_part_number || undefined,
        make: p.make || undefined,
        model: p.model || undefined,
        yearFrom: p.year_from || undefined,
        yearTo: p.year_to || undefined,
        brand: p.brand || undefined,
        binLocation: p.bin_location || undefined,
      }),
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
    tableId?: string;
    createKds?: boolean;
    kdsStation?: string;
  }) => req<CheckoutResult>('/checkout', { method: 'POST', body: JSON.stringify(payload) }),

  // Industry profile helpers
  productsSearch: (q: Record<string, string>) => {
    const qs = new URLSearchParams(q).toString();
    return req<Product[]>(`/products?${qs}`);
  },
  registerSerials: (productId: string, serials: string[]) =>
    req<{ inserted: string[]; count: number }>(`/products/${productId}/serials`, {
      method: 'POST',
      body: JSON.stringify({ serials }),
    }),
  productSerials: (productId: string, status = 'in_stock') =>
    req<Array<{ id: string; serial_number: string; status: string }>>(`/products/${productId}/serials?status=${status}`),

  repairs: (status?: string) => req<any[]>(`/repairs${status ? `?status=${status}` : ''}`),
  createRepair: (b: any) => req<any>('/repairs', { method: 'POST', body: JSON.stringify(b) }),
  updateRepairStatus: (id: string, status: string, finalCost?: number) =>
    req<any>(`/repairs/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, finalCost }) }),
  convertRepair: (id: string) => req<any>(`/repairs/${id}/convert`, { method: 'POST' }),

  tables: () => req<any[]>('/tables'),
  createTable: (name: string, capacity?: number) =>
    req<any>('/tables', { method: 'POST', body: JSON.stringify({ name, capacity }) }),
  updateTable: (id: string, patch: any) => req<any>(`/tables/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  assignTable: (id: string, documentId: string) =>
    req<any>(`/tables/${id}/assign`, { method: 'POST', body: JSON.stringify({ documentId }) }),

  kdsTickets: (status = 'open') => req<any[]>(`/kds/tickets?status=${status}`),
  bumpKds: (id: string, status: string) => req<any>(`/kds/tickets/${id}/bump`, { method: 'POST', body: JSON.stringify({ status }) }),

  customerCredit: (id: string) => req<any>(`/customers/${id}/credit`),
  updateCustomerCredit: (id: string, patch: any) =>
    req<any>(`/customers/${id}/credit`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // No type → every document type (sales, invoices, quotations) in one list.
  documents: (type?: string | null, limit = 100, status?: string) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (type) qs.set('type', type);
    if (status) qs.set('status', status);
    return req<PosDocument[]>(`/documents?${qs.toString()}`);
  },

  document: (id: string) => req<PosDocument>(`/documents/${id}`),

  // Installment payment against an existing invoice/quote (office or till issued)
  recordPayment: (id: string, p: { amount: number; method: string; reference?: string }) =>
    req<PosDocument & { balanceDue: number }>(`/documents/${id}/payments`, {
      method: 'POST',
      body: JSON.stringify(p),
    }),

  // Quotation/sale → invoice conversion (one click from document history)
  convertToInvoice: (id: string) => req<PosDocument>(`/documents/${id}/convert-to-invoice`, { method: 'POST' }),

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
};
