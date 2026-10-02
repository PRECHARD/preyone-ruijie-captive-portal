import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { playAlertSound } from '../utils/sound';
import Sidebar from './Sidebar';
import ErrorBoundary from './ErrorBoundary';
import ApWarningBanner from './ApWarningBanner';
import { FiLogOut } from 'react-icons/fi';
import './Layout.css';

interface LayoutProps {
  activeSection: string;
  onNavigate: (section: string) => void;
  activeProduct: 'pos' | 'wifi';
  onProductChange: (product: 'pos' | 'wifi') => void;
  children: React.ReactNode;
}

interface ToastItem {
  id: number;
  title: string;
  message: string;
  type: string;
  section?: string;
}

export default function Layout({ activeSection, onNavigate, activeProduct, onProductChange, children }: LayoutProps) {
  const { user, logout } = useAuth();
  const role = user?.role || 'Staff';
  const [notifCounts, setNotifCounts] = useState({ unreadBroadcasts: 0, pendingApprovals: 0, pendingHandovers: 0, pendingStaff: 0, total: 0 });
  const [alertsUnack, setAlertsUnack] = useState(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);
  const prevBroadcasts = useRef(0);
  const addToast = useCallback((title: string, message: string, type = 'info', section?: string) => {
    const id = ++toastId.current;
    setToasts(prev => [...prev, { id, title, message, type, section }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail;
      addToast(d.title, d.message, d.type || 'info', d.section);
    };
    window.addEventListener('app-toast', handler);
    return () => window.removeEventListener('app-toast', handler);
  }, [addToast]);

  // Notifications poll
  useEffect(() => {
    const fetch = async () => {
      try {
        const counts = await api.get('/notifications/count');
        setNotifCounts(counts);
      } catch { /* ignore */ }
    };
    fetch();
    const t = setInterval(fetch, 15000);
    return () => clearInterval(t);
  }, []);

  // Alerts unacknowledged poll
  useEffect(() => {
    const fetch = async () => {
      try {
        const data = await api.get<any>('/alerts');
        const count = data.totalUnacknowledged || 0;
        if (count > alertsUnack) {
          addToast('New Alert', `${count} unacknowledged alert(s)`, 'info', 'alerts');
          playAlertSound();
        }
        setAlertsUnack(count);
      } catch { /* ignore */ }
    };
    fetch();
    const t = setInterval(fetch, 15000);
    return () => clearInterval(t);
  }, [alertsUnack, addToast]);

  // Broadcasts unread poll
  useEffect(() => {
    const fetch = async () => {
      try {
        const counts = await api.get('/notifications/count');
        if (counts.unreadBroadcasts > prevBroadcasts.current) {
          addToast('New Broadcast', `${counts.unreadBroadcasts} unread broadcast(s)`, 'info', 'broadcasts');
          playAlertSound();
        }
        prevBroadcasts.current = counts.unreadBroadcasts;
      } catch { /* ignore */ }
    };
    fetch();
    const t = setInterval(fetch, 30000);
    return () => clearInterval(t);
  }, [addToast]);

  return (
    <div className={'admin-root' + (role === 'CEO' ? ' role-ceo' : '')}>
      <nav className="admin-nav">
        <div className="admin-nav-inner">
          <div className="admin-nav-brand">
            <img src="/images/preyonenoneglow-logo-zoom.png" alt="Preyone" className="admin-logo" />
          </div>
          <div className="admin-nav-center">
            <div className="workspace-switch" role="tablist" aria-label="Workspace">
              <button
                type="button"
                role="tab"
                aria-selected={activeProduct === 'pos'}
                data-ws="pos"
                className={'ws-btn' + (activeProduct === 'pos' ? ' active' : '')}
                onClick={() => onProductChange('pos')}
                title="Preyone POS"
              >
                <span className="ws-icon">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="7" width="18" height="3" rx="1" />
                    <path d="M5 10v9h14v-9" />
                    <path d="M8 10a4 4 0 0 0 8 0" />
                    <circle cx="9" cy="16" r=".5" fill="currentColor" />
                    <circle cx="15" cy="16" r=".5" fill="currentColor" />
                  </svg>
                </span>
                <span className="ws-label">Preyone POS</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeProduct === 'wifi'}
                data-ws="ultranet"
                className={'ws-btn' + (activeProduct === 'wifi' ? ' active' : '')}
                onClick={() => onProductChange('wifi')}
                title="Preyone UltraNet WiFi"
              >
                <span className="ws-icon">
                  <img src="/favicon.svg" alt="Preyone UltraNet WiFi" className="ws-logo ws-logo--favicon" />
                </span>
                <span className="ws-label">Preyone UltraNet WiFi</span>
              </button>
            </div>
          </div>
          <div className="nav-user">
            <span className="nav-user-dot" />
            <span className="nav-user-name">{user?.fullName}</span>
            <span className={'nav-role-badge ' + role.toLowerCase()}>{role}</span>
            <button className="nav-signout-btn" onClick={logout}>
              <FiLogOut /> Sign Out
            </button>
          </div>
        </div>
      </nav>
      <ApWarningBanner onNavigate={onNavigate} />
      <div className="admin-layout">
        <Sidebar activeSection={activeSection} onNavigate={onNavigate} notifCounts={notifCounts} alertsUnack={alertsUnack} activeProduct={activeProduct} />
        <main className="admin-main"><ErrorBoundary section={activeSection} onNavigate={onNavigate}>{children}</ErrorBoundary></main>
      </div>

      {/* iOS-style toast notifications */}
      <div className="toast-container">
        {toasts.map(t => (
          <div
            key={t.id}
            className={'toast-banner toast--' + t.type + (t.section ? ' toast--clickable' : '')}
            onClick={() => { if (t.section) onNavigate(t.section); }}
          >
            <div className="toast-title">
              {t.title}
              {t.section && <span className="toast-goto"> → {t.section}</span>}
            </div>
            <div className="toast-message">{t.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
