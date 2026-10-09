import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  FiActivity, FiCreditCard, FiDollarSign, FiDownload, FiExternalLink,
  FiGrid, FiHeadphones, FiLogOut, FiMail, FiMessageSquare, FiPackage, FiPhone,
  FiPlus, FiRefreshCw, FiRadio, FiSearch, FiSettings, FiShield,
  FiWifi, FiX, FiCheck, FiChevronDown, FiLock,
} from 'react-icons/fi';
import {
  fmtMoney, fmtDate, monthLabel, sfetch, slPaymentStatus, clearToken,
  SL_TABS, type SlTab, type SlDashboard, type SlCustomer, type SlInvoice,
  type SlKit, type SlCheckoutResult,
} from './api';
import InvoicesView from './InvoicesView';
import PeseCheckoutModal, { type CheckoutKind } from './PeseCheckoutModal';

const PENDING_KEY = 'starlink_pending_payment';

type Toast = { id: number; kind: 'ok' | 'err' | 'info'; title: string; body?: string };

type ProfileState = { fullName: string; phone: string };

const PLANS = [
  {
    name: 'Residential Standard',
    price: '$50',
    cadence: '/ month',
    perks: ['Unlimited data', 'Standard speeds at home', 'Self-service portal access', 'Pese mobile-money billing'],
    cta: 'data' as const,
  },
  {
    name: 'Residential Priority',
    price: '$150',
    cadence: '/ month',
    perks: ['Higher speeds in congested areas', 'Unlimited data', 'Priority support queue', 'Ideal for remote work'],
    cta: 'data' as const,
  },
  {
    name: 'Starlink Business',
    price: '$250',
    cadence: '/ month',
    perks: ['Performance for teams', 'Multi-site kit management', 'Dedicated account contact', 'USD invoicing via Pese'],
    cta: 'kit' as const,
  },
];

const FAQS = [
  { q: 'How do I pay for my Starlink service?', a: 'Use the Wallet Top Up or Data Top Up action on the Home tab. Payments run through the Pese gateway (EcoCash, InnBucks or Omari) and settle in USD — your invoice is marked paid automatically once the payment completes.' },
  { q: 'What happens after I complete a Pese payment?', a: 'Pese returns you to this portal. We poll the payment status, mark the invoice PAID and credit your wallet, data bundle or kit order — no manual confirmation needed.' },
  { q: 'How is data usage tracked per kit?', a: 'Each registered kit keeps a rolling four-month history of monthly consumption (GB). Register your kit from the Devices tab with the serial number printed on the box.' },
  { q: 'Can I download invoices for accounting?', a: 'Yes. Open Billing, click View on any invoice for the full document, then Download PDF. The Statement button exports everything on screen as a single account statement PDF.' },
  { q: 'I forgot my password — what now?', a: 'Click "Forgot password" on the sign-in screen. A reset link valid for one hour is emailed to you; open it and choose a new password (minimum 8 characters).' },
  { q: 'Which payment methods are supported?', a: 'EcoCash, InnBucks and Omari through Pese. All portal prices and balances are shown in USD.' },
];

