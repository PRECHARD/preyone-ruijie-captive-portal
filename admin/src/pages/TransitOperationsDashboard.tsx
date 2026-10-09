import { useState, useEffect, useCallback } from 'react';
import { transitApi } from '../api/client';
import {
  FiUsers, FiRadio, FiClock, FiTrendingUp, FiArchive, FiFileText, FiTruck,
} from 'react-icons/fi';
import './Dashboard.css';
import './SectorDashboards.css';

interface FleetVehicle { registration: string; tripCount: number; }

interface TransitDashboardData {
  company: { id: string; name: string | null; slug: string | null; currency: string | null; default_receipt_prefix: string | null } | null;
  fleet: {
    vehicles: number;
    fleet: FleetVehicle[];
    deviceOnline: number;
    deviceTotal: number;
    openShifts: number;
    totalShifts: number;
    activeTemplates: number;
    transitUsers: number;
    drivers: number;
    conductors: number;
  };
  status: {
    scheduled: number; open: number; active: number;
    completed: number; cancelled: number; closed: number;
  };
  today: { tickets: number; gross: number; cash: number };
  period: { week: { tickets: number; gross: number }; month: { tickets: number; gross: number } };
  routes: { route: string; trips: number; gross: number }[];
  history24h: { hour: string; trips: number; completed: number }[];
  history7d: { day: string; trips: number; completed: number }[];
  recentTrips: {
    id: string; trip_no: string; bus_reg: string | null; route_code: string | null; route_name: string | null;
    route_from: string | null; route_to: string | null; departure_time: string | null; driver: string | null;
    conductor1: string | null; status: string; opened_at: string | null; closed_at: string | null;
    operator: string | null; ticket_count: number; total_cents: number;
  }[];
}

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', ZWL: 'ZWL ', ZAR: 'R ', GBP: '£', EUR: '€', ZMW: 'K ', BWP: 'P ' };

