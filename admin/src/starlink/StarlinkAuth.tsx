import { useState, type FormEvent } from 'react';
import {
  FiCheck, FiLock, FiMail, FiPhone, FiRadio, FiShield, FiUser, FiWifi,
} from 'react-icons/fi';
import { sfetch, setToken, ApiError } from './api';

type View = 'signin' | 'signup' | 'forgot' | 'reset';

type AuthPayload = { token: string };

export default function StarlinkAuth({
  initialView = 'signin',
  resetToken = '',
  verified = false,
  onAuthed,
}: {
  initialView?: View;
  resetToken?: string;
  verified?: boolean;
  onAuthed: () => void;
}) {
  const [view, setView] = useState<View>(resetToken ? 'reset' : initialView);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(verified ? 'Email verified. Sign in to continue.' : '');
  const [busy, setBusy] = useState(false);

  // signin
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  // signup
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [kitSerial, setKitSerial] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  // forgot
  const [forgotEmail, setForgotEmail] = useState('');
  // reset
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');

  const go = (next: View) => {
    setView(next);
    setError('');
    setInfo('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setBusy(true);
    try {
      if (view === 'signin') {
        const data = await sfetch<AuthPayload>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ identifier, password }),
        });
        setToken(data.token);
        onAuthed();
      } else if (view === 'signup') {
        const data = await sfetch<AuthPayload>('/auth/signup', {
          method: 'POST',
          body: JSON.stringify({ fullName, email, phone, password: signupPassword, kitSerial }),
        });
        setToken(data.token);
        onAuthed();
      } else if (view === 'forgot') {
        const data = await sfetch<{ message: string }>('/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email: forgotEmail }),
        });
        setInfo(data.message);
      } else {
        if (newPassword !== newPassword2) {
          setError('Passwords do not match');
          setBusy(false);
          return;
        }
        const data = await sfetch<{ message: string }>('/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({ token: resetToken, password: newPassword }),
        });
        setInfo(data.message);
        go('signin');
        setInfo('Password updated. Sign in with your new password.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const heading =
    view === 'signin' ? 'Welcome back'
      : view === 'signup' ? 'Create your account'
        : view === 'forgot' ? 'Reset password'
          : 'Choose a new password';

  const sub =
    view === 'signin' ? 'Sign in to manage your Starlink service.'
      : view === 'signup' ? 'Join the Preyone Starlink customer portal.'
        : view === 'forgot' ? "We'll email you a secure reset link."
          : 'Enter a new password for your account.';

  return (
    <div className="sp-root sp-auth">
      {/* ── Brand panel ── */}
      <aside className="sp-auth-brand">
        <div>
          <span className="sp-badge">
            <span className="sp-badge-dot" />
            Preyone · Starlink Portal
          </span>
          <h1 className="sp-auth-title">
            Your satellite
            <br />
            <em>service, in orbit.</em>
          </h1>
          <p className="sp-auth-lead">
            Manage your Starlink kit, track data usage and settle invoices in USD —
            all from one secure Preyone account.
          </p>
          <ul className="sp-auth-points">
            <li>
              <FiWifi />
              <span><b>Live kit &amp; usage control</b> — monitor consumption, nicknames and data credits.</span>
            </li>
            <li>
              <FiLock />
              <span><b>Pay with Pese</b> — EcoCash, InnBucks and Omari, settled in USD.</span>
            </li>
            <li>
              <FiRadio />
              <span><b>Native Preyone invoices</b> — download PDFs and account statements.</span>
            </li>
            <li>
              <FiShield />
              <span><b>Bank-grade sessions</b> — signed JWT access, reset links expire in 1 hour.</span>
            </li>
          </ul>
        </div>
        <p className="sp-auth-foot">starlink.preyone.com · Preyone Enterprises (Pvt) Ltd</p>
      </aside>

      {/* ── Form panel ── */}
      <main className="sp-auth-side">
        <form className="sp-auth-card" onSubmit={submit} noValidate>
          <span className="sp-badge">
            <span className="sp-badge-dot" />
            {view === 'signup' ? 'New customer' : 'Customer access'}
          </span>
          <h2>{heading}</h2>
          <p className="sp-auth-sub">{sub}</p>

          {error && <div className="sp-alert sp-alert--err" role="alert">{error}</div>}
          {info && <div className="sp-alert sp-alert--ok" role="status">{info}</div>}

          {view === 'signin' && (
            <>
              <div className="sp-field">
                <label htmlFor="sl-identifier">Email or phone</label>
                <input
                  id="sl-identifier"
                  className="sp-input"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="you@example.com or +263…"
                  autoComplete="username"
                  required
                />
              </div>
              <div className="sp-field">
                <label htmlFor="sl-password">Password</label>
                <input
                  id="sl-password"
                  className="sp-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -4, marginBottom: 14 }}>
                <button type="button" className="sp-link" onClick={() => go('forgot')}>
                  Forgot password?
                </button>
              </div>
            </>
          )}

          {view === 'signup' && (
            <>
              <div className="sp-field">
                <label htmlFor="sl-name">Full name</label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="sl-name"
                    className="sp-input"
                    style={{ paddingLeft: 40 }}
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Tendai Muvirimi"
                    autoComplete="name"
                    required
                  />
                  <FiUser style={{ position: 'absolute', left: 13, top: 13, color: '#64748b' }} />
                </div>
              </div>
              <div className="sp-field">
                <label htmlFor="sl-email">Email address</label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="sl-email"
                    className="sp-input"
                    style={{ paddingLeft: 40 }}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                  />
                  <FiMail style={{ position: 'absolute', left: 13, top: 13, color: '#64748b' }} />
                </div>
              </div>
              <div className="sp-field">
                <label htmlFor="sl-phone">Phone (Pese billing alerts)</label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="sl-phone"
                    className="sp-input"
                    style={{ paddingLeft: 40 }}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+263 77 123 4567"
                    autoComplete="tel"
                    required
                  />
                  <FiPhone style={{ position: 'absolute', left: 13, top: 13, color: '#64748b' }} />
                </div>
              </div>
              <div className="sp-field">
                <label htmlFor="sl-kit">Kit serial (optional)</label>
                <input
                  id="sl-kit"
                  className="sp-input"
                  value={kitSerial}
                  onChange={(e) => setKitSerial(e.target.value)}
                  placeholder="e.g. UT-4X2H91P"
                />
                <span className="sp-hint">You can also register kits later from the Devices tab.</span>
              </div>
              <div className="sp-field">
                <label htmlFor="sl-newpass">Password</label>
                <input
                  id="sl-newpass"
                  className="sp-input"
                  type="password"
                  value={signupPassword}
                  onChange={(e) => setSignupPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  required
                />
              </div>
            </>
          )}

          {view === 'forgot' && (
            <div className="sp-field">
              <label htmlFor="sl-forgot-email">Email address</label>
              <input
                id="sl-forgot-email"
                className="sp-input"
                type="email"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </div>
          )}

          {view === 'reset' && (
            <>
              <div className="sp-field">
                <label htmlFor="sl-reset-pass">New password</label>
                <input
                  id="sl-reset-pass"
                  className="sp-input"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  required
                />
              </div>
              <div className="sp-field">
                <label htmlFor="sl-reset-pass2">Confirm password</label>
                <input
                  id="sl-reset-pass2"
                  className="sp-input"
                  type="password"
                  value={newPassword2}
                  onChange={(e) => setNewPassword2(e.target.value)}
                  placeholder="Repeat the password"
                  autoComplete="new-password"
                  required
                />
              </div>
            </>
          )}

          <button className="sp-btn sp-btn--primary" type="submit" disabled={busy}>
            {busy
              ? 'Please wait…'
              : view === 'signin' ? 'Sign In' : view === 'signup' ? 'Create Account'
                : view === 'forgot' ? 'Send Reset Link' : 'Update Password'}
          </button>

          <div className="sp-auth-switch">
            {view === 'signin' && (
              <>
                New to Preyone Starlink?{' '}
                <button type="button" className="sp-link" onClick={() => go('signup')}>Create account</button>
              </>
            )}
            {view === 'signup' && (
              <>
                Already registered?{' '}
                <button type="button" className="sp-link" onClick={() => go('signin')}>Sign in</button>
              </>
            )}
            {(view === 'forgot' || view === 'reset') && (
              <button type="button" className="sp-link" onClick={() => go('signin')}>
                Back to sign in
              </button>
            )}
          </div>

          <div className="sp-secure">
            <FiCheck /> Protected by Preyone secure customer auth
          </div>
        </form>
      </main>
    </div>
  );
}
