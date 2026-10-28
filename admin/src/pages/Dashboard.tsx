import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, AreaChart, Area,
} from 'recharts';
import { FiUsers, FiCreditCard, FiDollarSign, FiClock, FiActivity, FiTrendingUp, FiShoppingBag, FiWifi, FiHardDrive, FiAlertTriangle, FiRadio } from 'react-icons/fi';
import { DEFAULT_REVENUE_TARGET, resolveMonthlyTarget, monthlyTargetPctRaw } from '../utils/revenueTarget';
import './Dashboard.css';

interface DashboardData {
  metrics: {
    totalUsers: number;
    vouchersCreated: number;
    vouchersUsed: number;
    totalRevenue: number;
    activeSessions: number;
    pendingPayments: { count: number; total: number };
    activeVouchers: number;
    dataConsumedToday: number;
    fupTriggered: number;
    apOnline: number;
    apTotal: number;
  };
  sales: {
    daily: { amount: number; count: number };
    weekly: { amount: number; count: number };
    monthly: { amount: number; count: number };
  };
  charts: {
    dailySales: { day: string; revenue: number; count: number }[];
    dailySignups: { day: string; count: number }[];
  };
  sales24h: { hour: string; count: number; revenue: number }[];
  byTier: { package_tier: string; count: number; total: number }[];
  recentSales: {
    voucher_code: string;
    amount: number;
    currency: string;
    sold_by_name: string;
    sold_at: string;
    payment_method?: string;
    payment_reference?: string;
    package_tier?: string;
    client_name?: string;
    client_phone?: string;
  }[];
}

interface StaffStats {
  activeSessions: number;
  totalUsers: number;
  vouchersCreated: number;
  vouchersUsed: number;
}

