import { useCallback, useEffect, useState } from 'react';
import { api, auth, ApiError, type StaffUser, type MethodTotal, type Shift } from './api';
import PinLogin from './components/PinLogin';
import ShiftGate from './components/ShiftGate';
import Terminal from './components/Terminal';
import XReportModal from './components/XReportModal';
import StockManager from './components/StockManager';
import HistoryView from './components/HistoryView';
import SettingsView from './components/SettingsView';
import CloudSyncIndicator from './components/CloudSyncIndicator';

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
  const [view, setView] = useState<'home' | 'stock' | 'settings'>('home');
  const [homeTab, setHomeTab] = useState<'register' | 'documents'>('register');
  const [switching, setSwitching] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const notify = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ msg, kind });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

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
            <div className="spacer" />
            <button className={`chip ${view === 'home' ? 'ok' : ''}`} onClick={() => setView('home')}>HOME</button>
            {user.role !== 'Cashier' && (
              <button className={`chip ${view === 'stock' ? 'ok' : ''}`} onClick={() => setView('stock')}>STOCK</button>
            )}
            <button className={`chip ${view === 'settings' ? 'ok' : ''}`} onClick={() => setView('settings')}>
              SETTINGS
            </button>
            {shift && (
              <button className="chip ok" onClick={() => setShowX(true)}>
                SHIFT OPEN · ${shiftValue.toFixed(2)}
              </button>
            )}
            <CloudSyncIndicator />
            <span className="chip">{user.fullName}</span>
            <button className="ghost-btn" onClick={() => setSwitching(true)} title="Hand the till to another cashier">
              Switch
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
            <StockManager />
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
