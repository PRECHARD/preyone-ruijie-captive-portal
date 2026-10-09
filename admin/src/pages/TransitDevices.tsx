import { useState, useEffect, useCallback } from 'react';
import { transitApi } from '../api/client';
import Table from '../components/Table';
import Modal from '../components/Modal';
import { FiAlertOctagon, FiRefreshCw, FiSmartphone, FiPower, FiUnlock, FiPlus } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import '../styles/pages.css';
import '../styles/transit.css';

interface DeviceRow {
  device_id: string;
  device_uuid: string;
  device_model: string;
  app_version: string;
  status: string;
  last_sync: string | null;
  last_seen: string | null;
  battery_pct: number | null;
  active_trip: string | null;
  bound_username: string;
  bound_name: string;
  bound_role: string;
  company_name: string;
  revoked_at: string | null;
}

interface BlockedRow {
  id: string;
  hardware_id: string;
  hardware_type: string;
  device_name: string;
  reason: string;
  blocked_at: string;
  blocked_by_name: string | null;
  bound_device_id: string | null;
  bound_uuid: string | null;
  bound_status: string | null;
  bound_model: string | null;
}

const fmtAgo = (d: string | null) => {
  if (!d) return 'never';
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');

const BLOCKED_TYPES = ['MAC', 'UUID', 'SERIAL'];

export default function TransitDevices() {
  const { user } = useAuth();
  const canBlock = user?.permissions?.includes('system.developer');

  const [tab, setTab] = useState<'devices' | 'blocked'>('devices');

  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<DeviceRow | null>(null);
  const [working, setWorking] = useState(false);
  const [statusFilter, setStatusFilter] = useState('ALL');

  const [blockedRows, setBlockedRows] = useState<BlockedRow[]>([]);
  const [blockedLoading, setBlockedLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [confirmUnblock, setConfirmUnblock] = useState<BlockedRow | null>(null);
  const [unblocking, setUnblocking] = useState(false);
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [blockForm, setBlockForm] = useState({ hardwareId: '', hardwareType: 'UUID', deviceName: '', reason: '' });
  const [savingBlock, setSavingBlock] = useState(false);

  const load = useCallback(async () => {
    try {
      setError('');
      const data = await transitApi.get<{ devices: DeviceRow[] }>('/devices');
      setRows(data.devices);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBlocked = useCallback(async () => {
    if (!canBlock) return;
    try {
      setBlockedLoading(true);
      const data = await transitApi.get<{ devices: BlockedRow[] }>(`/blocked-devices?q=${encodeURIComponent(search)}`);
      setBlockedRows(data.devices);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBlockedLoading(false);
    }
  }, [canBlock, search]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab === 'blocked') {
      const t = setTimeout(loadBlocked, 250);
      return () => clearTimeout(t);
    }
  }, [tab, search, loadBlocked]);

  const filtered = statusFilter === 'ALL' ? rows : rows.filter(r => r.status === statusFilter);

  const revoke = async () => {
    if (!confirm) return;
    setWorking(true);
    try {
      await transitApi.post(`/devices/${confirm.device_uuid}/revoke`);
      setConfirm(null);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };

  const unblock = async () => {
    if (!confirmUnblock) return;
    setUnblocking(true);
    try {
      await transitApi.del(`/blocked-devices/${encodeURIComponent(confirmUnblock.hardware_id)}`);
      setConfirmUnblock(null);
      loadBlocked();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUnblocking(false);
    }
  };

  const submitBlock = async () => {
    setSavingBlock(true);
    try {
      await transitApi.post('/blocked-devices', blockForm);
      setShowBlockModal(false);
      setBlockForm({ hardwareId: '', hardwareType: 'UUID', deviceName: '', reason: '' });
      loadBlocked();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingBlock(false);
    }
  };

  const blockedFiltered = typeFilter === 'ALL'
    ? blockedRows
    : blockedRows.filter(b => b.hardware_type === typeFilter);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Device Controls</h1>
          <p className="page-desc">Remote management for POS hardware. Register, revoke, and block devices by hardware identifier.</p>
        </div>
      </div>

      <div className="tx-tabs">
        <button className={'tx-tab' + (tab === 'devices' ? ' active' : '')} onClick={() => setTab('devices')}>Registered Devices</button>
        {canBlock && (
          <button className={'tx-tab' + (tab === 'blocked' ? ' active' : '')} onClick={() => setTab('blocked')}>Blocked Devices</button>
        )}
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      {tab === 'devices' && (
        <>
          <div className="tx-toolbar">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="ALL">All statuses</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="DISABLED">DISABLED</option>
              <option value="REVOKED">REVOKED</option>
              <option value="UNBOUND">UNBOUND</option>
            </select>
            <button className="btn-secondary" onClick={load}><FiRefreshCw /> Refresh</button>
          </div>

          <div className="card">
            {loading ? (
              <div className="table-empty">Loading devices…</div>
            ) : (
              <Table<DeviceRow>
                columns={[
                  { key: 'device_uuid', label: 'POS Serial Number', render: r => (
                    <span>
                      <span style={{ fontWeight: 700, color: 'var(--cyan)' }}><FiSmartphone style={{ verticalAlign: 'middle' }} /> {r.device_uuid}</span>
                      <div className="tx-muted">{r.device_model || 'Generic device'}</div>
                    </span>
                  )},
                  { key: 'bound', label: 'Bound Staff Member', render: r => (
                    <span>
                      {r.bound_name || r.bound_username || '—'}
                      <div className="tx-muted">@{r.bound_username}</div>
                    </span>
                  )},
                  { key: 'app_version', label: 'App Version', render: r => <span className="tx-num">{r.app_version || '—'}</span> },
                  { key: 'battery_pct', label: 'Battery', render: r => (r.battery_pct === null || r.battery_pct === undefined ? '—' : `${r.battery_pct}%`) },
                  { key: 'active_trip', label: 'Active Trip', render: r => (r.active_trip ? `#${r.active_trip}` : <span className="tx-muted">—</span>) },
                  { key: 'last_sync', label: 'Last Sync', render: r => <span className="tx-muted">{fmtAgo(r.last_sync)}</span> },
                  { key: 'last_seen', label: 'Last Seen', render: r => <span className="tx-muted">{fmtAgo(r.last_seen)}</span> },
                  { key: 'status', label: 'Status', render: r => (
                    <span className={'status-chip status-chip--' + r.status.toLowerCase()}>{r.status}</span>
                  )},
                  { key: 'actions', label: '', render: r => (
                    r.status !== 'REVOKED' ? (
                      <button className="tx-btn-danger" onClick={() => setConfirm(r)} disabled={r.status !== 'ACTIVE'}>
                        <FiAlertOctagon /> Revoke Device Access
                      </button>
                    ) : <span className="tx-muted">revoked{r.revoked_at ? ` ${new Date(r.revoked_at).toLocaleString()}` : ''}</span>
                  )},
                ]}
                data={filtered}
                emptyMessage="No registered POS devices."
              />
            )}
          </div>

          <Modal open={!!confirm} onClose={() => setConfirm(null)} title="Revoke Device Access?">
            {confirm && (
              <>
                <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 }}>
                  You are about to <b style={{ color: 'var(--red)' }}>permanently revoke</b> POS device{' '}
                  <b style={{ color: 'var(--text)' }}>{confirm.device_uuid}</b> bound to{' '}
                  <b style={{ color: 'var(--text)' }}>{confirm.bound_name || confirm.bound_username}</b>.
                  Its active JWT is invalidated immediately, all signing keys are cleared, and the hardware is blocked from syncing.
                  This cannot be undone.
                </p>
                {error && <div className="auth-error" style={{ marginBottom: 10 }}>{error}</div>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                  <button className="btn-secondary" onClick={() => setConfirm(null)}>Cancel</button>
                  <button className="tx-btn-danger" onClick={revoke} disabled={working}>
                    <FiPower /> {working ? 'Revoking…' : 'Revoke Device Access'}
                  </button>
                </div>
              </>
            )}
          </Modal>
        </>
      )}

      {tab === 'blocked' && canBlock && (
        <>
          <div className="tx-toolbar">
            <input
              type="text"
              placeholder="Search hardware ID or MAC…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ minWidth: 240 }}
            />
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              <option value="ALL">All types</option>
              {BLOCKED_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className="btn-secondary" onClick={() => { setBlockForm({ hardwareId: '', hardwareType: 'UUID', deviceName: '', reason: '' }); setShowBlockModal(true); }}>
              <FiPlus /> Block Device
            </button>
            <button className="btn-secondary" onClick={loadBlocked}><FiRefreshCw /> Refresh</button>
          </div>

          <div className="card">
            {blockedLoading ? (
              <div className="table-empty">Loading blocked devices…</div>
            ) : (
              <Table<BlockedRow>
                columns={[
                  { key: 'hardware_id', label: 'Hardware ID / MAC', render: r => (
                    <span>
                      <span style={{ fontWeight: 700, color: 'var(--red)' }}>{r.hardware_id}</span>
                      <div className="tx-muted">
                        <span className={'status-chip status-chip--disabled'}>{r.hardware_type}</span>
                        {r.bound_uuid ? ` bound to ${r.bound_uuid} (${r.bound_status})` : ' not currently registered'}
                      </div>
                    </span>
                  )},
                  { key: 'device_name', label: 'Device Name / Model', render: r => (
                    <span>
                      {r.device_name || '—'}
                      {r.bound_model ? <div className="tx-muted">{r.bound_model}</div> : null}
                    </span>
                  )},
                  { key: 'blocked_at', label: 'Date Blocked', render: r => <span className="tx-muted">{fmtDate(r.blocked_at)}</span> },
                  { key: 'reason', label: 'Reason', render: r => <span>{r.reason || <span className="tx-muted">No reason provided</span>}</span> },
                  { key: 'actions', label: '', render: r => (
                    <button className="tx-btn-danger" onClick={() => setConfirmUnblock(r)}>
                      <FiUnlock /> Unblock Device
                    </button>
                  )},
                ]}
                data={blockedFiltered}
                emptyMessage="No blocked devices."
              />
            )}
          </div>

          <Modal open={!!confirmUnblock} onClose={() => setConfirmUnblock(null)} title="Unblock Device?">
            {confirmUnblock && (
              <>
                <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 }}>
                  Are you sure you want to unblock this hardware? This will allow fresh app installations and account
                  registrations from this device.
                </p>
                <div style={{ marginTop: 10 }}>
                  <div className="tx-cred-reveal">
                    <b>Hardware ID:</b> {confirmUnblock.hardware_id}<br />
                    <b>Type:</b> {confirmUnblock.hardware_type}<br />
                    <b>Blocked:</b> {fmtDate(confirmUnblock.blocked_at)} by {confirmUnblock.blocked_by_name || 'Unknown'}<br />
                    <b>Reason:</b> {confirmUnblock.reason || 'No reason provided'}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                  <button className="btn-secondary" onClick={() => setConfirmUnblock(null)}>Cancel</button>
                  <button className="tx-btn-danger" onClick={unblock} disabled={unblocking}>
                    <FiUnlock /> {unblocking ? 'Unblocking…' : 'Unblock Device'}
                  </button>
                </div>
              </>
            )}
          </Modal>

          <Modal open={showBlockModal} onClose={() => setShowBlockModal(false)} title="Block Device">
            <div className="tx-field" style={{ marginBottom: 12 }}>
              <label>Hardware ID / MAC Address</label>
              <input
                placeholder="e.g. A1B2-C3D4-E5F6 or 00:1A:2B:3C:4D:5E"
                value={blockForm.hardwareId}
                onChange={e => setBlockForm(f => ({ ...f, hardwareId: e.target.value }))}
              />
            </div>
            <div className="tx-form-row">
              <div className="tx-field">
                <label>Hardware Type</label>
                <select value={blockForm.hardwareType} onChange={e => setBlockForm(f => ({ ...f, hardwareType: e.target.value }))}>
                  {BLOCKED_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="tx-field">
                <label>Device Name / Model</label>
                <input
                  placeholder="e.g. RU-G100 POS"
                  value={blockForm.deviceName}
                  onChange={e => setBlockForm(f => ({ ...f, deviceName: e.target.value }))}
                />
              </div>
            </div>
            <div className="tx-field">
              <label>Reason</label>
              <textarea
                rows={3}
                placeholder="Why is this hardware blocked?"
                value={blockForm.reason}
                onChange={e => setBlockForm(f => ({ ...f, reason: e.target.value }))}
              />
            </div>
            {error && <div className="auth-error" style={{ marginBottom: 10 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="btn-secondary" onClick={() => setShowBlockModal(false)}>Cancel</button>
              <button className="tx-btn-danger" onClick={submitBlock} disabled={savingBlock || !blockForm.hardwareId.trim()}>
                {savingBlock ? 'Blocking…' : 'Block Device'}
              </button>
            </div>
          </Modal>
        </>
      )}
    </div>
  );
}