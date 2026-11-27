import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type CashierRow,
  type CompanyProfile,
  type CurrencyRate,
  type CustomerRow,
  type ShiftHistoryRow,
  type StaffUser,
  type SubscriptionPlans,
} from '../api';
import UpgradeModal from './UpgradeModal';
import { ConfirmDialog, type ConfirmOptions } from './ConfirmDialog';
import { mergePlanTiers } from '../plans';

const fmtDate = (t: string | null): string =>
  !t || Number.isNaN(Date.parse(t))
    ? '—'
    : new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

const fmtDateTime = (t: string | null): string =>
  !t || Number.isNaN(Date.parse(t))
    ? '—'
    : new Date(t).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });

const isManagerRole = (role: string): boolean => role === 'CEO' || role === 'Manager';

type TabKey = 'company' | 'plan' | 'team' | 'clients' | 'shifts' | 'session';

interface CompanyDraft {
  name: string;
  tagline: string;
  address: string;
  email: string;
  support_phone: string;
  website: string;
  currency: string;
  tax_pct: string;
  invoice_prefix: string;
  quote_prefix: string;
  receipt_footer: string;
  terms_text: string;
}

const draftFromCompany = (c: CompanyProfile): CompanyDraft => ({
  name: c.name || '',
  tagline: c.tagline || '',
  address: c.address || '',
  email: c.email || '',
  support_phone: c.support_phone || '',
  website: c.website || '',
  currency: c.currency || 'USD',
  tax_pct: String(Number(c.tax_pct) || 0),
  invoice_prefix: c.invoice_prefix || '',
  quote_prefix: c.quote_prefix || '',
  receipt_footer: c.receipt_footer || '',
  terms_text: c.terms_text || '',
});

