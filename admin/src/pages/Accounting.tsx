import { useCallback, useEffect, useState } from 'react';
import { accountingApi, getToken } from '../api/client';
import { FiDownload, FiRefreshCw, FiTrendingUp, FiDollarSign, FiPercent, FiInbox } from 'react-icons/fi';
import './Accounting.css';

type Tab = 'overview' | 'ledger' | 'pesepay' | 'tax';

interface Overview {
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
  role?: string;
}

interface LedgerRow {
  id: string;
  occurred_at: string;
  entry_type: string;
  rail: string;
  doc_number?: string;
  description?: string;
  gross_amount: number;
  tax_amount: number;
  net_amount: number;
  cogs_amount: number;
  reference?: string;
}

interface PnL {
  grossRevenue: number;
  creditNotes: number;
  adjustedGross: number;
  taxCollected: number;
  netSales: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  operatingProfit: number;
  byChannel?: Record<string, number>;
}

interface TaxSummary {
  vatRate: number;
  posReceipts: { gross: number; vat: number; net: number; count: number };
  taxInvoices: { gross: number; vat: number; net: number; count: number };
  totalVatLiability: number;
}

const money = (n: number | undefined) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PESEPAY_RAILS = ['ecocash', 'omari', 'innbucks', 'paygo', 'pesepay'];

