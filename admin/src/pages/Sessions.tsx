import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';

export default function Sessions() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try { setData(await api.get('/active-sessions')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); const t = setInterval(fetch, 30000); return () => clearInterval(t); }, [fetch]);

  if (loading) return <Spinner />;

  const sessions = data?.activeUsers || [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Active Sessions</h2>
          <p className="page-desc">{data?.totalActive || 0} active · {data?.totalRedeemed || 0} total redeemed</p>
        </div>
      </div>

      <div className="stats-grid stats-grid--compact" style={{ marginBottom: 20 }}>
        <div className="stat-card"><span className="stat-label">Active Sessions</span><span className="stat-number" style={{ color: 'var(--green)' }}>{data?.totalActive || 0}</span></div>
        <div className="stat-card"><span className="stat-label">Total Redeemed</span><span className="stat-number" style={{ color: 'var(--cyan)' }}>{data?.totalRedeemed || 0}</span></div>
      </div>

      {sessions.length === 0 ? (
        <EmptyState icon="🌙" title="No Active Sessions" message="No users are currently connected." />
      ) : (
        <div className="card">
          <Table
            columns={[
              { key: 'full_name', label: 'User' },
              { key: 'voucher_code', label: 'Voucher', width: '120px', render: (r: any) => <span className="code-cell">{r.voucher_code}</span> },
              { key: 'mac_address', label: 'MAC', width: '150px', render: (r: any) => <code style={{ fontSize: 11 }}>{r.mac_address || '—'}</code> },
              { key: 'ip_address', label: 'IP', width: '130px' },
              { key: 'data_used_bytes', label: 'Data Used', width: '120px', render: (r: any) => r.data_used_bytes ? `${(r.data_used_bytes / 1048576).toFixed(1)} MB` : '0 MB' },
              { key: 'status', label: 'Status', width: '90px', render: (r: any) => <Badge variant={r.active !== false ? 'active' : 'inactive'}>{r.active !== false ? 'Active' : 'Expired'}</Badge> },
              { key: 'session_expires_at', label: 'Expires', width: '160px', render: (r: any) => {
                if (!r.session_expires_at) return '—';
                const expiringSoon = new Date(r.session_expires_at).getTime() - Date.now() < 1800000 && r.active !== false;
                return <span style={expiringSoon ? { color: 'var(--orange)' } : {}}>{new Date(r.session_expires_at).toLocaleString()}{expiringSoon ? ' ⚠' : ''}</span>;
              }},
            ]}
            data={sessions}
          />
        </div>
      )}
    </div>
  );
}