function fmtN(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function fmtBytes(bytes: number): string {
  if (bytes > 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + ' GB';
  if (bytes > 1_048_576) return (bytes / 1_048_576).toFixed(0) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function fmtTimeAgo(d: string): string {
  try {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch { return d; }
}

const tooltipStyle = { background: '#111', border: '1px solid #2a2a3e', borderRadius: 6, color: '#e2e8f0', fontSize: 12 };

/**
 * Baseline monthly revenue target.
 *
 * `/api/admin/revenue-target` is the canonical source for this number, but a
 * tenant that has never saved one answers `configured: false` and `pct: null`.
 * The Dashboard still has to show a meaningful gauge instead of "Not set", so it
 * falls back to `DEFAULT_REVENUE_TARGET` (see `utils/revenueTarget`). Saving a
 * target always wins over it — nothing is written back to the database here.
 */
const GAUGE_RADIUS = 42;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

export default function Dashboard({ onNavigate }: { onNavigate?: (s: string) => void }) {
  const { user } = useAuth();
  const role = user?.role || 'Staff';
  const isMgmt = role === 'CEO' || role === 'Manager';

  const [data, setData] = useState<DashboardData | null>(null);
  const [staffStats, setStaffStats] = useState<StaffStats | null>(null);
  const [revenueTarget, setRevenueTarget] = useState<{
    target: number; achieved: number; remaining: number; pct: number | null;
    currency: string; label: string; configured: boolean;
  } | null>(null);

  const loadAll = useCallback(() => {
    if (isMgmt) {
      api.get<DashboardData>('/dashboard').then(setData).catch(() => {});
      // Monthly revenue target (settings-backed; canonical /api/admin/revenue-target).
      api.get('/revenue-target').then(setRevenueTarget).catch(() => {});
    } else {
      api.get<StaffStats>('/staff/stats').then(setStaffStats).catch(() => {});
    }
  }, [isMgmt]);

  useEffect(() => {
    loadAll();
    const i = setInterval(loadAll, 30000);
    // A target saved in My Sales / Settings must show up immediately when the
    // operator comes back to the Dashboard instead of waiting for the poll.
    const onFocus = () => { if (!document.hidden) loadAll(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(i);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [loadAll]);

  const m = data?.metrics;

  // ── Monthly revenue target (radial gauge) ──
  // Prefer the stored target, fall back to the $500 baseline so the gauge is
  // never blank. Fetched on mount through loadAll() and refreshed every 30s,
  // on window focus and on tab visibility — the same cadence as the metrics.
  const storedTarget = Number(revenueTarget?.target);
  const targetIsCustom = Boolean(revenueTarget?.configured) && Number.isFinite(storedTarget) && storedTarget > 0;
  const targetAmount = resolveMonthlyTarget(storedTarget, DEFAULT_REVENUE_TARGET);
  const targetAchieved = Number(revenueTarget?.achieved) || 0;
  const targetCurrency = revenueTarget?.currency || 'USD';
  const rawTargetPct = monthlyTargetPctRaw(targetAchieved, targetAmount);
  const targetPct = Number.isFinite(rawTargetPct) ? Math.max(0, rawTargetPct) : 0;
  // The ring caps at a full circle; the number beside it may exceed 100%.
  const gaugePct = Math.min(100, targetPct);
  const gaugeOffset = GAUGE_CIRCUMFERENCE - (gaugePct / 100) * GAUGE_CIRCUMFERENCE;
  const targetRemaining = Math.max(0, targetAmount - targetAchieved);

  if (isMgmt && !data) {
    return (
      <div className="dashboard">
        <div className="section-head">
          <div>
            <h2 className="section-head-title">Dashboard</h2>
            <p className="section-head-desc">Loading real-time data...</p>
          </div>
        </div>
        <div className="hero-grid">{ [1,2,3,4].map(i => (
          <div key={i} className="hero-card" style={{ opacity: 0.4 }}>
            <div className="hero-icon" style={{ background: 'var(--surface2)' }} />
            <div className="hero-body">
              <div style={{ height: 10, width: 80, background: 'var(--surface2)', borderRadius: 4, marginBottom: 6 }} />
              <div style={{ height: 22, width: 120, background: 'var(--surface2)', borderRadius: 4 }} />
            </div>
          </div>
        ))}</div>
        <p style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 40, fontSize: 13 }}>Dashboard initializing…</p>
      </div>
    );
  }

  const heroCards = isMgmt ? [
    { label: 'Total Users', value: fmtN(m?.totalUsers ?? 0), icon: <FiUsers size={20} />, sub: `${fmtN(m?.activeSessions ?? 0)} active sessions`, color: 'cyan', section: 'sessions' },
    { label: 'Vouchers Created', value: fmtN(m?.vouchersCreated ?? 0), icon: <FiCreditCard size={20} />, sub: `${fmtN(m?.vouchersUsed ?? 0)} redeemed`, color: 'purple' },
    { label: 'Revenue', value: '$' + (m?.totalRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), icon: <FiDollarSign size={20} />, sub: 'All-time sales', color: 'green', section: 'reports', money: true },
    { label: 'Pending Payments', value: '$' + (m?.pendingPayments?.total ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), icon: <FiClock size={20} />, sub: `${m?.pendingPayments?.count ?? 0} Pesepay pending`, color: 'orange', section: 'reports', money: true },
  ] : staffStats ? [
    { label: 'Active Sessions', value: staffStats.activeSessions.toString(), icon: <FiActivity size={20} />, sub: 'Your clients', color: 'cyan', section: 'sessions' },
    { label: 'Total Users', value: fmtN(staffStats.totalUsers), icon: <FiUsers size={20} />, sub: 'Your referrals', color: 'pink' },
    { label: 'Vouchers Created', value: fmtN(staffStats.vouchersCreated), icon: <FiCreditCard size={20} />, sub: 'All time', color: 'purple' },
    { label: 'Vouchers Used', value: fmtN(staffStats.vouchersUsed), icon: <FiShoppingBag size={20} />, sub: 'Redeemed', color: 'orange' },
  ] : [];

  const apAllOk = m && m.apTotal > 0 && m.apOnline === m.apTotal;

  return (
    <div className="dashboard">
      <div className="section-head">
        <div>
          <h2 className="section-head-title">Dashboard</h2>
          <p className="section-head-desc">Real-time network &amp; business overview</p>
        </div>
      </div>

      {/* ── Row 1: Hero metrics ── */}
      <div className="hero-grid">{heroCards.map(c => (
        <div key={c.label} className={'hero-card hero-' + c.color + ((c as any).section ? ' clickable' : '')}
          onClick={() => (c as any).section && onNavigate?.((c as any).section)}>
          <div className="hero-icon">{c.icon}</div>
          <div className="hero-body">
            <span className="hero-label">{c.label}</span>
            <span className={'hero-value' + ((c as any).money ? ' money' : '')}>{c.value}</span>
            <span className="hero-sub">{(c as any).sub || ''}</span>
          </div>
        </div>
      ))}</div>

      {isMgmt && (
        <div className="glass-stats" style={{ marginTop: '1rem' }}>
          <div className="glass-stat glass-stat--gold revenue-target" style={{ gridColumn: '1 / -1' }}>
            <div className="revenue-target__head">
              <span className="glass-stat__label">
                Monthly Revenue Target · {revenueTarget?.label || 'This month'}
              </span>
              <span className="glass-stat__value glass-stat__value--gold revenue-target__pct">
                {targetPct.toFixed(1)}%
              </span>
            </div>

            <div className="revenue-target__body">
              <div
                className="revenue-gauge"
                role="img"
                aria-label={`${targetPct.toFixed(1)} percent of the $${targetAmount.toFixed(2)} monthly revenue target`}
              >
                <svg className="revenue-gauge__svg" viewBox="0 0 100 100" aria-hidden="true">
                  <defs>
                    <linearGradient id="revenueGaugeGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#00ccff" />
                      <stop offset="60%" stopColor="#33e1c0" />
                      <stop offset="100%" stopColor="#f5c451" />
                    </linearGradient>
                  </defs>
                  <circle className="revenue-gauge__track" cx="50" cy="50" r={GAUGE_RADIUS} />
                  <circle
                    className="revenue-gauge__arc"
                    cx="50"
                    cy="50"
                    r={GAUGE_RADIUS}
                    strokeDasharray={GAUGE_CIRCUMFERENCE}
                    strokeDashoffset={gaugeOffset}
                  />
                </svg>
                <span className="revenue-gauge__center">
                  {targetPct.toFixed(0)}
                  <small>%</small>
                </span>
              </div>

              <div className="revenue-target__copy">
                <p className="revenue-target__achieved">
                  ${targetAchieved.toFixed(2)}
                  <span> of ${targetAmount.toFixed(2)} {targetCurrency}</span>
                </p>
                <p className="revenue-target__meta">
                  {targetIsCustom
                    ? `$${targetRemaining.toFixed(2)} to go this month`
                    : `Default target of $${DEFAULT_REVENUE_TARGET.toFixed(2)} — set your own in My Sales → Revenue Target`}
                </p>
                <div className="glass-progress" aria-hidden="true">
                  <div className="glass-progress__fill" style={{ width: `${gaugePct}%` }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isMgmt && data && (
        <>
          {/* ── Row 2: Real-time indicators ── */}
          <div className="section-head" style={{ marginTop: '1.5rem' }}>
            <h2 className="section-head-title">Right Now</h2>
            <p className="section-head-desc">Live network status</p>
          </div>
          <div className="hero-grid">
            <div className={'hero-card ' + (apAllOk ? 'hero-cyan' : 'hero-orange')}>
              <div className="hero-icon"><FiRadio size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Access Point</span>
                <span className="hero-value">{m ? `${m.apOnline}/${m.apTotal} Online` : '—'}</span>
                <span className="hero-sub">{apAllOk ? 'All healthy' : 'Offline AP detected'}</span>
              </div>
            </div>
            <div className="hero-card hero-purple">
              <div className="hero-icon"><FiWifi size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Active Vouchers</span>
                <span className="hero-value">{m?.activeVouchers ?? '—'}</span>
                <span className="hero-sub">Consuming data right now</span>
              </div>
            </div>
            <div className="hero-card hero-green">
              <div className="hero-icon"><FiHardDrive size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Data Today</span>
                <span className="hero-value">{m ? fmtBytes(m.dataConsumedToday) : '—'}</span>
                <span className="hero-sub">Total consumed in 24h</span>
              </div>
            </div>
            <div className={'hero-card ' + ((m?.fupTriggered ?? 0) > 0 ? 'hero-orange' : 'hero-cyan')}>
              <div className="hero-icon"><FiAlertTriangle size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">FUP Triggers</span>
                <span className="hero-value">{m?.fupTriggered ?? '—'}</span>
                <span className="hero-sub">Users at data cap</span>
              </div>
            </div>
          </div>

          {/* ── Row 3: Sales Performance ── */}
          <div className="section-head" style={{ marginTop: '1.5rem' }}>
            <h2 className="section-head-title">Sales Performance</h2>
            <p className="section-head-desc">Voucher revenue overview</p>
          </div>
          <div className="sales-grid">
            {[
              { label: 'Today', amount: data.sales.daily.amount, count: data.sales.daily.count, color: 'green' },
              { label: 'This Week', amount: data.sales.weekly.amount, count: data.sales.weekly.count, color: 'cyan' },
              { label: 'This Month', amount: data.sales.monthly.amount, count: data.sales.monthly.count, color: 'purple' },
              { label: 'Active Sessions', value: m?.activeSessions ?? 0, icon: <FiActivity size={18} />, color: 'pink' },
            ].map(s => (
              <div key={s.label} className={'stat-card stat-' + s.color}>
                <span className="stat-label">{s.label}</span>
                {(s as any).icon ? (
                  <span className="stat-number" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {(s as any).icon}{(s as any).value}
                  </span>
                ) : (
                  <>
                    <span className="stat-number stat-number--money"><span className="money">${(s as any).amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD</span></span>
                    <span className="stat-sub">{s.count} sale{s.count !== 1 ? 's' : ''}</span>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* ── Row 4: Sales velocity (24h) + Charts ── */}
          <div className="charts-row">
            <div className="card chart-card">
              <div className="chart-title"><FiTrendingUp size={14} /> Sales Velocity (24h)</div>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={data.sales24h}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3e" />
                  <XAxis dataKey="hour" tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={h => h ? new Date(h).toLocaleTimeString([], { hour: '2-digit' }) : ''} />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={l => new Date(l).toLocaleString()} formatter={(v: any) => [Number(v).toFixed(0), 'Sales']} />
                  <Area type="monotone" dataKey="count" stroke="#ff007f" fill="rgba(255,0,127,0.12)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="card chart-card">
              <div className="chart-title"><FiTrendingUp size={14} /> Revenue (14 days)</div>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={data.charts.dailySales}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3e" />
                  <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={d => d?.slice(5) || ''} />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={v => '$' + v} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => ['$' + Number(v).toFixed(2), 'Revenue']} />
                  <Area type="monotone" dataKey="revenue" stroke="#00e5ff" fill="rgba(0,229,255,0.12)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── Row 5: Signups + Tier Breakdown ── */}
          <div className="charts-row" style={{ marginTop: 14 }}>
            <div className="card chart-card">
              <div className="chart-title"><FiUsers size={14} /> New Signups (14 days)</div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={data.charts.dailySignups}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3e" />
                  <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={d => d?.slice(5) || ''} />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" fill="rgba(0, 229, 255, 0.12)" stroke="#00e5ff" strokeWidth={1.5} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="card chart-card">
              <div className="chart-title"><FiShoppingBag size={14} /> Top Tiers (by revenue)</div>
              <div style={{ padding: '0 4px' }}>
                {data.byTier?.length > 0 ? data.byTier.slice(0, 5).map((t, i) => {
                  const pct = data.byTier.length ? (t.total / Math.max(...data.byTier.map(x => x.total)) * 100) : 0;
                  return (
                    <div key={i} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                        <span style={{ fontWeight: 700 }}>{t.package_tier}</span>
                        <span className="money">${t.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                      <div className="tier-bar-track" style={{ height: 8 }}>
                        <div className="tier-bar-fill" style={{ width: pct + '%' }} />
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{t.count} sale{t.count !== 1 ? 's' : ''}</div>
                    </div>
                  );
                }) : <p style={{ color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>No tier data yet</p>}
              </div>
            </div>
          </div>

          {/* ── Row 6: Recent Sales ── */}
          {data.recentSales?.length > 0 && (
            <div className="card" style={{ marginTop: '1.5rem' }}>
              <div className="card-header">Recent Sales</div>
              <div className="card-table" style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead><tr><th>Code</th><th>Client</th><th>Package</th><th>Amount</th><th>Method</th><th>Sold By</th><th>Time</th></tr></thead>
                  <tbody>
                    {data.recentSales.map((s, i) => (
                      <tr key={i}>
                        <td><span className="code-cell">{s.voucher_code}</span></td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{s.client_name || '—'}</div>
                          {s.client_phone && <div className="muted">{s.client_phone}</div>}
                        </td>
                        <td>{s.package_tier || '—'}</td>
                        <td><span className="money money--sm">${Number(s.amount || 0).toFixed(2)} {s.currency || 'USD'}</span></td>
                        <td>{s.payment_method || '—'}</td>
                        <td>{s.sold_by_name || '—'}</td>
                        <td className="muted">{fmtTimeAgo(s.sold_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
