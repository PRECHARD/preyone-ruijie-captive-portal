import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, AreaChart, Area,
} from 'recharts';
import './Dashboard.css';

interface StaffStats {
  activeSessions: number;
  totalUsers: number;
  vouchersCreated: number;
  vouchersUsed: number;
}

interface SalesData {
  daily: { amount: number; count: number };
  weekly: { amount: number; count: number };
  monthly: { amount: number; count: number };
  total: { amount: number; count: number };
}

interface ChartData {
  dailySignups: { day: string; count: number }[];
  dailySales: { day: string; revenue: number; count: number }[];
  activeSessions: number;
  expiredSessions: number;
}

interface KpiData {
  avgSessionDurationMin: number;
  avgBytesPerUser: number;
  reconnectRate: number;
  completionRate: number;
}

interface RevenueData {
  combinedRevenue: number;
  totalRevenue: number;
  pendingRevenue: number;
}

interface AccessLog {
  event: string;
  full_name: string;
  detail: string;
  created_at: string;
}

function fmtBytes(bytes: number): string {
  if (bytes > 1_073_741_824) return (bytes / 1_073_741_824).toFixed(2) + ' GB';
  if (bytes > 1_048_576) return (bytes / 1_048_576).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function fmtDate(d: string): string {
  try { return new Date(d).toLocaleString(); } catch { return d; }
}

export default function Dashboard({ onNavigate }: { onNavigate?: (s: string) => void }) {
  const { user } = useAuth();
  const role = user?.role || 'Staff';
  const isMgmt = role === 'CEO' || role === 'Manager';

  const [staffStats, setStaffStats] = useState<StaffStats | null>(null);
  const [sales, setSales] = useState<SalesData | null>(null);
  const [charts, setCharts] = useState<ChartData | null>(null);
  const [kpis, setKpis] = useState<KpiData | null>(null);
  const [revenue, setRevenue] = useState<RevenueData | null>(null);
  const [logs, setLogs] = useState<AccessLog[]>([]);

  const loadAll = useCallback(() => {
    if (role === 'Staff') {
      api.get<StaffStats>('/staff/stats').then(setStaffStats).catch(() => {});
    }
    if (isMgmt) {
      api.get<ChartData>('/charts').then(setCharts).catch(() => {});
      api.get<SalesData>('/dashboard/sales').then(setSales).catch(() => {});
      api.get<KpiData>('/customer-kpis').then(setKpis).catch(() => {});
      api.get<RevenueData>('/revenue').then(setRevenue).catch(() => {});
    }
    api.get<AccessLog[]>('/access-log').then(d => setLogs(d.slice(-10).reverse())).catch(() => {});
  }, [role, isMgmt]);

  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 30000);
    return () => clearInterval(interval);
  }, [loadAll]);

  const statCards = role === 'Staff' && staffStats ? [
    { label: 'Active Sessions', value: staffStats.activeSessions, color: 'cyan', section: 'sessions' },
    { label: 'Total Users', value: staffStats.totalUsers, color: 'pink' },
    { label: 'Vouchers Created', value: staffStats.vouchersCreated, color: 'purple' },
    { label: 'Vouchers Used', value: staffStats.vouchersUsed, color: 'orange' },
  ] : [
    { label: 'Active Sessions', value: charts?.activeSessions ?? '—', color: 'cyan', section: 'sessions' },
    { label: 'Total Users', value: '—', color: 'pink' },
    { label: 'Vouchers Created', value: '—', color: 'purple' },
    { label: 'Vouchers Used', value: '—', color: 'orange' },
    { label: 'Revenue (USD)', value: revenue ? '$' + (revenue.combinedRevenue ?? revenue.totalRevenue).toFixed(2) : '—', color: 'green', section: 'reports' },
    { label: 'Pending Payments', value: revenue ? '$' + revenue.pendingRevenue.toFixed(2) : '—', color: 'blue', section: 'reports' },
  ];

  return (
    <div className="dashboard">
      <div className="section-head">
        <div>
          <h2 className="section-head-title">Dashboard</h2>
          <p className="section-head-desc">Real-time network overview</p>
        </div>
      </div>

      <div className="stats-grid">
        {statCards.map(s => (
          <div
            key={s.label}
            className={'stat-card stat-' + s.color + (s.section ? ' clickable' : '')}
            onClick={() => s.section && onNavigate?.(s.section)}
          >
            <span className="stat-label">{s.label}</span>
            <span className="stat-number">{s.value}</span>
          </div>
        ))}
      </div>

      {isMgmt && sales && (
        <div className="chart-section">
          <div className="section-head" style={{ marginTop: '2rem' }}>
            <h2 className="section-head-title">Sales Performance</h2>
            <p className="section-head-desc">Voucher sales overview</p>
          </div>
          <div className="stats-grid stats-grid--compact" style={{ marginBottom: '1.5rem' }}>
            {[
              { label: 'Today', value: '$' + sales.daily.amount.toFixed(2) + ' (' + sales.daily.count + ')', color: 'green' },
              { label: 'This Week', value: '$' + sales.weekly.amount.toFixed(2) + ' (' + sales.weekly.count + ')', color: 'cyan' },
              { label: 'This Month', value: '$' + sales.monthly.amount.toFixed(2) + ' (' + sales.monthly.count + ')', color: 'purple' },
              { label: 'All Time', value: '$' + sales.total.amount.toFixed(2) + ' (' + sales.total.count + ')', color: 'orange' },
            ].map(s => (
              <div key={s.label} className={'stat-card stat-' + s.color}>
                <span className="stat-label">{s.label}</span>
                <span className="stat-number">{s.value}</span>
              </div>
            ))}
          </div>

          {charts && (
            <>
              <div className="section-head" style={{ marginTop: '2rem' }}>
                <h2 className="section-head-title">Analytics</h2>
                <p className="section-head-desc">Daily user signups</p>
              </div>
              <div className="card chart-card">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={charts.dailySignups}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3e" />
                    <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: '#111', border: '1px solid #2a2a3e', borderRadius: 6, color: '#e2e8f0' }} />
                    <Bar dataKey="count" fill="#ff007f" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="section-head" style={{ marginTop: '2rem' }}>
                <h2 className="section-head-title">Revenue Streams</h2>
                <p className="section-head-desc">Daily sales — last 7 days</p>
              </div>
              <div className="card chart-card">
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={charts.dailySales}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3e" />
                    <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: '#111', border: '1px solid #2a2a3e', borderRadius: 6, color: '#e2e8f0' }} />
                    <Area type="monotone" dataKey="revenue" stroke="#00e5ff" fill="rgba(0,229,255,0.1)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          {kpis && (
            <div className="stats-grid" style={{ marginTop: '1.5rem' }}>
              <div className="stat-card stat-pink">
                <span className="stat-label">Avg Session</span>
                <span className="stat-number">{kpis.avgSessionDurationMin} min</span>
              </div>
              <div className="stat-card stat-cyan">
                <span className="stat-label">Avg Data/User</span>
                <span className="stat-number">{fmtBytes(kpis.avgBytesPerUser)}</span>
              </div>
              <div className="stat-card stat-purple">
                <span className="stat-label">Reconnect Rate</span>
                <span className="stat-number">{kpis.reconnectRate}%</span>
              </div>
              <div className="stat-card stat-green">
                <span className="stat-label">Completion</span>
                <span className="stat-number">{kpis.completionRate}%</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="section-head" style={{ marginTop: '2rem' }}>
        <h2 className="section-head-title">Recent Activity</h2>
      </div>
      <div className="card card-table">
        {logs.length === 0 ? (
          <div className="table-empty"><p>No recent activity.</p></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>User</th>
                <th>Detail</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={i}>
                  <td>{l.event}</td>
                  <td style={{ color: '#fff', fontWeight: 600 }}>{l.full_name}</td>
                  <td>{l.detail || <span className="muted">—</span>}</td>
                  <td>{fmtDate(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
