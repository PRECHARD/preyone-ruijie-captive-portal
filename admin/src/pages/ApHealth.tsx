import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Badge from '../components/Badge';

export default function ApHealth() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try { setData(await api.get('/ap-health')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); const t = setInterval(fetch, 30000); return () => clearInterval(t); }, [fetch]);

  if (loading) return <Spinner />;
  if (!data) return <EmptyState icon="📡" title="No AP Data" message="No access point data available." />;

  const devices = data.devices || [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">AP Health</h2>
          <p className="page-desc">{data.total || 0} total · {data.online || 0} online · {data.offline || 0} offline</p>
        </div>
      </div>

      <div className="stats-grid stats-grid--compact" style={{ marginBottom: 20 }}>
        <div className="stat-card"><span className="stat-label">Total</span><span className="stat-number" style={{ color: 'var(--text)' }}>{data.total || 0}</span></div>
        <div className="stat-card"><span className="stat-label">Online</span><span className="stat-number" style={{ color: 'var(--green)' }}>{data.online || 0}</span></div>
        <div className="stat-card"><span className="stat-label">Offline</span><span className="stat-number" style={{ color: 'var(--red)' }}>{data.offline || 0}</span></div>
        <div className="stat-card"><span className="stat-label">Warning</span><span className="stat-number" style={{ color: 'var(--orange)' }}>{data.warning || 0}</span></div>
        <div className="stat-card"><span className="stat-label">Total Clients</span><span className="stat-number" style={{ color: 'var(--cyan)' }}>{data.totalClients || 0}</span></div>
      </div>

      {devices.length === 0 ? (
        <EmptyState icon="📡" title="No AP Devices" message="No access points have been registered." />
      ) : (
        <div className="card">
          {devices.map((d: any) => (
            <div key={d.id} className="alert-row">
              <div style={{ flex: 1 }}>
                <div className="alert-title">{d.name || d.model || 'AP'}</div>
                <div className="alert-meta">
                  {d.model && <span>{d.model}</span>}
                  {d.mac_address && <span><code>{d.mac_address}</code></span>}
                  {d.ip_address && <span>{d.ip_address}</span>}
                  {d.location && <span>{d.location}</span>}
                </div>
              </div>
              <Badge variant={d.status === 'online' ? 'active' : d.status === 'offline' ? 'inactive' : 'warning'}>
                {d.status || 'unknown'}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
