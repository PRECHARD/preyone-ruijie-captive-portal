import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, clearToken, dateLabel, getToken, money, setToken } from './api';

type Me = {
  user: {
    id: string; username: string; fullName: string; role: string;
    phone: string; email: string; status: string; createdAt: string;
  };
  company: {
    id: string; name: string; currency: string; logoUrl: string;
    customerCare: string; minAppVersion: string;
  };
};

type Device = {
  id: string; deviceUuid: string; status: string; model: string; appVersion: string;
  lastSeen: string | null; offlineAuthorizationExpiresAt: string | null; minAppVersion: string;
};

type Shift = {
  id: string; vehicleReg: string; driverName: string; conductorName: string;
  status: string; ticketCount: number; totalCents: number; startedAt: string; closedAt: string | null;
};

type Trip = {
  id: string; tripNo: string; routeCode: string; routeFrom: string; routeTo: string;
  routeName: string; busReg: string; driver: string; status: string;
  totalSeats: number; seatsSold: number; openedAt: string; closedAt: string | null;
};

type Sales = {
  summary: { totalCount: number; totalCents: number };
  byType: Record<string, { count: number; cents: number }>;
};

type ManifestRow = {
  txId: string; receiptNo: string; seat: string; passenger: string; mobile: string;
  totalCents: number; paymentMethod: string; ticketType: string; saleTime: string; syncedAt: string;
};

const TABS = ['Overview', 'Profile', 'Shifts', 'Trips', 'Sales', 'Devices', 'Manifest'] as const;
type Tab = (typeof TABS)[number];

