import { useEffect, useRef, useState } from 'react';
import { FiChevronDown, FiLogOut } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import './Navbar.css';

export default function Navbar({ className }: { className?: string }) {
  const { user, logout } = useAuth();
  const [userOpen, setUserOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);
  const role = user?.role || 'Staff';

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUserOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className={'navbar-right' + (className ? ' ' + className : '')} ref={userRef}>
      <button
        type="button"
        className="navbar-profile"
        onClick={() => setUserOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={userOpen}
        aria-label="Account menu"
      >
        <span className="navbar-dot" />
        <span className="navbar-profile-name">{user?.fullName || 'Admin'}</span>
        <span className={'navbar-role navbar-role--' + role.toLowerCase()}>{role}</span>
        <FiChevronDown className={'navbar-chevron' + (userOpen ? ' open' : '')} />
      </button>
      {userOpen && (
        <div className="navbar-menu navbar-menu--right" role="menu" aria-label="Account">
          <div className="navbar-menu-head">
            <span className="navbar-menu-name">{user?.fullName || 'Admin'}</span>
            {user?.email && <span className="navbar-menu-email">{user.email}</span>}
          </div>
          <button type="button" role="menuitem" className="navbar-menu-item navbar-menu-item--danger" onClick={logout}>
            <FiLogOut /> Sign Out
          </button>
        </div>
      )}
    </div>
  );
}