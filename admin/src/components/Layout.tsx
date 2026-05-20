import { useAuth } from '../context/AuthContext';
import Sidebar from './Sidebar';
import { FiLogOut } from 'react-icons/fi';
import './Layout.css';

interface LayoutProps {
  activeSection: string;
  onNavigate: (section: string) => void;
  children: React.ReactNode;
}

export default function Layout({ activeSection, onNavigate, children }: LayoutProps) {
  const { user, logout } = useAuth();
  const role = user?.role || 'Staff';

  return (
    <div className={'admin-root' + (role === 'CEO' ? ' role-ceo' : '')}>
      <nav className="admin-nav">
        <div className="admin-nav-inner">
          <div className="admin-nav-brand">
            <img src="/images/preyonenoneglow-logo-zoom.png" alt="Preyone" className="admin-logo" />
            <span className="admin-nav-title">Admin Console</span>
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
      <div className="admin-layout">
        <Sidebar activeSection={activeSection} onNavigate={onNavigate} />
        <main className="admin-main">{children}</main>
      </div>
    </div>
  );
}
