import { useState, useEffect, useCallback } from 'react';
import { transitApi } from '../api/client';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, AreaChart, Area } from 'recharts';
import { FiTrendingUp, FiShoppingBag, FiAlertTriangle, FiRefreshCw } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface Financials {
  summary: {
    totalTickets: number; totalCents: number; todayCents: number;
    weekCents: number; monthCents: number; conflicts: number; cancelled: number;
  };
  byDate: { day: string; count: number; totalCents: number }[];
  byRoute: { routeName: string; count: number; totalCents: number }[];
  byStaff: { staff: string; count: number; totalCents: number }[];
  byCompany: { id: string; name: string; currency: string; commissionRate: number; grossCents: number; ticketCount: number }[];
}

const tooltipStyle = { background: '#111', border: '1px solid #2a2a3e', borderRadius: 6, color: '#e2e8f0', fontSize: 12 };

export default function Financials() {
  const [data, setData] = useState<Financials | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      setLoading(true);
      setData(await transitApi.get<Financials>('/financials'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const s = data?.summary;
  const currency = data?.byCompany[0]?.currency || '';
  const usd = (cents: number) => `${currency} ${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const daily = (data?.byDate || []).slice().reverse().map(d => ({ day: d.day.slice(5), revenue: Math.round(d.totalCents / 100), count: d.count }));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Financial Reports</h1>
          <p className="page-desc">Gross revenue, tickets and commission overview for your company.</p>
        </div>
        <div className="page-header-extra">
          <button className="btn-secondary" onClick={load}><FiRefreshCw /> Refresh</button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      {data && s && (
        <>
          <div className="stats-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card">
              <span className="stat-label"><FiTrendingUp /> Today</span>
              <span className="stat-number money">{usd(s.todayCents)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiTrendingUp /> This Week</span>
              <span className="stat-number money">{usd(s.weekCents)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiTrendingUp /> This Month</span>
              <span className="stat-number money">{usd(s.monthCents)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiShoppingBag /> Total Tickets</span>
              <span className="stat-number">{s.totalTickets.toLocaleString()}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiAlertTriangle /> Conflicts</span>
              <span className="stat-number" style={{ color: s.conflicts > 0 ? 'var(--orange)' : 'var(--text-muted)' }}>{s.conflicts}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiAlertTriangle /> Cancelled</span>
              <span className="stat-number" style={{ color: 'var(--text-muted)' }}>{s.cancelled}</span>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16, padding: 8 }}>
            <div className="section-header" style={{ border: 'none' }}>Daily Revenue (last 14 days)</div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={daily} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="finGreen" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#00e676" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#00e676" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area type="monotone" dataKey="revenue" name="Revenue (USD)" stroke="#00e676" fill="url(#finGreen)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="stats-grid--compact" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
            <div className="card" style={{ padding: 8 }}>
              <div className="section-header" style={{ border: 'none' }}>Revenue by Route</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={data.byRoute.map(r => ({ name: r.routeName, revenue: Math.round(r.totalCents / 100) }))} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 10 }} interval={0} angle={-12} height={40} />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="revenue" name="Revenue (USD)" fill="#00e5ff" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card" style={{ padding: 8 }}>
              <div className="section-header" style={{ border: 'none' }}>Revenue by Staff</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={data.byStaff.map(r => ({ name: r.staff, revenue: Math.round(r.totalCents / 100) }))} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 10 }} interval={0} angle={-12} height={40} />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="revenue" name="Revenue (USD)" fill="#ff00ff" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {data.byCompany.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="section-header">Company Commission Snapshot</div>
              <div className="card-table">
                <table className="data-table">
                  <thead><tr><th>Company</th><th>Commission Rate</th><th>Month Tickets</th><th>Month Gross</th><th>Platform Commission (est.)</th></tr></thead>
                  <tbody>
                    {data.byCompany.map(c => (
                      <tr key={c.id}>
                        <td style={{ fontWeight: 700 }}>{c.name}</td>
                        <td className="tx-num">{c.commissionRate}%</td>
                        <td className="tx-num">{c.ticketCount}</td>
                        <td className="tx-num tx-num--green">{usd(c.grossCents)}</td>
                        <td className="tx-num" style={{ color: 'var(--gold)' }}>{usd((c.grossCents * (Number(c.commissionRate) || 0)) / 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      {loading && <div className="table-empty">Loading financial data…</div>}
    </div>
  );
}