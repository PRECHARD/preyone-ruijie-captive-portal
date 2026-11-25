import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type StaffUser, type TillOperator } from '../api';
import ThemeToggle from './ThemeToggle';

const TENANT_KEY = 'pos_tenant';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storedTenant(): string {
  try {
    const value = localStorage.getItem(TENANT_KEY) || '';
    return UUID_RE.test(value) ? value : '';
  } catch {
    return '';
  }
}

export default function PinLogin({ onLoggedIn }: { onLoggedIn: (token: string, user: StaffUser) => void }) {
  const [operators, setOperators] = useState<TillOperator[]>([]);
  const [operator, setOperator] = useState<TillOperator | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  // Tenant hint. The roster endpoint is pre-auth, so the till proves which
  // company it belongs to with this id (or the server's single-tenant fallback).
  const [tenant, setTenant] = useState(storedTenant);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupCode, setSetupCode] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

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
    setLoadErr('');
    api
      .tillOperators(tenant || undefined)
      .then((res) => {
        if (!alive) return;
        setSetupOpen(false);
        setOperators(res.operators);
        if (res.companyId && res.companyId !== tenant) {
          try {
            localStorage.setItem(TENANT_KEY, res.companyId);
          } catch {
            /* private mode: the query param still scopes this session */
          }
          setTenant(res.companyId);
        }
        if (res.operators.length === 0) {
          setLoadErr('No till operators registered. Ask an admin to add staff and set a PIN.');
        }
      })
      .catch((e) => {
        if (!alive) return;
        setOperators([]);
        if (e instanceof ApiError && e.status === 400) {
          setSetupOpen(true);
          setLoadErr('Link this till to your company before selecting an operator.');
        } else {
          setLoadErr('Could not load till operators. Check the connection.');
        }
      });
    return () => {
      alive = false;
    };
  }, [tenant, reloadKey]);

  const connectTill = (e: FormEvent) => {
    e.preventDefault();
    const code = setupCode.trim();
    if (!UUID_RE.test(code)) {
      setLoadErr('That till code is not valid. Copy it from Invoice → Settings → Client Tenants.');
      return;
    }
    try {
      localStorage.setItem(TENANT_KEY, code);
    } catch {
      /* private mode: keep the in-memory value */
    }
    setTenant(code);
    setSetupOpen(false);
    setSetupCode('');
    setReloadKey((n) => n + 1);
  };

  const submit = async (code: string) => {
    if (!operator) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.loginPin(operator.id, code, tenant || undefined);
      onLoggedIn(res.token, res.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
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
      if (pin.length >= 4) void submit(pin);
      return;
    }
    setPin((pin + key).slice(0, 8));
  };

  const backToPicker = () => {
    setOperator(null);
    setPin('');
    setError('');
  };

  return (
    <div className="pin-login-screen">
      <ThemeToggle className="pin-theme-toggle" />
      <div className="pin-login-glass">
        <div className="pin-status-row" aria-live="polite">
          <span className={`pin-status${online ? ' ok' : ' warn'}`}>
            <i className="pin-status-dot" />
            {online ? 'Cloud online' : 'Offline'}
          </span>
          <span className={`pin-status${operators.length ? ' ok' : loadErr ? ' warn' : ''}`}>
            <i className="pin-status-dot" />
            {operators.length ? `${operators.length} operator${operators.length === 1 ? '' : 's'}` : loadErr ? 'No roster' : 'Loading…'}
          </span>
        </div>

        <img
          src="/images/preyonelogomainzw-email.png"
          alt="Preyone"
          className="pin-logo"
          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
        />
        <div className="pin-brand">PREYONE</div>
        <div className="pin-sub">POINT OF SALE</div>

        {setupOpen && (
          <form className="pin-setup" onSubmit={connectTill}>
            <div className="pin-hint">Till setup</div>
            <p className="pin-setup-copy">
              Enter the company till code. The house CEO can copy it from Invoice → Settings →
              Client Tenants.
            </p>
            <input
              className="pin-setup-input"
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Company till code"
            />
            <button type="submit" className="pin-setup-btn">
              Link this till
            </button>
          </form>
        )}

        {loadErr && !setupOpen && <div className="err-msg">{loadErr}</div>}

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
            <button
              type="button"
              className="pin-change-tenant"
              onClick={() => {
                setSetupCode(tenant);
                setSetupOpen(true);
              }}
            >
              Company till code
            </button>
            <a
              className="pin-recover"
              href="https://invoice.preyone.com/?recover=1"
              target="_blank"
              rel="noreferrer"
            >
              Forgot password?
            </a>
          </>
        ) : (
          <>
            <button type="button" className="op-selected" onClick={backToPicker}>
              {operator.full_name} <span className="op-change">(change)</span>
            </button>
            <div className="pin-dots">
              {Array.from({ length: Math.max(4, pin.length || 4) }, (_, i) => (
                <span key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
              ))}
            </div>
            {error && <div className="err-msg">{error}</div>}
            <div className="pin-pad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '←', '0', 'OK'].map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={busy}
                  onClick={() => press(k)}
                  className={k === 'OK' ? 'pin-ok' : undefined}
                >
                  {k}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
