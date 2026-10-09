import { useEffect, useState } from 'react';
import { api, type StaffUser, type TillOperator } from '../api';

export default function PinLogin({ onLoggedIn }: { onLoggedIn: (token: string, user: StaffUser) => void }) {
  const [operators, setOperators] = useState<TillOperator[]>([]);
  const [operator, setOperator] = useState<TillOperator | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .tillOperators()
      .then((rows) => {
        if (!alive) return;
        setOperators(rows);
        if (rows.length === 0) setLoadErr('No till operators registered. Ask an admin to add staff and set a PIN.');
      })
      .catch(() => alive && setLoadErr('Could not load till operators. Check the connection.'));
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (code: string) => {
    if (!operator) return;
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
  };

  const press = (key: string) => {
    if (busy) return;
    if (key === '←') {
      setPin((p) => p.slice(0, -1));
      return;
    }
    if (key === 'OK') {
      if (pin.length >= 4) submit(pin);
      return;
    }
    const next = (pin + key).slice(0, 8);
    setPin(next);
  };

  const backToPicker = () => {
    setOperator(null);
    setPin('');
    setError('');
  };

  return (
    <div className="pin-login-wrap">
      <img src="/Preyone.svg" alt="Preyone" className="pin-logo" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
      <div className="pin-sub">POINT OF SALE</div>

      {loadErr && <div className="err-msg">{loadErr}</div>}

      {!operator ? (
        <>
          <div className="pin-hint">Select your name</div>
          <div className="op-list">
            {operators.map((op) => (
              <button key={op.id} className="op-btn" onClick={() => setOperator(op)}>
                {op.full_name}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <button className="op-selected" onClick={backToPicker}>
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
                disabled={busy}
                onClick={() => press(k)}
                style={k === 'OK' ? { backgroundImage: 'var(--grad-brand)', color: '#fff', border: 'none' } : undefined}
              >
                {k}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}