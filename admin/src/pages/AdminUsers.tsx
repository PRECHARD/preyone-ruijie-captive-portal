import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';

export default function AdminUsers() {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try { setUsers(await api.get('/admin-users')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Admin Users</h2>
          <p className="page-desc">{users.length} registered admin(s)</p>
        </div>
      </div>
      {users.length === 0 ? (
        <EmptyState icon="👤" title="No Admin Users" />
      ) : (
        <div className="card">
          <Table
            columns={[
              { key: 'full_name', label: 'Name' },
              { key: 'email', label: 'Email' },
              { key: 'phone', label: 'Phone', width: '130px' },
              { key: 'role', label: 'Role', width: '100px', render: (r: any) => <Badge variant={r.role === 'CEO' ? 'info' : r.role === 'Manager' ? 'warning' : 'default'}>{r.role}</Badge> },
              { key: 'created_at', label: 'Created', width: '160px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
            ]}
            data={users}
          />
        </div>
      )}
    </div>
  );
}
