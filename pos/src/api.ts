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
  items: Array<{ description: string; price: number; qty: number; lineTotal: number }>;
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

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = auth.token();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/pos${path}`, { ...opts, headers });
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
}

export const api = {
  tillOperators: () => req<TillOperator[]>('/auth/operators'),

  company: () => req<CompanyProfile>('/company'),

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
  }) => req<CheckoutResult>('/checkout', { method: 'POST', body: JSON.stringify(payload) }),

  documents: (type = 'sale', limit = 100, status?: string) => {
    const qs = new URLSearchParams({ type, limit: String(limit) });
    if (status) qs.set('status', status);
    return req<PosDocument[]>(`/documents?${qs.toString()}`);
  },

  document: (id: string) => req<PosDocument>(`/documents/${id}`),
};
