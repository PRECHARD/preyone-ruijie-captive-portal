import { useState, useEffect, useCallback } from 'react';
import { systemApi } from '../api/client';
import { FiDatabase, FiServer, FiCpu, FiHardDrive, FiRadio, FiActivity, FiClock } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface Health {
  db: { ok: boolean; latencyMs: number };
  redis: { ok: boolean | null; note: string };
  memory: { rssMb: number; heapMb: number };
  disk: { freeGb: number; totalGb: number; freeBytes: number; totalBytes: number };
  uptime: { days: number; hours: number; minutes: number };
  gatewaySettings: Record<string, any>;
  hostname: string;
  node: string;
  time: string;
}

export default function SystemHealth() {
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await systemApi.get<Health>('/system-health'));
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load, refresh]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">System Health</h1>
          <p className="page-desc">Live infrastructure status for the Preyone platform. Level 0 only.</p>
        </div>
        <div className="page-header-extra">
          <button className="btn-secondary" onClick={() => setRefresh(x => x + 1)}><FiActivity /> Refresh</button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      {data && (
        <>
          <div className="stats-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card">
              <span className="stat-label"><FiDatabase /> Database</span>
              <span className="stat-number" style={{ color: data.db.ok ? 'var(--green)' : 'var(--red)' }}>
                {data.db.ok ? 'OPERATIONAL' : 'DOWN'}
              </span>
              <span className="tx-muted">{data.db.latencyMs} ms</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiServer /> Redis</span>
              <span className={'stat-number ' + (data.redis.ok === null ? 'tx-muted' : data.redis.ok ? 'money' : '')} style={data.redis.ok === null ? { color: 'var(--text-dim)' } : undefined}>
                {data.redis.ok === null ? 'NOT CONFIGURED' : data.redis.ok ? 'OK' : 'DOWN'}
              </span>
              {data.redis.note && <span className="tx-muted">{data.redis.note}</span>}
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiCpu /> Memory</span>
              <span className="stat-number">{data.memory.rssMb} MB</span>
              <span className="tx-muted">heap {data.memory.heapMb} MB</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiHardDrive /> Disk</span>
              <span className="stat-number">{data.disk.freeGb} <span style={{ fontSize: '0.8rem' }}>GB free</span></span>
              <span className="tx-muted">of {data.disk.totalGb} GB</span>
            </div>
            <div className="stat-card">
              <span className="stat-label"><FiClock /> Uptime</span>
              <span className="stat-number">{data.uptime.days}d {data.uptime.hours}h {data.uptime.minutes}m</span>
              <span className="tx-muted">node {data.node}</span>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="section-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FiRadio /> Gateway & RADIUS Configuration
            </div>
            <div className="tx-form-row tx-form-row--1" style={{ padding: 16, marginBottom: 0 }}>
              {Object.keys(data.gatewaySettings).length === 0 ? (
                <div className="table-empty">No gateway / RADIUS settings stored yet. Configure them in Gateway & RADIUS Settings.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                  {Object.entries(data.gatewaySettings).map(([k, v]) => (
                    <div key={k} className="tx-field">
                      <label>{k.replace(/_/g, ' ').toUpperCase()}</label>
                      <input readOnly value={String(v)} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="tx-muted" style={{ textAlign: 'right' }}>
            host {data.hostname} · checked {new Date(data.time).toLocaleTimeString()}
          </div>
        </>
      )}
    </div>
  );
}