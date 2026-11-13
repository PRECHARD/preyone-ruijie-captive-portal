import { useCallback, useEffect, useState } from 'react';
import { api, auth, ApiError, SESSION_EVENT, type SessionSignal, type StaffUser, type MethodTotal, type Shift } from './api';
import PinLogin from './components/PinLogin';
import ShiftGate from './components/ShiftGate';
import Terminal from './components/Terminal';
import XReportModal from './components/XReportModal';
import StockManager from './components/StockManager';
import HistoryView from './components/HistoryView';
import SparesSearch from './components/SparesSearch';
import KdsBoard from './components/KdsBoard';
import TableGrid from './components/TableGrid';
import RepairIntake from './components/RepairIntake';
import SettingsView from './components/SettingsView';
import CloudSyncIndicator from './components/CloudSyncIndicator';
import { applyPosTheme } from './theme';
import { useRealtimeSales } from './realtime';

export interface Toast {
  msg: string;
  kind: 'ok' | 'error';
}

type View = 'home' | 'sell' | 'stock' | 'history' | 'spares' | 'kds' | 'tables' | 'repairs' | 'settings';

/** Initials for the operator pill, e.g. "Prechard Muvirimi" → "PM". */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export default function App() {
  const [user, setUser] = useState<StaffUser | null>(auth.user());
  const [shift, setShift] = useState<Shift | null>(null);
  const [shiftTotals, setShiftTotals] = useState<MethodTotal[]>([]);
  const [shiftLoading, setShiftLoading] = useState(true);
  const [showX, setShowX] = useState(false);
  const [view, setView] = useState<View>('home');
  const [homeTab, setHomeTab] = useState<'register' | 'documents'>('register');
  const [switching, setSwitching] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  // The header clock is a trust signal on a till: it proves the terminal is
  // awake and matches the wall clock without touching the sale hot path.
  const [clock, setClock] = useState(() => new Date());
  // Null until the catalog loads, so a pre-migration backend never hides the
  // KDS/floor-plan buttons from a merchant who can already use them.
  const [modules, setModules] = useState<{ kds: boolean; tables: boolean } | null>(null);

  // Live settlement telemetry: stock decrements and ledger confirmations land
  // here the moment the server commits, whichever terminal or rail took the
  // payment. The till still reads REST for authoritative values.
  const live = useRealtimeSales(Boolean(user));

  const notify = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ msg, kind });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  // The shared admin session can lock (423) or expire (401) while the till is
  // open. api.ts emits this the moment it happens; returning to PinLogin is the
  // only safe state — the PIN re-issues a session without an email round-trip.
  useEffect(() => {
    const onSession = (event: Event) => {
      const state = (event as CustomEvent<SessionSignal>).detail;
      auth.clear();
      setUser(null);
      setShift(null);
      setShiftTotals([]);
      setShowX(false);
      setSwitching(false);
      setView('home');
      notify(
        state === 'locked'
          ? 'Till locked after inactivity — enter your PIN to continue'
          : 'Session expired — sign in again',
        'error'
      );
    };
    window.addEventListener(SESSION_EVENT, onSession);
    return () => window.removeEventListener(SESSION_EVENT, onSession);
  }, [notify]);

  useEffect(() => {
    const sale = live.sale;
    if (!sale) return;
    const amount =
      sale.amountPaid != null && Number.isFinite(sale.amountPaid)
        ? ` · ${sale.currency || 'USD'} ${sale.amountPaid.toFixed(2)}`
        : '';
    const low = sale.lowStock.map((m) => m.name).slice(0, 2).join(', ');
    notify(
      `${sale.documentNumber || 'Document'} settled${amount} · ledger updated${low ? ` · low stock: ${low}` : ''}`
    );
  }, [live.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshShift = useCallback(async () => {
    try {
      const data = await api.currentShift();
      setShift(data ? data.shift : null);
      setShiftTotals(data ? data.totalsByMethod : []);
    } catch (err) {
      // A revoked/locked session must return to the PIN screen. Swallowing the
      // error here used to leave a dead till on the "open a shift" gate.
      if (!(err instanceof ApiError && (err.status === 401 || err.status === 423))) {
        setShift(null);
        setShiftTotals([]);
      }
    } finally {
      setShiftLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) refreshShift();
  }, [user, refreshShift]);

  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 20_000);
    return () => window.clearInterval(id);
  }, []);

  // Theme + module toggles. One read gives the merchant's palette (applied as
  // CSS variables) and whether QSR KDS / dine-in tables are enabled, so the
  // header only offers the workspaces this company actually owns.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.allSettled([api.theme(), api.catalog()])
      .then(([themeRes, catalogRes]) => {
        if (cancelled) return;
        // Palette and module switches are independent: a theme read that fails
        // must not hide the KDS/tables workspaces (and vice versa).
        if (themeRes.status === 'fulfilled') applyPosTheme(themeRes.value);
        if (catalogRes.status === 'fulfilled') setModules(catalogRes.value.modules);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleLoggedIn = (token: string, u: StaffUser) => {
    auth.save(token, u);
    setUser(u);
    setShiftLoading(true);
  };

  const logout = () => {
    auth.clear();
    setUser(null);
    setShift(null);
    setShowX(false);
    setView('home');
  };

  const sessionExpired = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        logout();
        notify('Session expired — sign in again', 'error');
        return true;
      }
      return false;
    },
    [notify]
  );

  const shiftValue = shiftTotals.reduce((s, t) => s + Number(t.total || 0), 0);

  return (
    <>
      {!user ? (
        <PinLogin onLoggedIn={handleLoggedIn} />
      ) : (
        <div className="app-shell">
          <header className="topbar">
            <div className="brand-lockup">
              <img src="/Preyone.svg" alt="Preyone" />
              <span className="brand-text">
                <span className="brand-name">Preyone</span>
                <span className="brand-sub">POS · Enterprise</span>
              </span>
            </div>

            <span
              className={`live-badge ${live.connected ? 'on' : ''}`}
              title={live.connected ? 'Live sales and stock updates are streaming' : 'Reconnecting to the live feed'}
            >
              <i className="live-dot" />
              {live.sale ? 'LEDGER LIVE' : live.connected ? 'LIVE' : 'OFFLINE'}
            </span>

            <nav className="top-nav" aria-label="POS workspaces">
              <button className={`chip ${view === 'home' ? 'on' : ''}`} onClick={() => setView('home')}>HOME</button>
              {user.role !== 'Cashier' && (
                <>
                  <button className={`chip ${view === 'sell' ? 'on' : ''}`} onClick={() => setView('sell')}>SELL</button>
                  <button className={`chip ${view === 'stock' ? 'on' : ''}`} onClick={() => setView('stock')}>STOCK</button>
                  <button className={`chip ${view === 'spares' ? 'on' : ''}`} onClick={() => setView('spares')}>SPARES</button>
                  {modules?.kds !== false && (
                    <button className={`chip ${view === 'kds' ? 'on' : ''}`} onClick={() => setView('kds')}>KDS</button>
                  )}
                  {modules?.tables !== false && (
                    <button className={`chip ${view === 'tables' ? 'on' : ''}`} onClick={() => setView('tables')}>TABLES</button>
                  )}
                  <button className={`chip ${view === 'repairs' ? 'on' : ''}`} onClick={() => setView('repairs')}>REPAIRS</button>
                </>
              )}
              <button className={`chip ${view === 'settings' ? 'on' : ''}`} onClick={() => setView('settings')}>
                SETTINGS
              </button>
            </nav>

            <div className="spacer" />

            <span className="top-clock" title={clock.toLocaleString()}>
              <strong>{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong>
              <small>{clock.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</small>
            </span>

            {shift && (
              <button className="chip shift-chip" onClick={() => setShowX(true)} title="Open the X report and cash-up">
                SHIFT OPEN
                <b>${shiftValue.toFixed(2)}</b>
              </button>
            )}
            <CloudSyncIndicator />
            <span className="operator-pill" title={`${user.fullName} · ${user.role}`}>
              <span className="operator-avatar" aria-hidden>{initialsOf(user.fullName)}</span>
              <span className="operator-copy">
                <strong>{user.fullName}</strong>
                <small>{user.role}</small>
              </span>
            </span>
            <button className="ghost-btn ghost-btn--icon" onClick={() => setSwitching(true)} title="Hand the till to another cashier" aria-label="Switch cashier">
              ⇄
            </button>
            <button className="ghost-btn" onClick={logout}>Sign out</button>
          </header>

          {view === 'settings' ? (
            <SettingsView user={user} notify={notify} onApiError={sessionExpired} />
          ) : shiftLoading ? (
            <div className="empty-note">Checking till…</div>
          ) : !shift ? (
            <ShiftGate
              onOpened={(s) => {
                setShift(s);
                notify('Shift opened');
                refreshShift().catch(() => {});
              }}
              onError={(m) => {
                if (!sessionExpired(m)) notify(m, 'error');
              }}
            />
          ) : view === 'stock' ? (
            <StockManager liveStock={live.stock} stockTick={live.tick} />
          ) : view === 'spares' ? (
            <SparesSearch />
          ) : view === 'kds' ? (
            <KdsBoard notify={notify} />
          ) : view === 'tables' ? (
            <TableGrid notify={notify} />
          ) : view === 'repairs' ? (
            <RepairIntake notify={notify} />
          ) : view === 'history' ? (
            <HistoryView notify={notify} onApiError={sessionExpired} />
          ) : view === 'sell' ? (
            <Terminal
              user={user}
              notify={notify}
              onApiError={sessionExpired}
              onShiftChanged={refreshShift}
              shiftId={shift.id}
              liveStock={live.stock}
              stockTick={live.tick}
            />
          ) : (
            <div className="home-pane">
              <div className="home-tabs">
                <button
                  className={`hist-tab${homeTab === 'register' ? ' on' : ''}`}
                  onClick={() => setHomeTab('register')}
                >
                  Register
                </button>
                <button
                  className={`hist-tab${homeTab === 'documents' ? ' on' : ''}`}
                  onClick={() => setHomeTab('documents')}
                >
                  Invoices &amp; Quotes
                </button>
              </div>
              <div className="home-body">
                {homeTab === 'register' ? (
                  <Terminal
                    user={user}
                    notify={notify}
                    onApiError={sessionExpired}
                    onShiftChanged={refreshShift}
                    shiftId={shift.id}
                    liveStock={live.stock}
                    stockTick={live.tick}
                  />
                ) : (
                  <HistoryView notify={notify} onApiError={sessionExpired} />
                )}
              </div>
            </div>
          )}

          {switching && (
            <div className="modal-backdrop" onClick={() => setSwitching(false)}>
              <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <h3 className="modal-title">Switch cashier</h3>
                <p className="hint">Select the next operator and enter their PIN to hand over the till.</p>
                <PinLogin
                  onLoggedIn={(t, u) => {
                    handleLoggedIn(t, u);
                    setSwitching(false);
                    notify(`Now serving as ${u.fullName}`);
                  }}
                />
                <button className="secondary-btn" onClick={() => setSwitching(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {shift && showX && (
        <XReportModal
          shift={shift}
          totals={shiftTotals}
          onClose={() => setShowX(false)}
          onClosed={() => {
            setShowX(false);
            setShift(null);
            setShiftTotals([]);
            notify('Shift closed');
          }}
          onError={(m) => {
            if (!sessionExpired(m)) notify(m, 'error');
          }}
        />
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </>
  );
}
