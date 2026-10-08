import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { deviceShort } from '../utils/device';
import {
  FiRadio, FiActivity, FiCreditCard, FiServer, FiSmartphone, FiTrendingUp,
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
}interface WifiDashboardData {
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

function fmtZim(n: number): string {
  return (n || 0).toLocaleString('en-ZW', { style: 'currency', currency: 'ZWL', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function Sparkline({ data }: { data: { revenue: number }[] }) {
  if (!data.length) return <svg width="80" height="24"><rect width="80" height="24" fill="none"/></svg>;
  const max = Math.max(...data.map(d => d.revenue), 1);
  const points = data.map((d, i) => ((i * 80) / Math.max(1, data.length - 1)) + ',' + (24 - (d.revenue / max) * 20)).join(' ');
  return <svg width="80" height="24" viewBox="0 0 80 24"><polyline points={points} fill="none" stroke="#00F0FF" strokeWidth="2" /></svg>;
}
function Gauge({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const r = 16, c = 18, sw = 4;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return <svg width="40" height="24"><circle cx={c} cy="12" r={r} stroke="#1E293B" strokeWidth={sw} fill="none"/><circle cx={c} cy="12" r={r} stroke="#A855F7" strokeWidth={sw} fill="none" strokeDasharray={circ} strokeDashoffset={circ - dash} strokeLinecap="round" transform="rotate(-90 18 12)"/></svg>;
}
function drift(p: number, y: number): { v: number; up: boolean } {
  if (y <= 0) return { v: 0, up: p > 0 };
  const v = Math.round(((p - y) / y) * 100);
  return { v, up: v >= 0 };
}function fmtAgo(d?: string | null): string {
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

export default function WifiDashboard({ onNavigate }: { onNavigate?: (s: string) => void }) {
  const [data, setData] = useState<WifiDashboardData | null>(null); const [sales, setSales] = useState<SalesSummary | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get<WifiDashboardData>('/dashboard/wifi').then(setData).catch((e) => setError(e.message || 'Failed to load'));
    api.get<SalesSummary>('/dashboard/ultranet/sales-summary').then(setSales).catch(() => {});
  }, []);

  useEffect(() => { load(); const i = setInterval(load, 30000); return () => clearInterval(i); }, [load]);

  const v = data?.vouchers;

  return (
    <div className="dashboard sector-dashboard">
      <div className="section-head sector-head">
        <div>
          <h2 className="section-head-title">Preyone UltraNet WiFi <span className="muted hud-tag">High-Tech Telemetry</span></h2>
          <p className="section-head-desc">Live network &amp; captive-portal telemetry</p>
        </div>
        <span className="live-pill"><span className="live-dot" /> LIVE <span className="live-sub">30s</span></span>
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
          {/* ── Telemetry strip ── */}
          <div className="hero-grid">
            <div className="hero-card hero-cyan" onClick={() => onNavigate?.('ap-health')}>
              <div className="hero-icon"><FiRadio size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Access Points</span>
                <span className="hero-value">{data.aps.online}<span className="hero-unit">/{data.aps.total} online</span></span>
                <span className="hero-sub"><FiServer size={11} /> {data.aps.gateways.online}/{data.aps.gateways.total} gateways · {data.aps.clients} associated clients</span>
              </div>
            </div>
            <div className="hero-card hero-purple" onClick={() => onNavigate?.('sessions')}>
              <div className="hero-icon"><FiActivity size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Active Sessions</span>
                <span className="hero-value">{v?.activeSessions ?? '—'}</span>
                <span className="hero-sub">{v?.signupsToday ?? 0} signups today</span>
              </div>
            </div>
            <div className="hero-card hero-green" onClick={() => onNavigate?.('vouchers')}>
              <div className="hero-icon"><FiCreditCard size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Vouchers In Use</span>
                <span className="hero-value">{v?.activeVouchers ?? '—'}</span>
                <span className="hero-sub">{v?.redeemedToday ?? 0} redeemed today · {v?.createdToday ?? 0} created</span>
              </div>
            </div>
            <div className="hero-card hero-orange" onClick={() => onNavigate?.('vouchers')}>
              <div className="hero-icon"><FiTrendingUp size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Redemption Success</span>
                <span className="hero-value">{v?.authSuccessRate ?? 0}%</span>
                <span className="hero-sub">{v?.connectionsToday ?? 0} connections · {v?.pendingApprovals ?? 0} approvals pending</span>
              </div>
            </div>
          </div>

          {/* ── Executive HUD sales telemetry ── */}
          <div className="hud-grid">
            <div className="hud-card">
              <div className="hud-label">My Sales (Today)</div>
              <div className="hud-value">{sales ? fmtZim(sales.mySales) : '—'}</div>
            </div>
            <div className="hud-card">
              <div className="hud-label">Total Daily Revenue</div>
              <div className="hud-value">{sales ? fmtZim(sales.platformDaily) : '—'}</div>
              {sales && (() => { const d = drift(sales.platformDaily, sales.platformYesterday); return <div className={'hud-meta ' + (d.up ? 'up' : 'down')}>{d.up ? '▲' : '▼'} {Math.abs(d.v)}% vs yesterday</div>; })()}
            </div>
            <div className="hud-card">
              <div className="hud-label">Weekly Revenue</div>
              <div className="hud-value">{sales ? fmtZim(sales.weekly.reduce((s, p) => s + p.revenue, 0)) : '—'}</div>
              <div className="hud-meta"><Sparkline data={sales ? sales.weekly : []} /></div>
            </div>
            <div className="hud-card">
              <div className="hud-label">Monthly Revenue</div>
              <div className="hud-value">{sales ? fmtZim(sales.monthly) : '—'}</div>
              <div className="hud-meta hud-meta--row">
                <Gauge value={sales && sales.target > 0 ? Math.min(100, (sales.monthly / sales.target) * 100) : 0} />
                <span>{sales && sales.target > 0 ? Math.round((sales.monthly / sales.target) * 100) + '% of ' + fmtZim(sales.target) : 'Target ' + fmtZim(sales ? sales.target : 0)}</span>
              </div>
            </div>
          </div>

          {/* ── AP monitoring ── */}
          <div className="section-head" style={{ marginTop: '1.5rem' }}>
            <h2 className="section-head-title">Access Point Monitoring</h2>
            <p className="section-head-desc">Online status · clients · firmware</p>
          </div>
          <div className="card card-table">
            {data.apsList.length === 0 ? (
              <div className="table-empty"><p>No access points registered yet.</p></div>
            ) : (
              <table className="data-table">
                <thead><tr><th>AP</th><th>Model</th><th>Location</th><th>Signal</th><th>Clients</th><th>Uptime</th><th>Firmware</th><th>Last Seen</th></tr></thead>
                <tbody>
                  {data.apsList.map((a) => (
                    <tr key={a.mac_address}>
                      <td>
                        <span className="code-cell">{a.name}</span>
                        <span className="muted" style={{ fontSize: 11, display: 'block' }}>{a.ip_address || '—'} · {a.mac_address}</span>
                      </td>
                      <td>{a.model || '—'}</td>
                      <td>{a.location || '—'}</td>
                      <td>
                        <span className={'badge badge--' + (a.status === 'online' ? 'yes' : a.status === 'warning' ? 'warn' : 'no')}>
                          {a.status}
                        </span>
                      </td>
                      <td>{a.clients_count}</td>
                      <td>{fmtUptime(a.uptime_seconds)}</td>
                      <td className="muted" style={{ fontSize: 11 }}>{a.firmware_version || '—'}</td>
                      <td className="muted">{fmtAgo(a.last_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Gateway models ── */}
          {data.aps.gateways.byModel.length > 0 && (
            <div className="chip-row">
              {data.aps.gateways.byModel.map((g) => (
                <span key={g.dev_model || 'model'} className="sector-chip">
                  <FiServer size={12} /> {g.dev_model || 'Gateway'} <b>{g.online}/{g.total}</b>
                </span>
              ))}
            </div>
          )}

          {/* ── Active client sessions ── */}
          <div className="section-head" style={{ marginTop: '1.5rem' }}>
            <h2 className="section-head-title">Active Client Sessions</h2>
            <p className="section-head-desc">IP · MAC · device · bandwidth · data usage</p>
          </div>
          <div className="card card-table">
            {data.clients.length === 0 ? (
              <div className="table-empty"><p>No active client sessions.</p></div>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Client</th><th>Device</th><th>MAC Address</th><th>IP</th><th>Voucher</th><th>Package</th><th>Speed ↓/↑</th><th>Data Used</th><th>Connected</th><th>Expires</th></tr></thead>
                  <tbody>
                    {data.clients.map((c) => {
                      const used = c.data_used_bytes ?? 0;
                      const total = c.data_quota_bytes;
                      const pct = total ? Math.min(100, Math.round((used / total) * 100)) : null;
                      return (
                        <tr key={c.user_id}>
                          <td>{c.full_name || '—'}</td>
                          <td>
                            <span className="device-cell"><FiSmartphone size={12} /> {deviceShort(c.user_agent)}</span>
                          </td>
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
                            {pct != null && (
                              <div className="data-bar-track"><div className="data-bar-fill" style={{ width: pct + '%' }} /></div>
                            )}
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

          {/* ── Voucher usage (users connected with sold vouchers) ── */}
          <div className="section-head" style={{ marginTop: '1.5rem' }}>
            <h2 className="section-head-title">Voucher Usage</h2>
            <p className="section-head-desc">Users who connected using the vouchers we sold · device · package</p>
          </div>
          <div className="card card-table">
            {data.voucherUsage.length === 0 ? (
              <div className="table-empty"><p>No voucher redemptions recorded yet.</p></div>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Voucher</th><th>User</th><th>Device</th><th>Phone</th><th>MAC</th><th>Package</th><th>Price</th><th>Redeemed</th></tr></thead>
                  <tbody>
                    {data.voucherUsage.map((vu) => (
                      <tr key={vu.voucher_code + ':' + vu.redeemed_at}>
                        <td><span className="code-cell">{vu.voucher_code}</span></td>
                        <td>{vu.holder_name || vu.redeemed_by || vu.alias || '—'}
                          {vu.holder_name && vu.alias && <span className="muted" style={{ display: 'block', fontSize: 11 }}>{vu.alias}</span>}
                        </td>
                        <td>
                          {vu.user_agent ? <span className="device-cell"><FiSmartphone size={12} /> {deviceShort(vu.user_agent)}</span> : '—'}
                        </td>
                        <td>{vu.phone || '—'}</td>
                        <td className="vd-mono" style={{ fontSize: 11 }}>{vu.mac_address || '—'}</td>
                        <td>{vu.package_tier || '—'}</td>
                        <td className="money money--sm">{vu.price_amount ? '$' + parseFloat(vu.price_amount).toFixed(2) : '—'}</td>
                        <td className="muted">{fmtAgo(vu.redeemed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Captive portal activity ── */}
          
          <div className="hud-grid" style={{marginTop:12}}>
            <div className="hud-card"><div className="hud-label">What They Sold (Today)</div><div className="hud-body">{sales && sales.itemized && sales.itemized.length>0 ? (<table className="table"><thead><tr><th>Package</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>{sales.itemized.map((i:any,idx:number)=>(<tr key={idx}><td>{i.package_name}</td><td>{i.quantity}</td><td>{fmtZim(i.price)}</td><td>{fmtZim(i.total_revenue)}</td></tr>))}</tbody></table>) : (<div className="muted">No sales today</div>)}</div></div>
            <div className="hud-card"><div className="hud-label">Sales Velocity (24h)</div><div className="hud-body">{sales && sales.velocity && sales.velocity.length>0 ? (<table className="table"><thead><tr><th>Hour</th><th>Vol</th><th>Revenue</th></tr></thead><tbody>{sales.velocity.map((v:any,idx:number)=>(<tr key={idx}><td>{v.hour}:00</td><td>{v.volume}</td><td>{fmtZim(v.revenue)}</td></tr>))}</tbody></table>) : (<div className="muted">No data</div>)}</div></div>
          </div>
          <div className="hud-grid" style={{marginTop:12}}>
            <div className="hud-card"><div className="hud-label">Staff Sales Matrix</div><div className="hud-body">{sales && sales.matrix && sales.matrix.length>0 ? (<table className="table"><thead><tr><th>Staff</th><th>Role</th><th>Vouchers</th><th>Revenue</th><th>Last</th></tr></thead><tbody>{sales.matrix.map((m:any,idx:number)=>(<tr key={idx}><td>{m.full_name}</td><td>{m.role}</td><td>{m.vouchers_sold_today}</td><td>{fmtZim(m.revenue_today)}</td><td>{m.last_active ? fmtAgo(m.last_active) : '—'}</td></tr>))}</tbody></table>) : (<div className="muted">No data</div>)}</div></div>
            <div className="hud-card"><div className="hud-label">Live Activity Stream</div><div className="hud-body">{sales && sales.activity && sales.activity.length>0 ? (<div className="activity-list">{sales.activity.map((a:any,idx:number)=>(<div key={idx} className="activity-item"><span>{a.sold_by_name||'Staff'}</span> sold <span>{a.package_name||a.code}</span> — {fmtZim(a.price_amount)} <span className="muted">{fmtAgo(a.created_at)}</span></div>))}</div>) : (<div className="muted">No recent activity</div>)}</div></div>
          </div>
<div className="section-head" style={{ marginTop: '1.5rem' }}>
            <h2 className="section-head-title">Connections &amp; Authentication</h2>
            <p className="section-head-desc">Live captive-portal connection log</p>
          </div>
          <div className="card card-table">
            {data.connectionLog.length === 0 ? (
              <div className="table-empty"><p>No connection activity yet.</p></div>
            ) : (
              <table className="data-table">
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
            )}
          </div>
        </>
      )}
    </div>
  );
}