import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Modal from '../components/Modal';

export default function ApDevices() {
  const [devices, setDevices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({ name: '', model: '', macAddress: '', ipAddress: '', location: '' });

  const fetch = useCallback(async () => {
    try { setDevices(await api.get('/ap-devices')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const openNew = () => { setEditing(null); setForm({ name: '', model: '', macAddress: '', ipAddress: '', location: '' }); setShowForm(true); };

  const openEdit = (d: any) => {
    setEditing(d);
    setForm({ name: d.name || '', model: d.model || '', macAddress: d.mac_address || '', ipAddress: d.ip_address || '', location: d.location || '' });
    setShowForm(true);
  };

  const save = async () => {
    setMsg('');
    try {
      const body = { name: form.name, model: form.model || undefined, macAddress: form.macAddress, ipAddress: form.ipAddress || undefined, location: form.location || undefined };
      if (editing) { await api.put(`/ap-devices/${editing.id}`, body); setMsg('AP updated'); }
      else { await api.post('/ap-devices', body); setMsg('AP created'); }
      setShowForm(false); fetch();
    } catch (e: any) { setMsg(e.message); }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this AP device?')) return;
    try { await api.del(`/ap-devices/${id}`); fetch(); } catch (e: any) { setMsg(e.message); }
  };

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">AP Devices</h2>
          <p className="page-desc">{devices.length} access point(s) registered</p>
        </div>
        <button className="btn-primary" onClick={openNew}>Add AP</button>
      </div>

      {msg && (
        <div className={`form-status ${msg.includes('created') || msg.includes('updated') ? 'form-status--success' : 'form-status--error'}`} style={{ marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {devices.length === 0 ? (
        <EmptyState icon="📡" title="No AP Devices" message="Register your first access point." />
      ) : (
        <div className="card">
          <Table
            columns={[
              { key: 'name', label: 'Name' },
              { key: 'model', label: 'Model' },
              { key: 'mac_address', label: 'MAC', width: '150px', render: (r: any) => <code style={{ fontSize: 11 }}>{r.mac_address}</code> },
              { key: 'ip_address', label: 'IP', width: '130px' },
              { key: 'location', label: 'Location' },
              { key: 'status', label: 'Status', width: '90px', render: (r: any) => <span style={{ color: r.status === 'online' ? 'var(--green)' : 'var(--text-muted)' }}>{r.status || 'unknown'}</span> },
              { key: 'actions', label: '', width: '100px', render: (r: any) => (
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn-sm" onClick={() => openEdit(r)}>Edit</button>
                  <button className="btn-sm btn-reject" onClick={() => remove(r.id)}>✕</button>
                </div>
              )},
            ]}
            data={devices}
          />
        </div>
      )}

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit AP Device' : 'New AP Device'}>
        <div className="auth-form">
          <div className="auth-field"><label>Name</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div className="auth-field"><label>Model</label><input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} /></div>
          <div className="auth-field"><label>MAC Address</label><input value={form.macAddress} onChange={e => setForm({ ...form, macAddress: e.target.value })} placeholder="AA:BB:CC:DD:EE:FF" /></div>
          <div className="auth-field"><label>IP Address</label><input value={form.ipAddress} onChange={e => setForm({ ...form, ipAddress: e.target.value })} /></div>
          <div className="auth-field"><label>Location</label><input value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} /></div>
          <button className="auth-btn" onClick={save}>{editing ? 'Update' : 'Create'} AP Device</button>
        </div>
      </Modal>
    </div>
  );
}
