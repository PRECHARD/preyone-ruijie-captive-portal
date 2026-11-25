import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { mergePlanTiers } from '../plans';
import '../clientTenants.css';

/**
 * House-CEO control room for client portal tenants.
 *
 * This component never decides authorisation: every request goes to endpoints
 * guarded by requireHouseCeo. It is only rendered for the house CEO so client
 * CEOs never see the platform's tenant list.
 */

interface TenantRow {
  id: string;
  name: string;
  currency: string;
  plan_type: string | null;
  plan_name: string | null;
  plan_price: number | null;
  max_devices: number;
  active_devices: number;
  subscription_status: string;
  subscription_expires_at: string | null;
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
  is_house: boolean;
  status: 'Active' | 'Expiring Soon' | 'Expired' | 'Suspended' | string;
  till_code: string;
}

interface PortalListResponse {
  houseCompanyId: string;
  tenants: TenantRow[];
}

const BUSINESS_PROFILES = [
  { id: 'retail', name: 'Retail' },
  { id: 'mobile_computer', name: 'Mobile & Computer' },
  { id: 'auto_spares', name: 'Auto Spares' },
  { id: 'small_trader', name: 'Small Trader' },
  { id: 'fast_food_qsr', name: 'Fast Food / QSR' },
  { id: 'restaurant_dine_in', name: 'Restaurant / Fine Dining' },
];

const CURRENCIES = [
  { code: 'USD', name: 'US Dollar' },
  { code: 'ZWG', name: 'Zimbabwe Gold (ZiG)' },
];

function money(value: number | null | undefined): string {
  return `$${Number(value ?? 0).toFixed(2)}`;
}

