import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';

export default function AuditLog() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try { setLogs(await api.get('/audit-log')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Audit Log</h2>
          <p className="page-desc">{logs.length} entries (last 500)</p>
        </div>
      </div>
      {logs.length === 0 ? (
        <EmptyState icon="📝" title="No Audit Log Entries" message="No administrative actions recorded yet." />
      ) : (
        <div className="card">
          <Table
            columns={[
              { key: 'created_at', label: 'Time', width: '170px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
              { key: 'admin_name', label: 'Admin' },
              { key: 'action', label: 'Action', render: (r: any) => <Badge variant={r.action === 'create' ? 'active' : r.action === 'delete' ? 'rejected' : r.action === 'update' ? 'info' : 'default'}>{r.action}</Badge> },
              { key: 'target_type', label: 'Target' },
              { key: 'target_id', label: 'Target ID', render: (r: any) => r.target_id ? <code style={{ fontSize: 11 }}>{r.target_id}</code> : '—' },
              { key: 'detail', label: 'Detail', render: (r: any) => <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.detail || '—'}</span> },
            ]}
            data={logs}
          />
        </div>
      )}
    </div>
  );
}
