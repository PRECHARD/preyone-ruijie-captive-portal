import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatRemaining } from '../sessionPolicy';
import './SessionLock.css';

/**
 * State A — inactivity lock.
 *
 * Full-screen, non-dismissible overlay rendered above the intact console
 * (the dashboard stays mounted underneath so unsaved work is preserved).
 * Unlocking re-verifies the password only: the server keeps auth_time and the
 * sid, so 2FA is not re-triggered while the 10-hour cap still has budget.
 */
export default function LockScreen() {
  const { user, unlock, logout, msUntilExpiry } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [remaining, setRemaining] = useState(() => (msUntilExpiry ?? 0));

  // Count the absolute cap down while the overlay is up. AuthContext already
  // feeds msUntilExpiry from its 1s tick, but only while locked — mirror it
  // locally so the digits do not depend on a parent re-render.
  useEffect(() => {
    if (msUntilExpiry === null) return;
    setRemaining(msUntilExpiry);
  }, [msUntilExpiry]);

  useEffect(() => {
    const t = window.setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1000));
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setError('');
    setBusy(true);
    try {
      await unlock(password);
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock the session');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const initials = (user?.fullName || user?.email || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="lock-overlay" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <div className="lock-card">
        <div className="lock-brand">
          <img src="/images/preyone-plan-white-outline@4x.png" alt="Preyone" className="lock-logo" />
          <span className="lock-brand-title">Admin Console</span>
        </div>

        <div className="lock-avatar" aria-hidden="true">{initials}</div>
        <h2 id="lock-title" className="lock-title">Session Locked</h2>
        <p className="lock-sub">
          You were inactive for a while. Enter your password to pick up exactly where you left off —
          no need to run two-factor again.
        </p>

        {user && (
          <div className="lock-identity">
            <span className="lock-identity-name">{user.fullName || user.email}</span>
            <span className="lock-identity-role">{user.role}</span>
          </div>
        )}

        <form onSubmit={submit} className="lock-form">
          <label className="lock-field">
            <span>Password</span>
            <span className="lock-pw">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                autoFocus
                required
              />
              <button
                type="button"
                className="lock-eye"
                onClick={() => setShowPw((v) => !v)}
                tabIndex={-1}
                aria-label={showPw ? 'Hide password' : 'Show password'}
              >
                {showPw ? (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </span>
          </label>

          {error && <div className="lock-error" role="alert">{error}</div>}

          <button type="submit" className="lock-btn" disabled={busy || !password}>
            {busy ? (<><span className="lock-spinner" aria-hidden="true" />Unlocking…</>) : 'Unlock Console'}
          </button>
        </form>

        <div className="lock-foot">
          {msUntilExpiry !== null && (
            <span className="lock-cap">
              Signed out automatically in <strong>{formatRemaining(remaining)}</strong>
            </span>
          )}
          <button type="button" className="lock-signout" onClick={logout}>Sign out instead</button>
        </div>
        <p className="lock-note">
          Your session ends for good 10 hours after you signed in. After that, you will need your
          password and a fresh email code.
        </p>
      </div>
    </div>
  );
}
