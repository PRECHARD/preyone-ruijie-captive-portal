import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';

export default function Backup() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState('');

  const fetch = useCallback(async () => {
    try { setLogs(await api.get('/backup/logs')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const createBackup = async () => {
    setCreating(true);
    setMsg('');
    try {
      const result = await api.post('/backup');
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = result.fileName || `preyone-backup-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg(`Backup created: ${(result.fileSize ? (result.fileSize / 1024).toFixed(1) : '?')} KB`);
      fetch();
    } catch (e: any) {
      setMsg(e.message);
    }
    setCreating(false);
  };

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Backup Manager</h2>
          <p className="page-desc">{logs.length} backup(s) in history</p>
        </div>
        <button className="btn-primary" onClick={createBackup} disabled={creating}>
          {creating ? 'Creating...' : 'Create Backup'}
        </button>
      </div>

      {msg && (
        <div className={`form-status ${msg.includes('error') || msg.includes('failed') ? 'form-status--error' : 'form-status--success'}`} style={{ marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {logs.length === 0 ? (
        <EmptyState icon="💾" title="No Backups Yet" message="Create your first system backup." />
      ) : (
        <div className="card">
          {logs.map((l: any) => (
            <div key={l.id} className="alert-row">
              <div style={{ flex: 1 }}>
                <div className="alert-title">{l.file_name || `Backup #${l.id}`}</div>
                <div className="alert-meta">
                  <span>{l.created_at ? new Date(l.created_at).toLocaleString() : ''}</span>
                  {l.file_size && <span>{(l.file_size / 1024).toFixed(1)} KB</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
