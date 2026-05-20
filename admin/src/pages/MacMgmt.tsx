import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Modal from '../components/Modal';

export default function MacMgmt() {
  const [tab, setTab] = useState<'blacklist' | 'whitelist'>('blacklist');
  const [blacklist, setBlacklist] = useState<any[]>([]);
  const [whitelist, setWhitelist] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [mac, setMac] = useState('');
  const [reason, setReason] = useState('');
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState('');

  const fetch = useCallback(async () => {
    try { setBlacklist(await api.get('/blacklist')); } catch { /* ignore */ }
    try { setWhitelist(await api.get('/whitelist')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const addEntry = async () => {
    setMsg('');
    try {
      if (tab === 'blacklist') {
        await api.post('/blacklist', { macAddress: mac, reason });
      } else {
        await api.post('/whitelist', { macAddress: mac, label });
      }
      setMac(''); setReason(''); setLabel('');
      setShowAdd(false);
      setMsg(`${tab === 'blacklist' ? 'Blacklist' : 'Whitelist'} entry added`);
      fetch();
    } catch (e: any) { setMsg(e.message); }
  };

  const removeEntry = async (id: string, list: 'blacklist' | 'whitelist') => {
    try {
      await api.del(`/${list}/${id}`);
      fetch();
    } catch (e: any) { setMsg(e.message); }
  };

  if (loading) return <Spinner />;

  const list = tab === 'blacklist' ? blacklist : whitelist;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">MAC Management</h2>
          <p className="page-desc">{blacklist.length} blacklisted · {whitelist.length} whitelisted</p>
        </div>
        <button className="btn-primary" onClick={() => setShowAdd(true)}>Add MAC</button>
      </div>

      <div className="auth-tabs" style={{ marginBottom: 16 }}>
        <button className={`auth-tab ${tab === 'blacklist' ? 'active' : ''}`} onClick={() => setTab('blacklist')}>Blacklist ({blacklist.length})</button>
        <button className={`auth-tab ${tab === 'whitelist' ? 'active' : ''}`} onClick={() => setTab('whitelist')}>Whitelist ({whitelist.length})</button>
      </div>

      {msg && (
        <div className={`form-status ${msg.includes('added') || msg.includes('success') || msg.includes('removed') ? 'form-status--success' : 'form-status--error'}`} style={{ marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState icon="🔒" title={tab === 'blacklist' ? 'No Blacklisted MACs' : 'No Whitelisted MACs'} message={`No ${tab} entries found.`} />
      ) : (
        <div className="card">
          <Table
            columns={[
              { key: 'mac_address', label: 'MAC Address', width: '170px', render: (r: any) => <code style={{ fontSize: 11 }}>{r.mac_address}</code> },
              ...(tab === 'blacklist'
                ? [{ key: 'reason', label: 'Reason', render: (r: any) => r.reason || '—' } as any,
                   { key: 'blocked_by_name', label: 'Blocked By', render: (r: any) => r.blocked_by_name || '—' } as any]
                : [{ key: 'label', label: 'Label', render: (r: any) => r.label || '—' } as any]
              ),
              { key: 'created_at', label: 'Added', width: '160px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
              { key: 'actions', label: '', width: '50px', render: (r: any) =>
                <button className="btn-sm" style={{ borderColor: 'var(--red)', color: 'var(--red)' }} onClick={() => removeEntry(r.id, tab)}>✕</button>
              },
            ]}
            data={list}
          />
        </div>
      )}

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title={`Add to ${tab === 'blacklist' ? 'Blacklist' : 'Whitelist'}`}>
        <div className="auth-form">
          <div className="auth-field">
            <label>MAC Address</label>
            <input value={mac} onChange={e => setMac(e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" />
          </div>
          {tab === 'blacklist' ? (
            <div className="auth-field">
              <label>Reason</label>
              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Optional reason" />
            </div>
          ) : (
            <div className="auth-field">
              <label>Label</label>
              <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Optional label" />
            </div>
          )}
          <button className="auth-btn" onClick={addEntry}>Add Entry</button>
        </div>
      </Modal>
    </div>
  );
}
