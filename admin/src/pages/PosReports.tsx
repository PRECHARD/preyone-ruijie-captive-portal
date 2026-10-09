import { useCallback, useEffect, useState } from 'react';
import { posApi, money } from '../api/pos';
import { exportReportPdf } from '../utils/exportPdf';
import { exportReportExcel } from '../utils/exportExcel';

const iso = (d: Date) => d.toISOString().slice(0, 10);

function startOfWeek(d: Date) {
  const r = new Date(d);
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  r.setHours(0, 0, 0, 0);
  return r;
}


function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); }
function startOfQuarter(d: Date) { return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); }

function shift(d: Date, days: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

type Preset = { label: string; from: Date; to: Date; compareFrom: Date; compareTo: Date };

function getPreset(key: string): Preset {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const presets: Record<string, Preset> = {
    'thisWeek': {
      label: 'This Week',
      from: startOfWeek(today), to: now,
      compareFrom: shift(startOfWeek(today), -7), compareTo: shift(startOfWeek(today), -1),
    },
    'lastWeek': {
      label: 'Last Week',
      from: shift(startOfWeek(today), -7), to: shift(startOfWeek(today), -1),
      compareFrom: shift(startOfWeek(today), -14), compareTo: shift(startOfWeek(today), -8),
    },
    'thisMonth': {
      label: 'This Month',
      from: startOfMonth(today), to: now,
      compareFrom: shift(startOfMonth(today), -1), compareTo: shift(startOfMonth(today), -1),
    },
    'lastMonth': {
      label: 'Last Month',
      from: startOfMonth(shift(startOfMonth(today), -1)),
      to: endOfMonth(shift(startOfMonth(today), -1)),
      compareFrom: startOfMonth(shift(startOfMonth(today), -2)),
      compareTo: endOfMonth(shift(startOfMonth(today), -2)),
    },
    'thisQuarter': {
      label: 'This Quarter',
      from: startOfQuarter(today), to: now,
      compareFrom: shift(startOfQuarter(today), -1), compareTo: shift(startOfQuarter(today), -1),
    },
    'thisYear': {
      label: 'This Year',
      from: new Date(today.getFullYear(), 0, 1), to: now,
      compareFrom: new Date(today.getFullYear() - 1, 0, 1),
      compareTo: new Date(today.getFullYear() - 1, 11, 31, 23, 59, 59, 999),
    },
  };
  return presets[key] || presets['thisMonth'];
}

function pctChange(curr: number, prev: number): number | null {
  if (prev === 0 && curr === 0) return null;
  if (prev === 0) return 100;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function TrendArrow({ current, previous }: { current: number; previous: number }) {
  const pct = pctChange(current, previous);
  if (pct === null) return <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>—</span>;
  if (pct > 0) return <span style={{ color: 'var(--green)', fontSize: '0.72rem', fontWeight: 700 }}>▲ {pct.toFixed(1)}%</span>;
  if (pct < 0) return <span style={{ color: 'var(--red)', fontSize: '0.72rem', fontWeight: 700 }}>▼ {Math.abs(pct).toFixed(1)}%</span>;
  return <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>— 0%</span>;
}

export default function PosReports() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 864e5)));
  const [to, setTo] = useState(iso(new Date()));
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const compare = activePreset ? '&compare=true' : '';
    try { setData(await posApi.get(`/reports/sales?from=${from}&to=${to}${compare}`)); }
    catch { }
    finally { setLoading(false); }
  }, [from, to, activePreset]);
  useEffect(() => { load(); }, [load]);

  const applyPreset = (key: string) => {
    const p = getPreset(key);
    setFrom(iso(p.from));
    setTo(iso(p.to));
    setActivePreset(key);
  };

  const clearPreset = () => { setActivePreset(null); };

  const t = data?.totals;
  const pt = data?.prior?.totals;
  const margin = t && Number(t.revenue) > 0 ? (Number(t.profit) / Number(t.revenue)) * 100 : 0;
  const pm = pt && Number(pt.revenue) > 0 ? (Number(pt.profit) / Number(pt.revenue)) * 100 : 0;

  const PRESETS: [string, string][] = [
    ['thisWeek', 'This Week'],
    ['lastWeek', 'Last Week'],
    ['thisMonth', 'This Month'],
    ['lastMonth', 'Last Month'],
    ['thisQuarter', 'This Quarter'],
    ['thisYear', 'This Year'],
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">POS Reports</h1>
          <p className="page-desc">Revenue, profit and VAT across the till</p>
        </div>
      </div>

      {/* Preset buttons */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {PRESETS.map(([key, label]) => (
          <button
            key={key}
            className="btn-secondary"
            style={{
              fontSize: 12, padding: '6px 14px',
              borderColor: activePreset === key ? 'var(--cyan)' : undefined,
              color: activePreset === key ? 'var(--cyan)' : undefined,
              background: activePreset === key ? 'rgba(0,229,255,0.08)' : undefined,
            }}
            onClick={() => applyPreset(key)}
          >
            {label}
          </button>
        ))}
        {activePreset && (
          <button className="btn-secondary" style={{ fontSize: 12, padding: '6px 14px', color: 'var(--text-dim)' }} onClick={clearPreset}>
            ✕ Custom
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="date" value={from} onChange={e => { setFrom(e.target.value); clearPreset(); }}
            style={{ padding: '6px 10px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }} />
          <input type="date" value={to} onChange={e => { setTo(e.target.value); clearPreset(); }}
            style={{ padding: '6px 10px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }} />
          {data && (
            <>
              <button className="btn-secondary" style={{ fontSize: 11, padding: '6px 12px', color: 'var(--cyan)', borderColor: 'rgba(0,229,255,0.3)' }}
                onClick={() => exportReportPdf(data, from, to, activePreset ? getPreset(activePreset).label : undefined)}>
                ↓ PDF
              </button>
              <button className="btn-secondary" style={{ fontSize: 11, padding: '6px 12px', color: 'var(--green)', borderColor: 'rgba(0,230,118,0.3)' }}
                onClick={() => exportReportExcel(data, from, to, activePreset ? getPreset(activePreset).label : undefined)}>
                ↓ Excel
              </button>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : !data ? (
        <p style={{ color: 'var(--text-muted)' }}>No report available.</p>
      ) : (
        <>
          {/* Main stat cards with trend indicators */}
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            {([
              { key: 'REVENUE', value: money(t.revenue), hint: `${t.docs} documents`, curr: t.revenue, prev: pt?.revenue },
              { key: 'COLLECTED', value: money(t.collected), hint: `balance ${money(Number(t.revenue) - Number(t.collected))}`, curr: t.collected, prev: pt?.collected },
              { key: 'PROFIT', value: money(t.profit), hint: `${margin.toFixed(1)}% margin`, curr: t.profit, prev: pt?.profit },
              { key: 'VAT / TAX', value: money(t.vat), hint: 'taxable sales', curr: t.vat, prev: pt?.vat },
            ]).map(({ key, value, hint, curr, prev }) => (
              <div key={key} className="stat-card">
                <div className="stat-label">{key}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <div className="stat-number">{value}</div>
                  {curr !== undefined && prev !== undefined && <TrendArrow current={Number(curr)} previous={Number(prev)} />}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{hint}</div>
              </div>
            ))}
          </div>

          {/* Prior period comparison summary */}
          {pt && (
            <div className="glass" style={{ borderRadius: 8, padding: '14px 18px', marginBottom: 20, border: '1px solid rgba(0,229,255,0.12)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--cyan)', marginBottom: 10 }}>
                vs. Previous Period ({data.prior.from} → {data.prior.to})
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                {([
                  { label: 'Revenue', curr: Number(t.revenue), prev: Number(pt.revenue), format: 'money' as const },
                  { label: 'Collected', curr: Number(t.collected), prev: Number(pt.collected), format: 'money' as const },
                  { label: 'Profit', curr: Number(t.profit), prev: Number(pt.profit), format: 'money' as const },
                  { label: 'VAT', curr: Number(t.vat), prev: Number(pt.vat), format: 'money' as const },
                  { label: 'Documents', curr: Number(t.docs), prev: Number(pt.docs), format: 'money' as const },
                  { label: 'Margin', curr: margin, prev: pm, format: 'pct' as const },
                ]).map(({ label, curr, prev, format }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: 'var(--text)' }}>
                        {format === 'pct' ? `${curr.toFixed(1)}%` : money(curr)}
                      </span>
                      <TrendArrow current={curr} previous={prev} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
            <section>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>By Payment Method</h3>
              <div className="card-table"><table className="data-table"><thead><tr><th>METHOD</th><th>COUNT</th><th style={{ textAlign: 'right' }}>TOTAL</th></tr></thead><tbody>
                {(data.byMethod as any[]).map((r: any) => (
                  <tr key={r.method}><td style={{ textTransform: 'capitalize' }}>{r.method}</td><td>{r.count}</td><td style={{ textAlign: 'right' }}><strong>{money(r.total)}</strong></td></tr>
                ))}
                {data.byMethod.length === 0 && <tr><td colSpan={3} style={{ color: 'var(--text-muted)' }}>No payments in range</td></tr>}
              </tbody></table></div>

              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginTop: 18, marginBottom: 8 }}>Staff Performance</h3>
              <div className="card-table"><table className="data-table"><thead><tr><th>CASHIER</th><th>DOCS</th><th style={{ textAlign: 'right' }}>REVENUE</th><th style={{ textAlign: 'right' }}>COLLECTED</th></tr></thead><tbody>
                {(data.byCashier as any[]).map((r: any, i: number) => (
                  <tr key={i}><td>{r.cashier}</td><td>{r.docs}</td><td style={{ textAlign: 'right' }}>{money(r.revenue)}</td><td style={{ textAlign: 'right' }}>{money(r.collected)}</td></tr>
                ))}
                {data.byCashier.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--text-muted)' }}>No sales in range</td></tr>}
              </tbody></table></div>
            </section>

            <section>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Best Sellers</h3>
              <div className="card-table"><table className="data-table"><thead><tr><th>ITEM</th><th>QTY</th><th style={{ textAlign: 'right' }}>REVENUE</th><th style={{ textAlign: 'right' }}>PROFIT</th></tr></thead><tbody>
                {(data.bestSellers as any[]).map((r: any, i: number) => (
                  <tr key={i}><td>{r.description}</td><td>{Number(r.qty_sold)}</td><td style={{ textAlign: 'right' }}>{money(r.revenue)}</td><td style={{ textAlign: 'right' }}>{money(r.profit)}</td></tr>
                ))}
                {data.bestSellers.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--text-muted)' }}>No items sold in range</td></tr>}
              </tbody></table></div>

              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginTop: 18, marginBottom: 8 }}>Daily Revenue</h3>
              <div className="bar-chart" style={{ marginBottom: 8 }}>
                {(data.byDay as any[]).slice(-14).map((r: any, i: number) => {
                  const maxRev = Math.max(...(data.byDay as any[]).map((d: any) => Number(d.revenue) || 0), 1);
                  const pct = (Number(r.revenue) / maxRev) * 100;
                  return (
                    <div key={i} className="bar-col" title={`${r.day}: ${money(r.revenue)}`}>
                      <div className="bar" style={{ height: `${Math.max(pct, 4)}%` }} />
                      <div className="bar-label">{new Date(r.day).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</div>
                    </div>
                  );
                })}
              </div>
              <div className="card-table"><table className="data-table"><thead><tr><th>DAY</th><th>DOCS</th><th style={{ textAlign: 'right' }}>REVENUE</th></tr></thead><tbody>
                {(data.byDay as any[]).slice(-14).reverse().map((r: any, i: number) => (
                  <tr key={i}><td>{new Date(r.day).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</td><td>{r.docs}</td><td style={{ textAlign: 'right' }}>{money(r.revenue)}</td></tr>
                ))}
                {data.byDay.length === 0 && <tr><td colSpan={3} style={{ color: 'var(--text-muted)' }}>Nothing yet</td></tr>}
              </tbody></table></div>
            </section>
          </div>

          {data.lowStock.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginTop: 22, marginBottom: 8 }}>Low Stock Alerts</h3>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {(data.lowStock as any[]).map((p: any) => (
                  <span key={p.id} style={{ background: 'rgba(255,145,0,0.12)', color: 'var(--orange)', borderRadius: 8, padding: '6px 12px', fontSize: '0.78rem', fontWeight: 600 }}>
                    {p.name} · {Number(p.stock_qty)} left
                  </span>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
