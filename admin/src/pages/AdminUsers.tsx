import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';

export default function AdminUsers() {
  const { user } = useAuth();
  const isCEO = user?.role === 'CEO';
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const fetch = useCallback(async () => {
    try { setUsers(await api.get('/admin-users')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const handleAction = async (action: string, targetId: string) => {
    setMsg('');
    try {
      const endpoints: Record<string, string> = {
        promote: `/manager-promote/${targetId}`,
        demote: `/manager-demote/${targetId}`,
        removeStaff: `/staff-remove/${targetId}`,
        removeManager: `/manager-remove/${targetId}`,
      };
      const result = await api.post(endpoints[action]);
      setMsg(result.message || 'Done');
      fetch();
    } catch (e: any) { setMsg(e.message); }
  };

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Admin Users</h2>
          <p className="page-desc">{users.length} registered admin(s)</p>
        </div>
      </div>

      {msg && (
        <div className={`form-status ${msg.includes('successfully') || msg.includes('promoted') || msg.includes('Demoted') ? 'form-status--success' : 'form-status--error'}`} style={{ marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {users.length === 0 ? (
        <EmptyState icon="👤" title="No Admin Users" />
      ) : (
        <div className="card">
          <Table
            columns={[
              { key: 'full_name', label: 'Name' },
              { key: 'email', label: 'Email' },
              { key: 'phone', label: 'Phone', width: '130px' },
              { key: 'role', label: 'Role', width: '100px', render: (r: any) => {
                const badgeVariant = r.role === 'CEO' ? 'info' : r.role === 'Manager' ? 'warning' : 'default';
                return <Badge variant={badgeVariant}>{r.role}</Badge>;
              }},
              { key: 'created_at', label: 'Created', width: '160px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
              ...(isCEO ? [{
                key: 'actions' as string, label: '', width: '220px', render: (r: any) => {
                  if (r.role === 'CEO') return <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>;
                  return (
                    <div style={{ display: 'flex', gap: 4 }}>
                      {r.role === 'Staff' && (
                        <button className="btn-sm btn-approve" onClick={() => handleAction('promote', r.id)}>Promote</button>
                      )}
                      {r.role === 'Manager' && (
                        <button className="btn-sm" style={{ borderColor: 'var(--orange)', color: 'var(--orange)' }} onClick={() => handleAction('demote', r.id)}>Demote</button>
                      )}
                      <button className="btn-sm" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}
                        onClick={() => handleAction(r.role === 'Manager' ? 'removeManager' : 'removeStaff', r.id)}
                        disabled={r.id === user?.id}>
                        {r.id === user?.id ? 'You' : 'Remove'}
                      </button>
                    </div>
                  );
                },
              }] : []),
            ]}
            data={users}
          />
        </div>
      )}
    </div>
  );
}
