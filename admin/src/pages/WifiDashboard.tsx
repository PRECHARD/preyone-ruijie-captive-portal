import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { deviceShort } from '../utils/device';
import {
  FiRadio, FiActivity, FiCreditCard, FiServer, FiSmartphone, FiTrendingUp,
  FiGrid, FiWifi, FiUsers, FiDollarSign, FiKey, FiShield, FiClock, FiChevronRight,
} from 'react-icons/fi';
import './Dashboard.css';
import './SectorDashboards.css';

interface SalesItemized { package_name: string; quantity: number; price: number; total_revenue: number }
interface WeeklyPoint { day: string; revenue: number }
interface StaffMatrix { id: string; full_name: string; role: string; vouchers_sold_today: number; revenue_today: number; last_active: string | null }
interface HourlyVel { hour: number; volume: number; revenue: number }
interface Activity { id: string; code: string; package_name: string; price_amount: number; created_at: string; sold_by_name: string | null }
interface SalesSummary {
  mySales: number
  platformDaily: number
  platformYesterday: number
  weekly: WeeklyPoint[]
  monthly: number
  target: number
  matrix: StaffMatrix[]
  velocity: HourlyVel[]
  activity: Activity[]
  itemized: SalesItemized[]
}
interface WifiDashboardData {
  aps: {
    total: number; online: number; offline: number; clients: number;
    gateways: { total: number; online: number; byModel: { dev_model: string; online: number; total: number }[] };
  };
  apsList: {
    name: string; model: string | null; mac_address: string; ip_address: string | null;
    location: string | null; status: string; firmware_version: string | null;
    uptime_seconds: number; clients_count: number; last_seen: string;
  }[];
  clients: {
    user_id: string; full_name: string | null; mac_address: string | null; ip_address: string | null;
    connected_at: string; session_expires_at: string; voucher_code: string | null;
    user_agent: string | null; package_tier: string | null;
    bandwidth_up_kbps: number | null; bandwidth_down_kbps: number | null;
    data_used_bytes: number | null; data_quota_bytes: number | null; session_start: string | null;
  }[];
  vouchers: {
    activeSessions: number; activeVouchers: number; redeemedToday: number; createdToday: number;
    pendingApprovals: number; connectionsToday: number; signupsToday: number; authSuccessRate: number;
  };
  connectionLog: {
    id: number; event: string; mac_address: string | null; ip_address: string | null;
    detail: string | null; created_at: string; voucher_code: string | null;
  }[];
  voucherUsage: {
    voucher_code: string; redeemed_by: string | null; mac_address: string | null;
    ip_address: string | null; redeemed_at: string;
    holder_name: string | null; alias: string | null; phone: string | null; user_agent: string | null;
    package_tier: string | null; price_amount: string | null;
  }[];
}

const TABS = [
  { id: 'overview', label: 'Command Center', icon: FiGrid },
  { id: 'network', label: 'Network', icon: FiWifi },
  { id: 'sessions', label: 'Sessions', icon: FiUsers },
  { id: 'revenue', label: 'Revenue', icon: FiDollarSign },
  { id: 'vouchers', label: 'Vouchers', icon: FiKey },
  { id: 'access', label: 'Access Log', icon: FiShield },
] as const;
type TabId = typeof TABS[number]['id'];

