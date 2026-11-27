import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  FiActivity, FiBell, FiCreditCard, FiDollarSign, FiDownload, FiExternalLink,
  FiGrid, FiHeadphones, FiLogOut, FiMail, FiMessageSquare, FiPackage, FiPhone,
  FiPlus, FiRefreshCw, FiRadio, FiSearch, FiSettings, FiShield,
  FiWifi, FiX, FiCheck, FiChevronDown, FiLock, FiCpu, FiLayers, FiHelpCircle,
} from 'react-icons/fi';
import type { IconType } from 'react-icons';
import {
  fmtMoney, fmtDate, monthLabel, sfetch, slPaymentStatus, slVerifyPayment,
  slNotifications, slMarkNotificationsRead, clearToken, ApiError,
  SL_TABS, type SlTab, type SlDashboard, type SlCustomer, type SlInvoice,
  type SlKit, type SlCheckoutResult, type SlPlanApplication, type SlNotification,
  type SlRole,
} from './api';
import FleetPanel from './FleetPanel';
import InvoicesView from './InvoicesView';
import SlFooter from './SlFooter';
import PeseCheckoutModal, { type CheckoutKind } from './PeseCheckoutModal';
import TelemetryPanel from './TelemetryPanel';

const PENDING_KEY = 'starlink_pending_payment';

type Toast = { id: number; kind: 'ok' | 'err' | 'info'; title: string; body?: string };

type ProfileState = { fullName: string; phone: string };

type SlPlan = { code: string; name: string; priceUsd: number; cadence: string; perks: string[] };

const TAB_ICONS: Record<SlTab, IconType> = {
  Home: FiActivity,
  Subscriptions: FiLayers,
  Billing: FiCreditCard,
  Devices: FiCpu,
  Orders: FiPackage,
  Support: FiHeadphones,
  FAQs: FiHelpCircle,
};

const FAQS = [
  { q: 'How do I pay for my Starlink service?', a: 'Use the Wallet Top Up or Data Top Up action on the Home tab. Payments run through the Preyone Payment gateway (EcoCash, InnBucks or Omari) and settle in USD — your invoice is marked paid automatically once the payment completes.' },
  { q: 'What happens after I complete a Preyone Payment payment?', a: 'Preyone Payment returns you to this portal. We poll the payment status, mark the invoice PAID and credit your wallet, data bundle or kit order — no manual confirmation needed.' },
  { q: 'How is data usage tracked per kit?', a: 'Each registered kit keeps a rolling four-month history of monthly consumption (GB). The Telemetry & Forecast panel adds a live 30-day priority/standard view, terminal health and a projected exhaustion date. Register your kit from the Devices tab with the serial number printed on the box.' },
  { q: 'Can I get usage warnings or automatic data top-ups?', a: 'Yes. In Telemetry & Forecast you can enable 75%, 90% and 100% email and portal alerts for each billing cycle. Auto top-up can buy more data from your wallet when your remaining allowance drops below your chosen minimum.' },
  { q: 'Can I download invoices for accounting?', a: 'Yes. Open Billing, click View on any invoice for the full document, then Download PDF. The Statement button exports everything on screen as a single account statement PDF. Fleet accounts also get a consolidated PDF covering every site.' },
  { q: 'How do I manage several branches or kits?', a: 'Fleet Overview appears when your account has two or more kits. Name each site, add city/GPS tags and the hardware model, then switch kits, move data credit between them, schedule a seasonal pause or download one consolidated statement.' },
  { q: 'Can I give my accountant or site technician access?', a: 'Yes. From Fleet Overview, invite a billing user to download PDF invoices and pay through Preyone Payment, or a site technician who only sees telemetry for the kits assigned to them. Invitations expire after seven days.' },
  { q: 'I forgot my password — what now?', a: 'Click "Forgot password" on the sign-in screen. A reset link valid for one hour is emailed to you; open it and choose a new password (minimum 8 characters).' },
  { q: 'Which payment methods are supported?', a: 'EcoCash, InnBucks and Omari through Preyone Payment. All portal prices and balances are shown in USD.' },
];

