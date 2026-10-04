import { useState, useEffect, useCallback } from 'react';
import { transitApi, systemApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Table from '../components/Table';
import Modal from '../components/Modal';
import { FiUserPlus, FiRefreshCw, FiCopy, FiPower, FiCheckCircle, FiSmartphone, FiGlobe, FiUnlock, FiTrash2, FiAlertTriangle, FiEdit2 } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface StaffRow {
  id: string;
  username: string;
  full_name: string;
  phone: string;
  role: string;
  status: string;
  created_at: string;
  device_count: number;
  devices?: { id: string; deviceUuid: string; status: string }[];
}

interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  status: string;
}

const ROLE_FILTERS = ['ALL', 'OPERATIONS', 'DISPATCHER', 'ACCOUNTANT', 'CONDUCTOR', 'DRIVER', 'TICKET_SELLER'] as const;

const CREW_TABS = [
  { key: 'ALL', label: 'All Crew' },
  { key: 'DRIVER', label: 'Drivers' },
  { key: 'CONDUCTOR', label: 'Conductors' },
] as const;

export default function Fleet() {
  const { user } = useAuth();
  const isPlatform = !user?.companyId;
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [selectedCompany, setSelectedCompany] = useState('');
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<{ username: string; password: string; fullName: string; role: string } | null>(null);
  const [unbindTarget, setUnbindTarget] = useState<StaffRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StaffRow | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({ fullName: '', phone: '', role: 'CONDUCTOR', salesCode: '', companyId: '' });
  const [editTarget, setEditTarget] = useState<StaffRow | null>(null);
  const [editForm, setEditForm] = useState({ fullName: '', phone: '', role: 'CONDUCTOR' });

  useEffect(() => {
    if (!isPlatform) return;
    systemApi.get<CompanyRow[]>('/companies')
      .then(setCompanies)
      .catch(() => {});
  }, [isPlatform]);

  const load = useCallback(async () => {
    try {
      setError('');
      setNotice('');
      if (isPlatform && !selectedCompany) {
        setRows([]);
        setLoading(false);
        return;
      }
      const params = new URLSearchParams();
      if (roleFilter !== 'ALL') params.set('role', roleFilter);
      if (isPlatform && selectedCompany) params.set('companyId', selectedCompany);
      const qs = params.toString();
      const data = await transitApi.get<{ staff: StaffRow[] }>(`/staff${qs ? `?${qs}` : ''}`);
      setRows(data.staff);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [roleFilter, isPlatform, selectedCompany]);

  useEffect(() => { load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.fullName.trim()) { setError('Full name is required'); return; }
    const companyId = form.companyId || (companies[0]?.id ?? '');
    if (isPlatform && !companyId) { setError('No tenant company available. Add a tenant company before creating staff.'); return; }
    setSaving(true);
    try {
      const res = await transitApi.post<{ staff: { username: string; role: string; status: string }; generatedPassword: string }>('/staff', {
        fullName: form.fullName.trim(),
        phone: form.phone.trim(),
        role: form.role,
        salesCode: form.salesCode.trim(),
        ...(isPlatform && companyId ? { companyId } : {}),
      });
      setShowCreate(false);
      setForm({ fullName: '', phone: '', role: 'CONDUCTOR', salesCode: '', companyId: '' });
      setRevealed({ username: res.staff.username, password: res.generatedPassword, fullName: form.fullName.trim(), role: form.role });
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (s: StaffRow) => {
    setError('');
    setNotice('');
    try {
      const target = s.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
      const res = await transitApi.post<{ devicesUnbound?: number }>(`/staff/${s.id}/status`, { status: target });
      const unbound = res.devicesUnbound ?? 0;
      setNotice(target === 'DISABLED' && unbound > 0
        ? `Deactivated @${s.username} — ${unbound} bound device${unbound === 1 ? '' : 's'} released back to the unclaimed pool and will prompt for re-registration.`
        : `@${s.username} is now ${target === 'ACTIVE' ? 'active' : 'disabled'}.`);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const resetPassword = async (s: StaffRow) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await transitApi.patch<{ staff: { username: string }; generatedPassword: string }>(`/staff/${s.id}/reset-password`);
      setRevealed({ username: res.staff.username, password: res.generatedPassword, fullName: s.full_name, role: s.role });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const unbind = async (s: StaffRow) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await transitApi.post<{ ok: boolean; devicesUnbound: number; deviceUuids: string[] }>(`/staff/${s.id}/unbind-device`);
      setUnbindTarget(null);
      const count = res.devicesUnbound ?? 0;
      setNotice(count > 0
        ? `${count} device${count === 1 ? '' : 's'} unbound from @${s.username} — terminals will prompt for re-registration.`
        : `No bound devices found for @${s.username}.`);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await transitApi.del(`/staff/${deleteTarget.id}`);
      setDeleteTarget(null);
      setNotice(`Deleted @${deleteTarget.username} from the fleet.`);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const openCreate = () => {
    setError('');
    setForm(f => ({
      ...f,
      role: roleFilter !== 'ALL' ? roleFilter : f.role,
      companyId: f.companyId || selectedCompany || (companies[0]?.id ?? ''),
    }));
    setShowCreate(true);
  };

  const openEdit = (s: StaffRow) => {
    setError('');
    setEditForm({ fullName: s.full_name || '', phone: s.phone || '', role: s.role });
    setEditTarget(s);
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget) return;
    setError('');
    setSaving(true);
    try {
      await transitApi.patch(`/staff/${editTarget.id}`, {
        fullName: editForm.fullName.trim(),
        phone: editForm.phone.trim(),
        role: editForm.role,
      });
      setEditTarget(null);
      setNotice(`Updated @${editTarget.username}.`);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!revealed) return;
    const text = `Username: ${revealed.username}\nPassword: ${revealed.password}`;
    try {
      await navigator.clipboard.writeText(text);
      setError('');
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Fleet Crew &amp; Staff</h1>
          <p className="page-desc">Operations, dispatch, accounting and field staff for your company. Driver and Conductor accounts log into the mobile app only, where their names and phones appear on every printed ticket.</p>
        </div>
        <div className="page-header-extra">
          <button className="btn-primary" onClick={openCreate} disabled={saving || (isPlatform && companies.length === 0)}><FiUserPlus /> Create Staff Member</button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="tx-notice" style={{ marginBottom: 12 }}>{notice}</div>}

      {isPlatform && (
        <div className="card" style={{ marginBottom: 14, padding: 16 }}>
          <div className="tx-field" style={{ marginBottom: 0 }}>
            <label><FiGlobe style={{ verticalAlign: 'middle', marginRight: 6, color: 'var(--cyan)' }} />Tenant Company {companies.length > 0 && '(Level 0 — cross-company)'}</label>
            <select value={selectedCompany} onChange={e => setSelectedCompany(e.target.value)}>
              <option value="">Select a tenant company…</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name} ({c.slug})</option>)}
            </select>
            {!selectedCompany && (
              <div className="tx-muted" style={{ marginTop: 6 }}>Choose a company to view its fleet or create staff. Level 0 admins are not bound to a single tenant.</div>
            )}
          </div>
        </div>
      )}

      <div className="tx-toolbar">
        <div className="tx-tabs">
          {CREW_TABS.map(t => (
            <button
              key={t.key}
              className={'tx-tab' + (roleFilter === t.key ? ' active' : '')}
              onClick={() => setRoleFilter(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button className="btn-secondary" onClick={load}><FiRefreshCw /> Refresh</button>
      </div>

      <div className="card">
        {loading ? (
          <div className="table-empty">Loading staff…</div>
        ) : (
          <Table<StaffRow>
            columns={[
              { key: 'full_name', label: 'Full Name', render: r => <span style={{ fontWeight: 700 }}>{r.full_name || '—'}</span> },
              { key: 'username', label: 'Username', render: r => <span style={{ color: 'var(--cyan)' }}>@{r.username}</span> },
              { key: 'phone', label: 'Phone', render: r => <span className="tx-muted">{r.phone || '—'}</span> },
              { key: 'role', label: 'Role', render: r => <span className="status-chip status-chip--active">{r.role}</span> },
              { key: 'device_count', label: 'Devices', render: r => (
                <span className="tx-muted"><FiSmartphone style={{ verticalAlign: 'middle' }} /> {r.device_count}</span>
              )},
              { key: 'status', label: 'Status', render: r => (
                <span className={'status-chip status-chip--' + (r.status === 'ACTIVE' ? 'active' : 'disabled')}>{r.status}</span>
              )},
              { key: 'created_at', label: 'Joined', render: r => new Date(r.created_at).toLocaleDateString() },
              { key: 'actions', label: 'Actions', render: r => (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => openEdit(r)} title="Edit name, phone or role">
                    <FiEdit2 /> Edit
                  </button>
                  <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => resetPassword(r)} disabled={busy} title="Generate a new password to hand over — the old one stops working immediately">
                    <FiUnlock /> Reset PIN
                  </button>
                  <button className="btn-secondary btn-danger" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setDeleteTarget(r)} title="Hard-delete test/erroneous profile">
                    <FiTrash2 /> Delete
                  </button>
                  {r.device_count > 0 && (
                    <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setUnbindTarget(r)} title="Unbind all terminals locked to this profile">
                      <FiUnlock /> Unbind
                    </button>
                  )}
                  <button className={'btn-secondary ' + (r.status === 'ACTIVE' ? 'btn-danger' : '')} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => toggleStatus(r)}>
                    <FiPower /> {r.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              )},
            ]}
            data={rows}
            emptyMessage="No staff members in this team yet."
          />
        )}
      </div>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Staff Member">
        <form onSubmit={create}>
          {isPlatform && (
            <div className="tx-form-row tx-form-row--1">
              <div className="tx-field"><label>Tenant Company *</label>
                <select value={form.companyId} onChange={e => setForm({ ...form, companyId: e.target.value })}>
                  <option value="">Select a tenant company…</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name} ({c.slug})</option>)}
                </select>
              </div>
            </div>
          )}
          <div className="tx-form-row tx-form-row--1">
            <div className="tx-field"><label>Full Name *</label>
              <input value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} placeholder="e.g. Tendai Moyo" required />
            </div>
          </div>
          <div className="tx-form-row tx-form-row--1">
            <div className="tx-field"><label>Phone Number</label>
              <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="e.g. +263 71 234 5678" inputMode="tel" />
            </div>
          </div>
          <div className="tx-form-row">
            <div className="tx-field"><label>Role *</label>
              <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                {ROLE_FILTERS.filter(r => r !== 'ALL').map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div className="tx-field"><label>Sales Code / Username</label>
              <input value={form.salesCode} onChange={e => setForm({ ...form, salesCode: e.target.value.toUpperCase() })} placeholder="Auto-generated if blank" />
            </div>
          </div>
          {error && <div className="auth-error" style={{ marginBottom: 10 }}>{error}</div>}
          <div className="tx-muted" style={{ marginBottom: 14 }}>
            A secure password is generated automatically and shown once. Driver and Conductor accounts cannot sign in to this portal.
          </div>
          {isPlatform && !form.companyId && (
            <div className="auth-error" style={{ marginBottom: 14 }}>Select a tenant company first — no tenant companies are available.</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn-secondary" disabled={saving || (isPlatform && !form.companyId)}><FiUserPlus /> Create &amp; Generate Credentials</button>
          </div>
        </form>
      </Modal>

      <Modal open={!!revealed} onClose={() => setRevealed(null)} title="Staff Credentials — Show Once">
        {revealed && (
          <>
            <p className="tx-muted" style={{ marginBottom: 8 }}>
              <FiCheckCircle color="var(--green)" style={{ verticalAlign: 'middle' }} /> {revealed.fullName} · {revealed.role}
            </p>
            <div className="tx-cred-reveal">
              <b>Username:</b> {revealed.username}<br />
              <b>Password:</b> {revealed.password}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn-secondary" onClick={copy}><FiCopy /> Copy</button>
              <button className="btn-primary" onClick={() => setRevealed(null)}>Done</button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Staff Member">
        {editTarget && (
          <form onSubmit={saveEdit}>
            <div className="tx-form-row tx-form-row--1">
              <div className="tx-field"><label>Full Name *</label>
                <input value={editForm.fullName} onChange={e => setEditForm({ ...editForm, fullName: e.target.value })} required />
              </div>
            </div>
            <div className="tx-form-row tx-form-row--1">
              <div className="tx-field"><label>Phone Number</label>
                <input value={editForm.phone} onChange={e => setEditForm({ ...editForm, phone: e.target.value })} placeholder="e.g. +263 71 234 5678" inputMode="tel" />
              </div>
            </div>
            <div className="tx-form-row tx-form-row--1">
              <div className="tx-field"><label>Role *</label>
                <select value={editForm.role} onChange={e => setEditForm({ ...editForm, role: e.target.value })}>
                  {ROLE_FILTERS.filter(r => r !== 'ALL').map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <p className="tx-muted" style={{ marginBottom: 12 }}>
              Editing <b>@{editTarget.username}</b>. Username and credentials stay unchanged; only the name,
              phone and role are updated. The phone prints on tickets via the field app.
            </p>
            {['CONDUCTOR', 'DRIVER', 'TICKET_SELLER'].includes(editTarget.role) && !['CONDUCTOR', 'DRIVER', 'TICKET_SELLER'].includes(editForm.role) && (
              <div className="tx-notice" style={{ marginBottom: 12 }}>
                Moving @{editTarget.username} out of a field role will release their bound
                terminal(s) back to the unclaimed pool — they will need to re-register.
              </div>
            )}
            {error && <div className="auth-error" style={{ marginBottom: 10 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn-secondary" onClick={() => setEditTarget(null)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={saving}><FiEdit2 /> Save Changes</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!unbindTarget} onClose={() => setUnbindTarget(null)} title="Unbind Device(s)">
        {unbindTarget && (
          <>
            <p className="tx-muted" style={{ marginBottom: 8 }}>
              <FiUnlock color="var(--cyan)" style={{ verticalAlign: 'middle' }} /> @{unbindTarget.username} · {unbindTarget.full_name}
            </p>
            <div className="tx-notice" style={{ marginBottom: 12 }}>
              {unbindTarget.devices && unbindTarget.devices.length > 0
                ? <>
                    <b>{unbindTarget.devices.length} bound terminal{unbindTarget.devices.length === 1 ? '' : 's'}</b> with signing
                    keys will be released and put back into the unclaimed pool:
                    {unbindTarget.devices.map(d => (
                      <div key={d.id} style={{ marginTop: 6, fontFamily: 'monospace' }}>• {d.deviceUuid} <span className="tx-muted">({d.status})</span></div>
                    ))}
                  </>
                : 'No bound devices are currently locked to this profile.'}
            </div>
            <p className="tx-muted">
              The affected terminal will need to re-register with another staff member before it can sell offline or sync tickets.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn-secondary" onClick={() => setUnbindTarget(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => unbind(unbindTarget)} disabled={busy}>
                <FiUnlock /> Unbind &amp; Release
              </button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Staff Member">
        {deleteTarget && (
          <>
            <p style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 }}>
              <FiAlertTriangle color="var(--red, #B91C1C)" style={{ marginTop: 3, flexShrink: 0 }} />
              <span>
                Permanently delete <b>@{deleteTarget.username}</b> ({deleteTarget.full_name}) from the fleet?
              </span>
            </p>
            <div className="tx-notice">
              Hard delete is only allowed when the profile has <b>zero</b> linked shifts, tickets or trips —
              for erroneous/test entries. Active staff must be <b>Deactivated</b> instead. This cannot be undone.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="btn-secondary btn-danger" onClick={confirmDelete} disabled={busy}>
                <FiTrash2 /> Delete Permanently
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}