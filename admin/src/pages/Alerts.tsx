import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Badge from '../components/Badge';

export default function Alerts() {
  const { user } = useAuth();
  const isMgmt = user?.role === 'CEO' || user?.role === 'Manager';
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const d = await api.get('/alerts');
      setData(d);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); const t = setInterval(fetch, 30000); return () => clearInterval(t); }, [fetch]);

  const acknowledge = async (id: string) => {
    await api.post(`/alerts/${id}/acknowledge`);
    fetch();
  };

  const seedMock = async () => {
    await api.post('/alerts/seed-mock');
    fetch();
  };

  if (loading) return <Spinner />;
  if (!data || !data.all?.length) return <EmptyState icon="🔔" title="No Alerts" message="All clear — no alerts to display." />;

  const alerts = data.all || [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Alerts</h2>
          <p className="page-desc">{data.totalUnacknowledged || 0} unacknowledged</p>
        </div>
        <button className="btn-secondary" onClick={seedMock}>Seed Mock Alerts</button>
      </div>

      {alerts.length === 0 ? (
        <EmptyState icon="🔔" title="No Alerts" message="All clear." />
      ) : (
        <div className="card">
          {alerts.map((a: any) => (
            <div key={a.id} className="alert-row" style={{ opacity: a.acknowledged ? 0.5 : 1 }}>
              <div style={{ flex: 1 }}>
                <div className="alert-title">{a.title || a.type || 'Alert'}</div>
                {a.message && <div className="alert-msg">{a.message}</div>}
                <div className="alert-meta">
                  {a.level && <Badge variant={a.level === 'critical' || a.level === 'error' ? 'rejected' : a.level === 'warning' ? 'warning' : 'info'}>{a.level}</Badge>}
                  {a.created_at && <span>{new Date(a.created_at).toLocaleString()}</span>}
                  {a.admin_name && <span>by {a.admin_name}</span>}
                </div>
              </div>
              {!a.acknowledged && (
                <button className="btn-sm btn-approve" onClick={() => acknowledge(a.id)} style={{ flexShrink: 0 }}>Acknowledge</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