function fmtMoney(cents: number | null | undefined, currency: string | null): string {
  const sym = CURRENCY_SYMBOL[currency || 'USD'] || '$';
  return `${sym}${((Number(cents) || 0) / 100).toFixed(2)}`;
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

function fmtHourLabel(h?: string | null): string {
  if (!h) return '';
  try {
    const d = new Date(h);
    if (isNaN(d.getTime())) return h.slice(11, 16) || '';
    const now = new Date();
    const isYesterday = now.getTime() - d.getTime() > 12 * 3600 * 1000;
    return (isYesterday ? '−' : '') + String(d.getHours()).padStart(2, '0') + ':00';
  } catch { return ''; }
}

function fmtDayLabel(d?: string | null): string {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00Z');
  if (isNaN(dt.getTime())) return d.slice(5) || '';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function TransitOperationsDashboard({ onNavigate }: { onNavigate?: (s: string) => void }) {
  const [data, setData] = useState<TransitDashboardData | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setRefreshing(true);
    transitApi.get<TransitDashboardData>('/dashboard')
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load'))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => { load(); const i = setInterval(load, 30000); return () => clearInterval(i); }, [load]);

  const cur = (data?.company?.currency as string | null) || 'USD';
  const st = data?.status;

  const h24 = data?.history24h ?? [];
  const h7 = data?.history7d ?? [];
  const h24Total = h24.reduce((s, b) => s + (b.trips || 0), 0);
  const using7d = h24.length > 0 && h24Total === 0 && h7.length > 0;
  const hist = using7d ? h7 : h24;
  const histTitle = using7d ? 'Trips — Last 7 Days' : 'Trips — Last 24 Hours';
  const histDesc = using7d
    ? 'No departures in the last 24h — showing this week by day'
    : 'Departures by hour · completed trips in \u201Cgreen\u201D';
  const histKey = using7d ? 'day' : 'hour';
  const histLabel = using7d ? fmtDayLabel : fmtHourLabel;

  return (
    <div className="dashboard sector-dashboard">
      <div className="section-head sector-head">
        <div>
          <h2 className="section-head-title">Preyone Transit Operations</h2>
          <p className="section-head-desc">
            {data?.company?.name
              ? `${data.company.name} · ${data.company.slug || ''}`.trim()
              : 'Fleet, crew & ticket telemetry'}
          </p>
        </div>
        <span className={'live-pill' + (refreshing ? ' is-refreshing' : '')}>
          <span className="live-dot" /> {refreshing ? 'SYNCING' : 'LIVE'} <span className="live-sub">30s</span>
        </span>
      </div>

      {error && !data && (
        <div className="card sector-error"><p>{error}</p><p className="muted">Your account may not be provisioned for transit operations yet.</p></div>
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
          {/* ── Fleet & revenue strip ── */}
          <div className="hero-grid">
            <div className="hero-card hero-purple" onClick={() => onNavigate?.('fleet')}>
              <div className="hero-icon"><FiTruck size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Fleet Vehicles</span>
                <span className="hero-value">{data.fleet.vehicles}</span>
                <span className="hero-sub">{data.fleet.drivers} drivers · {data.fleet.conductors} conductors</span>
              </div>
            </div>
            <div className="hero-card hero-cyan" onClick={() => onNavigate?.('live-shifts')}>
              <div className="hero-icon"><FiClock size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Live Trips</span>
                <span className="hero-value">{(st?.open ?? 0) + (st?.active ?? 0)}</span>
                <span className="hero-sub">{st?.scheduled ?? 0} scheduled · {st?.completed ?? 0} completed · {st?.cancelled ?? 0} cancelled</span>
              </div>
            </div>
            <div className="hero-card hero-green" onClick={() => onNavigate?.('tickets')}>
              <div className="hero-icon"><FiTrendingUp size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">Today's Sales</span>
                <span className="hero-value">{fmtMoney(data.today.gross, cur)}</span>
                <span className="hero-sub">{data.today.tickets} tickets · {fmtMoney(data.today.cash, cur)} cash</span>
              </div>
            </div>
            <div className="hero-card hero-orange" onClick={() => onNavigate?.('financials')}>
              <div className="hero-icon"><FiFileText size={20} /></div>
              <div className="hero-body">
                <span className="hero-label">This Week &amp; Month</span>
                <span className="hero-value">{fmtMoney(data.period.month.gross, cur)}</span>
                <span className="hero-sub">week {fmtMoney(data.period.week.gross, cur)} · {data.period.month.tickets} tickets</span>
              </div>
            </div>
          </div>

          {/* ── Operations quick radar ── */}
          <div className="chip-row">
            <span className="sector-chip"><FiRadio size={12} /> Devices online <b>{data.fleet.deviceOnline}/{data.fleet.deviceTotal}</b></span>
            <span className="sector-chip"><FiClock size={12} /> Shifts <b>{data.fleet.openShifts} open</b>/<b>{data.fleet.totalShifts}</b></span>
            <span className="sector-chip"><FiArchive size={12} /> Active templates <b>{data.fleet.activeTemplates}</b></span>
            <span className="sector-chip"><FiUsers size={12} /> Transit users <b>{data.fleet.transitUsers}</b></span>
          </div>

          {/* ── Trip history (24h, falls back to 7d when the day is quiet) ── */}
          <div className="section-head" style={{ marginTop: '1.5rem' }}>
            <h2 className="section-head-title">{histTitle}</h2>
            <p className="section-head-desc">{histDesc}</p>
          </div>
          <div className="card">
            {hist.length === 0 ? (
              <div className="table-empty"><p>No trip departures recorded yet.</p></div>
            ) : (
              <div className="hist-wrap">
                <div className="hist-chart">
                  {hist.map((h: any) => {
                    const max = Math.max(1, ...hist.map((x: any) => x.trips));
                    const tripsPct = Math.max(3, Math.round((h.trips / max) * 100));
                    const compPct = h.trips > 0 ? Math.max(2, Math.round((h.completed / h.trips) * 100)) : 0;
                    return (
                      <div className="hist-col" key={h[histKey]} title={`${histLabel(h[histKey])} — ${h.trips} trips · ${h.completed} completed`}>
                        <div className="hist-bar" style={{ height: tripsPct + '%' }}>
                          <div className="hist-bar-comp" style={{ height: compPct + '%' }} />
                        </div>
                        <span className="hist-label">{histLabel(h[histKey])}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── Live trip board ── */}
          <div className="section-head" style={{ marginTop: '1.5rem' }}>
            <h2 className="section-head-title">Live Trip Board</h2>
            <p className="section-head-desc">Most recent trips · tickets · takings</p>
          </div>
          <div className="card card-table">
            {data.recentTrips.length === 0 ? (
              <div className="table-empty"><p>No trips recorded yet for this company.</p></div>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Trip</th><th>Route</th><th>Bus</th><th>Driver</th><th>Operator</th><th>Tickets</th><th>Takings</th><th>Status</th><th>Departed</th></tr></thead>
                  <tbody>
                    {data.recentTrips.map((t) => (
                      <tr key={t.id}>
                        <td><span className="code-cell">{t.trip_no}</span></td>
                        <td>{t.route_name || t.route_code || '—'}
                          {t.route_from && t.route_to && <span className="muted" style={{ display: 'block', fontSize: 11 }}>{t.route_from} → {t.route_to}</span>}
                        </td>
                        <td>{t.bus_reg || '—'}</td>
                        <td>{t.driver || '—'}</td>
                        <td className="muted">{t.operator || '—'}</td>
                        <td>{t.ticket_count}</td>
                        <td>{fmtMoney(t.total_cents, cur)}</td>
                        <td>
                          <span className={'badge badge--' + (['ACTIVE', 'OPEN'].includes(t.status) ? 'yes' : t.status === 'COMPLETED' ? 'yes' : t.status === 'CANCELLED' ? 'no' : 'warn')}>
                            {t.status}
                          </span>
                        </td>
                        <td className="muted">{fmtAgo(t.opened_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="charts-row" style={{ marginTop: '1.5rem' }}>
            {/* ── Top routes ── */}
            <div className="card">
              <div className="card-header"><h3 className="card-title">Top Routes by Revenue</h3></div>
              {data.routes.length === 0 ? (
                <div className="table-empty"><p>No route takings yet.</p></div>
              ) : (
                <table className="data-table">
                  <thead><tr><th>Route</th><th>Trips</th><th>Revenue</th></tr></thead>
                  <tbody>
                    {data.routes.map((r) => (
                      <tr key={r.route}>
                        <td>{r.route}</td>
                        <td>{r.trips}</td>
                        <td>{fmtMoney(r.gross, cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* ── Fleet roster ── */}
            <div className="card">
              <div className="card-header"><h3 className="card-title">Fleet Roster</h3></div>
              {data.fleet.fleet.length === 0 ? (
                <div className="table-empty"><p>No vehicles assigned yet.</p></div>
              ) : (
                <table className="data-table">
                  <thead><tr><th>Registration</th><th>Trips</th></tr></thead>
                  <tbody>
                    {data.fleet.fleet.map((v) => (
                      <tr key={v.registration}>
                        <td><span className="code-cell">{v.registration}</span></td>
                        <td>{v.tripCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}