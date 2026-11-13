import { useCallback, useEffect, useState } from 'react';
import { accounting, auth, login, type AuthUser, ApiError } from './api';

const money = (n?: number) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Tab = 'overview' | 'ledger' | 'pesepay' | 'tax';

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(auth.user());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Record<string, any> | null>(null);
  const [pnl, setPnl] = useState<Record<string, any> | null>(null);
  const [ledger, setLedger] = useState<any[]>([]);
  const [tax, setTax] = useState<Record<string, any> | null>(null);

  const full = user?.role === 'CEO' || user?.role === 'Manager' || user?.role === 'Admin';

  const load = useCallback(async () => {
    if (!user) return;
    setError('');
    try {
      const o = await accounting.overview();
      setOverview(o);
      if (full) {
        const [p, l, t] = await Promise.all([
          accounting.pnl(),
          accounting.ledger(150),
          accounting.taxSummary(),
        ]);
        setPnl(p);
        setLedger(l.rows || []);
        setTax(t);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        auth.clear();
        setUser(null);
      }
      setError((e as Error).message);
    }
  }, [user, full]);

  useEffect(() => {
    load();
  }, [load]);

  const onLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await login(email.trim(), password);
      auth.save(res.token, res.user);
      setUser(res.user);
    } catch (err) {
      setError((err as Error).message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <div className="shell login-shell">
        <form className="login-card" onSubmit={onLogin}>
          <div className="brand">PREYONE</div>
          <h1>Invoice · Accounting</h1>
          <p className="muted">Sign in with your Preyone admin account</p>
          {error && <div className="error">{error}</div>}
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="top">
        <div>
          <div className="brand">PREYONE INVOICE</div>
          <div className="sub">Accounting &amp; Finance</div>
        </div>
        <div className="spacer" />
        <span className="chip">{user.fullName} · {user.role}</span>
        <button
          className="ghost"
          onClick={() => {
            auth.clear();
            setUser(null);
          }}
        >
          Sign out
        </button>
      </header>

      {error && <div className="error banner">{error}</div>}

      <section className="kpis">
        <div className="kpi">
          <span>Today&apos;s Till</span>
          <strong>{money(overview?.todayTill)}</strong>
        </div>
        {full ? (
          <>
            <div className="kpi emerald">
              <span>Gross Profit</span>
              <strong>{money(overview?.grossProfit)}</strong>
            </div>
            <div className="kpi">
              <span>MTD Revenue</span>
              <strong>{money(overview?.mtdRevenue)}</strong>
            </div>
            <div className="kpi amber">
              <span>Outstanding AR</span>
              <strong>{money(overview?.outstandingAr)}</strong>
            </div>
          </>
        ) : (
          <>
            <div className="kpi emerald">
              <span>Cash</span>
              <strong>{money(overview?.cashTotal)}</strong>
            </div>
            <div className="kpi amber">
              <span>Pesepay</span>
              <strong>{money(overview?.pesepayTotal)}</strong>
            </div>
          </>
        )}
      </section>

      {full && (
        <>
          <nav className="tabs">
            <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>Overview &amp; P&amp;L</button>
            <button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>General Ledger</button>
            <button className={tab === 'pesepay' ? 'on' : ''} onClick={() => setTab('pesepay')}>Pesepay Rail Reconciliation</button>
            <button className={tab === 'tax' ? 'on' : ''} onClick={() => setTab('tax')}>Tax &amp; VAT Reports</button>
            <button className="ghost" onClick={load}>Refresh</button>
          </nav>

          {tab === 'overview' && pnl && (
            <div className="panel">
              {[
                ['Gross Revenue', pnl.grossRevenue],
                ['Credit Notes', pnl.creditNotes],
                ['Net Sales', pnl.netSales],
                ['Tax Collected', pnl.taxCollected],
                ['COGS', pnl.cogs],
                ['Gross Profit', pnl.grossProfit],
                ['Operating Profit', pnl.operatingProfit],
              ].map(([label, val]) => (
                <div className="row" key={String(label)}>
                  <span>{label}</span>
                  <strong>{money(Number(val))}</strong>
                </div>
              ))}
            </div>
          )}

          {tab === 'ledger' && (
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr><th>When</th><th>Type</th><th>Rail</th><th>Doc</th><th>Gross</th><th>VAT</th></tr>
                </thead>
                <tbody>
                  {ledger.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.occurred_at).toLocaleString()}</td>
                      <td>{r.entry_type}</td>
                      <td>{r.rail}</td>
                      <td>{r.doc_number || '—'}</td>
                      <td>{money(r.gross_amount)}</td>
                      <td>{money(r.tax_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'pesepay' && (
            <div className="kpis">
              {['ecocash', 'omari', 'innbucks', 'paygo', 'pesepay'].map((rail) => (
                <div className="kpi" key={rail}>
                  <span>{rail.toUpperCase()}</span>
                  <strong>{money(overview?.byRail?.[rail])}</strong>
                </div>
              ))}
            </div>
          )}

          {tab === 'tax' && tax && (
            <div className="kpis">
              <div className="kpi">
                <span>POS Receipts VAT</span>
                <strong>{money(tax.posReceipts?.vat)}</strong>
              </div>
              <div className="kpi">
                <span>Tax Invoice VAT</span>
                <strong>{money(tax.taxInvoices?.vat)}</strong>
              </div>
              <div className="kpi amber">
                <span>Total VAT Liability</span>
                <strong>{money(tax.totalVatLiability)}</strong>
              </div>
            </div>
          )}
        </>
      )}

      {!full && (
        <p className="muted center">Cashier view — till drawer totals only. Ask a Manager/CEO for the full ledger.</p>
      )}
    </div>
  );
}
