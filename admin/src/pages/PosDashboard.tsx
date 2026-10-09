import { useState, useEffect, useCallback } from 'react';
import { posApi, money } from '../api/pos';
import {
  FiShoppingCart, FiDollarSign, FiAlertTriangle, FiUsers, FiRepeat, FiFileText, FiClock,
} from 'react-icons/fi';
import './Dashboard.css';
import './SectorDashboards.css';

interface PosDashboardData {
  till: {
    docs: number; gross: number; collected: number; vat: number; profit: number;
    byMethod: { method: string; count: number; total: number }[];
  };
  bestSellers: { description: string; qty_sold: number; revenue: number }[];
  lowStock: { id: string; name: string; stock_qty: number; low_stock_threshold: number }[];
  staff: { cashier: string | null; count: number; gross: number }[];
  ledger: {
    invoices: { issued: number; paid: number; unpaid: number; partial: number; amountDue: number; overdue: { count: number; outstanding: number } };
    quotations: { draft: number; sent: number; converted: number };
    sales: number;
    recent: {
      id: string; doc_number: string; doc_type: string; status: string; total: number; amount_paid: number;
      issue_date: string | null; due_date: string | null; customer_name: string | null; cashier_name: string | null;
    }[];
  };
  shifts: { open: number; total: number };
}

