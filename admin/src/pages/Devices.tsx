import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Modal from '../components/Modal';

const TYPE_LABEL: Record<string, string> = { desktop: 'Desktop', web: 'Web', android: 'Android' };
const STATUS_COLOR: Record<string, string> = {
  active: 'var(--green)',
  suspended: 'var(--red)',
  registered: 'var(--gold)',
};

function timeAgo(d: string | null): string {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const INIT = { deviceId: '', deviceType: 'android', name: '', branch: '', appVersion: '', serverUrl: '' };

export default function Devices() {
  const { user } = useAuth();
  const isCEO = user?.role === 'CEO';

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(INIT);

  const fetch = useCallback(async () => {
    try {
      setRows(await api.get('/devices'));
    } catch (e: any) { setMsg(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const act = async (id: string, action: 'suspend' | 'activate') => {
    setBusy(id);
    try { await api.post(`/devices/${id}/${action}`); await fetch(); } catch (e: any) { setMsg(e.message); }
    setBusy(null);
  };

  const remove = async (id: string) => {
    if (!confirm('Remove this device permanently?')) return;
    try { await api.del(`/devices/${id}`); await fetch(); } catch (e: any) { setMsg(e.message); }
  };

  const registerDevice = async () => {
    setMsg('');
    try {
      const body = {
        deviceId: form.deviceId, deviceType: form.deviceType, name: form.name,
        branch: form.branch || undefined, appVersion: form.appVersion || undefined,
        serverUrl: form.serverUrl || undefined,
      };
      await api.post('/devices', body);
      setShowForm(false);
      setForm(INIT);
      await fetch();
    } catch (e: any) { setMsg(e.message); }
  };

  if (loading) return <Spinner />;

  const data = filter === 'all' ? rows : rows.filter((r) => r.device_type === filter);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Devices &amp; Endpoints</h2>
          <p className="page-desc">{rows.length} device(s) — desktop, web POS and APK tills across all branches.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>Register Device</button>
      </div>

      {msg && (
        <div className="form-status form-status--error" style={{ marginBottom: 16 }}>{msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['all', 'desktop', 'web', 'android'] as const).map((t) => (
          <button
            key={t}
            className="btn-sm"
            onClick={() => setFilter(t)}
            style={filter === t ? { borderColor: 'var(--purple-glow)', color: 'var(--purple-glow)' } : undefined}
          >
            {t === 'all' ? 'All' : TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      {data.length === 0 ? (
        <EmptyState icon="📱" title="No Devices" message="Register a till, register a desktop, or open the web POS at least once." />
      ) : (
        <div className="card">
          <Table
            columns={[
              { key: 'device_id', label: 'Device ID', render: (r: any) => <strong>{r.device_id}</strong> },
              { key: 'device_type', label: 'Type', width: '100px', render: (r: any) => <span className="text-sm text-muted">{TYPE_LABEL[r.device_type] || r.device_type}</span> },
              { key: 'name', label: 'Name', render: (r: any) => (<div>{r.name}{r.branch ? <span className="text-sm text-muted" style={{ display: 'block' }}>{r.branch}</span> : null}</div>) },
              { key: 'app_version', label: 'Version', width: '90px', render: (r: any) => r.app_version || '—' },
              { key: 'last_seen', label: 'Last Seen', width: '110px', render: (r: any) => timeAgo(r.last_seen) },
              { key: 'status', label: 'Status', width: '110px', render: (r: any) => <span style={{ color: STATUS_COLOR[r.status] || 'var(--text)' }}>{r.status.toUpperCase()}</span> },
              { key: 'actions', label: '', width: '160px', render: (r: any) => (
                <div style={{ display: 'flex', gap: 4 }}>
                  {r.status !== 'suspended'
                    ? <button className="btn-sm" disabled={busy === r.id} onClick={() => act(r.id, 'suspend')}>Suspend</button>
                    : <button className="btn-sm" disabled={busy === r.id} onClick={() => act(r.id, 'activate')}>Activate</button>}
                  {isCEO && <button className="btn-sm btn-reject" onClick={() => remove(r.id)}>✕</button>}
                </div>
              )},
            ]}
            data={data}
          />
        </div>
      )}

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Register Device">
        <div className="auth-form">
          <div className="auth-field">
            <label>Device ID</label>
            <input value={form.deviceId} onChange={e => setForm({ ...form, deviceId: e.target.value })} placeholder="e.g. till-main-01" />
          </div>
          <div className="auth-field">
            <label>Type</label>
            <select value={form.deviceType} onChange={e => setForm({ ...form, deviceType: e.target.value })} style={{ width: '100%', background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
              <option value="desktop">Desktop</option>
              <option value="web">Web POS</option>
              <option value="android">Android APK</option>
            </select>
          </div>
          <div className="auth-field">
            <label>Device / Location Name</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Till Tablet (Hall)" />
          </div>
          <div className="auth-field">
            <label>Branch</label>
            <input value={form.branch} onChange={e => setForm({ ...form, branch: e.target.value })} placeholder="e.g. Hall, Head Office" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="auth-field">
              <label>App Version</label>
              <input value={form.appVersion} onChange={e => setForm({ ...form, appVersion: e.target.value })} placeholder="e.g. 2.4.3" />
            </div>
            <div className="auth-field">
              <label>Server URL</label>
              <input value={form.serverUrl} onChange={e => setForm({ ...form, serverUrl: e.target.value })} placeholder="https://…:3000" />
            </div>
          </div>
          <button className="auth-btn" onClick={registerDevice}>Register Device</button>
        </div>
      </Modal>
    </div>
  );
}