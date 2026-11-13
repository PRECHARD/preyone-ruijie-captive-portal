import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type StaffUser, type TillOperator } from '../api';

/**
 * Till access terminal.
 *
 * `page` is the full first-run surface: brand story, live terminal status and
 * the keypad. `modal` is the compact hand-over variant used while switching
 * cashier, so the same PIN rules apply without remounting the whole shell.
 */
export default function PinLogin({
  onLoggedIn,
  variant = 'page',
}: {
  onLoggedIn: (token: string, user: StaffUser) => void;
  variant?: 'page' | 'modal';
}) {
  const [operators, setOperators] = useState<TillOperator[]>([]);
  const [operator, setOperator] = useState<TillOperator | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const loadOperators = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    api
      .tillOperators()
      .then((rows) => {
        setOperators(rows);
        if (rows.length === 0) {
          setLoadErr('No till operators registered. Ask an admin to add staff and set a PIN.');
        }
      })
      .catch(() => setLoadErr('Could not load till operators. Check the connection and retry.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadOperators();
  }, [loadOperators]);

  // A live clock makes the screen feel like a terminal rather than a web form,
  // and confirms the device time used on printed receipts.
  useEffect(() => {
    if (variant !== 'page') return;
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [variant]);

  const submit = useCallback(
    async (code: string) => {
      if (!operator || busy) return;
      setBusy(true);
      setError('');
      try {
        const res = await api.loginPin(operator.id, code);
        onLoggedIn(res.token, res.user);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Sign-in failed');
        setPin('');
      } finally {
        setBusy(false);
      }
    },
    [operator, busy, onLoggedIn]
  );

  const press = useCallback(
    (key: string) => {
      if (busy || !operator) return;
      if (key === '←') {
        setPin((p) => p.slice(0, -1));
        return;
      }
      if (key === 'OK') {
        if (pin.length >= 4) void submit(pin);
        return;
      }
      setPin((p) => (p + key).slice(0, 8));
    },
    [busy, operator, pin, submit]
  );

  // Physical keyboards are common at the till (USB numpad or laptop).
  useEffect(() => {
    if (variant !== 'page' || !operator) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        press(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        press('←');
      } else if (event.key === 'Enter') {
        event.preventDefault();
        press('OK');
      } else if (event.key === 'Escape') {
        setOperator(null);
        setPin('');
        setError('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [variant, operator, press]);

  const backToPicker = () => {
    setOperator(null);
    setPin('');
    setError('');
  };

  const slots = Math.max(4, pin.length || 4);
  const initials = useMemo(() => {
    if (!operator) return '';
    const parts = operator.full_name.trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : operator.full_name.slice(0, 2)).toUpperCase();
  }, [operator]);

  const body = (
    <>
      {loadErr && (
        <div className="pin-alert">
          <span>{loadErr}</span>
          <button type="button" className="pin-retry" onClick={loadOperators} disabled={loading}>
            {loading ? 'Loading…' : 'Retry'}
          </button>
        </div>
      )}

      {!operator ? (
        <>
          <div className="pin-step">
            <span className="pin-step-num">01</span>
            <div>
              <strong>Who is on the till?</strong>
              <span>Select your operator profile to continue.</span>
            </div>
          </div>
          <div className="op-list">
            {loading && operators.length === 0 && (
              <>
                {[0, 1, 2].map((i) => (
                  <span key={i} className="op-skeleton" aria-hidden />
                ))}
              </>
            )}
            {operators.map((op) => (
              <button key={op.id} className="op-btn" onClick={() => setOperator(op)}>
                <span className="op-avatar" aria-hidden>
                  {op.full_name
                    .trim()
                    .split(/\s+/)
                    .map((p) => p[0])
                    .slice(0, 2)
                    .join('')
                    .toUpperCase()}
                </span>
                <span className="op-meta">
                  <strong>{op.full_name}</strong>
                  <span>{op.role || 'Till operator'}</span>
                </span>
                <span className="op-arrow" aria-hidden>→</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="pin-operator">
            <span className="op-avatar op-avatar--lg" aria-hidden>{initials}</span>
            <div className="pin-operator-meta">
              <span className="pin-step-label">PIN required</span>
              <strong>{operator.full_name}</strong>
            </div>
            <button className="op-change-btn" type="button" onClick={backToPicker} disabled={busy}>
              Change
            </button>
          </div>

          <div className="pin-dots" role="status" aria-label={`${pin.length} of at least 4 digits entered`}>
            {Array.from({ length: slots }, (_, i) => (
              <span key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
            ))}
          </div>
          {error && <div className="pin-error" role="alert">{error}</div>}

          <div className="pin-pad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '←', '0', 'OK'].map((key) => (
              <button
                key={key}
                type="button"
                className={key === 'OK' ? 'pin-key pin-key--ok' : key === '←' ? 'pin-key pin-key--alt' : 'pin-key'}
                disabled={busy}
                onClick={() => press(key)}
                aria-label={key === '←' ? 'Delete last digit' : key === 'OK' ? 'Sign in' : key}
              >
                {busy && key === 'OK' ? <span className="pin-spinner" aria-hidden /> : key}
              </button>
            ))}
          </div>
          <p className="pin-foot">Enter your PIN, then press OK. Use the keypad or a USB keyboard.</p>
        </>
      )}
    </>
  );

  if (variant === 'modal') {
    return <div className="pin-modal">{body}</div>;
  }

  return (
    <div className="pin-shell">
      <aside className="pin-hero">
        <div className="pin-brand">
          <span className="pin-brand-logo">
            <img src="/Preyone.svg" alt="Preyone" />
          </span>
          <span className="pin-brand-tag">POS · Enterprise till</span>
        </div>

        <div className="pin-hero-copy">
          <span className="pin-eyebrow"><i aria-hidden /> Terminal online</span>
          <h1>Sell faster.<br />Close the day clean.</h1>
          <p>One shared ledger for the till, invoices, stock and shifts — settled the moment you take payment.</p>
        </div>

        <div className="pin-stats">
          <div>
            <span>Local time</span>
            <strong>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong>
          </div>
          <div>
            <span>Date</span>
            <strong>{now.toLocaleDateString([], { day: '2-digit', month: 'short' })}</strong>
          </div>
          <div>
            <span>Terminal</span>
            <strong>WEB-01</strong>
          </div>
        </div>

        <div className="pin-hero-foot">
          <span>Secure PIN session · per-device</span>
          <span>preyone.com</span>
        </div>
      </aside>

      <main className="pin-card-wrap">
        <section className="pin-card">
          <span className="pin-card-logo">
            <img src="/Preyone.svg" alt="Preyone" />
          </span>
          <div className="pin-card-head">
            <span className="pin-card-kicker">Access terminal</span>
            <span className="pin-card-chip">Shift required</span>
          </div>
          <h2>Sign in</h2>
          <p className="pin-card-sub">Choose your profile, then enter your PIN.</p>
          {body}
        </section>
        <p className="pin-legal">Need a PIN or a new profile? Ask your store manager.</p>
      </main>
    </div>
  );
}