export default function Accounting() {
  const [tab, setTab] = useState<Tab>('overview');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pnl, setPnl] = useState<PnL | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [tax, setTax] = useState<TaxSummary | null>(null);
  const [railFilter, setRailFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const qs = useCallback(() => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p.toString() ? `?${p}` : '';
  }, [from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const o = await accountingApi.get<Overview>(`/overview${qs()}`);
      setOverview(o);
      if (o.role !== 'Cashier') {
        const ledgerQs = new URLSearchParams();
        if (from) ledgerQs.set('from', from);
        if (to) ledgerQs.set('to', to);
        ledgerQs.set('limit', '200');
        if (railFilter) ledgerQs.set('rail', railFilter);
        if (typeFilter) ledgerQs.set('type', typeFilter);
        const [p, l, t] = await Promise.all([
          accountingApi.get<PnL>(`/pnl${qs()}`),
          accountingApi.get<{ rows: LedgerRow[] }>(`/ledger?${ledgerQs}`),
          accountingApi.get<TaxSummary>(`/tax-summary${qs()}`),
        ]);
        setPnl(p);
        setLedger(l.rows || []);
        setTax(t);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load accounting');
    } finally {
      setLoading(false);
    }
  }, [qs, railFilter, typeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () => {
    const token = getToken();
    const url = `/api/accounting/export.csv${qs()}`;
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `preyone-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => setError(e.message));
  };

  const exportPdf = () => {
    const lines = [
      'Preyone Accounting Report',
      `Period: ${from || 'start'} → ${to || 'now'}`,
      '',
      `Gross Revenue: ${money(overview?.totalGrossRevenue)}`,
      `Net Sales: ${money(overview?.netSales)}`,
      `Tax Collected: ${money(overview?.taxCollected)}`,
      `Gross Profit: ${money(overview?.grossProfit)}`,
      `Outstanding AR: ${money(overview?.outstandingAr)}`,
      `MTD Revenue: ${money(overview?.mtdRevenue)}`,
      '',
      'P&L (3rd-to-3rd)',
      `COGS: ${money(pnl?.cogs)}`,
      `Expenses: ${money(pnl?.expenses)}`,
      `Operating Profit: ${money(pnl?.operatingProfit)}`,
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    a.download = `preyone-pnl-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const cashier = overview?.role === 'Cashier';

  return (
    <div className="acct-page">
      <div className="acct-header">
        <div>
          <h1 className="acct-title">Accounting &amp; Financing</h1>
          <p className="acct-desc">Enterprise ledger · 3rd-to-3rd revenue cycle · Pesepay rails</p>
        </div>
        <div className="acct-actions">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="acct-date" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="acct-date" />
          <button className="acct-btn" onClick={load}><FiRefreshCw /> Refresh</button>
          {!cashier && (
            <>
              <button className="acct-btn acct-btn--emerald" onClick={exportCsv}><FiDownload /> CSV</button>
              <button className="acct-btn acct-btn--amber" onClick={exportPdf}><FiDownload /> PDF</button>
            </>
          )}
        </div>
      </div>

      {error && <div className="acct-error">{error}</div>}

      <div className="acct-kpis">
        <div className="acct-kpi">
          <span className="acct-kpi-label"><FiDollarSign /> Today&apos;s Till</span>
          <span className="acct-kpi-value">{money(overview?.todayTill)}</span>
        </div>
        {!cashier && (
          <>
            <div className="acct-kpi acct-kpi--emerald">
              <span className="acct-kpi-label"><FiTrendingUp /> Gross Profit</span>
              <span className="acct-kpi-value">{money(overview?.grossProfit)}</span>
            </div>
            <div className="acct-kpi">
              <span className="acct-kpi-label"><FiTrendingUp /> MTD Revenue</span>
              <span className="acct-kpi-value">{money(overview?.mtdRevenue)}</span>
            </div>
            <div className="acct-kpi acct-kpi--amber">
              <span className="acct-kpi-label"><FiInbox /> Outstanding AR</span>
              <span className="acct-kpi-value">{money(overview?.outstandingAr)}</span>
            </div>
          </>
        )}
        {cashier && (
          <>
            <div className="acct-kpi acct-kpi--emerald">
              <span className="acct-kpi-label">Cash</span>
              <span className="acct-kpi-value">{money(overview?.cashTotal)}</span>
            </div>
            <div className="acct-kpi acct-kpi--amber">
              <span className="acct-kpi-label">Pesepay Rails</span>
              <span className="acct-kpi-value">{money(overview?.pesepayTotal)}</span>
            </div>
          </>
        )}
      </div>

      {!cashier && (
        <>
          <div className="acct-tabs">
            <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>Overview &amp; P&amp;L</button>
            <button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>General Ledger</button>
            <button className={tab === 'pesepay' ? 'on' : ''} onClick={() => setTab('pesepay')}>Pesepay Rail Reconciliation</button>
            <button className={tab === 'tax' ? 'on' : ''} onClick={() => setTab('tax')}>Tax &amp; VAT Reports</button>
          </div>

          {loading && <div className="acct-empty">Loading…</div>}

          {!loading && tab === 'overview' && pnl && (
            <div className="acct-panel">
              <div className="acct-pnl-grid">
                {[
                  ['Gross Revenue', pnl.grossRevenue],
                  ['Credit Notes', pnl.creditNotes],
                  ['Adjusted Gross', pnl.adjustedGross],
                  [`VAT (${overview?.vatRate ?? 15.5}%)`, pnl.taxCollected],
                  ['Net Sales', pnl.netSales],
                  ['COGS', pnl.cogs],
                  ['Gross Profit', pnl.grossProfit],
                  ['Expenses', pnl.expenses],
                  ['Operating Profit', pnl.operatingProfit],
                ].map(([label, val]) => (
                  <div key={String(label)} className="acct-pnl-row">
                    <span>{label}</span>
                    <strong>{money(Number(val))}</strong>
                  </div>
                ))}
              </div>
              <div className="acct-rail-strip">
                <div><span>Cash / Card / Bank</span><strong>{money(overview?.cashTotal)}</strong></div>
                <div><span>Pesepay Rails</span><strong>{money(overview?.pesepayTotal)}</strong></div>
                <div><span>Stock Valuation</span><strong>{money(overview?.stockValuation)}</strong></div>
              </div>
            </div>
          )}

          {!loading && tab === 'ledger' && (
            <div className="acct-panel">
              <div className="acct-filters">
                <select value={railFilter} onChange={(e) => setRailFilter(e.target.value)}>
                  <option value="">All rails</option>
                  {['cash', 'card', 'bank', ...PESEPAY_RAILS, 'other'].map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="">All types</option>
                  {['pos_sale', 'invoice_payment', 'pesepay_collection', 'credit_note', 'expense'].map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div className="acct-table-wrap">
                <table className="acct-table">
                  <thead>
                    <tr>
                      <th>When</th><th>Type</th><th>Rail</th><th>Doc</th><th>Gross</th><th>VAT</th><th>Net</th><th>COGS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.length === 0 ? (
                      <tr><td colSpan={8} className="acct-empty">No ledger entries</td></tr>
                    ) : ledger.map((r) => (
                      <tr key={r.id}>
                        <td>{new Date(r.occurred_at).toLocaleString()}</td>
                        <td>{r.entry_type}</td>
                        <td>{r.rail}</td>
                        <td>{r.doc_number || '—'}</td>
                        <td>{money(r.gross_amount)}</td>
                        <td>{money(r.tax_amount)}</td>
                        <td>{money(r.net_amount)}</td>
                        <td>{money(r.cogs_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loading && tab === 'pesepay' && (
            <div className="acct-panel">
              <h3 className="acct-subhead">Pesepay mobile rail collections (EcoCash · O&apos;mari · InnBucks)</h3>
              <div className="acct-rail-cards">
                {PESEPAY_RAILS.map((rail) => (
                  <div key={rail} className="acct-rail-card">
                    <span>{rail.toUpperCase()}</span>
                    <strong>{money(overview?.byRail?.[rail])}</strong>
                  </div>
                ))}
              </div>
              <div className="acct-table-wrap" style={{ marginTop: 16 }}>
                <table className="acct-table">
                  <thead>
                    <tr><th>When</th><th>Rail</th><th>Doc</th><th>Reference</th><th>Gross</th></tr>
                  </thead>
                  <tbody>
                    {ledger.filter((r) => PESEPAY_RAILS.includes(r.rail)).map((r) => (
                      <tr key={r.id}>
                        <td>{new Date(r.occurred_at).toLocaleString()}</td>
                        <td>{r.rail}</td>
                        <td>{r.doc_number || '—'}</td>
                        <td>{r.reference || '—'}</td>
                        <td>{money(r.gross_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loading && tab === 'tax' && tax && (
            <div className="acct-panel">
              <div className="acct-tax-grid">
                <div className="acct-tax-card">
                  <h3><FiPercent /> POS Receipts</h3>
                  <p>{tax.posReceipts.count} docs</p>
                  <div>Gross {money(tax.posReceipts.gross)}</div>
                  <div>VAT {money(tax.posReceipts.vat)}</div>
                  <div>Net {money(tax.posReceipts.net)}</div>
                </div>
                <div className="acct-tax-card">
                  <h3><FiPercent /> Tax Invoices</h3>
                  <p>{tax.taxInvoices.count} docs</p>
                  <div>Gross {money(tax.taxInvoices.gross)}</div>
                  <div>VAT {money(tax.taxInvoices.vat)}</div>
                  <div>Net {money(tax.taxInvoices.net)}</div>
                </div>
                <div className="acct-tax-card acct-tax-card--liability">
                  <h3>Total VAT Liability</h3>
                  <strong>{money(tax.totalVatLiability)}</strong>
                  <p>Rate {tax.vatRate}%</p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
