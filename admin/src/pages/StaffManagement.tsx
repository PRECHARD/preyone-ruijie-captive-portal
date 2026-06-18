import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';

export default function StaffManagement() {
  const { user } = useAuth();
  const isCEO = user?.role === 'CEO';
  const [tab, setTab] = useState<'active' | 'pending' | 'managers'>('active');
  const [staff, setStaff] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [managers, setManagers] = useState<any[]>([]);
  const [statuses, setStatuses] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const fetch = useCallback(async () => {
    try { setStaff(await api.get('/staff')); } catch { /* ignore */ }
    try { setPending(await api.get('/staff-pending')); } catch { /* ignore */ }
    try { setStatuses(await api.get('/staff-status')); } catch { /* ignore */ }
    if (isCEO) { try { setManagers(await api.get('/managers')); } catch { /* ignore */ } }
    setLoading(false);
  }, [isCEO]);

  useEffect(() => { fetch(); }, [fetch]);

  const handleAction = async (action: string, id: string) => {
    setMsg('');
    try {
      const endpoints: Record<string, string> = {
        approve: `/staff-approve/${id}`,
        reject: `/staff-reject/${id}`,
        activate: `/staff-activate/${id}`,
        deactivate: `/staff-deactivate/${id}`,
        remove: `/staff-remove/${id}`,
        promote: `/manager-promote/${id}`,
        demote: `/manager-demote/${id}`,
        removeManager: `/manager-remove/${id}`,
      };
      const result = await api.post(endpoints[action]);
      setMsg(result.message || `${action}d successfully`);
      fetch();
    } catch (e: any) { setMsg(e.message); }
  };

  if (loading) return <Spinner />;

  const statusMap: Record<string, any> = {};
  if (statuses?.statuses) {
    statuses.statuses.forEach((s: any) => { statusMap[s.id] = s; });
  }

  const managerCount = managers.length;
  const maxManagers = 2;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Staff Management</h2>
          <p className="page-desc">{statuses?.onlineCount || 0} online · {statuses?.totalStaff || staff.length} total</p>
        </div>
        {isCEO && (
          <div className="page-header-extra">
            <Badge variant={managerCount >= maxManagers ? 'inactive' : 'active'}>
              Managers: {managerCount}/{maxManagers}
            </Badge>
          </div>
        )}
      </div>

      <div className="auth-tabs" style={{ marginBottom: 16 }}>
        <button className={`auth-tab ${tab === 'active' ? 'active' : ''}`} onClick={() => setTab('active')}>Active ({staff.length})</button>
        <button className={`auth-tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>Pending ({pending.length})</button>
        {isCEO && <button className={`auth-tab ${tab === 'managers' ? 'active' : ''}`} onClick={() => setTab('managers')}>Managers ({managerCount})</button>}
      </div>

      {msg && (
        <div className={`form-status ${msg.includes('successfully') || msg.includes('approved') || msg.includes('activated') || msg.includes('promoted') || msg.includes('Demoted') ? 'form-status--success' : msg.includes('rejected') || msg.includes('deactivated') ? 'form-status--cyan' : 'form-status--error'}`} style={{ marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {tab === 'active' && (
        staff.length === 0 ? (
          <EmptyState icon="👤" title="No Staff Accounts" message="No staff accounts created yet." />
        ) : (
          <div className="card">
            <Table
              columns={[
                { key: 'full_name', label: 'Name' },
                { key: 'email', label: 'Email' },
                { key: 'phone', label: 'Phone' },
                { key: 'role', label: 'Role', width: '90px', render: (r: any) => <Badge variant={r.role === 'Manager' ? 'info' : 'default'}>{r.role}</Badge> },
                { key: 'status', label: 'Status', width: '90px', render: (r: any) => {
                  const s = statusMap[r.id];
                  return s?.is_online ? <Badge variant="active">Online</Badge> : <Badge variant="default">Offline</Badge>;
                }},
                { key: 'commission_pct', label: 'Commission', width: '90px', render: (r: any) => r.commission_pct != null ? `${r.commission_pct}%` : '—' },
                { key: 'approved', label: 'Approved', width: '80px', render: (r: any) => r.approved ? <Badge variant="active">Yes</Badge> : <Badge variant="inactive">No</Badge> },
                { key: 'actions', label: '', width: '280px', render: (r: any) => (
                  <div style={{ display: 'flex', gap: 4 }}>
                    {r.approved
                      ? <button className="btn-sm" style={{ borderColor: 'var(--orange)', color: 'var(--orange)' }} onClick={() => handleAction('deactivate', r.id)}>Deactivate</button>
                      : <button className="btn-sm btn-approve" onClick={() => handleAction('activate', r.id)}>Activate</button>
                    }
                    <button className="btn-sm" style={{ borderColor: 'var(--red)', color: 'var(--red)' }} onClick={() => handleAction('remove', r.id)}>Remove</button>
                    {isCEO && r.role === 'Staff' && (
                      <button className="btn-sm btn-approve" onClick={() => handleAction('promote', r.id)}>Promote</button>
                    )}
                    {isCEO && r.role === 'Manager' && (
                      <button className="btn-sm" style={{ borderColor: 'var(--orange)', color: 'var(--orange)' }} onClick={() => handleAction('demote', r.id)}>Demote</button>
                    )}
                  </div>
                )},
              ]}
              data={staff}
            />
          </div>
        )
      )}

      {tab === 'pending' && (
        pending.length === 0 ? (
          <EmptyState icon="✅" title="No Pending Approvals" message="All staff accounts have been reviewed." />
        ) : (
          <div className="card">
            <Table
              columns={[
                { key: 'full_name', label: 'Name' },
                { key: 'email', label: 'Email' },
                { key: 'phone', label: 'Phone' },
                { key: 'created_at', label: 'Requested', width: '170px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
                { key: 'actions', label: '', width: '140px', render: (r: any) => (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn-sm btn-approve" onClick={() => handleAction('approve', r.id)}>Approve</button>
                    <button className="btn-sm btn-reject" onClick={() => handleAction('reject', r.id)}>Reject</button>
                  </div>
                )},
              ]}
              data={pending}
            />
          </div>
        )
      )}

      {isCEO && tab === 'managers' && (
        managers.length === 0 ? (
          <EmptyState icon="👤" title="No Managers" message="No Manager accounts have been created." />
        ) : (
          <div className="card">
            <Table
              columns={[
                { key: 'full_name', label: 'Name' },
                { key: 'email', label: 'Email' },
                { key: 'phone', label: 'Phone', width: '130px' },
                { key: 'role', label: 'Role', width: '90px', render: () => <Badge variant="info">Manager</Badge> },
                { key: 'created_at', label: 'Created', width: '160px', render: (row: any) => row.created_at ? new Date(row.created_at).toLocaleString() : '—' },
                { key: 'actions', label: '', width: '180px', render: (r: any) => (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn-sm" style={{ borderColor: 'var(--orange)', color: 'var(--orange)' }} onClick={() => handleAction('demote', r.id)}>Demote to Staff</button>
                    <button className="btn-sm" style={{ borderColor: 'var(--red)', color: 'var(--red)' }} onClick={() => handleAction('removeManager', r.id)}>Remove</button>
                  </div>
                )},
              ]}
              data={managers}
            />
          </div>
        )
      )}
    </div>
  );
}
