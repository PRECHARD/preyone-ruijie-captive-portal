import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import './Login.css';

type View = 'login' | 'signup' | 'forgot' | 'reset';

export default function Login() {
  const { login, signup } = useAuth();
  const [view, setView] = useState<View>('login');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [signedUp, setSignedUp] = useState<{ fullName: string; role: string; pendingApproval: boolean } | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [sName, setSName] = useState('');
  const [sEmail, setSEmail] = useState('');
  const [sPhone, setSPhone] = useState('');
  const [sRole, setSRole] = useState('Staff');
  const [sPassword, setSPassword] = useState('');
  const [showSPassword, setShowSPassword] = useState(false);
  const [sConfirmPassword, setSConfirmPassword] = useState('');

  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      setResetToken(token);
      setView('reset');
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    if (sPassword !== sConfirmPassword) {
      setError('Passwords do not match');
      return;
    }
    try {
      const result = await signup({ fullName: sName, email: sEmail, phone: sPhone, role: sRole, password: sPassword });
      setSignedUp({ fullName: sName, role: sRole, pendingApproval: !!result.pendingApproval });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    if (!email.trim()) { setError('Enter your email address'); return; }
    setSendingReset(true);
    try {
      const res = await fetch('/api/admin/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      setSuccessMsg(data.message || 'Check your email for the reset link.');
    } catch (err: any) {
      setError('Something went wrong. Try again.');
    } finally {
      setSendingReset(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    if (newPassword.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match'); return; }
    setResetting(true);
    try {
      const res = await fetch('/api/admin/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reset failed');
      setSuccessMsg('Password reset successfully! You can now sign in.');
      setTimeout(() => { setView('login'); setSuccessMsg(''); }, 2500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  };

  const switchView = (v: View) => { setView(v); setError(''); setSuccessMsg(''); };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-nav">
          <div className="auth-nav-inner">
            <div className="auth-brand">
              <img src="/images/preyone-plan-white-outline@4x.png" alt="Preyone" className="auth-logo" />
              <span className="auth-brand-title">Admin Console</span>
            </div>
          </div>
        </div>
        <div className="auth-body">
          {view !== 'forgot' && view !== 'reset' && (
            <div className="auth-tabs">
              <button className={'auth-tab' + (view === 'login' ? ' active' : '')} onClick={() => { switchView('login'); setSignedUp(null); }}>Sign In</button>
              <button className={'auth-tab' + (view === 'signup' ? ' active' : '')} onClick={() => { switchView('signup'); setSignedUp(null); }}>Sign Up</button>
            </div>
          )}

          {signedUp && (
            <div className="auth-success-screen">
              <div className="auth-success-icon">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </div>
              <h2 className="auth-success-title">Account Created</h2>
              <p className="auth-success-name">Welcome, {signedUp.fullName}</p>
              <div className="auth-success-role">{signedUp.role}</div>
              {signedUp.pendingApproval ? (
                <>
                  <p className="auth-success-desc">Your Staff account is pending approval. A Manager or CEO must activate your account before you can sign in. We'll notify you once approved.</p>
                  <div className="auth-success-note">📧 Check your email for confirmation</div>
                </>
              ) : (
                <>
                  <p className="auth-success-desc">Your {signedUp.role} account is ready. You can now sign in with your credentials.</p>
                  <div className="auth-success-note">✅ No approval required</div>
                </>
              )}
              <button className="auth-btn" onClick={() => { setSignedUp(null); switchView('login'); }}>Sign In</button>
            </div>
          )}

          {!signedUp && view === 'login' && (
            <form onSubmit={handleLogin} className="auth-form">
              <div className="auth-field">
                <label>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@preyone.com" required />
              </div>
              <div className="auth-field">
                <label>Password</label>
                <div className="password-wrapper">
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required />
                  <button type="button" className="password-toggle" onClick={() => setShowPassword(!showPassword)} tabIndex={-1} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                    {showPassword ? (
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    )}
                  </button>
                </div>
              </div>
              {error && <div className="auth-error">{error}</div>}
              <button type="submit" className="auth-btn">Sign In</button>
              <button type="button" className="auth-link-btn" onClick={() => { switchView('forgot'); setEmail(''); }}>Forgot Password?</button>
            </form>
          )}

          {!signedUp && view === 'signup' && (
            <form onSubmit={handleSignup} className="auth-form">
              <div className="auth-field">
                <label>Full Name</label>
                <input type="text" value={sName} onChange={e => setSName(e.target.value)} placeholder="Your full name" required />
              </div>
              <div className="auth-field">
                <label>Email</label>
                <input type="email" value={sEmail} onChange={e => setSEmail(e.target.value)} placeholder="you@preyone.com" required />
              </div>
              <div className="auth-field">
                <label>Phone Number</label>
                <input type="tel" value={sPhone} onChange={e => setSPhone(e.target.value)} placeholder="+263 7XX XXX XXX" required />
              </div>
              <div className="auth-field">
                <label>User Role</label>
                <div className="segmented">
                  {['Staff', 'Manager', 'CEO'].map(r => (
                    <button key={r} type="button" className={'segmented-option' + (sRole === r ? ' active' : '')} onClick={() => setSRole(r)}>{r}</button>
                  ))}
                </div>
              </div>
              <div className="auth-field">
                <label>Password</label>
                <div className="password-wrapper">
                  <input type={showSPassword ? 'text' : 'password'} value={sPassword} onChange={e => setSPassword(e.target.value)} placeholder="Create a strong password" required minLength={6} />
                  <button type="button" className="password-toggle" onClick={() => setShowSPassword(!showSPassword)} tabIndex={-1} aria-label={showSPassword ? 'Hide password' : 'Show password'}>
                    {showSPassword ? (
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    )}
                  </button>
                </div>
              </div>
              <div className="auth-field">
                <label>Confirm Password</label>
                <div className="password-wrapper">
                  <input type={showSPassword ? 'text' : 'password'} value={sConfirmPassword} onChange={e => setSConfirmPassword(e.target.value)} placeholder="Re-enter your password" required minLength={6} />
                </div>
              </div>
              {error && <div className="auth-error">{error}</div>}
              {successMsg && <div className="auth-success">{successMsg}</div>}
              <button type="submit" className="auth-btn">Create Account</button>
            </form>
          )}

          {view === 'forgot' && (
            <form onSubmit={handleForgotPassword} className="auth-form">
              <h3 style={{margin:0,fontSize:16,color:'var(--text)'}}>Reset Password</h3>
              <p style={{margin:0,fontSize:13,color:'var(--text-muted)',lineHeight:1.5}}>Enter your email and we'll send you a password reset link.</p>
              <div className="auth-field">
                <label>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@preyone.com" required />
              </div>
              {error && <div className="auth-error">{error}</div>}
              {successMsg && <div className="auth-success">{successMsg}</div>}
              <button type="submit" className="auth-btn" disabled={sendingReset}>{sendingReset ? 'Sending...' : 'Send Reset Link'}</button>
              <button type="button" className="auth-link-btn" onClick={() => switchView('login')}>Back to Sign In</button>
            </form>
          )}

          {view === 'reset' && (
            <form onSubmit={handleResetPassword} className="auth-form">
              <h3 style={{margin:0,fontSize:16,color:'var(--text)'}}>Set New Password</h3>
              <p style={{margin:0,fontSize:13,color:'var(--text-muted)',lineHeight:1.5}}>Enter your new password below.</p>
              <div className="auth-field">
                <label>New Password</label>
                <div className="password-wrapper">
                  <input type={showNewPassword ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="New password" required minLength={6} />
                  <button type="button" className="password-toggle" onClick={() => setShowNewPassword(!showNewPassword)} tabIndex={-1}>
                    {showNewPassword ? (
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    )}
                  </button>
                </div>
              </div>
              <div className="auth-field">
                <label>Confirm Password</label>
                <div className="password-wrapper">
                  <input type={showNewPassword ? 'text' : 'password'} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Confirm new password" required minLength={6} />
                </div>
              </div>
              {error && <div className="auth-error">{error}</div>}
              {successMsg && <div className="auth-success">{successMsg}</div>}
              <button type="submit" className="auth-btn" disabled={resetting}>{resetting ? 'Resetting...' : 'Reset Password'}</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
