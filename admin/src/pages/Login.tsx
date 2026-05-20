import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import './Login.css';

type Tab = 'login' | 'signup';

export default function Login() {
  const { login, signup } = useAuth();
  const [tab, setTab] = useState<Tab>('login');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [sName, setSName] = useState('');
  const [sEmail, setSEmail] = useState('');
  const [sPhone, setSPhone] = useState('');
  const [sRole, setSRole] = useState('Staff');
  const [sPassword, setSPassword] = useState('');

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
    try {
      const result = await signup({ fullName: sName, email: sEmail, phone: sPhone, role: sRole, password: sPassword });
      if (result.pendingApproval) {
        setSuccessMsg(result.message || 'Account created. Pending approval.');
      } else {
        setSuccessMsg('Account created! You can now sign in.');
        setTab('login');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-nav">
          <div className="auth-nav-inner">
            <div className="auth-brand">
              <img src="/images/preyonenoneglow-logo-zoom.png" alt="Preyone" className="auth-logo" />
              <span className="auth-brand-title">Admin Console</span>
            </div>
          </div>
        </div>
        <div className="auth-body">
          <div className="auth-tabs">
            <button className={'auth-tab' + (tab === 'login' ? ' active' : '')} onClick={() => { setTab('login'); setError(''); setSuccessMsg(''); }}>Sign In</button>
            <button className={'auth-tab' + (tab === 'signup' ? ' active' : '')} onClick={() => { setTab('signup'); setError(''); setSuccessMsg(''); }}>Sign Up</button>
          </div>

          {tab === 'login' && (
            <form onSubmit={handleLogin} className="auth-form">
              <div className="auth-field">
                <label>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@preyone.com" required />
              </div>
              <div className="auth-field">
                <label>Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required />
              </div>
              {error && <div className="auth-error">{error}</div>}
              <button type="submit" className="auth-btn">Sign In</button>
            </form>
          )}

          {tab === 'signup' && (
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
                <span className="auth-hint">Only 1 CEO and 1 Manager account allowed. Staff is unlimited.</span>
              </div>
              <div className="auth-field">
                <label>Password</label>
                <input type="password" value={sPassword} onChange={e => setSPassword(e.target.value)} placeholder="Create a strong password" required minLength={6} />
              </div>
              {error && <div className="auth-error">{error}</div>}
              {successMsg && <div className="auth-success">{successMsg}</div>}
              <button type="submit" className="auth-btn">Create Account</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
