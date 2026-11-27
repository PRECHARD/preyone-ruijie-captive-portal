/* Starlink customer portal — shared API client, token store and formatters. */

export const SL_TOKEN_KEY = 'starlink_token';

export type SlCustomer = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  walletBalance: number;
  planCode?: string | null;
  planRenewsAt?: string | null;
  emailVerified?: boolean;
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
  site_name: string;
  city: string;
  gps_lat: number | null;
  gps_lng: number | null;
  hardware_model: string;
  pending_status: string | null;
  pending_status_at: string | null;
  pending_request_id: string | null;
  usage?: SlUsagePoint[];
};

export type SlRole = 'owner' | 'admin' | 'billing' | 'viewer';

export type SlAccountMember = {
  id: string;
  name: string;
  email: string;
  role: Exclude<SlRole, 'owner'>;
  assignedKitIds: string[];
  acceptedAt: string | null;
};

export type SlCreditTransfer = {
  id: string;
  customer_id: string;
  from_kit_id: string;
  to_kit_id: string;
  gb: number;
  event_key: string;
  created_at: string;
};

export type SlFleetResponse = {
  role: SlRole;
  member: SlAccountMember | null;
  kits: SlKit[];
  invoices: SlInvoice[];
  transfers: SlCreditTransfer[];
  members: SlAccountMember[];
  permissions: { canBill: boolean; canManage: boolean; canInvite: boolean };
  summary: {
    kitCount: number;
    activeKits: number;
    pausedKits: number;
    totalDataUsedGb: number;
    totalDataCreditGb: number;
    walletBalance: number;
    balanceDue: number;
    nextRenewalDate: string | null;
  };
};

