import { useState, useEffect, useCallback } from 'react';
import { systemApi } from '../api/client';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { FiTrendingUp, FiShoppingBag, FiDollarSign, FiUsers } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface RevenueData {
  totals: { totalTickets: number; totalCents: number; monthCents: number };
  byDay: { day: string; count: number; totalCents: number }[];
  byCompany: { id: string; name: string; slug: string; currency: string; commissionRate: number; status: string; grossCents: number; ticketCount: number; activeStaff: number }[];
}

const tooltipStyle = { background: '#111', border: '1px solid #2a2a3e', borderRadius: 6, color: '#e2e8f0', fontSize: 12 };

export default function GlobalRevenue() {
  const [data, setData] = useState<RevenueData | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await systemApi.get<RevenueData>('/revenue'));
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load, refresh]);

  const gross = (c: { grossCents: number; currency: string }) =>
    `${c.currency} ${(c.grossCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Global Revenue</h1>
          <p className="page-desc">Consolidated transit revenue across all tenant companies. Level 0 only.</p>
        </div>
        <div className="page-header-extra">
          <button className="btn-secondary" onClick={() => setRefresh(x => x + 1)}><FiTrendingUp /> Refresh</button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      {data && (
        <>
          <div className="stats-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card">
              <span className="stat-label"><FiDollarSign /> All-Time Gross</span>
              <span className="stat-number money money--lg">{data.totals.totalCents >= 100000 ? (data.totals.totalCents / 100 / 1000).toFixed(1) + 'K' : (data.totals.totalCents / 100).toLocaleString()} USD</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiTrendingUp /> This Month</span>
              <span className="stat-number money">{((data.totals.monthCents) / 100).toLocaleString()} USD</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiShoppingBag /> Total Tickets</span>
              <span className="stat-number">{data.totals.totalTickets.toLocaleString()}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiUsers /> Tenant Companies</span>
              <span className="stat-number">{data.byCompany.length}</span>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16, padding: 8 }}>
            <div className="section-header" style={{ border: 'none' }}>Revenue per Company</div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.byCompany.map(c => ({ name: c.name, gross: Math.round(c.grossCents / 100) }))} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="gross" name="Gross (USD)" fill="url(#gvgrad)" radius={[4, 4, 0, 0]} />
                <defs>
                  <linearGradient id="gvgrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffd700" stopOpacity={0.9} />
                    <stop offset="100%" stopColor="#6a0dad" stopOpacity={0.5} />
                  </linearGradient>
                </defs>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <div className="section-header">Companies</div>
            <div className="card-table">
              <table className="data-table">
                <thead>
                  <tr><th>Company</th><th>Status</th><th>Commission</th><th>Gross</th><th>Tickets</th><th>Active Staff</th></tr>
                </thead>
                <tbody>
                  {data.byCompany.map(c => (
                    <tr key={c.id}>
                      <td><span style={{ color: 'var(--cyan)', fontWeight: 700 }}>{c.name}</span><div className="tx-muted">{c.slug}</div></td>
                      <td><span className={'status-chip status-chip--' + (c.status === 'ACTIVE' ? 'active' : 'disabled')}>{c.status}</span></td>
                      <td className="tx-num">{c.commissionRate}%</td>
                      <td className="tx-num tx-num--gold">{gross(c)}</td>
                      <td className="tx-num">{c.ticketCount.toLocaleString()}</td>
                      <td className="tx-num">{c.activeStaff}</td>
                    </tr>
                  ))}
                  {data.byCompany.length === 0 && (
                    <tr><td colSpan={6} className="table-empty">No companies yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}