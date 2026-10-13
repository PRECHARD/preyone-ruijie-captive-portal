import { useState, useEffect, useCallback } from 'react';
import { transitApi } from '../api/client';
import { FiTrendingUp, FiShoppingBag, FiSmartphone, FiAlertTriangle, FiTruck, FiUsers, FiArrowRight } from 'react-icons/fi';
import './Dashboard.css';
import '../styles/transit.css';

interface Fin {
  summary: { totalTickets: number; todayCents: number; weekCents: number; monthCents: number; conflicts: number; cancelled: number };
  byDate: { day: string; count: number; totalCents: number }[];
  byCompany: { id: string; name: string; currency: string; grossCents: number }[];
}

export default function CompanyDashboard({ onNavigate }: { onNavigate?: (s: string) => void }) {
  const [fin, setFin] = useState<Fin | null>(null);
  const [devices, setDevices] = useState<{ devices: { status: string }[] } | null>(null);
  const [trips, setTrips] = useState<{ trips: { status: string }[] } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [f, d, t] = await Promise.all([
        transitApi.get<Fin>('/financials'),
        transitApi.get<{ devices: { status: string }[] }>('/devices').catch(() => null),
        transitApi.get<{ trips: { status: string }[] }>('/trips').catch(() => null),
      ]);
      setFin(f); setDevices(d); setTrips(t);
      setError('');
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); const i = setInterval(load, 30000); return () => clearInterval(i); }, [load]);

  const s = fin?.summary;
  const currency = fin?.byCompany[0]?.currency || '';
  const money = (cents: number) => `${currency} ${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const activeDevices = devices?.devices.filter(d => d.status === 'ACTIVE').length ?? 0;
  const openTrips = trips?.trips.filter(t => t.status === 'OPEN').length ?? 0;

  return (
    <div className="dashboard">
      <div className="section-head">
        <div>
          <h2 className="section-head-title">Company Dashboard</h2>
          <p className="section-head-desc">Fleet operations at a glance</p>
        </div>
        <div className="page-header-extra">
          <button className="btn-secondary" onClick={() => onNavigate?.('financials')}><FiArrowRight /> Financial Reports</button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="hero-grid">
        <div className="hero-card hero-green">
          <div className="hero-icon"><FiTrendingUp size={20} /></div>
          <div className="hero-body">
            <span className="hero-label">Today's Revenue</span>
            <span className="hero-value money">{s ? money(s.todayCents) : '—'}</span>
            <span className="hero-sub">This month: {s ? money(s.monthCents) : '—'}</span>
          </div>
        </div>
        <div className="hero-card hero-cyan clickable" onClick={() => onNavigate?.('transit-devices')}>
          <div className="hero-icon"><FiSmartphone size={20} /></div>
          <div className="hero-body">
            <span className="hero-label">Active POS Devices</span>
            <span className="hero-value">{activeDevices}</span>
            <span className="hero-sub">{devices ? `of ${devices.devices.length} registered` : '—'} → Device Controls</span>
          </div>
        </div>
        <div className="hero-card hero-purple clickable" onClick={() => onNavigate?.('trips')}>
          <div className="hero-icon"><FiTruck size={20} /></div>
          <div className="hero-body">
            <span className="hero-label">Open Trips</span>
            <span className="hero-value">{openTrips}</span>
            <span className="hero-sub">→ Trip Schedules</span>
          </div>
        </div>
        <div className="hero-card hero-orange clickable" onClick={() => onNavigate?.('tickets')}>
          <div className="hero-icon"><FiShoppingBag size={20} /></div>
          <div className="hero-body">
            <span className="hero-label">Total Tickets</span>
            <span className="hero-value">{s?.totalTickets?.toLocaleString() ?? '—'}</span>
            <span className="hero-sub">{s && (s.conflicts > 0 || s.cancelled > 0) ? `${s.conflicts} conflict(s), ${s.cancelled} cancelled` : 'All checked out clean → Ticket Manifest'}</span>
          </div>
        </div>
      </div>

      <div className="section-head" style={{ marginTop: '1.5rem' }}>
        <h2 className="section-head-title">Fleet Status</h2>
        <p className="section-head-desc">Devices, staff and revenue health</p>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label"><FiSmartphone /> Devices</span>
          <span className="stat-number">{devices ? `${activeDevices}/${devices.devices.length} active` : '—'}</span>
          {devices && devices.devices.some(d => d.status === 'REVOKED') && (
            <span className="tx-muted" style={{ color: 'var(--red)' }}>{devices.devices.filter(d => d.status === 'REVOKED').length} revoked</span>
          )}
        </div>
        <div className="stat-card">
          <span className="stat-label"><FiTruck /> Trips</span>
          <span className="stat-number">{openTrips} open</span>
          <span className="tx-muted">{trips ? `${trips.trips.length} total logged` : '—'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label"><FiUsers /> Ticket Conflicts</span>
          <span className="stat-number" style={{ color: (s?.conflicts ?? 0) > 0 ? 'var(--orange)' : 'var(--text--muted)' }}>
            <FiAlertTriangle style={{ verticalAlign: 'middle' }} /> {s?.conflicts ?? '—'}
          </span>
          <span className="tx-muted">Double-sold seats requiring review</span>
        </div>
      </div>
    </div>
  );
}