function fmtMoney(n: number): string {
  return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtBytes(b?: number | null): string {
  if (b == null) return '—';
  if (b > 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + ' GB';
  if (b > 1_048_576) return (b / 1_048_576).toFixed(0) + ' MB';
  if (b > 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function fmtUptime(s?: number | null): string {
  if (!s) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Sparkline({ data, w = 92, h = 28 }: { data: { revenue: number }[]; w?: number; h?: number }) {
  if (!data.length) return <svg width={w} height={h} />;
  const max = Math.max(...data.map(d => d.revenue), 1);
  const pts = data.map((d, i) => ((i * w) / Math.max(1, data.length - 1)) + ',' + (h - 2 - (d.revenue / max) * (h - 6))).join(' ');
  const area = '0,' + h + ' ' + pts + ' ' + w + ',' + h;
  const gid = 'sg' + Math.abs(data.length * 7 + data[0].revenue | 0);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="spark-svg">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00F0FF" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#00F0FF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline points={pts} fill="none" stroke="#00F0FF" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function RadialGauge({ pct, label }: { pct: number; label: string }) {
  const p = Math.max(0, Math.min(100, pct));
  const r = 26, sw = 6, c = 32;
  const circ = 2 * Math.PI * r;
  return (
    <div className="gauge-wrap">
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle cx={c} cy={c} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth={sw} fill="none" />
        <circle cx={c} cy={c} r={r} stroke="#A855F7" strokeWidth={sw} fill="none"
          strokeDasharray={circ} strokeDashoffset={circ - (p / 100) * circ}
          strokeLinecap="round" transform="rotate(-90 32 32)" className="gauge-arc" />
        <text x="32" y="36" textAnchor="middle" className="gauge-pct">{Math.round(p)}%</text>
      </svg>
      <span className="gauge-label">{label}</span>
    </div>
  );
}

function BarChart({ data }: { data: { hour: number; volume: number; revenue: number }[] }) {
  const max = Math.max(...data.map(d => Math.max(d.volume, d.revenue / 10)), 1);
  return (
    <div className="bar-chart">
      {data.map(d => (
        <div key={d.hour} className="bar-col" title={`${d.hour}:00 — ${d.volume} sold · ${fmtMoney(d.revenue)}`}>
          <div className="bar-track">
            <div className="bar-fill" style={{ height: `${Math.max(4, (Math.max(d.volume, d.revenue / 10) / max) * 100)}%` }} />
          </div>
          <span className="bar-x">{d.hour}</span>
        </div>
      ))}
    </div>
  );
}

function drift(p: number, y: number): { v: number; up: boolean } {
  if (y <= 0) return { v: 0, up: p > 0 };
  const v = Math.round(((p - y) / y) * 100);
  return { v, up: v >= 0 };
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

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="hx-section-head">
      <div className="hx-title-row">
        <span className="hx-title-dot" />
        <h3>{title}</h3>
      </div>
      {sub && <p>{sub}</p>}
    </div>
  );
}

export default function WifiDashboard({ onNavigate }: { onNavigate?: (s: string) => void }) {
  const [data, setData] = useState<WifiDashboardData | null>(null);
  const [sales, setSales] = useState<SalesSummary | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<TabId>('overview');

  const load = useCallback(() => {
    api.get<WifiDashboardData>('/dashboard/wifi').then(setData).catch((e) => setError(e.message || 'Failed to load'));
    api.get<SalesSummary>('/dashboard/ultranet/sales-summary').then((s) => {
      if (!s || typeof s !== 'object' || !Array.isArray(s.weekly)) return;
      setSales({
        ...s,
        weekly: Array.isArray(s.weekly) ? s.weekly : [],
        matrix: Array.isArray(s.matrix) ? s.matrix : [],
        velocity: Array.isArray(s.velocity) ? s.velocity : [],
        activity: Array.isArray(s.activity) ? s.activity : [],
        itemized: Array.isArray(s.itemized) ? s.itemized : [],
        mySales: Number(s.mySales) || 0,
        platformDaily: Number(s.platformDaily) || 0,
        platformYesterday: Number(s.platformYesterday) || 0,
        monthly: Number(s.monthly) || 0,
        target: Number(s.target) || 0,
      });
    }).catch(() => {});
  }, []);

  useEffect(() => { load(); const i = setInterval(load, 30000); return () => clearInterval(i); }, [load]);

  const v = data?.vouchers;
  const weekTotal = sales ? sales.weekly.reduce((s, p) => s + p.revenue, 0) : 0;
  const d = sales ? drift(sales.platformDaily, sales.platformYesterday) : null;
  const apHealth = data && data.aps.total > 0 ? Math.round((data.aps.online / data.aps.total) * 100) : 0;
  const gwHealth = data && data.aps.gateways.total > 0 ? Math.round((data.aps.gateways.online / data.aps.gateways.total) * 100) : 0;
  const monthPct = sales && sales.target > 0 ? Math.min(100, (sales.monthly / sales.target) * 100) : 0;

  return (
    <div className="dashboard sector-dashboard un-shell">
      {/* ── Hero command header ── */}
      <div className="un-hero">
        <div className="un-hero-glow" />
        <div className="un-hero-top">
          <div>
            <div className="un-eyebrow">ULTRANET // NETWORK OPERATIONS</div>
            <h2 className="un-title">Preyone UltraNet WiFi</h2>
            <p className="un-sub">Real-time captive portal, RF &amp; revenue telemetry</p>
          </div>
          <div className="un-hero-status">
            <span className="live-pill"><span className="live-dot" /> LIVE <span className="live-sub">30s</span></span>
            <span className="un-clock"><FiClock size={12} /> {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
          </div>
        </div>

        <div className="un-hero-stats">
          <div className="un-stat">
            <span className="un-stat-label">AP Uptime</span>
            <span className="un-stat-value un-cyan">{data ? apHealth : '—'}%</span>
            <span className="un-stat-sub">{data ? `${data.aps.online}/${data.aps.total} online` : 'loading'}</span>
          </div>
          <div className="un-stat">
            <span className="un-stat-label">Gateway Health</span>
            <span className="un-stat-value un-purple">{data ? gwHealth : '—'}%</span>
            <span className="un-stat-sub">{data ? `${data.aps.gateways.online}/${data.aps.gateways.total} up` : 'loading'}</span>
          </div>
          <div className="un-stat">
            <span className="un-stat-label">Live Sessions</span>
            <span className="un-stat-value un-green">{v?.activeSessions ?? '—'}</span>
            <span className="un-stat-sub">{v?.signupsToday ?? 0} signups today</span>
          </div>
          <div className="un-stat">
            <span className="un-stat-label">Today Revenue</span>
            <span className="un-stat-value un-gold">{sales ? fmtMoney(sales.platformDaily) : '—'}</span>
            <span className={'un-stat-sub ' + (d ? (d.up ? 'un-up' : 'un-down') : '')}>
              {d ? `${d.up ? '▲' : '▼'} ${Math.abs(d.v)}% vs yesterday` : 'loading'}
            </span>
          </div>
          <div className="un-stat">
            <span className="un-stat-label">Auth Success</span>
            <span className="un-stat-value un-cyan">{v?.authSuccessRate ?? 0}%</span>
            <span className="un-stat-sub">{v?.connectionsToday ?? 0} connections</span>
          </div>
          <div className="un-stat">
            <span className="un-stat-label">Vouchers Live</span>
            <span className="un-stat-value un-purple">{v?.activeVouchers ?? '—'}</span>
            <span className="un-stat-sub">{v?.redeemedToday ?? 0} redeemed today</span>
          </div>
        </div>
      </div>

      {/* ── Tab navigation ── */}
      <div className="un-tabs" role="tablist">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={'un-tab' + (tab === t.id ? ' is-active' : '')}
              onClick={() => setTab(t.id)}
            >
              <Icon size={14} />
              <span>{t.label}</span>
              {tab === t.id && <span className="un-tab-glow" />}
            </button>
          );
        })}
      </div>

      {error && !data && (
        <div className="card sector-error"><p>{error}</p><p className="muted">Try refreshing the page, or contact support.</p></div>
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
          {/* ══════ COMMAND CENTER ══════ */}
          {tab === 'overview' && (
            <>
              <div className="hud-grid">
                <div className="hud-card hud-card--cyan">
                  <div className="hud-label">My Sales (Today)</div>
                  <div className="hud-value">{sales ? fmtMoney(sales.mySales) : '—'}</div>
                  <div className="hud-meta">your personal performance</div>
                </div>
                <div className="hud-card">
                  <div className="hud-label">Total Daily Revenue</div>
                  <div className="hud-value">{sales ? fmtMoney(sales.platformDaily) : '—'}</div>
                  {d && <div className={'hud-meta ' + (d.up ? 'up' : 'down')}>{d.up ? '▲' : '▼'} {Math.abs(d.v)}% vs yesterday</div>}
                </div>
                <div className="hud-card">
                  <div className="hud-label">Weekly Revenue</div>
                  <div className="hud-value">{sales ? fmtMoney(weekTotal) : '—'}</div>
                  <div className="hud-meta"><Sparkline data={sales ? sales.weekly : []} /></div>
                </div>
                <div className="hud-card">
                  <div className="hud-label">Monthly Revenue</div>
                  <div className="hud-value">{sales ? fmtMoney(sales.monthly) : '—'}</div>
                  <div className="hud-meta hud-meta--row">
                    <RadialGauge pct={monthPct} label={sales && sales.target > 0 ? 'of ' + fmtMoney(sales.target) : 'no target set'} />
                  </div>
                </div>
              </div>

              <div className="un-two-col">
                <div className="un-panel">
                  <SectionTitle title="Revenue Velocity · 24h" sub="Voucher sales per hour" />
                  {sales && sales.velocity.length ? <BarChart data={sales.velocity} /> : <div className="muted">No data</div>}
                </div>
                <div className="un-panel">
                  <SectionTitle title="Live Activity Stream" sub="Latest voucher sales" />
                  {sales && sales.activity.length ? (
                    <div className="activity-list">
                      {sales.activity.slice(0, 8).map((a, idx) => (
                        <div key={idx} className="activity-item">
                          <span>{a.sold_by_name || 'Staff'}</span> sold <span>{a.package_name || a.code}</span>
                          <b> {fmtMoney(a.price_amount)}</b> <span className="muted">{fmtAgo(a.created_at)}</span>
                        </div>
                      ))}
                    </div>
                  ) : <div className="muted">No recent activity</div>}
                </div>
              </div>

              <div className="un-panel">
                <SectionTitle title="Infrastructure Snapshot" sub="Core network health at a glance" />
                <div className="un-snap-grid">
                  <button className="un-snap" onClick={() => onNavigate?.('ap-health')}>
                    <FiRadio size={16} />
                    <span className="un-snap-k">Access Points</span>
                    <span className="un-snap-v">{data.aps.online}<small>/{data.aps.total} online</small></span>
                    <FiChevronRight size={14} className="un-snap-arrow" />
                  </button>
                  <button className="un-snap" onClick={() => onNavigate?.('sessions')}>
                    <FiActivity size={16} />
                    <span className="un-snap-k">Active Sessions</span>
                    <span className="un-snap-v">{v?.activeSessions ?? 0}</span>
                    <FiChevronRight size={14} className="un-snap-arrow" />
                  </button>
                  <button className="un-snap" onClick={() => onNavigate?.('vouchers')}>
                    <FiCreditCard size={16} />
                    <span className="un-snap-k">Vouchers</span>
                    <span className="un-snap-v">{v?.activeVouchers ?? 0}<small> live</small></span>
                    <FiChevronRight size={14} className="un-snap-arrow" />
                  </button>
                  <button className="un-snap" onClick={() => setTab('revenue')}>
                    <FiTrendingUp size={16} />
                    <span className="un-snap-k">Month to Date</span>
                    <span className="un-snap-v">{sales ? fmtMoney(sales.monthly) : '—'}</span>
                    <FiChevronRight size={14} className="un-snap-arrow" />
                  </button>
                </div>
              </div>
            </>
          )}

          {/* ══════ NETWORK ══════ */}
          {tab === 'network' && (
            <>
              <div className="hud-grid">
                <div className="hud-card hud-card--cyan">
                  <div className="hud-label">Associated Clients</div>
                  <div className="hud-value">{data.aps.clients}</div>
                  <div className="hud-meta">across {data.aps.total} access points</div>
                </div>
                <div className="hud-card">
                  <div className="hud-label">Gateways Online</div>
                  <div className="hud-value">{data.aps.gateways.online}<span className="hud-unit">/{data.aps.gateways.total}</span></div>
                  <div className="hud-meta">{gwHealth}% health</div>
                </div>
                <div className="hud-card">
                  <div className="hud-label">Offline APs</div>
                  <div className={'hud-value ' + (data.aps.offline > 0 ? 'un-down' : '')}>{data.aps.offline}</div>
                  <div className="hud-meta">{data.aps.offline > 0 ? 'attention required' : 'all clear'}</div>
                </div>
                <div className="hud-card">
                  <div className="hud-label">RF Health Index</div>
                  <div className="hud-value">{apHealth}%</div>
                  <div className="hud-meta"><RadialGauge pct={apHealth} label="uptime" /></div>
                </div>
              </div>

              <div className="un-panel">
                <SectionTitle title="Access Point Monitoring" sub="Online status · clients · firmware · signal" />
                {data.apsList.length === 0 ? (
                  <div className="table-empty"><p>No access points registered yet.</p></div>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table un-table">
                      <thead><tr><th>AP</th><th>Model</th><th>Location</th><th>Status</th><th>Clients</th><th>Uptime</th><th>Firmware</th><th>Last Seen</th></tr></thead>
                      <tbody>
                        {data.apsList.map((a) => (
                          <tr key={a.mac_address}>
                            <td>
                              <span className="code-cell">{a.name}</span>
                              <span className="muted" style={{ fontSize: 11, display: 'block' }}>{a.ip_address || '—'} · {a.mac_address}</span>
                            </td>
                            <td>{a.model || '—'}</td>
                            <td>{a.location || '—'}</td>
                            <td><span className={'badge badge--' + (a.status === 'online' ? 'yes' : a.status === 'warning' ? 'warn' : 'no')}>{a.status}</span></td>
                            <td>{a.clients_count}</td>
                            <td>{fmtUptime(a.uptime_seconds)}</td>
                            <td className="muted" style={{ fontSize: 11 }}>{a.firmware_version || '—'}</td>
                            <td className="muted">{fmtAgo(a.last_seen)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {data.aps.gateways.byModel.length > 0 && (
                <div className="chip-row">
                  {data.aps.gateways.byModel.map((g) => (
                    <span key={g.dev_model || 'model'} className="sector-chip">
                      <FiServer size={12} /> {g.dev_model || 'Gateway'} <b>{g.online}/{g.total}</b>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ══════ SESSIONS ══════ */}
          {tab === 'sessions' && (
            <>
              <div className="hud-grid">
                <div className="hud-card hud-card--cyan"><div className="hud-label">Active Sessions</div><div className="hud-value">{v?.activeSessions ?? 0}</div></div>
                <div className="hud-card"><div className="hud-label">Signups Today</div><div className="hud-value">{v?.signupsToday ?? 0}</div></div>
                <div className="hud-card"><div className="hud-label">Connections Today</div><div className="hud-value">{v?.connectionsToday ?? 0}</div></div>
                <div className="hud-card"><div className="hud-label">Pending Approvals</div><div className="hud-value">{v?.pendingApprovals ?? 0}</div></div>
              </div>

              <div className="un-panel">
                <SectionTitle title="Active Client Sessions" sub="IP · MAC · device · bandwidth · data usage" />
                {data.clients.length === 0 ? (
                  <div className="table-empty"><p>No active client sessions.</p></div>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table un-table">
                      <thead><tr><th>Client</th><th>Device</th><th>MAC Address</th><th>IP</th><th>Voucher</th><th>Package</th><th>Speed ↓/↑</th><th>Data Used</th><th>Connected</th><th>Expires</th></tr></thead>
                      <tbody>
                        {data.clients.map((c) => {
                          const used = c.data_used_bytes ?? 0;
                          const total = c.data_quota_bytes;
                          const pct = total ? Math.min(100, Math.round((used / total) * 100)) : null;
                          return (
                            <tr key={c.user_id}>
                              <td>{c.full_name || '—'}</td>
                              <td><span className="device-cell"><FiSmartphone size={12} /> {deviceShort(c.user_agent)}</span></td>
                              <td className="vd-mono" style={{ fontSize: 11 }}>{c.mac_address || '—'}</td>
                              <td style={{ fontSize: 12 }}>{c.ip_address || '—'}</td>
                              <td>{c.voucher_code ? <span className="code-cell">{c.voucher_code}</span> : '—'}</td>
                              <td>{c.package_tier || '—'}</td>
                              <td className="muted" style={{ fontSize: 11 }}>
                                {c.bandwidth_down_kbps != null && c.bandwidth_up_kbps != null
                                  ? `${Math.round(c.bandwidth_down_kbps / 1000 * 10) / 10}/${Math.round(c.bandwidth_up_kbps / 1000 * 10) / 10} Mbps`
                                  : '—'}
                              </td>
                              <td>
                                <span className="muted" style={{ fontSize: 11 }}>{fmtBytes(used)}</span>
                                {pct != null && <div className="data-bar-track"><div className="data-bar-fill" style={{ width: pct + '%' }} /></div>}
                              </td>
                              <td className="muted">{c.session_start ? fmtAgo(c.session_start) : '—'}</td>
                              <td className="muted">{c.session_expires_at ? fmtAgo(c.session_expires_at) : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ══════ REVENUE ══════ */}
          {tab === 'revenue' && (
            <>
              <div className="hud-grid">
                <div className="hud-card hud-card--cyan">
                  <div className="hud-label">Today</div>
                  <div className="hud-value">{sales ? fmtMoney(sales.platformDaily) : '—'}</div>
                  {d && <div className={'hud-meta ' + (d.up ? 'up' : 'down')}>{d.up ? '▲' : '▼'} {Math.abs(d.v)}% vs yesterday</div>}
                </div>
                <div className="hud-card">
                  <div className="hud-label">Yesterday</div>
                  <div className="hud-value">{sales ? fmtMoney(sales.platformYesterday) : '—'}</div>
                  <div className="hud-meta">baseline comparison</div>
                </div>
                <div className="hud-card">
                  <div className="hud-label">This Week</div>
                  <div className="hud-value">{sales ? fmtMoney(weekTotal) : '—'}</div>
                  <div className="hud-meta"><Sparkline data={sales ? sales.weekly : []} /></div>
                </div>
                <div className="hud-card">
                  <div className="hud-label">This Month</div>
                  <div className="hud-value">{sales ? fmtMoney(sales.monthly) : '—'}</div>
                  <div className="hud-meta"><RadialGauge pct={monthPct} label={sales && sales.target > 0 ? 'of target' : 'no target'} /></div>
                </div>
              </div>

              <div className="un-two-col">
                <div className="un-panel">
                  <SectionTitle title="What They Sold · Today" sub="Package breakdown" />
                  {sales && sales.itemized.length ? (
                    <table className="data-table un-table">
                      <thead><tr><th>Package</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
                      <tbody>
                        {sales.itemized.map((i, idx) => (
                          <tr key={idx}><td>{i.package_name}</td><td>{i.quantity}</td><td>{fmtMoney(i.price)}</td><td className="un-money">{fmtMoney(i.total_revenue)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <div className="muted">No sales today</div>}
                </div>
                <div className="un-panel">
                  <SectionTitle title="Sales Velocity · 24h" sub="Volume and revenue by hour" />
                  {sales && sales.velocity.length ? <BarChart data={sales.velocity} /> : <div className="muted">No data</div>}
                </div>
              </div>

              <div className="un-two-col">
                <div className="un-panel">
                  <SectionTitle title="Staff Sales Matrix" sub="Team performance today" />
                  {sales && sales.matrix.length ? (
                    <div className="table-scroll">
                      <table className="data-table un-table">
                        <thead><tr><th>Staff</th><th>Role</th><th>Vouchers</th><th>Revenue</th><th>Last Active</th></tr></thead>
                        <tbody>
                          {sales.matrix.map((m, idx) => (
                            <tr key={idx}>
                              <td>{m.full_name}</td>
                              <td><span className="badge badge--yes">{m.role}</span></td>
                              <td>{m.vouchers_sold_today}</td>
                              <td className="un-money">{fmtMoney(m.revenue_today)}</td>
                              <td className="muted">{m.last_active ? fmtAgo(m.last_active) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <div className="muted">No data</div>}
                </div>
                <div className="un-panel">
                  <SectionTitle title="Weekly Trend" sub="Last 7 days of revenue" />
                  {sales ? (
                    <div className="un-week">
                      {sales.weekly.map((w, i) => {
                        const max = Math.max(...sales.weekly.map(x => x.revenue), 1);
                        return (
                          <div key={i} className="un-week-row">
                            <span className="un-week-day">{w.day}</span>
                            <div className="un-week-track"><div className="un-week-fill" style={{ width: `${(w.revenue / max) * 100}%` }} /></div>
                            <span className="un-week-val">{fmtMoney(w.revenue)}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : <div className="muted">No data</div>}
                </div>
              </div>
            </>
          )}

          {/* ══════ VOUCHERS ══════ */}
          {tab === 'vouchers' && (
            <>
              <div className="hud-grid">
                <div className="hud-card hud-card--cyan"><div className="hud-label">In Use Now</div><div className="hud-value">{v?.activeVouchers ?? 0}</div></div>
                <div className="hud-card"><div className="hud-label">Redeemed Today</div><div className="hud-value">{v?.redeemedToday ?? 0}</div></div>
                <div className="hud-card"><div className="hud-label">Created Today</div><div className="hud-value">{v?.createdToday ?? 0}</div></div>
                <div className="hud-card"><div className="hud-label">Pending Approvals</div><div className="hud-value">{v?.pendingApprovals ?? 0}</div></div>
              </div>

              <div className="un-panel">
                <SectionTitle title="Voucher Usage" sub="Users connected using the vouchers we sold · device · package" />
                {data.voucherUsage.length === 0 ? (
                  <div className="table-empty"><p>No voucher redemptions recorded yet.</p></div>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table un-table">
                      <thead><tr><th>Voucher</th><th>User</th><th>Device</th><th>Phone</th><th>MAC</th><th>Package</th><th>Price</th><th>Redeemed</th></tr></thead>
                      <tbody>
                        {data.voucherUsage.map((vu) => (
                          <tr key={vu.voucher_code + ':' + vu.redeemed_at}>
                            <td><span className="code-cell">{vu.voucher_code}</span></td>
                            <td>{vu.holder_name || vu.redeemed_by || vu.alias || '—'}
                              {vu.holder_name && vu.alias && <span className="muted" style={{ display: 'block', fontSize: 11 }}>{vu.alias}</span>}
                            </td>
                            <td>{vu.user_agent ? <span className="device-cell"><FiSmartphone size={12} /> {deviceShort(vu.user_agent)}</span> : '—'}</td>
                            <td>{vu.phone || '—'}</td>
                            <td className="vd-mono" style={{ fontSize: 11 }}>{vu.mac_address || '—'}</td>
                            <td>{vu.package_tier || '—'}</td>
                            <td className="un-money">{vu.price_amount ? fmtMoney(parseFloat(vu.price_amount)) : '—'}</td>
                            <td className="muted">{fmtAgo(vu.redeemed_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ══════ ACCESS LOG ══════ */}
          {tab === 'access' && (
            <>
              <div className="hud-grid">
                <div className="hud-card hud-card--cyan"><div className="hud-label">Connections Today</div><div className="hud-value">{v?.connectionsToday ?? 0}</div></div>
                <div className="hud-card"><div className="hud-label">Auth Success</div><div className="hud-value">{v?.authSuccessRate ?? 0}%</div></div>
                <div className="hud-card"><div className="hud-label">Signups Today</div><div className="hud-value">{v?.signupsToday ?? 0}</div></div>
                <div className="hud-card"><div className="hud-label">Log Entries</div><div className="hud-value">{data.connectionLog.length}</div></div>
              </div>

              <div className="un-panel">
                <SectionTitle title="Connections &amp; Authentication" sub="Live captive-portal access log" />
                {data.connectionLog.length === 0 ? (
                  <div className="table-empty"><p>No connection activity yet.</p></div>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table un-table">
                      <thead><tr><th>Event</th><th>MAC</th><th>IP</th><th>Voucher</th><th>Detail</th><th>When</th></tr></thead>
                      <tbody>
                        {data.connectionLog.map((l) => (
                          <tr key={l.id}>
                            <td><span className="badge badge--yes">{l.event}</span></td>
                            <td className="vd-mono" style={{ fontSize: 11 }}>{l.mac_address || '—'}</td>
                            <td style={{ fontSize: 12 }}>{l.ip_address || '—'}</td>
                            <td>{l.voucher_code ? <span className="code-cell">{l.voucher_code}</span> : '—'}</td>
                            <td className="muted" style={{ fontSize: 11 }}>{l.detail || '—'}</td>
                            <td className="muted">{fmtAgo(l.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
