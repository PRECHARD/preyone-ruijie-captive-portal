import { useCallback, useEffect, useState } from 'react';
import { accountingApi, type StaffUser } from '../api';

interface Overview {
  role?: string;
  todayTill?: number;
  totalGrossRevenue?: number;
  netSales?: number;
  taxCollected?: number;
  grossProfit?: number;
  outstandingAr?: number;
  mtdRevenue?: number;
  cashTotal?: number;
  pesepayTotal?: number;
  byRail?: Record<string, number>;
  stockValuation?: number;
  vatRate?: number;
}

interface LedgerRow {
  id: string;
  occurred_at: string;
  entry_type: string;
  rail: string;
  doc_number?: string;
  gross_amount: number;
  tax_amount: number;
  net_amount: number;
}

const money = (n?: number) => `$${(Number(n) || 0).toFixed(2)}`;

export default function AccountingView({
  user,
  notify,
  onApiError,
}: {
  user: StaffUser;
  notify: (msg: string, kind?: 'ok' | 'error') => void;
  onApiError: (e: unknown) => boolean;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [tab, setTab] = useState<'overview' | 'ledger' | 'rails' | 'tax'>('overview');
  const [loading, setLoading] = useState(true);
  const full = user.role === 'CEO' || user.role === 'Manager' || user.role === 'Admin';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const o = await accountingApi.overview();
      setOverview(o);
      if (full) {
        const l = await accountingApi.ledger({ limit: 100 });
        setLedger(l.rows || []);
      }
    } catch (e) {
      if (!onApiError(e)) notify((e as Error).message || 'Failed to load accounting', 'error');
    } finally {
      setLoading(false);
    }
  }, [full, notify, onApiError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="acct-view">
      <div className="acct-view-head">
        <div>
          <h2 className="acct-view-title">Accounting &amp; Finance</h2>
          <p className="hint">
            {full ? 'Full enterprise ledger' : 'Till drawer summary'} · VAT {overview?.vatRate ?? 15.5}%
          </p>
        </div>
        <button className="chip ok" onClick={load}>Refresh</button>
      </div>

      {loading && <div className="empty-note">Loading accounting…</div>}

      {!loading && overview && (
        <>
          <div className="acct-kpi-row">
            <div className="acct-kpi-card">
              <span>Today&apos;s Till</span>
              <strong>{money(overview.todayTill)}</strong>
            </div>
            {full ? (
              <>
                <div className="acct-kpi-card emerald">
                  <span>Gross Profit</span>
                  <strong>{money(overview.grossProfit)}</strong>
                </div>
                <div className="acct-kpi-card">
                  <span>MTD Revenue</span>
                  <strong>{money(overview.mtdRevenue)}</strong>
                </div>
                <div className="acct-kpi-card amber">
                  <span>Outstanding AR</span>
                  <strong>{money(overview.outstandingAr)}</strong>
                </div>
              </>
            ) : (
              <>
                <div className="acct-kpi-card emerald">
                  <span>Cash</span>
                  <strong>{money(overview.cashTotal)}</strong>
                </div>
                <div className="acct-kpi-card amber">
                  <span>Pesepay</span>
                  <strong>{money(overview.pesepayTotal)}</strong>
                </div>
              </>
            )}
          </div>

          {full && (
            <>
              <div className="home-tabs" style={{ marginTop: 12 }}>
                <button className={`hist-tab${tab === 'overview' ? ' on' : ''}`} onClick={() => setTab('overview')}>Overview &amp; P&amp;L</button>
                <button className={`hist-tab${tab === 'ledger' ? ' on' : ''}`} onClick={() => setTab('ledger')}>General Ledger</button>
                <button className={`hist-tab${tab === 'rails' ? ' on' : ''}`} onClick={() => setTab('rails')}>Pesepay Rails</button>
                <button className={`hist-tab${tab === 'tax' ? ' on' : ''}`} onClick={() => setTab('tax')}>Tax &amp; VAT</button>
              </div>

              {tab === 'overview' && (
                <div className="acct-panel">
                  <div className="tot-row"><span>Gross Revenue</span><span>{money(overview.totalGrossRevenue)}</span></div>
                  <div className="tot-row"><span>Net Sales</span><span>{money(overview.netSales)}</span></div>
                  <div className="tot-row"><span>Tax Collected</span><span>{money(overview.taxCollected)}</span></div>
                  <div className="tot-row"><span>Stock Valuation</span><span>{money(overview.stockValuation)}</span></div>
                </div>
              )}

              {tab === 'ledger' && (
                <div className="acct-panel">
                  <table className="acct-mini-table">
                    <thead>
                      <tr><th>When</th><th>Type</th><th>Rail</th><th>Doc</th><th>Gross</th></tr>
                    </thead>
                    <tbody>
                      {ledger.map((r) => (
                        <tr key={r.id}>
                          <td>{new Date(r.occurred_at).toLocaleString()}</td>
                          <td>{r.entry_type}</td>
                          <td>{r.rail}</td>
                          <td>{r.doc_number || '—'}</td>
                          <td>{money(r.gross_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'rails' && (
                <div className="acct-kpi-row">
                  {['ecocash', 'omari', 'innbucks', 'paygo', 'pesepay'].map((rail) => (
                    <div key={rail} className="acct-kpi-card">
                      <span>{rail.toUpperCase()}</span>
                      <strong>{money(overview.byRail?.[rail])}</strong>
                    </div>
                  ))}
                </div>
              )}

              {tab === 'tax' && (
                <div className="acct-panel">
                  <div className="tot-row"><span>VAT rate</span><span>{overview.vatRate}%</span></div>
                  <div className="tot-row"><span>Tax collected (period)</span><span>{money(overview.taxCollected)}</span></div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