function fmtAgo(d?: string | null): string {
  if (!d) return '—';
  try {
    const mins = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch { return d; }
}

export default function PosDashboard({ onNavigate }: { onNavigate?: (s: string) => void }) {
  const [data, setData] = useState<PosDashboardData | null>(null);
  const [error, setError] = useState('');
  const [converting, setConverting] = useState('');
  const [flash, setFlash] = useState('');

  const load = useCallback(() => {
    posApi.get<PosDashboardData>('/dashboard').then(setData).catch((e) => setError(e.message || 'Failed to load'));
  }, []);

  useEffect(() => { load(); const i = setInterval(load, 30000); return () => clearInterval(i); }, [load]);

  const notify = (msg: string) => { setFlash(msg); window.setTimeout(() => setFlash(''), 3000); };

  const convert = async (doc: PosDashboardData['ledger']['recent'][number]) => {
    if (!window.confirm(`Convert ${doc.doc_number} (${doc.customer_name || 'walk-in'}) into an invoice? A fresh INV- number will be assigned.`)) return;
    setConverting(doc.id);
    try {
      await posApi.convertToInvoice(doc.id);
      notify(`${doc.doc_number} → converted to ${'INV-' + doc.doc_number.split('-').slice(1).join('-')}`);
      load();
    } catch (e: any) {
      notify(e.message || 'Conversion failed');
    } finally {
      setConverting('');
    }
  };

  const t = data?.till;
  const inv = data?.ledger.invoices;

  return (
    <div className="dashboard sector-dashboard">
      <div className="section-head sector-head">
        <div>
          <h2 className="section-head-title">Preyone POS</h2>
          <p className="section-head-desc">Till, inventory &amp; ledger at a glance</p>
        </div>
        <span className={'live-pill' + (flash ? ' has-flash' : '')}>
          <span className="live-dot" /> {flash || 'LIVE'} {!flash && <span className="live-sub">30s</span>}
        </span>
      </div>

      {error && !data && (
        <div className="card sector-error"><p>{error}</p><p className="muted">Your account may not be provisioned for POS yet.</p></div>
      )}

      {!data && !error && (
        <div className="hero-grid">{['a', 'b', 'c', 'd'].map((k) => (
          <div key={k} className="hero-card" style={{ opacity: 0.4 }}>
            <div className="hero-icon" style={{ background: 'var(--surface2)' }} />
            <div className="hero-body">
              <div style={{ height: 10, width: 90, background: 'var(--surface2)', borderRadius: 4, marginBottom: 6 }} />
              <div style={{ height: 22, width: 130, background: 'var(--surface2)', borderRadius: 4 }} />
            </div>
          </div>
        ))}</div>
      )}

      {data && (
        <>
          {/* ── Till strip ── */}
          <div className="hero-grid">
            <div className="hero-card hero-green" onClick={() => onNavigate?.('pos-sales')}>
              <div className="hero-icon"><FiShoppingCart size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Today's Till</span>
                <span className="hero-value">{money(t?.gross)}</span>
                <span className="hero-sub">{t?.docs} docs · {money(t?.collected)} collected</span>
              </div>
            </div>
            <div className="hero-card hero-cyan" onClick={() => onNavigate?.('pos-sales')}>
              <div className="hero-icon"><FiDollarSign size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Gross Profit</span>
                <span className="hero-value">{money(t?.profit)}</span>
                <span className="hero-sub">{money(t?.vat)} VAT</span>
              </div>
            </div>
            <div className="hero-card hero-orange" onClick={() => onNavigate?.('pos-reports')}>
              <div className="hero-icon"><FiFileText size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Invoices Due</span>
                <span className="hero-value">{money(inv?.amountDue)}</span>
                <span className="hero-sub">{inv?.issued ?? 0} issued · {inv?.overdue?.count ?? 0} overdue ({money(inv?.overdue?.outstanding)})</span>
              </div>
            </div>
            <div className="hero-card hero-purple" onClick={() => onNavigate?.('pos-inventory')}>
              <div className="hero-icon"><FiClock size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Open Shift</span>
                <span className="hero-value">{data.shifts.open ? 'Yes' : 'No'}</span>
                <span className="hero-sub">{data.shifts.total} shifts · {data.ledger.sales} sale docs</span>
              </div>
            </div>
          </div>

          {/* ── Payment mix ── */}
          {t && t.byMethod.length > 0 && (
            <div className="chip-row">
              {t.byMethod.map((m) => (
                <span key={m.method} className="sector-chip"><b>{m.method}</b> {money(m.total)} <b className="muted">{m.count}</b></span>
              ))}
            </div>
          )}

          <div className="charts-row" style={{ marginTop: '1.5rem' }}>
            {/* ── Best sellers ── */}
            <div className="card">
              <div className="card-header"><h3 className="card-title">Best Sellers · Today</h3></div>
              {data.bestSellers.length === 0 ? (
                <div className="table-empty"><p>No sales yet today.</p></div>
              ) : (
                <table className="data-table">
                  <thead><tr><th>Item</th><th>Qty</th><th>Revenue</th></tr></thead>
                  <tbody>
                    {data.bestSellers.map((b) => (
                      <tr key={b.description}>
                        <td>{b.description}</td>
                        <td>{b.qty_sold}</td>
                        <td>{money(b.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* ── Low stock ── */}
            <div className="card">
              <div className="card-header"><h3 className="card-title"><FiAlertTriangle size={14} /> Low Stock Alert</h3></div>
              {data.lowStock.length === 0 ? (
                <div className="table-empty"><p>All tracked products above threshold.</p></div>
              ) : (
                <table className="data-table">
                  <thead><tr><th>Product</th><th>Stock</th><th>Threshold</th></tr></thead>
                  <tbody>
                    {data.lowStock.map((p) => (
                      <tr key={p.id}>
                        <td>{p.name}</td>
                        <td><span className="badge badge--no">{p.stock_qty}</span></td>
                        <td>{p.low_stock_threshold}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* ── Recent documents + convert action ── */}
          <div className="section-head" style={{ marginTop: '1.5rem' }}>
            <h2 className="section-head-title">Recent Documents</h2>
            <p className="section-head-desc">Quotations can be converted into invoices in place</p>
          </div>
          <div className="card card-table">
            {data.ledger.recent.length === 0 ? (
              <div className="table-empty"><p>No documents yet.</p></div>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Doc</th><th>Type</th><th>Customer</th><th>Status</th><th>Total</th><th>Paid</th><th>Currency Notes</th><th>When</th><th /></tr></thead>
                  <tbody>
                    {data.ledger.recent.map((d) => (
                      <tr key={d.id}>
                        <td><span className="code-cell">{d.doc_number}</span></td>
                        <td><span className="badge">{d.doc_type}</span></td>
                        <td>{d.customer_name || 'Walk-in'}</td>
                        <td>
                          <span className={'badge badge--' + (d.status === 'paid' ? 'yes' : d.status === 'void' ? 'no' : d.status === 'unpaid' ? 'warn' : '')}>
                            {d.status}
                          </span>
                        </td>
                        <td>{money(d.total)}</td>
                        <td>{money(d.amount_paid)}</td>
                        <td className="muted" style={{ fontSize: 11 }}>{d.due_date ? `due ${fmtAgo(d.due_date)}` : '—'}</td>
                        <td className="muted">{fmtAgo(d.issue_date)}</td>
                        <td>
                          {d.doc_type === 'quotation' && d.status !== 'converted' && (
                            <button
                              className="btn btn--sm btn--primary"
                              disabled={converting === d.id}
                              onClick={() => convert(d)}
                            >
                              <FiRepeat size={12} /> {converting === d.id ? 'Converting…' : 'Invoice'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Staff performance ── */}
          <div className="section-head" style={{ marginTop: '1.5rem' }}>
            <h2 className="section-head-title">Cashier Performance</h2>
            <p className="section-head-desc">Today's sales by cashier</p>
          </div>
          <div className="card card-table">
            {data.staff.length === 0 ? (
              <div className="table-empty"><p>No cashier activity today.</p></div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Cashier</th><th>Docs</th><th>Gross</th></tr></thead>
                <tbody>
                  {data.staff.map((s) => (
                    <tr key={s.cashier || '—'}>
                      <td><FiUsers size={12} /> {s.cashier || '—'}</td>
                      <td>{s.count}</td>
                      <td>{money(s.gross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}