export type SlServiceStateRequest = {
  id: string;
  kit_id: string;
  requested_status: 'active' | 'paused';
  effective_at: string;
  note: string;
  applied_at: string | null;
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

export type SlPendingIntent = {
  intent_id: string;
  invoice_id: string;
  invoice_number: string;
  reference: string;
  amount: number;
  created_at: string;
};

export type SlNotification = {
  id: string;
  customer_id: string;
  category: 'PAYMENT' | 'USAGE_ALERT' | 'AUTO_TOPUP' | 'COMMAND' | 'TICKET' | 'FLEET';
  event_key: string;
  title: string;
  body: string;
  link_url: string | null;
  meta: Record<string, unknown>;
  is_read: boolean;
  visible_in_portal?: boolean;
  email_status: string;
  email_sent_at: string | null;
  created_at: string;
};

export type SlAlertPreferences = {
  kit_id: string;
  customer_id: string;
  alert_75_sent_cycle: string | null;
  alert_90_sent_cycle: string | null;
  alert_100_sent_cycle: string | null;
  alert_75_email_enabled: boolean;
  alert_75_portal_enabled: boolean;
  alert_90_email_enabled: boolean;
  alert_90_portal_enabled: boolean;
  alert_100_email_enabled: boolean;
  alert_100_portal_enabled: boolean;
  email_alerts_enabled: boolean;
  portal_alerts_enabled: boolean;
  offline_alerts_enabled: boolean;
  auto_topup_enabled: boolean;
  auto_topup_gb: number;
  auto_topup_min_gb: number;
};

export type SlTelemetrySnapshot = {
  id: string;
  kit_id: string;
  recorded_at: string;
  priority_used_gb: number;
  standard_used_gb: number;
  download_mbps: number | null;
  upload_mbps: number | null;
  latency_ms: number | null;
  ping_drop_rate: number | null;
  obstruction_percent: number | null;
  uptime_seconds: number | null;
  online_status: boolean;
};

export type SlTelemetryDailyPoint = {
  date: string;
  priority_gb: number;
  standard_gb: number;
  total_gb: number;
};

export type SlTelemetryMetrics = {
  daily_burn_rate_gb: number;
  days_remaining: number | null;
  projected_exhaustion_date: string | null;
  priority_used_gb: number;
  standard_used_gb: number;
  priority_total_gb: number;
  standard_total_gb: number;
  priority_percent: number;
  standard_percent: number;
  total_percent: number;
  remaining_gb: number;
  sample_count: number;
};

export type SlTelemetryResponse = {
  kit_id: string;
  cycle: string;
  snapshots: SlTelemetrySnapshot[];
  daily: SlTelemetryDailyPoint[];
  metrics: SlTelemetryMetrics;
  preferences: SlAlertPreferences;
};

export type SlVerifyResult = {
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  message: string;
  invoiceNumber?: string;
  providerReference?: string;
  alreadyPaid?: boolean;
  amount?: number;
};

export type SlDashboard = {
  customer: SlCustomer;
  role?: SlRole;
  member?: SlAccountMember | null;
  balanceDue: number;
  paidThisMonth: number;
  kits: SlKit[];
  invoices: SlInvoice[];
  pendingIntents?: SlPendingIntent[];
  unreadCount?: number;
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
  kind: 'wallet_topup' | 'data_topup' | 'kit_purchase' | 'plan_change' | 'plan_renewal';
  planCode?: string;
  invoiceId?: string;
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

/** Customer-authenticated re-check of a Starlink intent after a missed webhook. */
export async function slVerifyPayment(intentId: string): Promise<SlVerifyResult> {
  return sfetch<SlVerifyResult>(`/payments/verify/${encodeURIComponent(intentId)}`, { method: 'POST' });
}

export async function slNotifications(limit = 50): Promise<{
  notifications: SlNotification[];
  unreadCount: number;
}> {
  return sfetch(`/notifications?limit=${limit}`);
}

export async function slMarkNotificationsRead(ids?: string[]): Promise<{
  ok: boolean;
  changed: number;
  unreadCount: number;
}> {
  return sfetch('/notifications/mark-read', {
    method: 'POST',
    body: JSON.stringify(ids?.length ? { ids } : {}),
  });
}

/** Latest 30-day telemetry, daily totals, burn-rate forecast and alert prefs. */
export async function slTelemetry(kitId: string): Promise<SlTelemetryResponse> {
  return sfetch(`/telemetry?kitId=${encodeURIComponent(kitId)}`);
}

export type SlAlertPreferenceUpdate = Partial<Pick<
  SlAlertPreferences,
  | 'alert_75_email_enabled'
  | 'alert_75_portal_enabled'
  | 'alert_90_email_enabled'
  | 'alert_90_portal_enabled'
  | 'alert_100_email_enabled'
  | 'alert_100_portal_enabled'
  | 'email_alerts_enabled'
  | 'portal_alerts_enabled'
  | 'offline_alerts_enabled'
  | 'auto_topup_enabled'
  | 'auto_topup_gb'
  | 'auto_topup_min_gb'
>> & { kitId?: string };

export async function slUpdateAlertPreferences(body: SlAlertPreferenceUpdate): Promise<{
  ok: boolean;
  preferences: SlAlertPreferences;
}> {
  return sfetch('/telemetry/preferences', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/* ── Fleet, transfers and sub-accounts ──────────────────── */

export async function slPatchKit(kitId: string, body: Record<string, unknown>): Promise<{ ok: boolean }> {
  return sfetch(`/kits/${encodeURIComponent(kitId)}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function slFleet(): Promise<SlFleetResponse> {
  return sfetch('/fleet');
}

export async function slInvoices(status?: string): Promise<{ invoices: SlInvoice[] }> {
  return sfetch(`/invoices${status ? `?status=${encodeURIComponent(status)}` : ''}`);
}

export async function slTransferData(body: {
  fromKitId: string;
  toKitId: string;
  gb: number;
  idempotencyKey?: string;
}): Promise<{
  ok: boolean;
  transfer: SlCreditTransfer;
  fromBalance: number;
  toBalance: number;
  notificationCreated: boolean;
}> {
  return sfetch('/kits/transfer-data', { method: 'POST', body: JSON.stringify(body) });
}

export async function slSetServiceState(kitId: string, body: {
  state: 'active' | 'paused';
  effectiveAt?: string;
  note?: string;
}): Promise<{
  ok: boolean;
  request: SlServiceStateRequest;
  applied: boolean;
  notificationCreated: boolean;
}> {
  return sfetch(`/kits/${encodeURIComponent(kitId)}/service-state`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function slMembers(): Promise<{ members: SlAccountMember[] }> {
  return sfetch('/members');
}

export async function slInviteMember(body: {
  email: string;
  name: string;
  role: 'admin' | 'billing' | 'viewer';
  assignedKitIds: string[];
}): Promise<{ member: SlAccountMember; inviteUrl: string; emailSent: boolean }> {
  return sfetch('/members/invite', { method: 'POST', body: JSON.stringify(body) });
}

export async function slUpdateMember(
  memberId: string,
  body: { role: 'admin' | 'billing' | 'viewer'; assignedKitIds: string[] }
): Promise<{ member: SlAccountMember }> {
  return sfetch(`/members/${encodeURIComponent(memberId)}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function slResendMemberInvite(
  memberId: string
): Promise<{ member: SlAccountMember; inviteUrl: string; emailSent: boolean }> {
  return sfetch(`/members/${encodeURIComponent(memberId)}/resend-invite`, { method: 'POST' });
}

export async function slRemoveMember(memberId: string): Promise<{ ok: boolean }> {
  return sfetch(`/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
}

/** Public invite acceptance; the token comes from the emailed link. */
export async function slAcceptMemberInvite(body: {
  token: string;
  name?: string;
  password: string;
}): Promise<{
  token: string;
  customer: SlCustomer;
  role: SlRole;
  member?: SlAccountMember;
}> {
  return sfetch('/members/accept', { method: 'POST', body: JSON.stringify(body) });
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

export type SlPlanApplication = {
  id: string;
  from_plan_code: string | null;
  to_plan_code: string;
  requested_start: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
  decision_note: string | null;
  created_at: string;
};

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
