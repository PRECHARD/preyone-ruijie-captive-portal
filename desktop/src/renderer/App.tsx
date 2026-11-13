import { FormEvent, useEffect, useState } from 'react';
import type { ShellSession } from '../shared/session';
import { upgradeCopy, type ModuleKey } from '../shared/plans';

type Screen = 'loading' | 'login' | 'home' | 'module' | 'upgrade';

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [session, setSession] = useState<ShellSession | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [deviceNotice, setDeviceNotice] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<ModuleKey | null>(null);
  const [upgrade, setUpgrade] = useState('');

  useEffect(() => {
    const offOnline = window.preyone.onOnline((up) => {
      setOnline(up);
      if (!up) {
        setOpenKey(null);
        setScreen((current) => (current === 'login' || current === 'loading' ? current : 'home'));
      }
    });
    const offDevice = window.preyone.onDeviceNotice(setDeviceNotice);
    window.preyone.retry().then(setOnline).catch(() => setOnline(false));
    window.preyone
      .restore()
      .then((restored) => {
        setSession(restored);
        setScreen(restored ? 'home' : 'login');
      })
      .catch(() => setScreen('login'));
    return () => {
      offOnline();
      offDevice();
    };
  }, []);

  async function onLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const next = await window.preyone.login(email, password);
      setSession(next);
      setPassword('');
      setScreen('home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  async function openModule(key: ModuleKey) {
    setError('');
    const result = await window.preyone.openModule(key);
    if (result.ok) {
      setOpenKey(key);
      setScreen('module');
      return;
    }
    if (result.reason === 'offline') {
      setOnline(false);
      return;
    }
    setUpgrade(result.message || upgradeCopy(key, session?.planName ?? null));
    setOpenKey(null);
    setScreen('upgrade');
  }

  async function goHome() {
    await window.preyone.goHome();
    setOpenKey(null);
    setScreen('home');
  }

  async function signOut() {
    await window.preyone.logout();
    setSession(null);
    setOpenKey(null);
    setDeviceNotice(null);
    setScreen('login');
  }

  const signedIn = screen !== 'loading' && screen !== 'login' && session;

  return (
    <div className="shell">
      {signedIn && (
        <header className="toolbar">
          <div className="brand">
            <img src="./logo.png" alt="" />
            Preyone
            {session.planName && <span className="plan">{session.planName}</span>}
          </div>
          <button type="button" aria-pressed={screen === 'home'} onClick={goHome}>
            Home
          </button>
          {session.tiles.map((tile) => (
            <button
              key={tile.key}
              type="button"
              aria-pressed={openKey === tile.key && screen === 'module'}
              onClick={() => openModule(tile.key)}
            >
              {tile.key === 'pos' ? 'POS' : 'Invoice'}
            </button>
          ))}
          <span className="spacer" />
          <span className={online ? 'dot on' : 'dot'} title={online ? 'Online' : 'Offline'} />
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </header>
      )}

      {screen === 'loading' && (
        <main className="stage">
          <p className="muted">Opening Preyone…</p>
        </main>
      )}

      {screen === 'login' && (
        <main className="stage">
          <form className="card center" onSubmit={onLogin}>
            <div className="brand">
              <img src="./logo.png" alt="" />
              <span>Preyone</span>
            </div>
            <p className="muted">Sign in once. Your plan decides whether you see POS, Invoice, or both.</p>
            <label>
              <span>Email</span>
              <input type="email" value={email} autoComplete="username" required onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              <span>Password</span>
              <input type="password" value={password} autoComplete="current-password" required onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <div className="error">{error}</div>}
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </main>
      )}

      {screen === 'home' && session && (
        <main className="stage">
          <h1>Your workspaces</h1>
          <p className="muted">{session.fullName} · {session.planName || 'No plan'}</p>
          {deviceNotice && <div className="notice">{deviceNotice}</div>}
          {session.tiles.length === 0 ? (
            <section className="card">
              <h2>Nothing is on this plan yet</h2>
              <p>Upgrade to PreTill for POS, or PreBiz for POS and Invoice.</p>
            </section>
          ) : (
            <div className="tiles">
              {session.tiles.map((tile) => (
                <button key={tile.key} className="tile" type="button" onClick={() => openModule(tile.key)}>
                  <strong>{tile.title}</strong>
                  <span>{tile.description}</span>
                </button>
              ))}
            </div>
          )}
        </main>
      )}

      {screen === 'upgrade' && (
        <main className="stage">
          <section className="card" style={{ maxWidth: 560 }}>
            <h2>Not on your plan</h2>
            <p>{upgrade}</p>
            <button className="primary" type="button" onClick={goHome}>
              Back to home
            </button>
          </section>
        </main>
      )}

      {!online && screen !== 'login' && screen !== 'loading' && (
        <div className="offline">
          <div>
            <h2>You are offline</h2>
            <p className="muted">Preyone keeps your sales on the server. Connect, then try again.</p>
            <button
              className="primary"
              type="button"
              onClick={async () => {
                const up = await window.preyone.retry();
                setOnline(up);
                if (up) {
                  setOpenKey(null);
                  setScreen('home');
                }
              }}
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
