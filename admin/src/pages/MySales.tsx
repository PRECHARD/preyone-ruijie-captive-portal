import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';

export default function MySales() {
  const { user } = useAuth();
  const isMgmt = user?.role === 'CEO' || user?.role === 'Manager';
  const [sales, setSales] = useState<any>(null);
  const [handovers, setHandovers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState<any>(null);
  const [msg, setMsg] = useState('');

  const fetch = useCallback(async () => {
    try { setSales(await api.get('/my-sales')); } catch { /* ignore */ }
    try { setHandovers(await api.get('/cash-handovers/my')); } catch { /* ignore */ }
    try { setAvailable(await api.get('/cash-handovers/available-sales')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const submitHandover = async () => {
    if (!available?.sales?.length) return;
    try {
      await api.post('/cash-handovers', { saleIds: available.sales.map((s: any) => s.id) });
      setMsg('Handover submitted for approval');
      fetch();
    } catch (e: any) { setMsg(e.message); }
  };

  if (loading) return <Spinner />;

  const saleList = sales?.sales || [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">My Sales</h2>
          <p className="page-desc">
            {sales?.totalSales || 0} sale(s) · {sales?.totalAmount ? `${Number(sales.totalAmount).toFixed(2)} ${sales.currency || 'USD'}` : '—'}
          </p>
        </div>
      </div>

      {sales && (
        <div className="stats-grid stats-grid--compact" style={{ marginBottom: 20 }}>
          <div className="stat-card"><span className="stat-label">Total Sales</span><span className="stat-number" style={{ color: 'var(--green)' }}>{sales.totalSales || 0}</span></div>
          <div className="stat-card"><span className="stat-label">Total Amount</span><span className="stat-number" style={{ color: 'var(--cyan)' }}>{Number(sales.totalAmount || 0).toFixed(2)} USD</span></div>
          {available && (
            <div className="stat-card clickable" onClick={submitHandover}>
              <span className="stat-label">Available for Handover</span>
              <span className="stat-number" style={{ color: 'var(--orange)' }}>{available.count || 0}</span>
              {available.count > 0 && <span style={{ fontSize: 11, color: 'var(--cyan)' }}>Click to submit →</span>}
            </div>
          )}
        </div>
      )}

      {msg && (
        <div className={`form-status ${msg.includes('submitted') || msg.includes('Success') ? 'form-status--success' : 'form-status--error'}`} style={{ marginBottom: 16 }}>
          {msg}
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>My Voucher Sales</div>
        {saleList.length === 0 ? (
          <EmptyState icon="💳" title="No Sales Yet" message="Vouchers you create will appear here." />
        ) : (
          <Table
            columns={[
              { key: 'code', label: 'Code', width: '120px', render: (r: any) => <span className="code-cell">{r.code}</span> },
              { key: 'package_tier', label: 'Package', width: '100px', render: (r: any) => r.package_tier || '—' },
              { key: 'price_amount', label: 'Price', width: '90px', render: (r: any) => r.price_amount ? `${Number(r.price_amount).toFixed(2)} USD` : '—' },
              { key: 'used_count', label: 'Used', width: '70px', render: (r: any) => `${r.used_count || 0}/${r.max_uses || 1}` },
              { key: 'created_at', label: 'Created', width: '160px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
              { key: 'handover', label: 'Handover', width: '90px', render: (r: any) =>
                r.handover_status === 'approved' ? <Badge variant="approved">Approved</Badge> :
                r.handover_status === 'pending' ? <Badge variant="pending">Pending</Badge> :
                <Badge variant="default">—</Badge>
              },
            ]}
            data={saleList}
          />
        )}
      </div>

      {handovers.length > 0 && (
        <div className="card">
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Cash Handover History</div>
          <Table
            columns={[
              { key: 'created_at', label: 'Date', width: '170px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
              { key: 'amount', label: 'Amount', width: '100px', render: (r: any) => `${Number(r.amount || 0).toFixed(2)} USD` },
              { key: 'sale_count', label: 'Sales', width: '70px', render: (r: any) => r.sale_count || (r.sales?.length) || '—' },
              { key: 'status', label: 'Status', width: '100px', render: (r: any) =>
                r.status === 'approved' ? <Badge variant="approved">Approved</Badge> :
                r.status === 'rejected' ? <Badge variant="rejected">Rejected</Badge> :
                <Badge variant="pending">Pending</Badge>
              },
              { key: 'approved_by', label: 'Approved By', render: (r: any) => r.approved_by_name || '—' },
            ]}
            data={handovers}
          />
        </div>
      )}
    </div>
  );
}
