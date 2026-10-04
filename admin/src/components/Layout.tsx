import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { playAlertSound } from '../utils/sound';
import { FiMenu } from 'react-icons/fi';
import Sidebar from './Sidebar';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import Navbar from './Navbar';
import ErrorBoundary from './ErrorBoundary';
import ApWarningBanner from './ApWarningBanner';
import type { Workspace } from '../workspace';
import './Layout.css';

interface LayoutProps {
  activeSection: string;
  onNavigate: (section: string) => void;
  workspace: Workspace;
  onWorkspaceChange: (workspace: Workspace) => void;
  children: React.ReactNode;
}

interface ToastItem {
  id: number;
  title: string;
  message: string;
  type: string;
  section?: string;
}

export default function Layout({ activeSection, onNavigate, workspace, onWorkspaceChange, children }: LayoutProps) {
  const { user } = useAuth();
  const role = user?.role || 'Staff';
  const [navOpen, setNavOpen] = useState(false);
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
    <div className={'admin-root' + (role === 'CEO' ? ' role-ceo' : '') + (navOpen ? ' nav-open' : '')}>
      <nav className="admin-nav">
        <div className="admin-nav-inner">
          <button className="nav-hamburger" onClick={() => setNavOpen(o => !o)} aria-label="Toggle navigation menu" aria-expanded={navOpen}>
            <FiMenu />
          </button>
          <div className="admin-nav-brand">
            <img src="/images/preyonenoneglow-logo-zoom.png" alt="Preyone" className="admin-logo" />
            <span className="admin-brand-label">Command</span>
          </div>
          <div className="admin-nav-center">
            <WorkspaceSwitcher workspace={workspace} onChange={onWorkspaceChange} />
          </div>
          <Navbar />
        </div>
      </nav>
      <div className={'sidebar-overlay' + (navOpen ? ' visible' : '')} onClick={() => setNavOpen(false)} />
      <ApWarningBanner onNavigate={onNavigate} />
      <div className="admin-layout">
        <Sidebar
          activeSection={activeSection}
          onNavigate={(s) => { setNavOpen(false); onNavigate(s); }}
          workspace={workspace}
          notifCounts={notifCounts}
          alertsUnack={alertsUnack}
        />
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
