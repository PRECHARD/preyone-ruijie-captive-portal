import { useAuth } from '../context/AuthContext';
import { formatRemaining } from '../sessionPolicy';
import './SessionLock.css';

/**
 * Pre-lock warning, shown 2 minutes before the 15-minute inactivity lock.
 *
 * Any real user interaction dismisses it automatically (AuthContext re-arms on
 * mousemove/keydown/etc.); the button is for someone watching a timer who
 * wants to acknowledge it without moving the mouse.
 */
export default function IdleWarningDialog() {
  const { warning, msUntilLock, staySignedIn, logout } = useAuth();
  if (!warning) return null;

  return (
    <div className="idle-warning" role="alertdialog" aria-modal="true" aria-labelledby="idle-warning-title">
      <div className="idle-warning-card">
        <div className="idle-warning-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <div className="idle-warning-body">
          <h3 id="idle-warning-title" className="idle-warning-title">Still there?</h3>
          <p className="idle-warning-text">
            Your console locks in <strong>{formatRemaining(msUntilLock)}</strong> to protect
            customer and payment data. Move the mouse or hit continue to stay signed in.
          </p>
        </div>
        <div className="idle-warning-actions">
          <button type="button" className="idle-warning-ghost" onClick={logout}>Sign out</button>
          <button type="button" className="idle-warning-btn" onClick={staySignedIn} autoFocus>
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}
