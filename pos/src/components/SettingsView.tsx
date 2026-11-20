import { useCallback, useEffect, useState } from 'react';
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

export default function SettingsView({
  user,
  notify,
  onApiError,
}: {
  user: StaffUser;
  notify: (msg: string, kind?: 'ok' | 'error') => void;
  onApiError: (e: unknown) => boolean;
}) {
  const [plans, setPlans] = useState<SubscriptionPlans | null>(null);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [rates, setRates] = useState<CurrencyRate[]>([]);
  const [rateFallback, setRateFallback] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [busy, setBusy] = useState(false);

  // Till management (set-pin / cashiers / shifts)
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [cashiers, setCashiers] = useState<CashierRow[]>([]);
  const [shifts, setShifts] = useState<ShiftHistoryRow[]>([]);
  const [shiftsAll, setShiftsAll] = useState(false);
  const manager = isManagerRole(user.role);

  // Client book (manager/CEO): add, edit and delete customers here so the
  // invoice composer and credit statements always have clean records.
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
    const confirm = pinOverride ? pin : confirmPin.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      notify('PIN must be 4–8 digits', 'error');
      return;
    }
    if (pin !== confirm) {
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

  const saveClient = async () => {
    if (!clientDraft) return;
    const name = clientDraft.name.trim();
    if (!name) {
      notify('Client name is required', 'error');
      return;
    }
    setClientBusy(true);
    try {
      // null (not undefined) so clearing a field really clears it: the server
      // only updates keys that are present in the JSON body.
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

  if (loading) return <div className="empty-note">Loading settings…</div>;

  return (
    <div className="settings-pane">
      <div className="settings-title">SETTINGS</div>

      <section className="settings-card">
        <div className="settings-card-head">
          <span>Billing &amp; plan</span>
          <button className="hr-pay" onClick={() => setShowUpgrade(true)} disabled={!plans}>
            Upgrade my plan
          </button>
        </div>
        {plans ? (
          <>
            <div className="plan-row">
              <div className="plan-name">
                {planName}
                <span className={statusClass}>{current?.subscription_status ?? 'unknown'}</span>
              </div>
              <div className="plan-meta">
                <span>
                  {tierMeta
                    ? tierMeta.devices >= 9999
                      ? 'Unlimited devices'
                      : `Up to ${tierMeta.devices} device${tierMeta.devices === 1 ? '' : 's'}`
                    : '—'}
                </span>
                <span>Renews {fmtDate(current?.subscription_expires_at ?? null)}</span>
                {tierMeta && (
                  <span>
                    ${tierMeta.price}/mo · {tierMeta.tagline}
                  </span>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="err-msg">Could not load billing details.</div>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-card-head"><span>Store profile</span></div>
        {company ? (
          <div className="profile-grid">
            <div>
              <span className="field-label">Name</span>
              {company.name || '—'}
            </div>
            <div>
              <span className="field-label">Currency</span>
              {company.currency || 'USD'}
            </div>
            <div>
              <span className="field-label">VAT %</span>
              {Number(company.tax_pct) || 0}
            </div>
            <div>
              <span className="field-label">Email</span>
              {company.email || '—'}
            </div>
            <div>
              <span className="field-label">Support phone</span>
              {company.support_phone || '—'}
            </div>
            <div>
              <span className="field-label">Website</span>
              {company.website || '—'}
            </div>
          </div>
        ) : (
          <div className="hint">No store profile on file.</div>
        )}
      </section>

      {manager && (
        <section className="settings-card">
          <div className="settings-card-head">
            <span>Clients</span>
            <button
              className="ghost-btn small"
              onClick={() =>
                setClientDraft({ name: '', phone: '', email: '', address: '', notes: '' })
              }
            >
              + Add client
            </button>
          </div>
          <input
            placeholder="Search clients…"
            value={clientQuery}
            onChange={(e) => setClientQuery(e.target.value)}
            style={{ width: '100%', margin: '0.2rem 0 0.6rem' }}
          />
          {customers.length === 0 ? (
            <div className="hint">No clients yet — add one to use on invoices and credit sales.</div>
          ) : (
            <div className="rate-list">
              {customers
                .filter((c) => {
                  const q = clientQuery.trim().toLowerCase();
                  if (!q) return true;
                  return [c.name, c.phone, c.email, c.address].some((v) =>
                    (v || '').toLowerCase().includes(q)
                  );
                })
                .map((c) => (
                  <div className="x-report-row" key={c.id}>
                    <span>
                      {c.name}
                      <span className="receipt-muted">
                        {[c.phone, c.email].filter(Boolean).length
                          ? ` · ${[c.phone, c.email].filter(Boolean).join(' · ')}`
                          : ''}
                      </span>
                    </span>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
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

      <section className="settings-card">
        <div className="settings-card-head">
          <span>Exchange rates</span>
          <button className="ghost-btn small" onClick={() => load()}>Refresh</button>
        </div>
        {rates.length === 0 ? (
          <div className="hint">
            {rateFallback ? 'No company rates set — global defaults will be used.' : 'No rates configured yet.'}
          </div>
        ) : (
          <div className="rate-list">
            {rates.map((r, i) => (
              <div className="x-report-row" key={`${r.base_currency}-${r.target_currency}-${i}`}>
                <span>
                  {r.base_currency} → {r.target_currency}
                </span>
                <strong>{Number(r.rate)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-card-head"><span>Cash drawer audit</span></div>
        <div className="hint">
          Every drawer kick is logged against the open shift with the ESC/POS command bytes
          (<code>\x1B\x70\x00\x19\xFA</code>) so audits can reconcile drawer events.
        </div>
        <button className="secondary-btn" disabled={busy} onClick={testDrawer}>
          {busy ? 'Logging…' : 'Log a test drawer kick'}
        </button>
      </section>

      <section className="settings-card">
        <div className="settings-card-head"><span>Change my PIN</span></div>
        <div className="hint">Your PIN signs you into this till. 4–8 digits.</div>
        <div className="pin-grid">
          <label>
            <span className="field-label">New PIN</span>
            <input
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
      </section>

      {manager && (
        <section className="settings-card">
          <div className="settings-card-head">
            <span>Till operators</span>
            <button className="ghost-btn small" onClick={() => loadTill()}>Refresh</button>
          </div>
          {cashiers.length === 0 ? (
            <div className="hint">No operators found.</div>
          ) : (
            <div className="rate-list">
              {cashiers.map((c) => (
                <div className="x-report-row" key={c.id}>
                  <span>
                    {c.full_name}
                    <span className="receipt-muted"> · {c.role}{c.has_pin ? '' : ' · no PIN'}</span>
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

      <section className="settings-card">
        <div className="settings-card-head">
          <span>Shift history</span>
          {manager && (
            <button
              className="ghost-btn small"
              onClick={() => setShiftsAll((v) => !v)}
            >
              {shiftsAll ? 'My shifts' : 'All cashiers'}
            </button>
          )}
        </div>
        {shifts.length === 0 ? (
          <div className="hint">No shifts recorded yet.</div>
        ) : (
          <div className="rate-list">
            {shifts.slice(0, 20).map((s) => (
              <div className="x-report-row" key={s.id}>
                <span>
                  {fmtDateTime(s.opened_at)}
                  <span className="receipt-muted">
                    {' '}· {s.cashier_name || '—'} · float ${(Number(s.opening_float) || 0).toFixed(2)}
                  </span>
                </span>
                <span className={`pill ${s.status === 'open' ? 'warn' : 'ok'}`}>{s.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-card-head"><span>Session</span></div>
        <div className="profile-grid">
          <div>
            <span className="field-label">Signed in as</span>
            {user.fullName}
          </div>
          <div>
            <span className="field-label">Role</span>
            {user.role}
          </div>
        </div>
      </section>

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
