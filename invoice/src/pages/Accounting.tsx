import { useCallback, useEffect, useState } from 'react';
import { api, download } from '../api';

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
}

interface TaxSummary {
  vatRate: number;
  posReceipts: { gross: number; vat: number; net: number; count: number };
  taxInvoices: { gross: number; vat: number; net: number; count: number };
  totalVatLiability: number;
}

const PESEPAY_RAILS = ['ecocash', 'omari', 'innbucks', 'paygo', 'pesepay'];

const money = (n: number | undefined) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Accounting & Financing dashboard — same /api/accounting surface as the
 * admin POS Accounting page, styled with the invoice workspace chrome.
 */
export default function AccountingPage() {
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
  const [error, setError] = useState<string | null>(null);

  const qs = useCallback(() => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p.toString() ? `?${p}` : '';
  }, [from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const o = await api.get<Overview>(`/api/accounting/overview${qs()}`);
      setOverview(o);
      if (o.role !== 'Cashier') {
        const ledgerQs = new URLSearchParams();
        if (from) ledgerQs.set('from', from);
        if (to) ledgerQs.set('to', to);
        ledgerQs.set('limit', '200');
        if (railFilter) ledgerQs.set('rail', railFilter);
        if (typeFilter) ledgerQs.set('type', typeFilter);
        const [p, l, t] = await Promise.all([
          api.get<PnL>(`/api/accounting/pnl${qs()}`),
          api.get<{ rows: LedgerRow[] }>(`/api/accounting/ledger?${ledgerQs}`),
          api.get<TaxSummary>(`/api/accounting/tax-summary${qs()}`),
        ]);
        setPnl(p);
        setLedger(l.rows || []);
        setTax(t);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load accounting');
    } finally {
      setLoading(false);
    }
  }, [qs, from, to, railFilter, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = () => {
    const q = qs();
    void download(`/api/accounting/export.csv${q}`, `preyone-ledger-${new Date().toISOString().slice(0, 10)}.csv`).catch(
      (e) => setError(e instanceof Error ? e.message : 'Export failed')
    );
  };

  const cashier = overview?.role === 'Cashier';

  return (
    <div className="acct-view">
      <div className="topbar">
        <div>
          <h1 className="page-title">Accounting &amp; Financing</h1>
          <p className="page-sub">Overview, P&amp;L, ledger, Pesepay rails and VAT — same reports as the admin console.</p>
        </div>
        <div className="topbar-actions">
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
          <button className="btn ghost" type="button" onClick={() => void load()} disabled={loading}>
            {loading ? <span className="spinner" aria-hidden /> : null}
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          {!cashier && (
            <button className="btn" type="button" onClick={exportCsv}>
              Export CSV
            </button>
          )}
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Today&apos;s till</div>
          <div className="stat-value">{money(overview?.todayTill)}</div>
          <div className="stat-foot">cash drawer today</div>
        </div>
        {!cashier && (
          <>
            <div className="stat">
              <div className="stat-label">Gross profit</div>
              <div className="stat-value">{money(overview?.grossProfit)}</div>
              <div className="stat-foot">after COGS</div>
            </div>
            <div className="stat">
              <div className="stat-label">MTD revenue</div>
              <div className="stat-value">{money(overview?.mtdRevenue)}</div>
              <div className="stat-foot">month to date</div>
            </div>
            <div className="stat">
              <div className="stat-label">Outstanding AR</div>
              <div className={`stat-value ${(overview?.outstandingAr ?? 0) > 0 ? 'warn' : ''}`}>
                {money(overview?.outstandingAr)}
              </div>
              <div className="stat-foot">unpaid invoices</div>
            </div>
          </>
        )}
        {cashier && (
          <>
            <div className="stat">
              <div className="stat-label">Cash</div>
              <div className="stat-value">{money(overview?.cashTotal)}</div>
              <div className="stat-foot">cash / card / bank</div>
            </div>
            <div className="stat">
              <div className="stat-label">Pesepay</div>
              <div className="stat-value">{money(overview?.pesepayTotal)}</div>
              <div className="stat-foot">mobile rails</div>
            </div>
          </>
        )}
      </div>

      {cashier ? (
        <p className="muted">Cashier view — till drawer totals only. Ask a Manager or CEO for the full ledger.</p>
      ) : (
        <>
          <div className="acct-tabs" role="tablist" aria-label="Accounting reports">
            {(
              [
                ['overview', 'Overview & P&L'],
                ['ledger', 'General Ledger'],
                ['pesepay', 'Pesepay Rail'],
                ['tax', 'Tax & VAT'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`acct-tab${tab === id ? ' on' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {loading && <div className="empty">Loading accounting…</div>}

          {!loading && tab === 'overview' && pnl && (
            <div className="card panel">
              <div className="panel-head">
                <div className="panel-title">Profit &amp; loss (3rd-to-3rd)</div>
                <span className="muted small">VAT {overview?.vatRate ?? 15.5}%</span>
              </div>
              <div className="acct-pnl">
                {(
                  [
                    ['Gross Revenue', pnl.grossRevenue],
                    ['Credit Notes', pnl.creditNotes],
                    ['Adjusted Gross', pnl.adjustedGross],
                    [`VAT (${overview?.vatRate ?? 15.5}%)`, pnl.taxCollected],
                    ['Net Sales', pnl.netSales],
                    ['COGS', pnl.cogs],
                    ['Gross Profit', pnl.grossProfit],
                    ['Expenses', pnl.expenses],
                    ['Operating Profit', pnl.operatingProfit],
                  ] as Array<[string, number]>
                ).map(([label, val]) => (
                  <div className="acct-pnl-row" key={label}>
                    <span>{label}</span>
                    <strong className="mono">{money(val)}</strong>
                  </div>
                ))}
              </div>
              <div className="acct-rail-strip">
                <div>
                  <span className="muted small">Cash / Card / Bank</span>
                  <strong className="mono">{money(overview?.cashTotal)}</strong>
                </div>
                <div>
                  <span className="muted small">Pesepay Rails</span>
                  <strong className="mono">{money(overview?.pesepayTotal)}</strong>
                </div>
                <div>
                  <span className="muted small">Stock Valuation</span>
                  <strong className="mono">{money(overview?.stockValuation)}</strong>
                </div>
              </div>
            </div>
          )}

          {!loading && tab === 'ledger' && (
            <div className="card panel">
              <div className="panel-head">
                <div className="panel-title">General ledger</div>
                <div className="panel-tools">
                  <select className="select" value={railFilter} onChange={(e) => setRailFilter(e.target.value)}>
                    <option value="">All rails</option>
                    {['cash', 'card', 'bank', ...PESEPAY_RAILS, 'other'].map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <select className="select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="">All types</option>
                    {['pos_sale', 'invoice_payment', 'pesepay_collection', 'credit_note', 'expense'].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Type</th>
                      <th>Rail</th>
                      <th>Doc</th>
                      <th className="num">Gross</th>
                      <th className="num">VAT</th>
                      <th className="num">Net</th>
                      <th className="num">COGS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="empty">
                          No ledger entries
                        </td>
                      </tr>
                    ) : (
                      ledger.map((r) => (
                        <tr key={r.id}>
                          <td>{new Date(r.occurred_at).toLocaleString()}</td>
                          <td>{r.entry_type}</td>
                          <td>{r.rail}</td>
                          <td className="mono">{r.doc_number || '—'}</td>
                          <td className="num mono">{money(r.gross_amount)}</td>
                          <td className="num mono">{money(r.tax_amount)}</td>
                          <td className="num mono">{money(r.net_amount)}</td>
                          <td className="num mono">{money(r.cogs_amount)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loading && tab === 'pesepay' && (
            <>
              <div className="stats">
                {PESEPAY_RAILS.map((rail) => (
                  <div className="stat" key={rail}>
                    <div className="stat-label">{rail.toUpperCase()}</div>
                    <div className="stat-value">{money(overview?.byRail?.[rail])}</div>
                    <div className="stat-foot">rail collections</div>
                  </div>
                ))}
              </div>
              <div className="card panel">
                <div className="panel-head">
                  <div className="panel-title">Pesepay rail reconciliation</div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Rail</th>
                        <th>Doc</th>
                        <th>Reference</th>
                        <th className="num">Gross</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.filter((r) => PESEPAY_RAILS.includes(r.rail)).length === 0 ? (
                        <tr>
                          <td colSpan={5} className="empty">
                            No Pesepay rail entries in this period
                          </td>
                        </tr>
                      ) : (
                        ledger
                          .filter((r) => PESEPAY_RAILS.includes(r.rail))
                          .map((r) => (
                            <tr key={r.id}>
                              <td>{new Date(r.occurred_at).toLocaleString()}</td>
                              <td>{r.rail}</td>
                              <td className="mono">{r.doc_number || '—'}</td>
                              <td>{r.reference || '—'}</td>
                              <td className="num mono">{money(r.gross_amount)}</td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {!loading && tab === 'tax' && tax && (
            <div className="stats">
              <div className="stat">
                <div className="stat-label">POS receipts VAT</div>
                <div className="stat-value">{money(tax.posReceipts.vat)}</div>
                <div className="stat-foot">
                  {tax.posReceipts.count} docs · gross {money(tax.posReceipts.gross)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Tax invoice VAT</div>
                <div className="stat-value">{money(tax.taxInvoices.vat)}</div>
                <div className="stat-foot">
                  {tax.taxInvoices.count} docs · gross {money(tax.taxInvoices.gross)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Total VAT liability</div>
                <div className="stat-value warn">{money(tax.totalVatLiability)}</div>
                <div className="stat-foot">rate {tax.vatRate}%</div>
              </div>
            </div>
          )}
        </>
      )}

    </div>
  );
}