function dateText(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusClass(status: string): string {
  switch (status) {
    case 'Active':
      return 'is-active';
    case 'Expiring Soon':
      return 'is-soon';
    case 'Expired':
      return 'is-expired';
    case 'Suspended':
      return 'is-suspended';
    default:
      return '';
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

function copyText(text: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }
}

/* ───────────────────────── Provision modal ───────────────────────── */

function ProvisionModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const tiers = useMemo(() => mergePlanTiers(), []);
  const [form, setForm] = useState({
    businessName: '',
    tagline: '',
    businessProfile: 'retail',
    currency: 'USD',
    taxPct: '15.5',
    invoicePrefix: 'INV',
    quotePrefix: 'QUO',
    planType: 'pos_invoice_15',
    durationDays: '30',
    ownerName: '',
    ownerEmail: '',
    ownerPhone: '',
    tempPassword: '',
    posPin: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{
    company: { id: string; name: string };
    owner: { full_name: string; email: string };
    plan_name: string;
    duration_days: number;
    till_code: string;
    login_urls: { invoice: string; pos: string };
    welcome_email_sent?: boolean;
  } | null>(null);

  const set = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const generatePassword = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
    const bytes = new Uint32Array(14);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 2 ** 32);
    }
    const password = Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
    set('tempPassword', password);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{
        company: { id: string; name: string };
        owner: { full_name: string; email: string };
        plan_name: string;
        duration_days: number;
        till_code: string;
        login_urls: { invoice: string; pos: string };
        welcome_email_sent?: boolean;
      }>('/api/admin/tenants/provision', {
        businessName: form.businessName.trim(),
        tagline: form.tagline.trim(),
        businessProfile: form.businessProfile,
        currency: form.currency,
        taxPct: Number(form.taxPct) || 0,
        invoicePrefix: form.invoicePrefix.trim(),
        quotePrefix: form.quotePrefix.trim(),
        planType: form.planType,
        durationDays: Number(form.durationDays) || 30,
        ownerName: form.ownerName.trim(),
        ownerEmail: form.ownerEmail.trim(),
        ownerPhone: form.ownerPhone.trim(),
        tempPassword: form.tempPassword,
        posPin: form.posPin.trim() || undefined,
      });
      setCreated(res);
      onDone(`Provisioned ${res.company.name} on ${res.plan_name}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ct-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="ct-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ct-provision-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ct-modal-head">
          <div>
            <span className="ct-eyebrow">Onboarding</span>
            <h3 id="ct-provision-title">Provision new client</h3>
            <p>Creates the tenant, its CEO login and both module subscriptions in one transaction.</p>
          </div>
          <button type="button" className="ct-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {created ? (
          <div className="ct-success">
            <strong>{created.company.name} is live on {created.plan_name}.</strong>
            <p>
              {created.owner.full_name} can sign in with <b>{created.owner.email}</b> and the
              temporary password you set, then change it from the console.
            </p>
            <div className="ct-success-grid">
              <div>
                <span>Invoice portal</span>
                <a href={created.login_urls.invoice} target="_blank" rel="noreferrer">
                  {created.login_urls.invoice}
                </a>
              </div>
              <div>
                <span>POS portal</span>
                <a href={created.login_urls.pos} target="_blank" rel="noreferrer">
                  {created.login_urls.pos}
                </a>
              </div>
              <div className="ct-span-2">
                <span>Till code (enter once on each new till)</span>
                <code>{created.till_code}</code>
                <button type="button" className="ct-copy" onClick={() => copyText(created.till_code)}>
                  Copy
                </button>
              </div>
            </div>
            <p className="ct-hint">
              Plan valid for {created.duration_days} days.{' '}
              {created.welcome_email_sent
                ? `A welcome email with the sign-in details was sent to ${created.owner.email}.`
                : 'The welcome email could not be sent — hand the credentials over securely.'}{' '}
              Record the cash payment next from the client row to book the revenue in Preyone's
              ledger.
            </p>
            <div className="ct-modal-actions">
              <button type="button" className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form className="ct-form" onSubmit={submit}>
            {error && <div className="banner error">{error}</div>}

            <div className="ct-form-grid">
              <label className="ct-field ct-span-2">
                <span>Business name</span>
                <input
                  className="input"
                  value={form.businessName}
                  onChange={(e) => set('businessName', e.target.value)}
                  placeholder="Acme Traders (Pvt) Ltd"
                  required
                />
              </label>

              <label className="ct-field ct-span-2">
                <span>Tagline</span>
                <input
                  className="input"
                  value={form.tagline}
                  onChange={(e) => set('tagline', e.target.value)}
                  placeholder="Wholesale & retail"
                />
              </label>

              <label className="ct-field">
                <span>Business profile</span>
                <select
                  className="select"
                  value={form.businessProfile}
                  onChange={(e) => set('businessProfile', e.target.value)}
                >
                  {BUSINESS_PROFILES.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="ct-field">
                <span>Currency</span>
                <select
                  className="select"
                  value={form.currency}
                  onChange={(e) => set('currency', e.target.value)}
                >
                  {CURRENCIES.map((currency) => (
                    <option key={currency.code} value={currency.code}>
                      {currency.code} · {currency.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="ct-field">
                <span>Plan</span>
                <select
                  className="select"
                  value={form.planType}
                  onChange={(e) => set('planType', e.target.value)}
                >
                  {tiers.map((tier) => (
                    <option key={tier.id} value={tier.id}>
                      {tier.name} · ${tier.price}/mo
                    </option>
                  ))}
                </select>
              </label>

              <label className="ct-field">
                <span>Duration (days)</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={3650}
                  value={form.durationDays}
                  onChange={(e) => set('durationDays', e.target.value)}
                />
              </label>

              <label className="ct-field">
                <span>Tax %</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={form.taxPct}
                  onChange={(e) => set('taxPct', e.target.value)}
                />
              </label>

              <label className="ct-field">
                <span>Invoice prefix</span>
                <input
                  className="input"
                  value={form.invoicePrefix}
                  maxLength={12}
                  onChange={(e) => set('invoicePrefix', e.target.value.toUpperCase())}
                />
              </label>

              <label className="ct-field">
                <span>Quote prefix</span>
                <input
                  className="input"
                  value={form.quotePrefix}
                  maxLength={12}
                  onChange={(e) => set('quotePrefix', e.target.value.toUpperCase())}
                />
              </label>

              <label className="ct-field ct-span-2">
                <span>Owner full name</span>
                <input
                  className="input"
                  value={form.ownerName}
                  onChange={(e) => set('ownerName', e.target.value)}
                  placeholder="Acme Owner"
                  required
                />
              </label>

              <label className="ct-field">
                <span>Owner email</span>
                <input
                  className="input"
                  type="email"
                  value={form.ownerEmail}
                  onChange={(e) => set('ownerEmail', e.target.value)}
                  placeholder="owner@acme.co.zw"
                  required
                />
              </label>

              <label className="ct-field">
                <span>Owner phone</span>
                <input
                  className="input"
                  value={form.ownerPhone}
                  onChange={(e) => set('ownerPhone', e.target.value)}
                  placeholder="+263 77 123 4567"
                  required
                />
              </label>

              <label className="ct-field ct-span-2">
                <span>Temporary password</span>
                <div className="ct-inline">
                  <input
                    className="input"
                    value={form.tempPassword}
                    onChange={(e) => set('tempPassword', e.target.value)}
                    minLength={8}
                    placeholder="At least 8 characters"
                    required
                  />
                  <button type="button" className="btn ghost" onClick={generatePassword}>
                    Generate
                  </button>
                </div>
                <small className="ct-hint">
                  Only the bcrypt hash is stored. Send this to the client over a secure channel.
                </small>
              </label>

              <label className="ct-field">
                <span>POS PIN (optional)</span>
                <input
                  className="input"
                  value={form.posPin}
                  onChange={(e) => set('posPin', e.target.value.replace(/\D/g, '').slice(0, 8))}
                  inputMode="numeric"
                  placeholder="Generated and emailed if blank"
                />
              </label>
            </div>

            <div className="ct-modal-actions">
              <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? 'Provisioning…' : 'Provision client'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────── Cash subscription modal ─────────────────────── */

function CashModal({
  tenant,
  onClose,
  onDone,
}: {
  tenant: TenantRow;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const tiers = useMemo(() => mergePlanTiers(), []);
  const initialPlan = tenant.plan_type ?? 'pos_invoice_15';
  const [planType, setPlanType] = useState(initialPlan);
  const [durationDays, setDurationDays] = useState('30');
  const [amountUsd, setAmountUsd] = useState(
    String(tiers.find((tier) => tier.id === initialPlan)?.price ?? 15)
  );
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    subscription: { plan_type: string; subscription_expires_at: string };
    plan_name: string;
    duration_days: number;
    receipt: { doc_number: string; amount: number; currency: string; company_name: string };
  } | null>(null);

  const choosePlan = (next: string) => {
    setPlanType(next);
    const tier = tiers.find((item) => item.id === next);
    if (tier) setAmountUsd(String(tier.price));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{
        subscription: { plan_type: string; subscription_expires_at: string };
        plan_name: string;
        duration_days: number;
        receipt: { doc_number: string; amount: number; currency: string; company_name: string };
      }>(`/api/admin/tenants/${tenant.id}/cash-subscription`, {
        planType,
        durationDays: Number(durationDays) || 30,
        amountUsd: Number(amountUsd),
        notes: notes.trim(),
      });
      setResult(res);
      onDone(`Recorded ${money(res.receipt.amount)} cash for ${res.plan_name}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ct-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="ct-modal ct-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ct-cash-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ct-modal-head">
          <div>
            <span className="ct-eyebrow">Cash subscription</span>
            <h3 id="ct-cash-title">{tenant.name}</h3>
            <p>Book the cash sale in Preyone's house ledger and extend this client's plan.</p>
          </div>
          <button type="button" className="ct-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {result ? (
          <div className="ct-success">
            <strong>{result.plan_name} activated until {dateText(result.subscription.subscription_expires_at)}.</strong>
            <p>
              {money(result.receipt.amount)} cash was booked as{' '}
              <b>{result.receipt.doc_number}</b> in the {result.receipt.company_name} house ledger and
              the till drawer for this shift.
            </p>
            <div className="ct-success-grid">
              <div>
                <span>Receipt</span>
                <code>{result.receipt.doc_number}</code>
              </div>
              <div>
                <span>Amount</span>
                <code>
                  {result.receipt.currency} {result.receipt.amount.toFixed(2)}
                </code>
              </div>
              <div className="ct-span-2">
                <span>Client expiry</span>
                <code>{dateText(result.subscription.subscription_expires_at)}</code>
              </div>
            </div>
            <div className="ct-modal-actions">
              <button type="button" className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form className="ct-form" onSubmit={submit}>
            {error && <div className="banner error">{error}</div>}

            <div className="ct-form-grid">
              <label className="ct-field">
                <span>Plan sold</span>
                <select
                  className="select"
                  value={planType}
                  onChange={(e) => choosePlan(e.target.value)}
                >
                  {tiers.map((tier) => (
                    <option key={tier.id} value={tier.id}>
                      {tier.name} · ${tier.price}/mo
                    </option>
                  ))}
                </select>
              </label>

              <label className="ct-field">
                <span>Duration (days)</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={3650}
                  value={durationDays}
                  onChange={(e) => setDurationDays(e.target.value)}
                />
              </label>

              <label className="ct-field">
                <span>Cash received (USD)</span>
                <input
                  className="input"
                  type="number"
                  min={0.01}
                  step="0.01"
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value)}
                />
              </label>

              <label className="ct-field">
                <span>Current expiry</span>
                <input className="input" value={dateText(tenant.subscription_expires_at)} readOnly />
              </label>

              <label className="ct-field ct-span-2">
                <span>Notes (optional)</span>
                <textarea
                  className="textarea"
                  rows={3}
                  maxLength={500}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Cash received by Prechard at the shop."
                />
              </label>
            </div>

            <label className="ct-confirm">
              <input type="checkbox" required />
              <span>
                I confirm the cash was counted. The sale will be recorded in the Preyone house
                tenant, never in {tenant.name}'s books.
              </span>
            </label>

            <div className="ct-modal-actions">
              <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? 'Recording…' : 'Record cash & extend'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────── Panel ───────────────────────────── */

export default function ClientTenants() {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [cashTarget, setCashTarget] = useState<TenantRow | null>(null);
  const [resetId, setResetId] = useState<string | null>(null);
  const [pinTarget, setPinTarget] = useState<TenantRow | null>(null);
  const [pinValue, setPinValue] = useState('');
  const [pinBusy, setPinBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<PortalListResponse>('/api/admin/tenants/portal-list');
      setTenants(res.tenants);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendResetLink = async (tenant: TenantRow) => {
    setResetId(tenant.id);
    setNotice(null);
    try {
      const res = await api.post<{ message: string; sent: boolean }>(
        `/api/admin/tenants/${tenant.id}/password-reset`
      );
      setNotice({ kind: res.sent ? 'ok' : 'error', text: res.message });
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    } finally {
      setResetId(null);
    }
  };

  const savePin = async (event: FormEvent) => {
    event.preventDefault();
    if (!pinTarget) return;
    if (!/^\d{4,8}$/.test(pinValue)) {
      setNotice({ kind: 'error', text: 'POS PIN must be 4–8 digits.' });
      return;
    }
    setPinBusy(true);
    try {
      await api.post(`/api/admin/tenants/${pinTarget.id}/ceo-pin`, { pin: pinValue });
      setNotice({
        kind: 'ok',
        text: `POS PIN updated for ${pinTarget.owner_name || pinTarget.name}'s CEO.`,
      });
      setPinTarget(null);
      setPinValue('');
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    } finally {
      setPinBusy(false);
    }
  };

  const clients = tenants.filter((tenant) => !tenant.is_house);
  const expiring = clients.filter((tenant) => tenant.status === 'Expiring Soon').length;
  const expired = clients.filter(
    (tenant) => tenant.status === 'Expired' || tenant.status === 'Suspended'
  ).length;

  return (
    <div className="ct-root">
      <div className="ct-hero">
        <div>
          <span className="ct-eyebrow">House control · Preyone</span>
          <h3>Client tenants &amp; subscriptions</h3>
          <p>
            Provision a company into both portals, then record a cash package payment so the
            revenue lands in Preyone's own ledger and shift drawer.
          </p>
        </div>
        <button type="button" className="btn primary" onClick={() => setProvisionOpen(true)}>
          + Provision new client
        </button>
      </div>

      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}
      {error && (
        <div className="banner error">
          {error}
          <button type="button" className="btn ghost ct-retry" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      <div className="ct-stats">
        <div className="ct-stat">
          <span>Client tenants</span>
          <strong>{clients.length}</strong>
        </div>
        <div className="ct-stat is-ok">
          <span>Live</span>
          <strong>{clients.length - expiring - expired}</strong>
        </div>
        <div className="ct-stat is-soon">
          <span>Expiring in 7 days</span>
          <strong>{expiring}</strong>
        </div>
        <div className="ct-stat is-bad">
          <span>Expired / suspended</span>
          <strong>{expired}</strong>
        </div>
      </div>

      <div className="ct-table-wrap">
        <table className="ct-table">
          <thead>
            <tr>
              <th>Business</th>
              <th>Owner</th>
              <th>Plan</th>
              <th>Devices</th>
              <th>Expiry</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="ct-empty">
                  Loading client tenants…
                </td>
              </tr>
            )}
            {!loading && tenants.length === 0 && (
              <tr>
                <td colSpan={7} className="ct-empty">
                  No portal companies yet. Provision the first client to get started.
                </td>
              </tr>
            )}
            {!loading &&
              tenants.map((tenant) => (
                <tr key={tenant.id} className={tenant.is_house ? 'is-house' : undefined}>
                  <td>
                    <div className="ct-business">
                      <strong>{tenant.name}</strong>
                      <small>
                        {tenant.currency} · till code {tenant.till_code.slice(0, 8)}…
                      </small>
                      {tenant.is_house && <span className="ct-house-badge">House</span>}
                    </div>
                  </td>
                  <td>
                    <div className="ct-owner">
                      <span>{tenant.owner_name ?? 'No CEO account'}</span>
                      <small>{tenant.owner_email ?? '—'}</small>
                    </div>
                  </td>
                  <td>
                    <span className="ct-plan">
                      {tenant.plan_name ?? 'No plan'}
                      {tenant.plan_price != null && <small>${tenant.plan_price}/mo</small>}
                    </span>
                  </td>
                  <td>
                    <span className="ct-devices">
                      {tenant.active_devices} /{' '}
                      {tenant.max_devices >= 9999 ? '∞' : tenant.max_devices || '—'}
                    </span>
                  </td>
                  <td>{dateText(tenant.subscription_expires_at)}</td>
                  <td>
                    <span className={`ct-status ${statusClass(tenant.status)}`}>{tenant.status}</span>
                  </td>
                  <td>
                    <div className="ct-row-actions">
                      <button
                        type="button"
                        className="ct-action"
                        disabled={tenant.is_house}
                        title={tenant.is_house ? 'The house tenant cannot bill itself' : undefined}
                        onClick={() => setCashTarget(tenant)}
                      >
                        Record cash
                      </button>
                      <button
                        type="button"
                        className="ct-action ct-action--copy"
                        disabled={
                          tenant.is_house ||
                          !tenant.owner_email ||
                          resetId === tenant.id
                        }
                        title={
                          tenant.is_house
                            ? 'The house tenant uses its own CEO sign-in'
                            : 'Email the owner a one-hour password reset link'
                        }
                        onClick={() => void sendResetLink(tenant)}
                      >
                        {resetId === tenant.id ? 'Sending…' : 'Reset link'}
                      </button>
                      <button
                        type="button"
                        className="ct-action ct-action--copy"
                        disabled={tenant.is_house || !tenant.owner_email}
                        title="Set the client CEO's POS PIN"
                        onClick={() => {
                          setPinTarget(tenant);
                          setPinValue('');
                        }}
                      >
                        Set PIN
                      </button>
                      <button
                        type="button"
                        className="ct-action ct-action--copy"
                        onClick={() => copyText(tenant.till_code)}
                        title="Copy full till code"
                      >
                        Copy code
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <p className="ct-footnote">
        Cash payments are recorded as paid sales in the first-created Preyone company, then the
        client's <code>plan_type</code> and expiry are extended in the same transaction. Pesepay
        renewals are untouched and continue through the existing webhook.
      </p>
      <p className="ct-footnote">
        <strong>Credentials:</strong> passwords are stored only as bcrypt hashes. The temporary
        password is sent once in the welcome email; if it is lost, use <em>Reset link</em> to email
        the owner a one-hour recovery link. Provisioning, plan changes, cash receipts and password
        resets are written to the admin audit log.
      </p>

      {provisionOpen && (
        <ProvisionModal
          onClose={() => setProvisionOpen(false)}
          onDone={(text) => {
            setNotice({ kind: 'ok', text });
            void load();
          }}
        />
      )}

      {cashTarget && (
        <CashModal
          tenant={cashTarget}
          onClose={() => setCashTarget(null)}
          onDone={(text) => {
            setNotice({ kind: 'ok', text });
            void load();
          }}
        />
      )}

      {pinTarget && (
        <div className="ct-modal-backdrop" role="presentation" onClick={() => setPinTarget(null)}>
          <form
            className="ct-modal ct-modal--narrow"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ct-pin-title"
            onClick={(event) => event.stopPropagation()}
            onSubmit={savePin}
          >
            <header className="ct-modal-head">
              <div>
                <span className="ct-eyebrow">POS access</span>
                <h3 id="ct-pin-title">Set CEO POS PIN</h3>
                <p>
                  {pinTarget.owner_name || pinTarget.name} can sign into the till with this
                  4–8 digit PIN immediately.
                </p>
              </div>
              <button type="button" className="ct-close" onClick={() => setPinTarget(null)} aria-label="Close">
                ×
              </button>
            </header>
            <label className="ct-field">
              <span>New POS PIN</span>
              <input
                className="input"
                value={pinValue}
                onChange={(e) => setPinValue(e.target.value.replace(/\D/g, '').slice(0, 8))}
                inputMode="numeric"
                autoFocus
                placeholder="4–8 digits"
                required
              />
            </label>
            <div className="ct-modal-actions">
              <button type="button" className="btn ghost" onClick={() => setPinTarget(null)} disabled={pinBusy}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={pinBusy}>
                {pinBusy ? 'Saving…' : 'Save PIN'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
