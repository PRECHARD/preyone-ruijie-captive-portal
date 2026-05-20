import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';

export default function Users() {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try { setUsers(await api.get('/users')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Users</h2>
          <p className="page-desc">{users.length} registered user(s)</p>
        </div>
      </div>
      {users.length === 0 ? (
        <EmptyState icon="👥" title="No Users" message="No users have registered yet." />
      ) : (
        <div className="card">
          <Table
            columns={[
              { key: 'full_name', label: 'Name' },
              { key: 'phone', label: 'Phone', width: '140px' },
              { key: 'voucher_code', label: 'Voucher', width: '120px', render: (r: any) => <span className="code-cell">{r.voucher_code}</span> },
              { key: 'mac_address', label: 'MAC', width: '150px', render: (r: any) => <code style={{ fontSize: 11 }}>{r.mac_address || '—'}</code> },
              { key: 'ip_address', label: 'IP', width: '130px' },
              { key: 'created_at', label: 'Registered', width: '160px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
            ]}
            data={users}
          />
        </div>
      )}
    </div>
  );
}
