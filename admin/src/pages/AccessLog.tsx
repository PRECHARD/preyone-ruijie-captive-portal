import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';

export default function AccessLog() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try { setLogs(await api.get('/access-log')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Access Log</h2>
          <p className="page-desc">{logs.length} entries (last 1000)</p>
        </div>
      </div>
      {logs.length === 0 ? (
        <EmptyState icon="📋" title="No Access Log Entries" message="No access events recorded yet." />
      ) : (
        <div className="card">
          <Table
            columns={[
              { key: 'created_at', label: 'Time', width: '170px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
              { key: 'event', label: 'Event', width: '120px', render: (r: any) => <code style={{ fontSize: 11 }}>{r.event}</code> },
              { key: 'full_name', label: 'User' },
              { key: 'mac_address', label: 'MAC', width: '150px', render: (r: any) => <code style={{ fontSize: 11 }}>{r.mac_address || '—'}</code> },
              { key: 'ip_address', label: 'IP', width: '130px' },
              { key: 'detail', label: 'Detail', render: (r: any) => <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.detail || '—'}</span> },
            ]}
            data={logs}
          />
        </div>
      )}
    </div>
  );
}