export default function SettingsView({
  user,
  notify,
  onApiError,
  onCompanyUpdated,
}: {
  user: StaffUser;
  notify: (msg: string, tone?: 'ok' | 'error') => void;
  onApiError: (e: unknown) => boolean;
  onCompanyUpdated?: (c: CompanyProfile) => void;
}) {
  const manager = isManagerRole(user.role);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('company');

  const [plans, setPlans] = useState<SubscriptionPlans | null>(null);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [draft, setDraft] = useState<CompanyDraft | null>(null);
  const [savingCompany, setSavingCompany] = useState(false);

  const [rates, setRates] = useState<CurrencyRate[]>([]);
  const [rateFallback, setRateFallback] = useState(false);

  const [cashiers, setCashiers] = useState<CashierRow[]>([]);
  const [shifts, setShifts] = useState<ShiftHistoryRow[]>([]);
  const [shiftsAll, setShiftsAll] = useState(false);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [clientQuery, setClientQuery] = useState('');
  const [clientDraft, setClientDraft] = useState<{
    id?: string;
    name: string;
    phone: string;
    email: string;
    address: string;
    notes: string;
  } | null>(null);
  const [clientBusy, setClientBusy] = useState(false);

  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);

  const loadTill = useCallback(async () => {
    const [c, s, cust] = await Promise.all([
      manager ? api.cashiers().catch(() => [] as CashierRow[]) : Promise.resolve([] as CashierRow[]),
      api.shiftHistory(manager && shiftsAll).catch(() => [] as ShiftHistoryRow[]),
      manager ? api.customers().catch(() => [] as CustomerRow[]) : Promise.resolve([] as CustomerRow[]),
    ]);
    setCashiers(c);
    setShifts(s);
    setCustomers(cust);
  }, [manager, shiftsAll]);

  const load = useCallback(async () => {
    try {
      const [p, c, r] = await Promise.all([
        api.subscriptionPlans().catch(() => null),
        api.company().catch(() => null),
        api.currencyRates().catch(() => ({ rates: [] as CurrencyRate[], fallback: false })),
      ]);
      setPlans(p);
      setCompany(c);
      if (c) setDraft(draftFromCompany(c));
      setRates(r.rates);
      setRateFallback(r.fallback);
      await loadTill();
    } finally {
      setLoading(false);
    }
  }, [loadTill]);

  useEffect(() => {
    load();
  }, [load]);

  const changePin = async (targetId?: string, pinOverride?: string) => {
    const pin = (pinOverride ?? newPin).trim();
    const confirmPinValue = pinOverride ? pin : confirmPin.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      notify('PIN must be 4–8 digits', 'error');
      return;
    }
    if (pin !== confirmPinValue) {
      notify('PINs do not match', 'error');
      return;
    }
    setPinBusy(true);
    try {
      const r = await api.setPin(pin, targetId);
      notify(`PIN updated for ${r.user.full_name}`);
      setNewPin('');
      setConfirmPin('');
      await loadTill();
    } catch (e) {
      if (!onApiError(e)) notify(e instanceof Error ? e.message : 'Could not update PIN', 'error');
    } finally {
      setPinBusy(false);
    }
  };

  const saveCompany = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      notify('Company name is required', 'error');
      return;
    }
    const tax = Number(draft.tax_pct);
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) {
      notify('VAT % must be between 0 and 100', 'error');
      return;
    }
    setSavingCompany(true);
    try {
      const saved = await api.updateCompany({
        name: draft.name.trim(),
        tagline: draft.tagline.trim() || null,
        address: draft.address.trim() || null,
        email: draft.email.trim() || null,
        support_phone: draft.support_phone.trim() || null,
        website: draft.website.trim() || null,
        currency: draft.currency.trim().toUpperCase() || 'USD',
        tax_pct: tax,
        invoice_prefix: draft.invoice_prefix.trim() || null,
        quote_prefix: draft.quote_prefix.trim() || null,
        receipt_footer: draft.receipt_footer.trim() || null,
        terms_text: draft.terms_text.trim() || null,
      });
      setCompany(saved);
      setDraft(draftFromCompany(saved));
      onCompanyUpdated?.(saved);
      notify('Company settings saved');
    } catch (e) {
      if (!onApiError(e)) notify(e instanceof Error ? e.message : 'Could not save settings', 'error');
    } finally {
      setSavingCompany(false);
    }
  };

  const saveClient = async () => {
    if (!clientDraft) return;
    const name = clientDraft.name.trim();
    if (!name) {
      notify('Client name is required', 'error');
      return;
    }
    setClientBusy(true);
    try {
      const payload = {
        name,
        phone: clientDraft.phone.trim() || null,
        email: clientDraft.email.trim() || null,
        address: clientDraft.address.trim() || null,
        notes: clientDraft.notes.trim() || null,
      };
      if (clientDraft.id) await api.updateCustomer(clientDraft.id, payload);
      else await api.createCustomer(payload);
      notify(clientDraft.id ? 'Client updated' : 'Client added');
      setClientDraft(null);
      await loadTill();
    } catch (e) {
      if (!onApiError(e)) notify(e instanceof Error ? e.message : 'Could not save client', 'error');
    } finally {
      setClientBusy(false);
    }
  };

  const removeClient = (c: CustomerRow) => {
    setConfirm({
      title: 'Delete this client?',
      message: `${c.name} will be removed from the client book. Clients with existing documents are protected and cannot be deleted.`,
      confirmLabel: 'Delete client',
      tone: 'danger',
      onConfirm: async () => {
        try {
          await api.deleteCustomer(c.id);
          notify('Client deleted');
          await loadTill();
        } catch (e) {
          if (!onApiError(e)) throw e;
        }
      },
    });
  };

  const testDrawer = async () => {
    setBusy(true);
    try {
      const r = await api.drawerAudit({ event: 'test' });
      notify(`Drawer kick logged · ${r.command}`);
    } catch (e) {
      if (!onApiError(e)) notify(e instanceof Error ? e.message : 'Drawer audit failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const current = plans?.current ?? null;
  const displayTiers = mergePlanTiers(plans?.tiers);
  const tierMeta = current ? displayTiers.find((t) => t.id === current.plan_type) : null;
  const planName = tierMeta?.name ?? current?.plan_type ?? '—';
  const statusClass =
    current?.subscription_status === 'active'
      ? 'pill ok'
      : current?.subscription_status === 'suspended'
        ? 'pill bad'
        : 'pill warn';

  const tabs = useMemo(
    () =>
      [
        { key: 'company' as const, label: 'Company & branding', caption: 'Identity, logo, contacts' },
        { key: 'plan' as const, label: 'Billing & plan', caption: 'Tier, devices, renewal' },
        ...(manager
          ? [
              { key: 'team' as const, label: 'Team & PINs', caption: 'Operators and access' },
              { key: 'clients' as const, label: 'Clients', caption: 'Client book' },
            ]
          : []),
        { key: 'shifts' as const, label: 'Shifts', caption: 'Cash-up history' },
        { key: 'session' as const, label: 'Session', caption: 'PIN, rates, drawer' },
      ] satisfies { key: TabKey; label: string; caption: string }[],
    [manager]
  );

  const filteredClients = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      [c.name, c.phone, c.email, c.address].some((v) => (v || '').toLowerCase().includes(q))
    );
  }, [customers, clientQuery]);

  if (loading) return <div className="empty-note">Loading settings…</div>;

  return (
    <div className="settings-page">
      <header className="settings-hero">
        <div className="settings-hero-mark" aria-hidden>
          ⚙
        </div>
        <div className="settings-hero-copy">
          <span className="settings-eyebrow">Workspace configuration</span>
          <h2>{company?.name || 'Your workspace'}</h2>
          <p>Company identity, billing, team access and till preferences in one place.</p>
        </div>
        <div className="settings-hero-chips">
          <span className="settings-chip">{company?.currency || 'USD'} ledger</span>
          <span className="settings-chip">{Number(company?.tax_pct) || 0}% VAT</span>
          <span className="settings-chip">{planName}</span>
          <span className="settings-chip">{user.role}</span>
        </div>
      </header>

      <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={`settings-tab${activeTab === t.key ? ' is-active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            <span className="settings-tab-label">{t.label}</span>
            <span className="settings-tab-caption">{t.caption}</span>
          </button>
        ))}
      </nav>

      {activeTab === 'company' && (
        <section className="settings-panel">
          <header className="settings-section-head">
            <span className="settings-eyebrow">01 · Identity</span>
            <h3>Company &amp; branding</h3>
            <p>
              Shown on receipts, invoices and the customer-facing checkout. The Preyone wordmark is
              locked; these details sit beside it.
            </p>
          </header>

          {!manager && (
            <div className="settings-lock">
              <span aria-hidden>🔒</span>
              <span>Only a Manager or CEO can edit company details.</span>
            </div>
          )}

          {draft ? (
            <div className="settings-company-grid">
              <div className="settings-fields">
                <label className="settings-field settings-field--wide">
                  <span>Legal company name</span>
                  <input
                    className="settings-input"
                    value={draft.name}
                    disabled={!manager}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <label className="settings-field settings-field--wide">
                  <span>Tagline</span>
                  <input
                    className="settings-input"
                    value={draft.tagline}
                    disabled={!manager}
                    placeholder="Short line shown under the name"
                    onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
                  />
                </label>
                <label className="settings-field settings-field--wide">
                  <span>Address</span>
                  <textarea
                    className="settings-input"
                    rows={2}
                    value={draft.address}
                    disabled={!manager}
                    onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>Email</span>
                  <input
                    className="settings-input"
                    type="email"
                    value={draft.email}
                    disabled={!manager}
                    onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>Support phone</span>
                  <input
                    className="settings-input"
                    value={draft.support_phone}
                    disabled={!manager}
                    onChange={(e) => setDraft({ ...draft, support_phone: e.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>Website</span>
                  <input
                    className="settings-input"
                    value={draft.website}
                    disabled={!manager}
                    onChange={(e) => setDraft({ ...draft, website: e.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>Currency</span>
                  <input
                    className="settings-input"
                    value={draft.currency}
                    maxLength={3}
                    disabled={!manager}
                    onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
                  />
                </label>
                <label className="settings-field">
                  <span>VAT %</span>
                  <input
                    className="settings-input"
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={draft.tax_pct}
                    disabled={!manager}
                    onChange={(e) => setDraft({ ...draft, tax_pct: e.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>Invoice prefix</span>
                  <input
                    className="settings-input"
                    value={draft.invoice_prefix}
                    disabled={!manager}
                    placeholder="INV"
                    onChange={(e) => setDraft({ ...draft, invoice_prefix: e.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>Quote prefix</span>
                  <input
                    className="settings-input"
                    value={draft.quote_prefix}
                    disabled={!manager}
                    placeholder="QUO"
                    onChange={(e) => setDraft({ ...draft, quote_prefix: e.target.value })}
                  />
                </label>
                <label className="settings-field settings-field--wide">
                  <span>Receipt footer</span>
                  <input
                    className="settings-input"
                    value={draft.receipt_footer}
                    disabled={!manager}
                    placeholder="Thank you for your business"
                    onChange={(e) => setDraft({ ...draft, receipt_footer: e.target.value })}
                  />
                </label>
                <label className="settings-field settings-field--wide">
                  <span>Terms &amp; conditions</span>
                  <textarea
                    className="settings-input"
                    rows={3}
                    value={draft.terms_text}
                    disabled={!manager}
                    onChange={(e) => setDraft({ ...draft, terms_text: e.target.value })}
                  />
                </label>
              </div>

              <aside className="settings-preview">
                <span className="settings-eyebrow">Receipt preview</span>
                <div className="settings-receipt">
                  <div className="settings-receipt-brand">Preyone</div>
                  <div className="settings-receipt-name">{draft.name || 'Company name'}</div>
                  {draft.tagline && <div className="settings-receipt-tagline">{draft.tagline}</div>}
                  {draft.address && <div className="settings-receipt-line">{draft.address}</div>}
                  {draft.support_phone && (
                    <div className="settings-receipt-line">Tel {draft.support_phone}</div>
                  )}
                  {draft.email && <div className="settings-receipt-line">{draft.email}</div>}
                  <div className="settings-receipt-rule" />
                  <div className="settings-receipt-row">
                    <span>VAT</span>
                    <strong>{Number(draft.tax_pct) || 0}%</strong>
                  </div>
                  <div className="settings-receipt-row">
                    <span>Currency</span>
                    <strong>{draft.currency || 'USD'}</strong>
                  </div>
                  <div className="settings-receipt-rule" />
                  <div className="settings-receipt-footer">
                    {draft.receipt_footer || 'Thank you for your business'}
                  </div>
                </div>
              </aside>
            </div>
          ) : (
            <div className="hint">No company profile on file.</div>
          )}

          {manager && draft && (
            <div className="settings-actions">
              <button className="primary-btn" disabled={savingCompany} onClick={() => void saveCompany()}>
                {savingCompany ? 'Saving…' : 'Save company settings'}
              </button>
              <button
                className="secondary-btn"
                disabled={savingCompany || !company}
                onClick={() => company && setDraft(draftFromCompany(company))}
              >
                Reset
              </button>
            </div>
          )}
        </section>
      )}

      {activeTab === 'plan' && (
        <section className="settings-panel">
          <header className="settings-section-head">
            <span className="settings-eyebrow">02 · Subscription</span>
            <h3>Billing &amp; plan</h3>
            <p>Your Preyone tier controls device seats and which modules the till can use.</p>
          </header>
          {plans ? (
            <div className="settings-plan">
              <div className="settings-plan-head">
                <div>
                  <div className="settings-plan-name">
                    {planName} <span className={statusClass}>{current?.subscription_status ?? 'unknown'}</span>
                  </div>
                  <div className="settings-plan-meta">
                    {tierMeta
                      ? tierMeta.devices >= 9999
                        ? 'Unlimited devices'
                        : `Up to ${tierMeta.devices} device${tierMeta.devices === 1 ? '' : 's'}`
                      : '—'}
                    <span>·</span>
                    <span>Renews {fmtDate(current?.subscription_expires_at ?? null)}</span>
                  </div>
                </div>
                <button className="hr-pay" onClick={() => setShowUpgrade(true)}>
                  Upgrade my plan
                </button>
              </div>
              {tierMeta && (
                <div className="settings-plan-price">
                  ${tierMeta.price}/mo <span>· {tierMeta.tagline}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="err-msg">Could not load billing details.</div>
          )}
        </section>
      )}

      {activeTab === 'team' && manager && (
        <section className="settings-panel">
          <header className="settings-section-head">
            <span className="settings-eyebrow">03 · Access</span>
            <h3>Team &amp; PINs</h3>
            <p>Every operator signs in with their own 4–8 digit PIN. Manager/CEO can reset one.</p>
          </header>
          {cashiers.length === 0 ? (
            <div className="hint">No operators found.</div>
          ) : (
            <div className="settings-list">
              {cashiers.map((c) => (
                <div className="settings-list-row" key={c.id}>
                  <span className="settings-list-main">
                    <strong>{c.full_name}</strong>
                    <small>
                      {c.role}
                      {c.has_pin ? '' : ' · no PIN'} {c.approved ? '' : ' · not approved'}
                    </small>
                  </span>
                  <button
                    className="ghost-btn small"
                    disabled={pinBusy}
                    onClick={() =>
                      setConfirm({
                        title: 'Set operator PIN',
                        message: `Choose a new 4–8 digit PIN for ${c.full_name}. This PIN signs them into the till.`,
                        confirmLabel: 'Update PIN',
                        input: { label: 'New PIN', placeholder: '4–8 digits', required: true },
                        onConfirm: async (pin) => {
                          if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN must be 4–8 digits.');
                          await changePin(c.id, pin);
                        },
                      })
                    }
                  >
                    Set PIN
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === 'clients' && manager && (
        <section className="settings-panel">
          <header className="settings-section-head">
            <span className="settings-eyebrow">04 · Client book</span>
            <h3>Clients</h3>
            <p>Used on invoices, quotations and credit sales.</p>
          </header>
          <div className="settings-toolbar">
            <input
              className="settings-input"
              placeholder="Search clients…"
              value={clientQuery}
              onChange={(e) => setClientQuery(e.target.value)}
            />
            <button
              className="primary-btn"
              onClick={() => setClientDraft({ name: '', phone: '', email: '', address: '', notes: '' })}
            >
              + Add client
            </button>
          </div>
          {filteredClients.length === 0 ? (
            <div className="hint">No clients yet — add one to use on invoices and credit sales.</div>
          ) : (
            <div className="settings-list">
              {filteredClients.map((c) => (
                <div className="settings-list-row" key={c.id}>
                  <span className="settings-list-main">
                    <strong>{c.name}</strong>
                    <small>{[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details'}</small>
                  </span>
                  <span className="settings-row-actions">
                    <button
                      className="ghost-btn small"
                      onClick={() =>
                        setClientDraft({
                          id: c.id,
                          name: c.name,
                          phone: c.phone || '',
                          email: c.email || '',
                          address: c.address || '',
                          notes: c.notes || '',
                        })
                      }
                    >
                      Edit
                    </button>
                    <button className="ghost-btn small" onClick={() => void removeClient(c)}>
                      Delete
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === 'shifts' && (
        <section className="settings-panel">
          <header className="settings-section-head">
            <span className="settings-eyebrow">05 · Cash-up</span>
            <h3>Shift history</h3>
            <p>Float, counted cash and variance for each till session.</p>
          </header>
          <div className="settings-toolbar">
            <span className="settings-chip">{shiftsAll ? 'All cashiers' : 'My shifts'}</span>
            {manager && (
              <button className="ghost-btn small" onClick={() => setShiftsAll((v) => !v)}>
                {shiftsAll ? 'Show my shifts' : 'Show all cashiers'}
              </button>
            )}
          </div>
          {shifts.length === 0 ? (
            <div className="hint">No shifts recorded yet.</div>
          ) : (
            <div className="settings-list">
              {shifts.slice(0, 30).map((s) => (
                <div className="settings-list-row" key={s.id}>
                  <span className="settings-list-main">
                    <strong>{fmtDateTime(s.opened_at)}</strong>
                    <small>
                      {s.cashier_name || '—'} · float ${(Number(s.opening_float) || 0).toFixed(2)}
                      {s.status === 'closed' && (
                        <>
                          {' '}· counted ${(Number(s.counted_cash) || 0).toFixed(2)}
                          {' '}· variance ${(Number(s.variance) || 0).toFixed(2)}
                          {s.close_receipt_sent_at ? ' · proof emailed' : ''}
                        </>
                      )}
                    </small>
                  </span>
                  <span className={`pill ${s.status === 'open' ? 'warn' : 'ok'}`}>{s.status}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === 'session' && (
        <section className="settings-panel">
          <header className="settings-section-head">
            <span className="settings-eyebrow">06 · This till</span>
            <h3>Session &amp; hardware</h3>
            <p>Your PIN, live exchange rates and the cash-drawer audit trail.</p>
          </header>

          <div className="settings-grid-2">
            <div className="settings-block">
              <h4>Change my PIN</h4>
              <p className="settings-hint">Your PIN signs you into this till. 4–8 digits.</p>
              <div className="pin-grid">
                <label>
                  <span className="field-label">New PIN</span>
                  <input
                    className="settings-input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={8}
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="••••"
                  />
                </label>
                <label>
                  <span className="field-label">Confirm PIN</span>
                  <input
                    className="settings-input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={8}
                    value={confirmPin}
                    onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="••••"
                  />
                </label>
              </div>
              <button className="secondary-btn" disabled={pinBusy || !newPin} onClick={() => changePin()}>
                {pinBusy ? 'Updating…' : 'Update PIN'}
              </button>
            </div>

            <div className="settings-block">
              <div className="settings-block-head">
                <h4>Exchange rates</h4>
                <button className="ghost-btn small" onClick={() => load()}>
                  Refresh
                </button>
              </div>
              {rates.length === 0 ? (
                <p className="settings-hint">
                  {rateFallback
                    ? 'No company rates set — global defaults will be used.'
                    : 'No rates configured yet.'}
                </p>
              ) : (
                <div className="settings-list settings-list--compact">
                  {rates.map((r, i) => (
                    <div className="settings-list-row" key={`${r.base_currency}-${r.target_currency}-${i}`}>
                      <span className="settings-list-main">
                        <strong>
                          {r.base_currency} → {r.target_currency}
                        </strong>
                      </span>
                      <span className="settings-figure">{Number(r.rate)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="settings-block">
              <h4>Cash drawer audit</h4>
              <p className="settings-hint">
                Every drawer kick is logged against the open shift with the ESC/POS command bytes
                (<code>\x1B\x70\x00\x19\xFA</code>).
              </p>
              <button className="secondary-btn" disabled={busy} onClick={() => void testDrawer()}>
                {busy ? 'Logging…' : 'Log a test drawer kick'}
              </button>
            </div>

            <div className="settings-block">
              <h4>Signed in as</h4>
              <div className="settings-kv">
                <span>Name</span>
                <strong>{user.fullName}</strong>
              </div>
              <div className="settings-kv">
                <span>Role</span>
                <strong>{user.role}</strong>
              </div>
              <div className="settings-kv">
                <span>Email</span>
                <strong className="settings-wrap">{user.email}</strong>
              </div>
            </div>
          </div>
        </section>
      )}

      {clientDraft && (
        <div className="modal-backdrop" onClick={() => setClientDraft(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">{clientDraft.id ? 'Edit client' : 'New client'}</h3>
            <label className="field-label">
              Name *
              <input
                value={clientDraft.name}
                autoFocus
                onChange={(e) => setClientDraft({ ...clientDraft, name: e.target.value })}
              />
            </label>
            <div className="form-grid">
              <label className="field-label">
                Phone
                <input
                  value={clientDraft.phone}
                  onChange={(e) => setClientDraft({ ...clientDraft, phone: e.target.value })}
                />
              </label>
              <label className="field-label">
                Email
                <input
                  type="email"
                  value={clientDraft.email}
                  onChange={(e) => setClientDraft({ ...clientDraft, email: e.target.value })}
                />
              </label>
            </div>
            <label className="field-label">
              Address
              <textarea
                rows={2}
                value={clientDraft.address}
                onChange={(e) => setClientDraft({ ...clientDraft, address: e.target.value })}
              />
            </label>
            <label className="field-label">
              Notes
              <textarea
                rows={2}
                value={clientDraft.notes}
                onChange={(e) => setClientDraft({ ...clientDraft, notes: e.target.value })}
              />
            </label>
            <button className="primary-btn" disabled={clientBusy} onClick={() => void saveClient()}>
              {clientBusy ? 'Saving…' : 'Save client'}
            </button>
            <button className="secondary-btn" onClick={() => setClientDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirm && <ConfirmDialog options={confirm} onClose={() => setConfirm(null)} />}

      {showUpgrade && (
        <UpgradeModal
          onClose={() => setShowUpgrade(false)}
          onUpgraded={(planType) => {
            setShowUpgrade(false);
            notify(`Plan upgraded to ${planType.replace('_', ' ')}`);
            load();
          }}
        />
      )}
    </div>
  );
}