export default function StarlinkPortal({ onSignOut }: { onSignOut: () => void }) {
  const [data, setData] = useState<SlDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<SlTab>('Home');
  const [plans, setPlans] = useState<SlPlan[]>([]);

  useEffect(() => {
    fetch('/api/starlink/plans')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('plans'))))
      .then((body: { plans: SlPlan[] }) => setPlans(body.plans))
      .catch(() => setPlans([]));
  }, []);
  const [kitId, setKitId] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [checkout, setCheckout] = useState<CheckoutKind | null>(null);
  const [checkoutKitId, setCheckoutKitId] = useState('');
  const [planTarget] = useState<SlPlan | null>(null);
  const [renewalPayId, setRenewalPayId] = useState<string | undefined>(undefined);
  const [planGroup, setPlanGroup] = useState<'residential' | 'business'>('residential');
  const [switchTarget, setSwitchTarget] = useState<SlPlan | null>(null);
  const [switchOn, setSwitchOn] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const [switchDone, setSwitchDone] = useState('');
  const [applications, setApplications] = useState<SlPlanApplication[]>([]);

  const loadApplications = useCallback(async () => {
    try {
      const r = await sfetch<{ applications: SlPlanApplication[] }>('/plan-applications');
      setApplications(r.applications);
    } catch {
      setApplications([]);
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    try {
      const r = await slNotifications();
      setNotifications(r.notifications);
      setUnreadCount(r.unreadCount);
    } catch {
      /* keep the last known feed — notifications must never block the portal */
    }
  }, []);

  const nextMonthLabel = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  const closeSwitch = () => {
    setSwitchTarget(null);
    setSwitchOn(false);
    setSwitchError('');
    setSwitchDone('');
  };

  const submitSwitch = async () => {
    if (!switchTarget || !switchOn) return;
    setSwitchBusy(true);
    setSwitchError('');
    try {
      await sfetch('/plan-applications', { method: 'POST', body: JSON.stringify({ planCode: switchTarget.code }) });
      setSwitchDone(nextMonthLabel());
      await loadApplications();
    } catch (err) {
      setSwitchError(err instanceof ApiError ? err.message : 'Could not submit your application. Please try again.');
    } finally {
      setSwitchBusy(false);
    }
  };

  const [resending, setResending] = useState(false);
  const [verifyNotice, setVerifyNotice] = useState('');

  const resendVerification = async () => {
    setResending(true);
    setVerifyNotice('');
    try {
      const r = await sfetch<{ message: string }>('/auth/resend-verification', { method: 'POST' });
      setVerifyNotice(r.message);
    } catch (err) {
      setVerifyNotice(err instanceof ApiError ? err.message : 'Could not send the verification email.');
    } finally {
      setResending(false);
    }
  };
  const renewalInvoice = useMemo(
    () => data?.invoices.find((i) => i.kind === 'plan_renewal' && i.status === 'PENDING') ?? null,
    [data]
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<SlNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [verifyingIntent, setVerifyingIntent] = useState<string | null>(null);
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
  const notifRef = useRef<HTMLDivElement>(null);
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
      setUnreadCount(next.unreadCount ?? 0);
      void loadNotifications();
      setProfileForm({ fullName: next.customer.fullName, phone: next.customer.phone });
      setKitId((prev) => (prev && next.kits.some((k) => k.id === prev) ? prev : next.kits[0]?.id || ''));
    } catch (err) {
      if (!silent) setLoadError(err instanceof Error ? err.message : 'Could not load your dashboard');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [loadNotifications]);

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
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
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
        setNotifOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (paletteOpen) window.setTimeout(() => paletteRef.current?.focus(), 30);
    else setPaletteQuery('');
  }, [paletteOpen]);

  /* ── pending Preyone Payment payment (set before redirect, settled on return) ── */
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
  const role: SlRole = data?.role ?? 'owner';
  const customerId = customer?.id;

  useEffect(() => {
    if (customerId) loadApplications();
  }, [customerId, loadApplications]);
  const visibleTabs = useMemo(
    () => role === 'viewer'
      ? SL_TABS.filter((t) => t === 'Home' || t === 'Support' || t === 'FAQs')
      : SL_TABS,
    [role]
  );
  const kits: SlKit[] = useMemo(() => data?.kits ?? [], [data]);
  const invoices: SlInvoice[] = useMemo(() => data?.invoices ?? [], [data]);
  const pendingIntents = data?.pendingIntents ?? [];
  const recoverableInvoice = invoices.find(
    (i) => i.status === 'PENDING' && pendingIntents.some((p) => p.invoice_id === i.id)
  ) ?? null;
  const recoverableIntent = recoverableInvoice
    ? pendingIntents.find((p) => p.invoice_id === recoverableInvoice.id) ?? null
    : null;
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

  const openTopUp = (kind: CheckoutKind, kitId?: string) => {
    setCheckoutKitId(kitId || activeKit?.id || kits[0]?.id || '');
    setCheckout(kind);
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

  /* ── payment recovery + notifications ── */
  const verifyNow = async (intentId: string) => {
    if (verifyingIntent) return;
    setVerifyingIntent(intentId);
    try {
      const result = await slVerifyPayment(intentId);
      if (result.status === 'SUCCESS') {
        try {
          const raw = sessionStorage.getItem(PENDING_KEY);
          if (raw) {
            const pending = JSON.parse(raw) as { intentId?: string };
            if (pending.intentId === intentId) sessionStorage.removeItem(PENDING_KEY);
          }
        } catch { /* storage unavailable */ }
        pushToast('ok', 'Payment confirmed', result.message);
      } else if (result.status === 'FAILED') {
        pushToast('err', 'Payment not completed', result.message);
      } else {
        pushToast('info', 'Still processing', result.message);
      }
      await Promise.all([load(true), loadNotifications()]);
    } catch (err) {
      pushToast('err', 'Verification failed', err instanceof ApiError ? err.message : 'Please try again shortly.');
    } finally {
      setVerifyingIntent(null);
    }
  };

  const markOneRead = async (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    setUnreadCount((n) => Math.max(0, n - 1));
    try {
      const r = await slMarkNotificationsRead([id]);
      setUnreadCount(r.unreadCount);
    } catch {
      /* optimistic UI is harmless if the server call fails */
    }
  };

  const markAllRead = async () => {
    try {
      const r = await slMarkNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(r.unreadCount);
      pushToast('ok', 'Notifications cleared', 'Everything is now marked as read.');
    } catch (err) {
      pushToast('err', 'Could not update notifications', err instanceof Error ? err.message : undefined);
    }
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
    const finance = role !== 'viewer';
    const base = [
      ...visibleTabs.map((t) => ({ label: `Go to ${t}`, hint: 'Tab', run: () => goto(t), icon: <FiGrid /> })),
      ...(finance ? [
        { label: 'Wallet Top Up', hint: 'Action', run: () => { goto('Home'); openTopUp('wallet_topup'); }, icon: <FiDollarSign /> },
        { label: 'Data Top Up', hint: 'Action', run: () => { goto('Home'); openTopUp('data_topup'); }, icon: <FiWifi /> },
        { label: 'Buy Starlink Kit', hint: 'Action', run: () => { goto('Home'); openTopUp('kit_purchase'); }, icon: <FiPackage /> },
        { label: 'Download account statement', hint: 'Billing', run: () => goto('Billing'), icon: <FiDownload /> },
      ] : []),
      { label: 'Contact support', hint: 'Support', run: () => goto('Support'), icon: <FiHeadphones /> },
    ];
    const q = paletteQuery.trim().toLowerCase();
    return q ? base.filter((i) => i.label.toLowerCase().includes(q)) : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteQuery, tab, role, visibleTabs]);

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
          <img src="/images/preyone-logo-starlink.png" alt="Preyone" className="sp-logo-img" />
          <span className="sp-brand-txt">
            <b>STARLINK</b>
            <span>Customer Portal</span>
          </span>
        </div>

        <nav className="sp-tabs" aria-label="Portal sections">
          {visibleTabs.map((t) => (
            <button
              key={t}
              type="button"
              className={'sp-tab' + (tab === t ? ' is-active' : '')}
              onClick={() => goto(t)}
            >
              {(() => { const Icon = TAB_ICONS[t]; return <Icon aria-hidden="true" />; })()}
              <span>{t}</span>
            </button>
          ))}
        </nav>

        <div className="sp-right">
          <button type="button" className="sp-search" onClick={() => setPaletteOpen(true)} aria-label="Open search">
            <FiSearch />
            <span>Search…</span>
            <kbd>Ctrl K</kbd>
          </button>

          <div className="sp-notif" ref={notifRef}>
            <button
              type="button"
              className="sp-notif-btn"
              onClick={() => { setNotifOpen((v) => !v); setUserMenuOpen(false); }}
              aria-label="Notifications"
              aria-haspopup="dialog"
              aria-expanded={notifOpen}
            >
              <FiBell size={17} />
              {unreadCount > 0 && (
                <span className="sp-notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
              )}
            </button>
            {notifOpen && (
              <div className="sp-notif-pop" role="dialog" aria-label="Notifications">
                <div className="sp-notif-head">
                  <b>Notifications</b>
                  <button type="button" disabled={unreadCount === 0} onClick={markAllRead}>
                    Mark all read
                  </button>
                </div>
                <div className="sp-notif-list">
                  {notifications.length === 0 ? (
                    <div className="sp-notif-empty">You’re all caught up.</div>
                  ) : (
                    notifications.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        className={
                          'sp-notif-item sp-notif-item--' + n.category.toLowerCase().replace('_', '-')
                          + (n.is_read ? '' : ' is-unread')
                        }
                        onClick={() => {
                          if (!n.is_read) void markOneRead(n.id);
                          setNotifOpen(false);
                          if (n.link_url) window.location.assign(n.link_url);
                        }}
                      >
                        <span className="sp-notif-dot" aria-hidden="true" />
                        <span className="sp-notif-copy">
                          <b>{n.title}</b>
                          <small>{n.body}</small>
                          <time>{fmtDate(n.created_at)}</time>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

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

        {recoverableInvoice && recoverableIntent && (
          <div className="sp-alert sp-payment-recovery" role="status">
            <div>
              <b>Payment still pending.</b> We could not automatically confirm{' '}
              <strong>{recoverableInvoice.invoice_number}</strong>. If you already paid, verify it now.
            </div>
            <button
              type="button"
              className="sp-btn sp-btn--primary sp-btn--small"
              disabled={verifyingIntent === recoverableIntent.intent_id}
              onClick={() => void verifyNow(recoverableIntent.intent_id)}
            >
              <FiRefreshCw /> {verifyingIntent === recoverableIntent.intent_id ? 'Verifying…' : 'Verify Payment Now'}
            </button>
          </div>
        )}

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
            {role !== 'viewer' && customer.emailVerified === false && (
              <>
                <div className="sp-alert sp-alert--ok sp-renewal-banner" role="status">
                  <div>
                    <b>Verify your email.</b> We sent a confirmation link to {customer.email}. It expires in 24 hours.
                  </div>
                  <button type="button" className="sp-btn sp-btn--ghost" disabled={resending} onClick={resendVerification}>
                    {resending ? 'Sending…' : 'Resend email'}
                  </button>
                </div>
                {verifyNotice && <p className="sp-hint" style={{ margin: '-8px 0 14px' }}>{verifyNotice}</p>}
              </>
            )}
            {role !== 'viewer' && !customer.planCode && (
              <div className="sp-alert sp-alert--ok sp-renewal-banner" role="status">
                <div>
                  <b>Welcome to Preyone Starlink.</b> Choose a plan to activate your service.
                </div>
                <button type="button" className="sp-btn sp-btn--primary" onClick={() => goto('Subscriptions')}>
                  View plans
                </button>
              </div>
            )}
            {renewalInvoice && (
              <div className="sp-alert sp-alert--ok sp-renewal-banner" role="status">
                <div>
                  <b>Plan renewal due</b> — {renewalInvoice.description} for {fmtMoney(Number(renewalInvoice.amount))}
                  {renewalInvoice.due_date ? ` (renews ${fmtDate(renewalInvoice.due_date)})` : ''}.
                </div>
                <button
                  type="button"
                  className="sp-btn sp-btn--primary"
                  onClick={() => { setRenewalPayId(renewalInvoice.id); openTopUp('plan_renewal'); }}
                >
                  Pay renewal
                </button>
              </div>
            )}

            <FleetPanel
              customer={customer}
              kits={kits}
              invoices={invoices}
              role={role}
              selectedKitId={activeKit?.id || ''}
              onSelectKit={setKitId}
              onTopUpKit={(kit) => openTopUp('data_topup', kit)}
              onRefresh={() => load(true)}
              onToast={pushToast}
            />

            {/* Wallet & financial overview */}
            {role !== 'viewer' && (
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
                <button type="button" className="sp-action sp-action--cyan" onClick={() => openTopUp('wallet_topup')}>
                  <FiDollarSign /> <span>Wallet Top Up</span>
                </button>
                <button type="button" className="sp-action sp-action--purple" onClick={() => openTopUp('data_topup')}>
                  <FiWifi /> <span>Data Top Up</span>
                </button>
                <button type="button" className="sp-action sp-action--gold" onClick={() => openTopUp('kit_purchase')}>
                  <FiRadio /> <span>Buy Starlink Kit</span>
                </button>
                <button type="button" className="sp-action sp-action--ghost" onClick={() => goto('Billing')}>
                  <FiDownload /> <span>View Invoices</span>
                </button>
              </div>
            </section>
            )}

            {role === 'viewer' && (
              <div className="sp-alert sp-alert--ok sp-renewal-banner" role="status">
                <div><b>Telemetry-only access.</b> You can view live usage for your assigned site(s). Billing, transfers and account settings are hidden by your role.</div>
              </div>
            )}

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

            <TelemetryPanel kit={activeKit} readOnly={role === 'viewer' || role === 'billing'} />

            {/* Recent invoices — billing roles only */}
            {role !== 'viewer' && (
            <section className="sp-panel">
              <div className="sp-panel-head">
                <div>
                  <h3 className="sp-panel-title">Recent Invoices</h3>
                  <p className="sp-panel-sub">Native Preyone billing · Preyone Payment settlement</p>
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
            )}
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
            <section className="sp-panel sp-plans-panel">
              <div className="sp-panel-head">
                <div>
                  <h3 className="sp-panel-title">Service plans</h3>
                  <p className="sp-panel-sub">Switches start on the 1st of next month, subject to capacity.</p>
                </div>
                <div className="sp-seg" role="tablist" aria-label="Plan group">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={planGroup === 'residential'}
                    className={planGroup === 'residential' ? 'is-active' : ''}
                    onClick={() => setPlanGroup('residential')}
                  >
                    Residential
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={planGroup === 'business'}
                    className={planGroup === 'business' ? 'is-active' : ''}
                    onClick={() => setPlanGroup('business')}
                  >
                    Business
                  </button>
                </div>
              </div>
              <div className="sp-plan-grid">
                {plans
                  .filter((p) => (planGroup === 'business') === p.code.startsWith('business'))
                  .map((p) => {
                    const isCurrent = customer?.planCode === p.code;
                    const isPending = applications.some((a) => a.status === 'PENDING' && a.to_plan_code === p.code);
                    return (
                      <div className={'sp-panel sp-plan' + (isCurrent ? ' is-current' : '')} key={p.code}>
                        <div className="sp-plan-top">
                          <h4>{p.name}</h4>
                          {isCurrent && <span className="sp-badge-pill sp-badge-pill--paid">Active</span>}
                        </div>
                        <div className="sp-plan-price">${p.priceUsd}<small>/ {p.cadence}</small></div>
                        <ul>
                          {p.perks.map((perk) => (
                            <li key={perk}><FiCheck size={14} /> {perk}</li>
                          ))}
                        </ul>
                        {isCurrent ? (
                          <button type="button" className="sp-btn sp-btn--ghost" disabled>Current package</button>
                        ) : isPending ? (
                          <button type="button" className="sp-btn sp-btn--ghost" disabled>Application under review</button>
                        ) : (
                          <button
                            type="button"
                            className="sp-btn sp-btn--primary"
                            onClick={() => { setSwitchTarget(p); setSwitchOn(false); setSwitchError(''); setSwitchDone(''); }}
                          >
                            Choose plan
                          </button>
                        )}
                      </div>
                    );
                  })}
              </div>
            </section>

            {applications.length > 0 && (
              <section className="sp-panel" style={{ marginTop: 16 }}>
                <div className="sp-panel-head">
                  <div>
                    <h3 className="sp-panel-title">Plan applications</h3>
                    <p className="sp-panel-sub">Status of your plan switch requests</p>
                  </div>
                </div>
                <div className="sp-table-wrap">
                  <table className="sp-table">
                    <thead>
                      <tr><th>Requested package</th><th>Start</th><th>Submitted</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {applications.map((a) => (
                        <tr key={a.id}>
                          <td><b>{plans.find((p) => p.code === a.to_plan_code)?.name ?? a.to_plan_code}</b></td>
                          <td className="is-muted">{fmtDate(a.requested_start)}</td>
                          <td className="is-muted">{fmtDate(a.created_at)}</td>
                          <td>
                            <span className={`sp-badge-pill ${a.status === 'APPROVED' ? 'sp-badge-pill--paid' : a.status === 'REJECTED' ? 'sp-badge-pill--failed' : 'sp-badge-pill--pending'}`}>
                              {a.status === 'PENDING' ? 'Under review' : a.status === 'APPROVED' ? 'Confirmed' : 'Not confirmed'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            <section className="sp-panel" style={{ marginTop: 16 }}>
              <div className="sp-panel-head">
                <div>
                  <h3 className="sp-panel-title">Billing notes</h3>
                  <p className="sp-panel-sub">How subscriptions settle on this portal</p>
                </div>
              </div>
              <p style={{ color: 'var(--sp-mut)', fontSize: 13.5, margin: 0, lineHeight: 1.7 }}>
                Every plan on this portal is billed in <b style={{ color: 'var(--sp-cyan)' }}>USD</b> through the
                Preyone Payment gateway (EcoCash, InnBucks, Omari). Data top-ups are credited to the kit you choose at
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
                onPay={() => openTopUp('wallet_topup')}
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
                onPay={() => openTopUp('kit_purchase')}
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
                  <div className="sp-row-actions sp-kit-actions" style={{ marginTop: 14 }}>
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
                    <button type="button" className="sp-icon-btn" onClick={() => openTopUp('data_topup', k.id)}>
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
                <span>Chat with our team</span>
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

      <SlFooter />

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

      {/* ── Preyone Payment checkout ── */}
      {checkout && customer && (
        <PeseCheckoutModal
          customer={customer}
          kits={kits}
          initialKind={checkout}
          initialKitId={checkoutKitId || activeKit?.id || ''}
          plan={
            checkout === 'plan_renewal'
              ? plans.find((p) => p.code === customer.planCode)
              : checkout === 'plan_change' && planTarget ? planTarget : undefined
          }
          invoiceId={checkout === 'plan_renewal' ? renewalPayId : undefined}
          onClose={() => setCheckout(null)}
          onQueued={onQueued}
        />
      )}

      {switchTarget && (
        <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label={`Switch to ${switchTarget.name}`} onClick={closeSwitch}>
          <div className="sp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sp-modal-head">
              <h3>{switchDone ? 'Application received' : `Switch to ${switchTarget.name}`}</h3>
              <button type="button" className="sp-modal-close" onClick={closeSwitch} aria-label="Close">✕</button>
            </div>
            <div className="sp-modal-body">
              {switchDone ? (
                <div className="sp-alert sp-alert--ok" role="status">
                  Your application for <b>{switchTarget.name}</b> was received. Your current package stays active until{' '}
                  <b>{switchDone}</b>. You will receive a confirmation email if there is capacity for this package. A copy has
                  been sent to your email and to our team.
                </div>
              ) : (
                <>
                  <div className="sp-summary">
                    <div>
                      <div className="sp-summary-k">{switchTarget.name} · ${switchTarget.priceUsd} / month</div>
                      <div style={{ fontSize: 12, color: 'var(--sp-dim)', marginTop: 4 }}>
                        Effective from {nextMonthLabel()}
                      </div>
                    </div>
                  </div>
                  <ul className="sp-switch-perks">
                    {switchTarget.perks.map((perk) => (
                      <li key={perk}><FiCheck size={14} /> {perk}</li>
                    ))}
                  </ul>
                  <div className="sp-switch-row">
                    <div>
                      <b>Confirm plan switch</b>
                      <div className="sp-hint">Slide to apply for {switchTarget.name} starting {nextMonthLabel()}.</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={switchOn}
                      aria-label="Confirm plan switch"
                      className="sp-switch"
                      onClick={() => setSwitchOn((v) => !v)}
                    />
                  </div>
                  <p className="sp-hint" style={{ marginTop: 12 }}>
                    If there is no capacity on this package, we will tell you by email and your current plan stays unchanged.
                  </p>
                  {switchError && <div className="sp-alert sp-alert--err" role="alert">{switchError}</div>}
                </>
              )}
            </div>
            <div className="sp-modal-foot">
              {switchDone ? (
                <button type="button" className="sp-btn sp-btn--primary" style={{ width: 'auto' }} onClick={closeSwitch}>Done</button>
              ) : (
                <>
                  <button type="button" className="sp-btn sp-btn--ghost" style={{ width: 'auto' }} onClick={closeSwitch}>Cancel</button>
                  <button
                    type="button"
                    className="sp-btn sp-btn--primary"
                    style={{ width: 'auto' }}
                    disabled={!switchOn || switchBusy}
                    onClick={submitSwitch}
                  >
                    {switchBusy ? 'Submitting…' : 'Submit application'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
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
