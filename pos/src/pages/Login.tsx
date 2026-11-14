import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, type StaffUser, type TillOperator } from '../api';
import { applyCssVars } from '../theme';

const AUTH_POINTS = [
  {
    title: 'Lightning-fast till',
    body: 'Ring sales, split tenders and kick the drawer without leaving the register.',
  },
  {
    title: 'Stock that stays honest',
    body: 'Every item sold decrements inventory the moment the receipt prints.',
  },
  {
    title: 'Shift-ready cash control',
    body: 'Open floats, X-reports and Pesepay rails — locked to the signed-in cashier.',
  },
];

type Mode = 'sso' | 'pin' | 'setup';

async function ssoLogin(email: string, password: string): Promise<{
  token?: string;
  user?: StaffUser;
  requires2fa?: boolean;
  challengeToken?: string;
  maskedEmail?: string;
  expiresAt?: string;
  error?: string;
  code?: string;
}> {
  const res = await fetch('/api/admin/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, client: 'pos' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || 'Sign-in failed', code: data.code };
  return data;
}

async function verify2fa(
  challengeToken: string,
  code: string
): Promise<{ token?: string; user?: StaffUser; error?: string; code?: string }> {
  const res = await fetch('/api/admin/auth/verify-2fa', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken, code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || 'Verification failed', code: data.code };
  return data;
}

function AuthFrame({
  kicker,
  title,
  subtitle,
  children,
  logoSrc,
}: {
  kicker: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  logoSrc: string;
}) {
  return (
    <div className="auth-shell">
      <aside className="auth-hero">
        <div className="auth-hero-brand">
          <span className="auth-logo">
            <img src={logoSrc} alt="Preyone" onError={(e) => ((e.target as HTMLImageElement).src = '/Preyone.svg')} />
          </span>
          <span className="auth-hero-division">Point of sale</span>
        </div>
        <div className="auth-hero-copy">
          <span className="auth-eyebrow">Till terminal</span>
          <h2>Every till sale, inventory item and cash drawer — in one lightning-fast terminal.</h2>
          <ul className="auth-points">
            {AUTH_POINTS.map((point) => (
              <li key={point.title}>
                <span className="auth-point-dot" aria-hidden />
                <div>
                  <strong>{point.title}</strong>
                  <span>{point.body}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="auth-hero-foot">
          <span className="auth-secure">
            <i aria-hidden /> Secure session
          </span>
          <span>pos.preyone.com</span>
        </div>
      </aside>

      <main className="auth-panel">
        <section className="card auth-card" aria-live="polite">
          <div className="auth-kicker">{kicker}</div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
          {children}
        </section>
        <p className="auth-legal">
          Protected by Preyone single sign-on · Need help? <a href="mailto:support@preyone.com">support@preyone.com</a>
        </p>
      </main>
    </div>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <span className="input-affix">
        <input
          className="input"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required
        />
        <button
          className="input-affix-btn"
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </span>
    </label>
  );
}

function PinPad({
  pin,
  busy,
  onPress,
}: {
  pin: string;
  busy: boolean;
  onPress: (key: string) => void;
}) {
  return (
    <>
      <div className="pin-dots">
        {Array.from({ length: Math.max(4, pin.length || 4) }, (_, i) => (
          <span key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
        ))}
      </div>
      <div className="pin-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '←', '0', 'OK'].map((k) => (
          <button key={k} type="button" disabled={busy} onClick={() => onPress(k)} className={k === 'OK' ? 'pin-ok' : undefined}>
            {k}
          </button>
        ))}
      </div>
    </>
  );
}

export default function Login({
  onLoggedIn,
  compact = false,
}: {
  onLoggedIn: (token: string, user: StaffUser) => void;
  /** Switch-cashier modal: PIN-only, no dual-pane hero. */
  compact?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(compact ? 'pin' : 'sso');
  const [logoSrc, setLogoSrc] = useState('/Preyone.svg');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  // SSO
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [masked, setMasked] = useState('');
  const [otp, setOtp] = useState('');

  // PIN
  const [operators, setOperators] = useState<TillOperator[]>([]);
  const [operator, setOperator] = useState<TillOperator | null>(null);
  const [pin, setPin] = useState('');
  const [loadErr, setLoadErr] = useState('');

  // Setup PIN after SSO
  const [pendingUser, setPendingUser] = useState<StaffUser | null>(null);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .tillOperators()
      .then((rows) => {
        if (!alive) return;
        setOperators(rows);
        if (rows.length === 0) setLoadErr('No till operators with a PIN yet. Sign in with SSO to set one.');
      })
      .catch(() => alive && setLoadErr('Could not load till operators.'));
    return () => {
      alive = false;
    };
  }, []);

  // Best-effort theme/logo once we have any session (setup-pin / after SSO).
  useEffect(() => {
    if (!pendingToken) return;
    let alive = true;
    api
      .theme()
      .then((res) => {
        if (!alive) return;
        applyCssVars(res.css);
      })
      .catch(() => {
        /* cosmetic */
      });
    api
      .company()
      .then((c) => {
        if (!alive) return;
        const logo = (c as { logo_url?: string | null }).logo_url;
        if (logo) setLogoSrc(logo);
      })
      .catch(() => {
        /* keep fallback */
      });
    return () => {
      alive = false;
    };
  }, [pendingToken]);

  const finishLogin = (token: string, user: StaffUser, offerPinSetup: boolean) => {
    if (offerPinSetup && !compact) {
      setPendingToken(token);
      setPendingUser(user);
      setMode('setup');
      setNotice('Optional: set a till PIN for fast shift unlock on this device.');
      return;
    }
    onLoggedIn(token, user);
  };

  const submitSso = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (challenge) {
        const data = await verify2fa(challenge, otp);
        if (data.error) throw new Error(data.error);
        if (!data.token || !data.user) throw new Error('Sign-in failed');
        finishLogin(data.token, data.user, true);
        return;
      }
      const data = await ssoLogin(email.trim(), password);
      if (data.error) throw new Error(data.error);
      if (data.requires2fa && data.challengeToken) {
        setChallenge(data.challengeToken);
        setMasked(data.maskedEmail || '');
        setOtp('');
        return;
      }
      if (!data.token || !data.user) throw new Error('Sign-in failed');
      finishLogin(data.token, data.user, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const submitPin = async (code: string) => {
    if (!operator) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.loginPin(operator.id, code);
      onLoggedIn(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'PIN sign-in failed');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const press = (key: string) => {
    if (busy) return;
    if (key === '←') {
      setPin((p) => p.slice(0, -1));
      return;
    }
    if (key === 'OK') {
      if (pin.length >= 4) void submitPin(pin);
      return;
    }
    setPin((pin + key).slice(0, 8));
  };

  const savePin = async (e: FormEvent) => {
    e.preventDefault();
    if (!pendingToken || !pendingUser) return;
    if (!/^\d{4,8}$/.test(newPin)) {
      setError('PIN must be 4–8 digits');
      return;
    }
    if (newPin !== confirmPin) {
      setError('PINs do not match');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // Temporarily store token so setPin can authorize.
      localStorage.setItem('pos_token', pendingToken);
      localStorage.setItem('pos_user', JSON.stringify(pendingUser));
      await api.setPin(newPin);
      onLoggedIn(pendingToken, pendingUser);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save PIN');
    } finally {
      setBusy(false);
    }
  };

  const skipPin = () => {
    if (pendingToken && pendingUser) onLoggedIn(pendingToken, pendingUser);
  };

  const pinBody = (
    <>
      {loadErr && <div className="err-msg">{loadErr}</div>}
      {error && <div className="err-msg">{error}</div>}
      {!operator ? (
        <>
          <div className="pin-hint">Select your name</div>
          <div className="op-list">
            {operators.map((op) => (
              <button key={op.id} type="button" className="op-btn" onClick={() => setOperator(op)}>
                <span>{op.full_name}</span>
                <span className="op-role">{op.role}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            className="op-selected"
            onClick={() => {
              setOperator(null);
              setPin('');
              setError('');
            }}
          >
            {operator.full_name} <span className="op-change">(change)</span>
          </button>
          <PinPad pin={pin} busy={busy} onPress={press} />
        </>
      )}
    </>
  );

  if (compact) {
    return (
      <div className="pin-login-wrap compact-login">
        <div className="pin-status-row">
          <span className={`pin-status${online ? ' ok' : ' warn'}`}>
            <i className="pin-status-dot" />
            {online ? 'Cloud online' : 'Offline'}
          </span>
        </div>
        <div className="pin-sub">SWITCH CASHIER</div>
        {pinBody}
      </div>
    );
  }

  const kicker = mode === 'pin' ? 'Cashier unlock' : mode === 'setup' ? 'Till security' : challenge ? 'Identity check' : 'POS workspace';
  const title =
    mode === 'pin'
      ? 'Unlock with PIN'
      : mode === 'setup'
        ? 'Set your till PIN'
        : challenge
          ? 'Two-factor code'
          : 'Sign in to Preyone POS';
  const subtitle =
    mode === 'pin'
      ? 'Pick your name and enter your till PIN to open the register.'
      : mode === 'setup'
        ? 'A 4–8 digit PIN lets cashiers unlock the till without typing a password.'
        : challenge
          ? `Enter the 6-digit code sent to ${masked || 'your email'}.`
          : 'One Preyone account unlocks the till, stock and shift drawer — or use a cashier PIN for instant unlock.';

  return (
    <AuthFrame kicker={kicker} title={title} subtitle={subtitle} logoSrc={logoSrc}>
      {mode !== 'setup' && (
        <div className="auth-mode-tabs" role="tablist" aria-label="Sign-in method">
          <button type="button" role="tab" aria-selected={mode === 'sso'} className={mode === 'sso' || challenge ? 'on' : ''} onClick={() => setMode('sso')}>
            SSO email
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'pin'}
            className={mode === 'pin' ? 'on' : ''}
            onClick={() => {
              setMode('pin');
              setChallenge(null);
            }}
          >
            Cashier PIN
          </button>
        </div>
      )}

      <div className="pin-status-row auth-status-row">
        <span className={`pin-status${online ? ' ok' : ' warn'}`}>
          <i className="pin-status-dot" />
          {online ? 'Cloud online' : 'Offline'}
        </span>
        <span className={`pin-status${operators.length ? ' ok' : ''}`}>
          <i className="pin-status-dot" />
          {operators.length ? `${operators.length} PIN operator${operators.length === 1 ? '' : 's'}` : 'No PIN roster'}
        </span>
      </div>

      {notice && <div className="banner ok">{notice}</div>}
      {error && mode !== 'pin' && <div className="banner error">{error}</div>}

      {mode === 'sso' && (
        <form className="auth-form" onSubmit={submitSso} noValidate>
          {challenge ? (
            <label className="field">
              <span>6-digit code</span>
              <input
                className="input input-otp"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                required
              />
            </label>
          ) : (
            <>
              <label className="field">
                <span>Email</span>
                <input
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                />
              </label>
              <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
            </>
          )}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : challenge ? 'Verify code' : 'Sign in'}
          </button>
          {challenge && (
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                setChallenge(null);
                setOtp('');
              }}
            >
              Back
            </button>
          )}
        </form>
      )}

      {mode === 'pin' && <div className="auth-pin-block">{pinBody}</div>}

      {mode === 'setup' && pendingUser && (
        <form className="auth-form" onSubmit={savePin}>
          <p className="auth-hint">Signed in as {pendingUser.fullName}. Create a PIN for fast unlock next time.</p>
          <label className="field">
            <span>New PIN (4–8 digits)</span>
            <input
              className="input input-otp"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric"
              autoComplete="new-password"
              required
            />
          </label>
          <label className="field">
            <span>Confirm PIN</span>
            <input
              className="input input-otp"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric"
              autoComplete="new-password"
              required
            />
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save till PIN'}
          </button>
          <button className="btn ghost" type="button" onClick={skipPin} disabled={busy}>
            Skip for now
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