export default function StarlinkPortal({ onSignOut }: { onSignOut: () => void }) {
  const [data, setData] = useState<SlDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<SlTab>('Home');
  const [kitId, setKitId] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [checkout, setCheckout] = useState<CheckoutKind | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [registering, setRegistering] = useState(false);
  const [kitNumber, setKitNumber] = useState('');
  const [nickname, setNickname] = useState('');
  const [profileForm, setProfileForm] = useState<ProfileState>({ fullName: '', phone: '' });
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '' });
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busyTab, setBusyTab] = useState(false);

  const userRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLInputElement>(null);
  const toastSeq = useRef(0);

  /* ── toasts ── */
  const pushToast = useCallback((kind: Toast['kind'], title: string, body?: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, title, body }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  /* ── data loading ── */
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await sfetch<SlDashboard>('/dashboard');
      setData(next);
      setLoadError('');
      setProfileForm({ fullName: next.customer.fullName, phone: next.customer.phone });
      setKitId((prev) => (prev && next.kits.some((k) => k.id === prev) ? prev : next.kits[0]?.id || ''));
    } catch (err) {
      if (!silent) setLoadError(err instanceof Error ? err.message : 'Could not load your dashboard');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* ── session expiry (401 dispatched by api layer) ── */
  useEffect(() => {
    const onExpired = () => {
      pushToast('err', 'Session expired', 'Please sign in again.');
      onSignOut();
    };
    window.addEventListener('starlink:unauthorized', onExpired);
    return () => window.removeEventListener('starlink:unauthorized', onExpired);
  }, [onSignOut, pushToast]);

  /* ── outside-click for menus ── */
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  /* ── Ctrl/Cmd+K search palette ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (paletteOpen) window.setTimeout(() => paletteRef.current?.focus(), 30);
    else setPaletteQuery('');
  }, [paletteOpen]);

  /* ── pending Pese payment (set before redirect, settled on return) ── */
  useEffect(() => {
    let cancelled = false;
    const raw = (() => { try { return sessionStorage.getItem(PENDING_KEY); } catch { return null; } })();
    if (!raw) return;
    let pending: { intentId: string; statusToken: string; invoiceNumber: string } | null = null;
    try { pending = JSON.parse(raw); } catch { pending = null; }
    if (!pending?.intentId || !pending.statusToken) return;

    let attempts = 0;
    const finish = (cleared: boolean) => {
      try { sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
      if (cleared) {
        pushToast('ok', 'Payment confirmed', `${pending!.invoiceNumber} is now PAID. Wallet, data or kit credited.`);
        load(true);
      }
    };

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const st = await slPaymentStatus(pending!.intentId, pending!.statusToken);
        if (st.status === 'SUCCESS') { finish(true); return; }
        if (st.status === 'FAILED') {
          try { sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
          pushToast('err', 'Payment failed', `${pending!.invoiceNumber} was not settled. You can retry from Billing.`);
          load(true);
          return;
        }
      } catch {
        /* transient — keep polling until the budget runs out */
      }
      if (attempts < 30) window.setTimeout(poll, 2000);
      else {
        try { sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
        pushToast('info', 'Payment still processing', `We will keep invoice ${pending!.invoiceNumber} pending — refresh Billing in a moment.`);
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [load, pushToast]);

  /* ── derived ── */
  const customer: SlCustomer | null = data?.customer ?? null;
  const kits: SlKit[] = useMemo(() => data?.kits ?? [], [data]);
  const invoices: SlInvoice[] = useMemo(() => data?.invoices ?? [], [data]);
  const activeKit = useMemo(() => kits.find((k) => k.id === kitId) || kits[0] || null, [kits, kitId]);
  const balanceDue = data?.balanceDue ?? 0;
  const wallet = customer?.walletBalance ?? 0;

  const initials = (customer?.fullName || 'S')
    .split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  const goto = (next: SlTab) => {
    setTab(next);
    setUserMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const onQueued = (result: SlCheckoutResult) => {
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({
        intentId: result.intentId,
        statusToken: result.statusToken,
        invoiceNumber: result.invoiceNumber,
      }));
    } catch { /* storage unavailable */ }
  };

  /* ── kit actions ── */
  const registerKit = async (e: FormEvent) => {
    e.preventDefault();
    if (kitNumber.trim().length < 4) {
      pushToast('err', 'Kit serial required', 'Enter the serial number printed on the box.');
      return;
    }
    try {
      await sfetch('/kits', {
        method: 'POST',
        body: JSON.stringify({ kitNumber: kitNumber.trim(), nickname: nickname.trim() }),
      });
      setRegistering(false);
      setKitNumber('');
      setNickname('');
      pushToast('ok', 'Kit registered', 'Usage history starts collecting immediately.');
      load(true);
    } catch (err) {
      pushToast('err', 'Registration failed', err instanceof Error ? err.message : undefined);
    }
  };

  const patchKit = async (id: string, body: Record<string, string>) => {
    try {
      await sfetch(`/kits/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      pushToast('ok', 'Kit updated');
      load(true);
    } catch (err) {
      pushToast('err', 'Update failed', err instanceof Error ? err.message : undefined);
    }
  };

  /* ── profile ── */
  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setProfileBusy(true);
    setProfileMsg(null);
    try {
      await sfetch('/auth/profile', { method: 'PATCH', body: JSON.stringify(profileForm) });
      setProfileMsg({ kind: 'ok', text: 'Profile updated.' });
      pushToast('ok', 'Profile updated');
      load(true);
    } catch (err) {
      setProfileMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setProfileBusy(false);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setProfileBusy(true);
    setProfileMsg(null);
    try {
      const res = await sfetch<{ message: string }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify(pwForm),
      });
      setPwForm({ currentPassword: '', newPassword: '' });
      setProfileMsg({ kind: 'ok', text: res.message });
      pushToast('ok', 'Password changed');
    } catch (err) {
      setProfileMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Could not change password' });
    } finally {
      setProfileBusy(false);
    }
  };

  const signOut = () => {
    clearToken();
    onSignOut();
  };

  /* ── search palette ── */
  const paletteItems = useMemo(() => {
    const base = [
      ...SL_TABS.map((t) => ({ label: `Go to ${t}`, hint: 'Tab', run: () => goto(t as SlTab), icon: <FiGrid /> })),
      { label: 'Wallet Top Up', hint: 'Action', run: () => { goto('Home'); setCheckout('wallet_topup'); }, icon: <FiDollarSign /> },
      { label: 'Data Top Up', hint: 'Action', run: () => { goto('Home'); setCheckout('data_topup'); }, icon: <FiWifi /> },
      { label: 'Buy Starlink Kit', hint: 'Action', run: () => { goto('Home'); setCheckout('kit_purchase'); }, icon: <FiPackage /> },
      { label: 'Download account statement', hint: 'Billing', run: () => goto('Billing'), icon: <FiDownload /> },
      { label: 'Contact support', hint: 'Support', run: () => goto('Support'), icon: <FiHeadphones /> },
    ];
    const q = paletteQuery.trim().toLowerCase();
    return q ? base.filter((i) => i.label.toLowerCase().includes(q)) : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteQuery, tab]);

  const runPaletteItem = (item: typeof paletteItems[number]) => {
    setPaletteOpen(false);
    item.run();
  };

  /* ── loading / error shells ── */
  if (loading && !data) {
    return (
      <div className="sp-root">
        <div className="sp-main" style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
          <div className="sp-paying">
            <div className="sp-spinner" />
            <p style={{ color: 'var(--sp-mut)' }}>Loading your Starlink dashboard…</p>
          </div>
        </div>
      </div>
    );
  }

  if (loadError && !data) {
    return (
      <div className="sp-root">
        <div className="sp-main" style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
          <div className="sp-panel" style={{ maxWidth: 460, textAlign: 'center' }}>
            <p className="sp-alert sp-alert--err">{loadError}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="sp-btn sp-btn--ghost" onClick={() => load()}>Retry</button>
              <button className="sp-btn sp-btn--primary" style={{ width: 'auto' }} onClick={signOut}>Sign out</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const usagePoints = activeKit?.usage ?? [];
  const maxUsage = Math.max(1, ...usagePoints.map((u) => Number(u.usage_gb)));

  return (
    <div className="sp-root">
      {/* ── Header ── */}
      <header className="sp-topbar">
        <div className="sp-brand">
          <img src="/images/preyonenoneglow-logo-zoom.png" alt="Preyone" />
          <span className="sp-brand-txt">
            <b>STARLINK</b>
            <span>Customer Portal</span>
          </span>
        </div>

        <nav className="sp-tabs" aria-label="Portal sections">
          {SL_TABS.map((t) => (
            <button
              key={t}
              type="button"
              className={'sp-tab' + (tab === t ? ' is-active' : '')}
              onClick={() => goto(t)}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="sp-right">
          <button type="button" className="sp-search" onClick={() => setPaletteOpen(true)} aria-label="Open search">
            <FiSearch />
            <span>Search…</span>
            <kbd>Ctrl K</kbd>
          </button>

          <div className="sp-user" ref={userRef}>
            <button
              type="button"
              className="sp-user-btn"
              onClick={() => setUserMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
            >
              <span className="sp-avatar">{initials}</span>
              <span className="sp-user-name">{customer?.fullName?.split(' ')[0] || 'Customer'}</span>
              <FiChevronDown size={14} color="#64748b" />
            </button>
            {userMenuOpen && (
              <div className="sp-user-menu" role="menu">
                <div className="sp-user-head">
                  <b>{customer?.fullName}</b>
                  <span>{customer?.email}</span>
                </div>
                <button type="button" className="sp-menu-item" role="menuitem" onClick={() => { setUserMenuOpen(false); setProfileOpen(true); }}>
                  <FiSettings /> Profile Settings
                </button>
                <button type="button" className="sp-menu-item" role="menuitem" onClick={() => goto('Support')}>
                  <FiHeadphones /> Support
                </button>
                <button type="button" className="sp-menu-item sp-menu-item--danger" role="menuitem" onClick={signOut}>
                  <FiLogOut /> Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="sp-main">
        {busyTab && <div className="sp-alert" style={{ background: 'rgba(0,229,255,0.06)', borderColor: 'rgba(0,229,255,0.3)', color: 'var(--sp-cyan)' }}>Refreshing…</div>}

        {/* ── HOME ── */}
        {tab === 'Home' && customer && (
          <>
            <div className="sp-hello">
              <div>
                <h1>Welcome back, <em>{customer.fullName.split(' ')[0]}</em></h1>
                <p>{fmtDate(new Date().toISOString())} · Account {customer.email}</p>
              </div>
              <button type="button" className="sp-icon-btn" onClick={() => { setBusyTab(true); load(true).finally(() => setBusyTab(false)); }}>
                <FiRefreshCw /> Refresh
              </button>
            </div>

            {/* Wallet & financial overview */}
            <section className="sp-wallet">
              <div className="sp-wallet-left">
                <div>
                  <div className="sp-metric-label"><FiDollarSign size={13} /> Wallet balance</div>
                  <div className="sp-balance">{fmtMoney(wallet)}</div>
                </div>
                <div>
                  <div className="sp-metric-label"><FiActivity size={13} /> Balance due</div>
                  <div className="sp-due-row">
                    <span className={'sp-due-val ' + (balanceDue > 0 ? 'is-owed' : 'is-clear')}>
                      {fmtMoney(balanceDue)}
                    </span>
                    <span className="sp-due-note">
                      {balanceDue > 0 ? 'Outstanding invoices' : 'All invoices settled'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="sp-wallet-right">
                <button type="button" className="sp-action sp-action--cyan" onClick={() => setCheckout('wallet_topup')}>
                  <FiDollarSign /> <span>Wallet Top Up</span>
                </button>
                <button type="button" className="sp-action sp-action--purple" onClick={() => setCheckout('data_topup')}>
                  <FiWifi /> <span>Data Top Up</span>
                </button>
                <button type="button" className="sp-action sp-action--gold" onClick={() => setCheckout('kit_purchase')}>
                  <FiRadio /> <span>Buy Starlink Kit</span>
                </button>
                <button type="button" className="sp-action sp-action--ghost" onClick={() => goto('Billing')}>
                  <FiDownload /> <span>View Invoices</span>
                </button>
              </div>
            </section>

            <div className="sp-stats">
              <div className="sp-stat">
                <div className="sp-stat-label">Registered kits</div>
                <div className="sp-stat-val is-cyan">{data?.totals.kits ?? 0}</div>
                <div className="sp-stat-sub">Devices under management</div>
              </div>
              <div className="sp-stat">
                <div className="sp-stat-label">Pending invoices</div>
                <div className="sp-stat-val is-gold">{data?.totals.pending ?? 0}</div>
                <div className="sp-stat-sub">Awaiting settlement</div>
              </div>
              <div className="sp-stat">
                <div className="sp-stat-label">Paid invoices</div>
                <div className="sp-stat-val is-green">{data?.totals.paid ?? 0}</div>
                <div className="sp-stat-sub">Lifetime</div>
              </div>
              <div className="sp-stat">
                <div className="sp-stat-label">Paid this month</div>
                <div className="sp-stat-val">{fmtMoney(data?.paidThisMonth ?? 0)}</div>
                <div className="sp-stat-sub">Current calendar month</div>
              </div>
            </div>

            {/* Data usage */}
            <section className="sp-panel" style={{ marginTop: 16 }}>
              <div className="sp-panel-head">
                <div>
                  <h3 className="sp-panel-title">Data Usage</h3>
                  <p className="sp-panel-sub">Last 4 months · GB consumed per kit</p>
                </div>
                <div className="sp-kit-select">
                  <label htmlFor="sl-home-kit">Kit</label>
                  <select id="sl-home-kit" className="sp-select" value={kitId} onChange={(e) => setKitId(e.target.value)}>
                    {kits.length === 0 && <option value="">No kits yet</option>}
                    {kits.map((k) => (
                      <option key={k.id} value={k.id}>{k.nickname || 'Untitled kit'} · {k.kit_number}</option>
                    ))}
                  </select>
                </div>
              </div>

              {kits.length === 0 ? (
                <div className="sp-empty">
                  <FiRadio size={34} />
                  <p>No kits registered — add one from the Devices tab.</p>
                </div>
              ) : (
                <div className="sp-usage-grid">
                  <div>
                    <div className="sp-chart">
                      {usagePoints.map((u) => {
                        const gb = Number(u.usage_gb);
                        return (
                          <div className="sp-chart-col" key={u.month}>
                            <span className="sp-chart-val">{gb} GB</span>
                            <div className="sp-chart-bar-track">
                              <div
                                className={'sp-chart-bar' + (u.is_baseline ? ' is-baseline' : '')}
                                style={{ height: `${Math.max(6, (gb / maxUsage) * 100)}%` }}
                                title={`${monthLabel(u.month)}: ${gb} GB`}
                              />
                            </div>
                            <span className="sp-chart-x">{monthLabel(u.month)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="sp-details">
                    <div className="sp-detail">
                      <span className="sp-detail-k">Total data usage</span>
                      <span className="sp-detail-v is-cyan">{Number(activeKit?.data_usage_gb ?? 0)} GB</span>
                    </div>
                    <div className="sp-detail">
                      <span className="sp-detail-k">Data credit</span>
                      <span className="sp-detail-v">{Number(activeKit?.data_credit_gb ?? 0)} GB</span>
                    </div>
                    <div className="sp-detail">
                      <span className="sp-detail-k">Nickname</span>
                      <span className="sp-detail-v">{activeKit?.nickname || '—'}</span>
                    </div>
                    <div className="sp-detail">
                      <span className="sp-detail-k">Kit number</span>
                      <span className="sp-detail-v">{activeKit?.kit_number}</span>
                    </div>
                    <div className="sp-detail">
                      <span className="sp-detail-k">Status</span>
                      <span className="sp-detail-v" style={{ textTransform: 'uppercase' }}>
                        <span className={`sp-badge-pill ${activeKit?.status === 'active' ? 'sp-badge-pill--active' : 'sp-badge-pill--pending'}`}>
                          {activeKit?.status || 'active'}
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* Recent invoices */}
            <section className="sp-panel">
              <div className="sp-panel-head">
                <div>
                  <h3 className="sp-panel-title">Recent Invoices</h3>
                  <p className="sp-panel-sub">Native Preyone billing · Pese settlement</p>
                </div>
                <button type="button" className="sp-icon-btn" onClick={() => goto('Billing')}>
                  <FiExternalLink /> View all
                </button>
              </div>
              {invoices.length === 0 ? (
                <div className="sp-empty"><FiCreditCard size={32} /><p>No invoices yet.</p></div>
              ) : (
                <div className="sp-table-wrap">
                  <table className="sp-table">
                    <thead>
                      <tr><th>Invoice #</th><th>Date</th><th>Description</th><th>Amount</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {invoices.slice(0, 5).map((inv) => (
                        <tr key={inv.id}>
                          <td><b>{inv.invoice_number}</b></td>
                          <td className="is-muted">{fmtDate(inv.issued_date)}</td>
                          <td>{inv.description}</td>
                          <td className="is-money">{fmtMoney(Number(inv.amount), inv.currency)}</td>
                          <td><span className={`sp-badge-pill ${inv.status === 'PAID' ? 'sp-badge-pill--paid' : inv.status === 'FAILED' ? 'sp-badge-pill--failed' : 'sp-badge-pill--pending'}`}>{inv.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {/* ── SUBSCRIPTIONS ── */}
        {tab === 'Subscriptions' && (
          <>
            <div className="sp-hello">
              <div>
                <h1>Service <em>Plans</em></h1>
                <p>Indicative Starlink plans — final quotes confirmed by Preyone support.</p>
              </div>
            </div>
            <div className="sp-cards">
              {PLANS.map((p) => (
                <div className="sp-panel sp-plan" key={p.name}>
                  <h4>{p.name}</h4>
                  <div className="sp-plan-price">{p.price}<small>{p.cadence}</small></div>
                  <ul>
                    {p.perks.map((perk) => (
                      <li key={perk}><FiCheck size={14} /> {perk}</li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="sp-btn sp-btn--primary"
                    onClick={() => setCheckout(p.cta === 'kit' ? 'kit_purchase' : 'data_topup')}
                  >
                    {p.cta === 'kit' ? 'Order a Kit' : 'Top Up Data'}
                  </button>
                </div>
              ))}
            </div>
            <section className="sp-panel" style={{ marginTop: 16 }}>
              <div className="sp-panel-head">
                <div>
                  <h3 className="sp-panel-title">Billing notes</h3>
                  <p className="sp-panel-sub">How subscriptions settle on this portal</p>
                </div>
              </div>
              <p style={{ color: 'var(--sp-mut)', fontSize: 13.5, margin: 0, lineHeight: 1.7 }}>
                Every plan on this portal is billed in <b style={{ color: 'var(--sp-cyan)' }}>USD</b> through the
                Pese gateway (EcoCash, InnBucks, Omari). Data top-ups are credited to the kit you choose at
                checkout, wallet top-ups land in your portal balance, and kit orders are invoiced as
                SL-numbered Preyone invoices you can download as PDF from the Billing tab.
              </p>
            </section>
          </>
        )}

        {/* ── BILLING ── */}
        {tab === 'Billing' && customer && (
          <>
            <div className="sp-hello">
              <div>
                <h1>Billing &amp; <em>Invoices</em></h1>
                <p>Balance due {fmtMoney(balanceDue)} · Wallet {fmtMoney(wallet)}</p>
              </div>
            </div>
            <section className="sp-panel">
              <InvoicesView
                customer={customer}
                invoices={invoices}
                loading={loading}
                onRefresh={() => load(true)}
                onPay={() => setCheckout('wallet_topup')}
              />
            </section>
          </>
        )}

        {/* ── ORDERS ── */}
        {tab === 'Orders' && customer && (
          <>
            <div className="sp-hello">
              <div>
                <h1>Kit &amp; Data <em>Orders</em></h1>
                <p>Purchases of Starlink kits and data bundles.</p>
              </div>
            </div>
            <section className="sp-panel">
              <InvoicesView
                customer={customer}
                invoices={invoices}
                loading={loading}
                kinds={['kit_purchase', 'data_topup']}
                onRefresh={() => load(true)}
                onPay={() => setCheckout('kit_purchase')}
              />
            </section>
          </>
        )}

        {/* ── DEVICES ── */}
        {tab === 'Devices' && (
          <>
            <div className="sp-hello">
              <div>
                <h1>Your <em>Kits</em></h1>
                <p>Register hardware, nickname it and watch data credit.</p>
              </div>
              <button type="button" className="sp-btn sp-btn--ghost" onClick={() => setRegistering((v) => !v)}>
                {registering ? <FiX /> : <FiPlus />} {registering ? 'Cancel' : 'Register Kit'}
              </button>
            </div>

            {registering && (
              <section className="sp-panel">
                <div className="sp-panel-head">
                  <div>
                    <h3 className="sp-panel-title">Register a kit</h3>
                    <p className="sp-panel-sub">Serial number is printed on the Starlink box</p>
                  </div>
                </div>
                <form onSubmit={registerKit} style={{ display: 'grid', gap: 14, maxWidth: 520 }}>
                  <div className="sp-field">
                    <label htmlFor="sl-reg-serial">Kit serial</label>
                    <input id="sl-reg-serial" className="sp-input" value={kitNumber} onChange={(e) => setKitNumber(e.target.value)} placeholder="e.g. UT-4X2H91P" required />
                  </div>
                  <div className="sp-field">
                    <label htmlFor="sl-reg-nick">Nickname</label>
                    <input id="sl-reg-nick" className="sp-input" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Home, Office, Shop…" />
                  </div>
                  <div>
                    <button className="sp-btn sp-btn--primary" style={{ width: 'auto' }} type="submit">Save Kit</button>
                  </div>
                </form>
              </section>
            )}

            <div className="sp-cards" style={{ marginTop: registering ? 16 : 0 }}>
              {kits.length === 0 && !registering && (
                <div className="sp-panel sp-empty" style={{ gridColumn: '1 / -1' }}>
                  <FiRadio size={34} />
                  <p>No kits registered yet — click Register Kit to add your hardware.</p>
                </div>
              )}
              {kits.map((k) => (
                <div className="sp-panel" key={k.id}>
                  <div className="sp-panel-head" style={{ marginBottom: 10 }}>
                    <div>
                      <h3 className="sp-panel-title">{k.nickname || 'Untitled kit'}</h3>
                      <p className="sp-panel-sub">{k.kit_number}</p>
                    </div>
                    <span className={`sp-badge-pill ${k.status === 'active' ? 'sp-badge-pill--active' : 'sp-badge-pill--pending'}`}>
                      {k.status}
                    </span>
                  </div>
                  <div className="sp-details">
                    <div className="sp-detail">
                      <span className="sp-detail-k">Data usage</span>
                      <span className="sp-detail-v is-cyan">{Number(k.data_usage_gb)} GB</span>
                    </div>
                    <div className="sp-detail">
                      <span className="sp-detail-k">Data credit</span>
                      <span className="sp-detail-v">{Number(k.data_credit_gb)} GB</span>
                    </div>
                    <div className="sp-detail">
                      <span className="sp-detail-k">Added</span>
                      <span className="sp-detail-v">{fmtDate(k.created_at)}</span>
                    </div>
                  </div>
                  <div className="sp-row-actions" style={{ marginTop: 14 }}>
                    <button
                      type="button"
                      className="sp-icon-btn"
                      onClick={() => {
                        const next = window.prompt('New nickname', k.nickname || '');
                        if (next !== null) patchKit(k.id, { nickname: next.trim() });
                      }}
                    >
                      <FiSettings /> Rename
                    </button>
                    <button
                      type="button"
                      className="sp-icon-btn"
                      onClick={() => patchKit(k.id, { status: k.status === 'active' ? 'paused' : 'active' })}
                    >
                      <FiWifi /> {k.status === 'active' ? 'Pause' : 'Activate'}
                    </button>
                    <button type="button" className="sp-icon-btn" onClick={() => { setKitId(k.id); setCheckout('data_topup'); }}>
                      <FiDollarSign /> Top Up
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── SUPPORT ── */}
        {tab === 'Support' && (
          <>
            <div className="sp-hello">
              <div>
                <h1>Talk to <em>Preyone</em></h1>
                <p>Starlink installations, billing and hardware support.</p>
              </div>
            </div>
            <div className="sp-support-grid">
              <a className="sp-panel sp-support-card" href="https://wa.me/263771327202" target="_blank" rel="noreferrer">
                <FiMessageSquare size={22} />
                <b>WhatsApp</b>
                <span>Chat with the team · +263 771 327 202</span>
              </a>
              <a className="sp-panel sp-support-card" href="tel:+263771327202">
                <FiPhone size={22} />
                <b>Call us</b>
                <span>+263 771 327 202</span>
              </a>
              <a className="sp-panel sp-support-card" href="mailto:support@preyone.com?subject=Starlink%20portal%20support">
                <FiMail size={22} />
                <b>Email</b>
                <span>support@preyone.com</span>
              </a>
              <div className="sp-panel sp-support-card">
                <FiShield size={22} />
                <b>Service hours</b>
                <span>Mon–Sat · 08:00–20:00 (CAT)</span>
              </div>
            </div>
            <section className="sp-panel" style={{ marginTop: 16 }}>
              <div className="sp-panel-head">
                <div>
                  <h3 className="sp-panel-title">Before you contact us</h3>
                  <p className="sp-panel-sub">Fastest fixes first</p>
                </div>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--sp-mut)', fontSize: 13.5, lineHeight: 1.8 }}>
                <li>Payment stuck? Note the invoice number from Billing — settlement is usually instant.</li>
                <li>Kit not showing usage? Confirm the serial in Devices matches the box label.</li>
                <li>Reset link expired? Request a new one from the sign-in screen (valid 1 hour).</li>
              </ul>
            </section>
          </>
        )}

        {/* ── FAQs ── */}
        {tab === 'FAQs' && (
          <>
            <div className="sp-hello">
              <div>
                <h1>Frequently asked <em>questions</em></h1>
                <p>Billing, usage and account management on the Starlink portal.</p>
              </div>
            </div>
            <section className="sp-panel">
              {FAQS.map((f) => (
                <details className="sp-faq" key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </section>
          </>
        )}
      </main>

      {/* ── Search palette ── */}
      {paletteOpen && (
        <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label="Search" onClick={() => setPaletteOpen(false)}>
          <div className="sp-modal sp-palette" onClick={(e) => e.stopPropagation()}>
            <div className="sp-modal-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                <FiSearch color="#00e5ff" />
                <input
                  ref={paletteRef}
                  className="sp-palette-input"
                  value={paletteQuery}
                  onChange={(e) => setPaletteQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && paletteItems[0]) {
                      e.preventDefault();
                      runPaletteItem(paletteItems[0]);
                    }
                  }}
                  placeholder="Search tabs and actions…"
                />
              </div>
              <button type="button" className="sp-modal-close" onClick={() => setPaletteOpen(false)} aria-label="Close search">✕</button>
            </div>
            <div className="sp-modal-body" style={{ paddingTop: 14 }}>
              <div className="sp-palette-list">
                {paletteItems.length === 0 && <div className="sp-empty"><p>No matches.</p></div>}
                {paletteItems.map((item) => (
                  <button type="button" key={item.label} className="sp-palette-item" onClick={() => runPaletteItem(item)}>
                    {item.icon} {item.label} <span>{item.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Profile settings ── */}
      {profileOpen && customer && (
        <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label="Profile settings" onClick={() => setProfileOpen(false)}>
          <div className="sp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sp-modal-head">
              <h3>Profile Settings</h3>
              <button type="button" className="sp-modal-close" onClick={() => setProfileOpen(false)} aria-label="Close profile">✕</button>
            </div>
            <div className="sp-modal-body">
              {profileMsg && (
                <div className={`sp-alert ${profileMsg.kind === 'ok' ? 'sp-alert--ok' : 'sp-alert--err'}`}>{profileMsg.text}</div>
              )}
              <form onSubmit={saveProfile}>
                <div className="sp-field">
                  <label htmlFor="sl-pf-name">Full name</label>
                  <input id="sl-pf-name" className="sp-input" value={profileForm.fullName} onChange={(e) => setProfileForm((f) => ({ ...f, fullName: e.target.value }))} required />
                </div>
                <div className="sp-field">
                  <label htmlFor="sl-pf-phone">Phone</label>
                  <input id="sl-pf-phone" className="sp-input" value={profileForm.phone} onChange={(e) => setProfileForm((f) => ({ ...f, phone: e.target.value }))} required />
                </div>
                <div className="sp-field">
                  <label>Email (fixed)</label>
                  <input className="sp-input" value={customer.email} disabled style={{ opacity: 0.6 }} />
                </div>
                <button className="sp-btn sp-btn--primary" type="submit" disabled={profileBusy}>
                  {profileBusy ? 'Saving…' : 'Save Profile'}
                </button>
              </form>

              <div style={{ height: 1, background: 'var(--sp-line)', margin: '22px 0' }} />

              <form onSubmit={changePassword}>
                <div className="sp-field">
                  <label htmlFor="sl-pf-cur">Current password</label>
                  <input id="sl-pf-cur" className="sp-input" type="password" value={pwForm.currentPassword} onChange={(e) => setPwForm((f) => ({ ...f, currentPassword: e.target.value }))} autoComplete="current-password" required />
                </div>
                <div className="sp-field">
                  <label htmlFor="sl-pf-new">New password</label>
                  <input id="sl-pf-new" className="sp-input" type="password" value={pwForm.newPassword} onChange={(e) => setPwForm((f) => ({ ...f, newPassword: e.target.value }))} autoComplete="new-password" required />
                </div>
                <button className="sp-btn sp-btn--ghost" type="submit" disabled={profileBusy} style={{ width: '100%' }}>
                  <FiLock /> Change Password
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ── Pese checkout ── */}
      {checkout && customer && (
        <PeseCheckoutModal
          customer={customer}
          kits={kits}
          initialKind={checkout}
          onClose={() => setCheckout(null)}
          onQueued={onQueued}
        />
      )}

      {/* ── Toasts ── */}
      <div className="sp-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`sp-toast sp-toast--${t.kind}`}>
            {t.kind === 'ok' ? <FiCheck color="#22c55e" /> : t.kind === 'err' ? <FiX color="#f87171" /> : <FiActivity color="#00e5ff" />}
            <div>
              <b>{t.title}</b>
              {t.body && <span>{t.body}</span>}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