function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    setError('');
    api<T>(path)
      .then((value) => { if (alive) setData(value); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : 'Request failed'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

function ErrorBox({ message }: { message: string }) {
  return message ? <div className="alert">{message}</div> : null;
}

function AuthScreen({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<'signin' | 'setup'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (mode === 'signin') {
        const res = await api<{ sessionToken: string }>('/api/transit/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        setToken(res.sessionToken);
        onLogin();
      } else {
        const res = await api<{ message: string }>('/api/transit/portal/auth/request-setup', {
          method: 'POST',
          body: JSON.stringify({ identifier }),
        });
        setNotice(res.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">Preyone <span>Transit</span></div>
        <h1>{mode === 'signin' ? 'Staff sign in' : 'Set up your password'}</h1>
        <p className="muted">
          {mode === 'signin'
            ? 'Use the username and password issued by your operator.'
            : 'Enter the email on your staff record. We will send a one-time setup link.'}
        </p>
        <form onSubmit={submit}>
          {mode === 'signin' ? (
            <>
              <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" /></label>
              <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></label>
            </>
          ) : (
            <label>Email or phone<input value={identifier} onChange={(e) => setIdentifier(e.target.value)} required /></label>
          )}
          <ErrorBox message={error} />
          {notice && <div className="success">{notice}</div>}
          <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Send setup link'}</button>
        </form>
        <button className="link" onClick={() => { setMode(mode === 'signin' ? 'setup' : 'signin'); setError(''); setNotice(''); }}>
          {mode === 'signin' ? 'Forgot or need to set a password?' : 'Back to sign in'}
        </button>
        <a className="link" href="/set-password">I have a setup link</a>
      </div>
    </div>
  );
}

function SetPasswordPage() {
  const token = useMemo(() => new URLSearchParams(location.search).get('token') || '', []);
  const verify = useFetch<{ valid: boolean; fullName: string; companyName: string }>(
    token ? `/api/transit/portal/auth/verify-setup?token=${encodeURIComponent(token)}` : null
  );
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/transit/portal/auth/set-password', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">Preyone <span>Transit</span></div>
        <h1>Set your password</h1>
        {verify.loading && <p className="muted">Checking your link…</p>}
        <ErrorBox message={verify.error || error} />
        {done ? (
          <>
            <div className="success">Password set. You can now sign in.</div>
            <a className="primary button-link" href="/">Go to sign in</a>
          </>
        ) : verify.data?.valid ? (
          <>
            <p className="muted">Hello {verify.data.fullName || 'there'} — choose a password for {verify.data.companyName}.</p>
            <form onSubmit={submit}>
              <label>New password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></label>
              <label>Confirm password<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} /></label>
              <p className="hint">At least 8 characters with uppercase, lowercase, a number and a symbol.</p>
              <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
            </form>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Overview({ me }: { me: Me }) {
  const sales = useFetch<Sales>('/api/transit/portal/sales');
  const devices = useFetch<{ devices: Device[] }>('/api/transit/portal/devices');
  return (
    <section>
      <div className="page-title">
        <h2>Overview</h2>
        <p className="muted">Welcome back, {me.user.fullName || me.user.username}.</p>
      </div>
      <div className="cards">
        <div className="card"><span>Tickets sold (all time)</span><strong>{sales.data?.summary.totalCount ?? '—'}</strong></div>
        <div className="card"><span>Sales total</span><strong>{sales.data ? money(sales.data.summary.totalCents, me.company.currency) : '—'}</strong></div>
        <div className="card"><span>Bound devices</span><strong>{devices.data?.devices.length ?? '—'}</strong></div>
        <div className="card"><span>Required app</span><strong>{me.company.minAppVersion || 'Any'}</strong></div>
      </div>
      <ErrorBox message={sales.error || devices.error} />
      <div className="card wide">
        <h3>Need help?</h3>
        <p className="muted">Care line: {me.company.customerCare || 'Not set'}. Your phone can stay on the current app version — password and profile changes happen here.</p>
      </div>
    </section>
  );
}

function Profile({ me, onUpdated }: { me: Me; onUpdated: () => void }) {
  const [fullName, setFullName] = useState(me.user.fullName);
  const [phone, setPhone] = useState(me.user.phone);
  const [email, setEmail] = useState(me.user.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/transit/portal/me', {
        method: 'PATCH',
        body: JSON.stringify({ fullName, phone, email }),
      });
      setNotice('Profile saved.');
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save profile');
    } finally { setBusy(false); }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/transit/portal/me/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setNotice('Password updated.');
      setCurrentPassword(''); setNewPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change password');
    } finally { setBusy(false); }
  };

  return (
    <section>
      <div className="page-title"><h2>My profile</h2><p className="muted">Username: {me.user.username} · Role: {me.user.role}</p></div>
      <ErrorBox message={error} />
      {notice && <div className="success">{notice}</div>}
      <div className="card wide">
        <h3>Details</h3>
        <form onSubmit={save}>
          <label>Full name<input value={fullName} onChange={(e) => setFullName(e.target.value)} /></label>
          <label>Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
          <p className="hint">Add an email to request password setup links from the app without calling your operator.</p>
          <button className="primary" disabled={busy}>Save profile</button>
        </form>
      </div>
      <div className="card wide">
        <h3>Change password</h3>
        <form onSubmit={changePassword}>
          <label>Current password<input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required /></label>
          <label>New password<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} /></label>
          <button className="primary" disabled={busy}>Update password</button>
        </form>
      </div>
    </section>
  );
}

function Shifts() {
  const { data, error, loading } = useFetch<{ shifts: Shift[] }>('/api/transit/portal/shifts');
  return (
    <section>
      <div className="page-title"><h2>My shifts</h2></div>
      {loading && <p className="muted">Loading…</p>}
      <ErrorBox message={error} />
      <div className="card wide table-wrap">
        <table><thead><tr><th>Vehicle</th><th>Driver</th><th>Status</th><th>Tickets</th><th>Total</th><th>Started</th><th>Closed</th></tr></thead>
          <tbody>{(data?.shifts || []).map((s) => (
            <tr key={s.id}><td>{s.vehicleReg || '—'}</td><td>{s.driverName || '—'}</td><td><span className="pill">{s.status}</span></td><td>{s.ticketCount}</td><td>{money(s.totalCents)}</td><td>{dateLabel(s.startedAt)}</td><td>{dateLabel(s.closedAt)}</td></tr>
          ))}</tbody></table>
      </div>
    </section>
  );
}

function Trips() {
  const { data, error, loading } = useFetch<{ trips: Trip[] }>('/api/transit/portal/trips');
  return (
    <section>
      <div className="page-title"><h2>My trips</h2></div>
      {loading && <p className="muted">Loading…</p>}
      <ErrorBox message={error} />
      <div className="card wide table-wrap">
        <table><thead><tr><th>Trip</th><th>Route</th><th>Bus</th><th>Status</th><th>Seats</th><th>Opened</th></tr></thead>
          <tbody>{(data?.trips || []).map((t) => (
            <tr key={t.id}><td>{t.tripNo}</td><td>{t.routeFrom || t.routeCode} → {t.routeTo || t.routeName}</td><td>{t.busReg || '—'}</td><td><span className="pill">{t.status}</span></td><td>{t.seatsSold}/{t.totalSeats}</td><td>{dateLabel(t.openedAt)}</td></tr>
          ))}</tbody></table>
      </div>
    </section>
  );
}

function Sales({ currency }: { currency: string }) {
  const { data, error, loading } = useFetch<Sales>('/api/transit/portal/sales');
  return (
    <section>
      <div className="page-title"><h2>My sales</h2></div>
      {loading && <p className="muted">Loading…</p>}
      <ErrorBox message={error} />
      <div className="cards">
        <div className="card"><span>Tickets</span><strong>{data?.summary.totalCount ?? '—'}</strong></div>
        <div className="card"><span>Revenue</span><strong>{data ? money(data.summary.totalCents, currency) : '—'}</strong></div>
      </div>
      <div className="card wide table-wrap">
        <table><thead><tr><th>Type</th><th>Tickets</th><th>Revenue</th></tr></thead>
          <tbody>{Object.entries(data?.byType || {}).map(([key, value]) => (
            <tr key={key}><td>{key === 'luggage' ? 'Luggage' : 'Bus fare'}</td><td>{value.count}</td><td>{money(value.cents, currency)}</td></tr>
          ))}</tbody></table>
      </div>
    </section>
  );
}

function Devices({ minAppVersion }: { minAppVersion: string }) {
  const { data, error, loading } = useFetch<{ devices: Device[] }>('/api/transit/portal/devices');
  return (
    <section>
      <div className="page-title"><h2>My devices</h2><p className="muted">One account, one bound device. Ask your operator to reset binding if your phone changed.</p></div>
      {loading && <p className="muted">Loading…</p>}
      <ErrorBox message={error} />
      {minAppVersion && <div className="success">Required app version: {minAppVersion}</div>}
      <div className="card wide table-wrap">
        <table><thead><tr><th>Device</th><th>Status</th><th>App</th><th>Offline until</th><th>Last seen</th></tr></thead>
          <tbody>{(data?.devices || []).map((d) => (
            <tr key={d.id}><td>{d.deviceUuid}</td><td><span className="pill">{d.status}</span></td><td>{d.appVersion || '—'}</td><td>{dateLabel(d.offlineAuthorizationExpiresAt)}</td><td>{dateLabel(d.lastSeen)}</td></tr>
          ))}</tbody></table>
      </div>
    </section>
  );
}

function Manifest() {
  const [tripNo, setTripNo] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const { data, error, loading } = useFetch<{ tickets: ManifestRow[] }>(query ? `/api/transit/portal/manifest/${encodeURIComponent(query)}` : null);

  return (
    <section>
      <div className="page-title"><h2>Trip manifest</h2><p className="muted">Enter a trip number to see tickets sold on that trip.</p></div>
      <form className="search" onSubmit={(e) => { e.preventDefault(); setQuery(tripNo.trim()); }}>
        <input value={tripNo} onChange={(e) => setTripNo(e.target.value)} placeholder="e.g. TRIP-1042" required />
        <button className="primary">Look up</button>
      </form>
      {loading && <p className="muted">Loading…</p>}
      <ErrorBox message={error} />
      {query && (
        <div className="card wide table-wrap">
          <table><thead><tr><th>Receipt</th><th>Seat</th><th>Passenger</th><th>Mobile</th><th>Type</th><th>Amount</th></tr></thead>
            <tbody>{(data?.tickets || []).map((t) => (
              <tr key={t.txId}><td>{t.receiptNo}</td><td>{t.seat || '—'}</td><td>{t.passenger}</td><td>{t.mobile || '—'}</td><td>{t.ticketType === 'luggage' ? 'LUGGAGE ONLY' : 'BUS TICKET'}</td><td>{money(t.totalCents)}</td></tr>
            ))}</tbody></table>
        </div>
      )}
    </section>
  );
}

function Portal({ me, onLogout, onUpdated }: { me: Me; onLogout: () => void; onUpdated: () => void }) {
  const [tab, setTab] = useState<Tab>('Overview');
  return (
    <div className="shell">
      <aside>
        <div className="brand">Preyone <span>Transit</span></div>
        <div className="who">
          <strong>{me.user.fullName || me.user.username}</strong>
          <small>{me.company.name}</small>
        </div>
        <nav>
          {TABS.map((item) => (
            <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>
          ))}
        </nav>
        <button className="logout" onClick={onLogout}>Sign out</button>
      </aside>
      <main>
        {tab === 'Overview' && <Overview me={me} />}
        {tab === 'Profile' && <Profile me={me} onUpdated={onUpdated} />}
        {tab === 'Shifts' && <Shifts />}
        {tab === 'Trips' && <Trips />}
        {tab === 'Sales' && <Sales currency={me.company.currency} />}
        {tab === 'Devices' && <Devices minAppVersion={me.company.minAppVersion} />}
        {tab === 'Manifest' && <Manifest />}
      </main>
    </div>
  );
}

function App() {
  const [path, setPath] = useState(location.pathname);
  const [token, setTokenState] = useState(getToken());
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const refreshMe = useCallback(() => {
    if (!getToken()) { setMe(null); return; }
    setLoading(true); setError('');
    api<Me>('/api/transit/portal/me')
      .then(setMe)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load your account');
        if (err instanceof ApiError && err.status === 401) {
          clearToken(); setTokenState(''); setMe(null);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (token) refreshMe(); }, [token, refreshMe]);

  if (path === '/set-password') return <SetPasswordPage />;

  if (!token) return <AuthScreen onLogin={() => setTokenState(getToken())} />;

  if (loading && !me) return <div className="auth-page"><div className="auth-card"><p className="muted">Loading your portal…</p></div></div>;

  if (error && !me) return (
    <div className="auth-page"><div className="auth-card"><ErrorBox message={error} /><button className="primary" onClick={() => { clearToken(); setTokenState(''); setError(''); }}>Sign in again</button></div></div>
  );

  if (!me) return null;

  return (
    <Portal
      me={me}
      onLogout={() => { clearToken(); setTokenState(''); setMe(null); }}
      onUpdated={refreshMe}
    />
  );
}

export default App;
