import { useCallback, useEffect, useState } from 'react';
import { api, auth, ApiError, type StaffUser, type MethodTotal, type Shift } from './api';
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
import { applyPosTheme } from './theme';
import { useRealtimeSales } from './realtime';

export interface Toast {
  msg: string;
  kind: 'ok' | 'error';
}

export default function App() {
  const [user, setUser] = useState<StaffUser | null>(auth.user());
  const [shift, setShift] = useState<Shift | null>(null);
  const [shiftTotals, setShiftTotals] = useState<MethodTotal[]>([]);
  const [shiftLoading, setShiftLoading] = useState(true);
  const [showX, setShowX] = useState(false);
  const [view, setView] = useState<'sell' | 'stock' | 'history' | 'spares' | 'kds' | 'tables' | 'repairs'>('sell');
  const [toast, setToast] = useState<Toast | null>(null);
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
    } catch {
      setShift(null);
      setShiftTotals([]);
    } finally {
      setShiftLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) refreshShift();
  }, [user, refreshShift]);

  // Theme + module toggles. One read gives the merchant's palette (applied as
  // CSS variables) and whether QSR KDS / dine-in tables are enabled, so the
  // header only offers the workspaces this company actually owns.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([api.theme(), api.catalog()])
      .then(([theme, catalog]) => {
        if (cancelled) return;
        applyPosTheme(theme);
        setModules(catalog.modules);
      })
      .catch(() => {
        /* pre-migration database: keep the built-in palette */
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
            <div>
              <div className="brand-name">PREYONE POS</div>
              <div className="brand-sub">ENTERPRISE</div>
            </div>
            <span
              className={`live-badge ${live.connected ? 'on' : ''}`}
              title={live.connected ? 'Live sales and stock updates are streaming' : 'Reconnecting to the live feed'}
            >
              <i className="live-dot" />
              {live.sale ? 'LEDGER LIVE' : live.connected ? 'LIVE' : 'OFFLINE'}
            </span>
            <div className="spacer" />
            {user.role !== 'Cashier' && (
              <>
                <button className={`chip ${view === 'sell' ? 'ok' : ''}`} onClick={() => setView('sell')}>SELL</button>
                <button className={`chip ${view === 'stock' ? 'ok' : ''}`} onClick={() => setView('stock')}>STOCK</button>
                <button className={`chip ${view === 'spares' ? 'ok' : ''}`} onClick={() => setView('spares')}>SPARES</button>
                {modules?.kds !== false && (
                  <button className={`chip ${view === 'kds' ? 'ok' : ''}`} onClick={() => setView('kds')}>KDS</button>
                )}
                {modules?.tables !== false && (
                  <button className={`chip ${view === 'tables' ? 'ok' : ''}`} onClick={() => setView('tables')}>TABLES</button>
                )}
                <button className={`chip ${view === 'repairs' ? 'ok' : ''}`} onClick={() => setView('repairs')}>REPAIRS</button>
              </>
            )}
            <button className={`chip ${view === 'history' ? 'ok' : ''}`} onClick={() => setView('history')}>HISTORY</button>
            {shift && (
              <button className="chip ok" onClick={() => setShowX(true)}>
                SHIFT OPEN · ${shiftValue.toFixed(2)}
              </button>
            )}
            <span className="chip">{user.fullName}</span>
            <button className="ghost-btn" onClick={logout}>Sign out</button>
          </header>

          {shiftLoading ? (
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
          ) : (
            <Terminal
              user={user}
              notify={notify}
              onApiError={sessionExpired}
              onShiftChanged={refreshShift}
              liveStock={live.stock}
              stockTick={live.tick}
            />
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
