import { useState, useEffect, useCallback } from 'react';
import { transitApi } from '../api/client';
import Table from '../components/Table';
import Modal from '../components/Modal';
import { FiUserPlus, FiRefreshCw } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface StaffRow {
  id: string;
  role: 'DRIVER' | 'CONDUCTOR';
  fullName: string;
  phone: string;
  licenseNo: string;
  status: 'ACTIVE' | 'INACTIVE' | 'ON_LEAVE';
  createdAt: string | null;
  updatedAt: string | null;
}

type Role = 'DRIVER' | 'CONDUCTOR';
const STATUSES: StaffRow['status'][] = ['ACTIVE', 'INACTIVE', 'ON_LEAVE'];

const emptyForm = { fullName: '', phone: '', licenseNo: '', status: 'ACTIVE' as StaffRow['status'] };

export default function StaffRoster() {
  const [tab, setTab] = useState<Role>('DRIVER');
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(async () => {
    try {
      setError('');
      const data = await transitApi.get<{ staff: StaffRow[] }>(`/drivers?role=${tab}`);
      setRows(data.staff);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const addStaff = async () => {
    if (!form.fullName.trim()) {
      setError('Name is required.');
      return;
    }
    setWorking(true);
    setError('');
    try {
      await transitApi.post('/drivers', { ...form, role: tab, fullName: form.fullName.trim() });
      setAdding(false);
      setForm(emptyForm);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  const setStatus = async (row: StaffRow, status: StaffRow['status']) => {
    if (status === row.status) return;
    setWorking(true);
    setError('');
    try {
      await transitApi.put(`/drivers/${row.id}`, { status });
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Drivers &amp; Conductors</h1>
          <p className="page-desc">
            Staff profiles synced to every conductor device. Profiles you create here appear in
            the field app&apos;s driver/conductor selection drop-downs.
          </p>
        </div>
        <div className="tx-actions">
          <button className="btn-secondary" onClick={load}><FiRefreshCw /> Refresh</button>
          <button className="btn-primary" onClick={() => setAdding(true)}><FiUserPlus /> Add {tab === 'DRIVER' ? 'Driver' : 'Conductor'}</button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="tx-tabs">
        <button className={'tx-tab' + (tab === 'DRIVER' ? ' active' : '')} onClick={() => setTab('DRIVER')}>Drivers</button>
        <button className={'tx-tab' + (tab === 'CONDUCTOR' ? ' active' : '')} onClick={() => setTab('CONDUCTOR')}>Conductors</button>
      </div>

      <div className="card">
        {loading ? (
          <div className="table-empty">Loading {tab.toLowerCase()}s…</div>
        ) : (
          <Table<StaffRow>
            columns={[
              { key: 'fullName', label: 'Name', render: r => (
                <span>
                  <b style={{ color: 'var(--text)' }}>{r.fullName}</b>
                  <div className="tx-muted">
                    {r.licenseNo ? <>Licence {r.licenseNo}</> : <em>no licence</em>}
                  </div>
                </span>
              )},
              { key: 'phone', label: 'Phone', render: r => (r.phone ? <span>{r.phone}</span> : <span className="tx-muted">—</span>) },
              { key: 'status', label: 'Status', render: r => (
                <span className={'status-chip status-chip--' + r.status.toLowerCase()}>{r.status}</span>
              )},
              { key: 'updatedAt', label: 'Last Updated', render: r => (
                <span className="tx-muted">{r.updatedAt ? new Date(r.updatedAt).toLocaleString() : '—'}</span>
              )},
              { key: 'actions', label: 'Status Toggle', render: r => (
                <select
                  value={r.status}
                  disabled={working}
                  onChange={e => setStatus(r, e.target.value as StaffRow['status'])}
                  className="tx-status-select"
                >
                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              )},
            ]}
            data={rows}
            emptyMessage={`No ${tab.toLowerCase()}s registered yet.`}
          />
        )}
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title={`Add ${tab === 'DRIVER' ? 'Driver' : 'Conductor'}`}>
        <div className="tx-field" style={{ marginBottom: 12 }}>
          <label>Full Name</label>
          <input value={form.fullName} onChange={e => setForm(p => ({ ...p, fullName: e.target.value }))} placeholder="Full name" />
        </div>
        <div className="tx-form-row">
          <div className="tx-field">
            <label>Phone</label>
            <input value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} placeholder="+263 …" />
          </div>
          <div className="tx-field">
            <label>Licence No</label>
            <input value={form.licenseNo} onChange={e => setForm(p => ({ ...p, licenseNo: e.target.value }))} placeholder="e.g. DL-00000" />
          </div>
        </div>
        <div className="tx-field">
          <label>Status</label>
          <select value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value as StaffRow['status'] }))}>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {error && <div className="auth-error" style={{ marginTop: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
          <button className="btn-primary" onClick={addStaff} disabled={working}>
            <FiUserPlus /> {working ? 'Saving…' : 'Create Profile'}
          </button>
        </div>
      </Modal>
    </div>
  );
}