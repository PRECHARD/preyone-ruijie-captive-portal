import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { showToast } from '../utils/toast';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';

type Tab = 'sales' | 'handover' | 'history';
type Range = 'today' | 'week' | 'month' | 'all';

export default function MySales() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('sales');
  const [sales, setSales] = useState<any>(null);
  const [handovers, setHandovers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [range, setRange] = useState<Range>('all');
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    try { setSales(await api.get('/my-sales')); } catch { /* ignore */ }
    try { setHandovers(await api.get('/cash-handovers/my')); } catch { /* ignore */ }
    try { setAvailable(await api.get('/cash-handovers/available-sales')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const submitHandover = async () => {
    const ids = availSales.map((s: any) => s.id);
    if (!ids.length) return;
    setSubmitting(true);
    try {
      const data = await api.post<any>('/cash-handovers', { saleIds: ids });
      showToast({ title: 'Handover Submitted', message: data.message, type: 'success' });
      loadData();
    } catch (e: any) {
      showToast({ title: 'Handover Failed', message: e.message, type: 'error' });
    }
    setSubmitting(false);
  };

  const exportExcel = async () => {
    const token = api.getToken();
    if (!token) return;
    try {
      const res = await fetch('/api/admin/my-sales/export', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        let msg = 'Export failed';
        try { const err = await res.json(); msg = err.error || msg; } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Preyone_Sales_${user?.fullName?.replace(/\s+/g, '_') || 'export'}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      showToast({ title: 'Export Failed', message: e.message, type: 'error' });
    }
  };

  const saleList = sales?.sales || [];
  const availSales = available?.sales || [];
  const totalAvailable = available?.totalAvailable || 0;

  const filteredSales = useMemo(() => {
    let list = [...saleList];
    if (range === 'today') {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      list = list.filter((s: any) => s.created_at && new Date(s.created_at) >= today);
    } else if (range === 'week') {
      const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
      list = list.filter((s: any) => s.created_at && new Date(s.created_at) >= weekAgo);
    } else if (range === 'month') {
      const monthAgo = new Date(); monthAgo.setMonth(monthAgo.getMonth() - 1);
      list = list.filter((s: any) => s.created_at && new Date(s.created_at) >= monthAgo);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((s: any) => (s.code || '').toLowerCase().includes(q) || (s.package_tier || '').toLowerCase().includes(q));
    }
    return list;
  }, [saleList, range, search]);

  const packageBreakdown = useMemo(() => {
    const map: Record<string, { count: number; total: number }> = {};
    saleList.forEach((s: any) => {
      const tier = s.package_tier || 'Bulk Sales';
      if (!map[tier]) map[tier] = { count: 0, total: 0 };
      map[tier].count++;
      map[tier].total += parseFloat(s.price_amount || '0');
    });
    return Object.entries(map).sort((a, b) => b[1].total - a[1].total);
  }, [saleList]);

  const pendingHandoverTotal = handovers.filter((h: any) => h.status === 'pending').reduce((sum, h) => sum + parseFloat(h.total_amount || '0'), 0);
  const approvedHandoverTotal = handovers.filter((h: any) => h.status === 'approved').reduce((sum, h) => sum + parseFloat(h.total_amount || '0'), 0);

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">My Sales</h2>
          <p className="page-desc">{sales?.totalSales || 0} sale(s) · {sales?.totalAmount ? <span className="money">${Number(sales.totalAmount).toFixed(2)} {sales.currency || 'USD'}</span> : '—'}</p>
        </div>
        {tab === 'sales' && filteredSales.length > 0 && (
            <button className="btn-secondary" onClick={exportExcel}>

            Export Excel
          </button>
        )}
      </div>

      <div className="stats-grid stats-grid--compact" style={{ marginBottom: 20 }}>
        <div className="stat-card"><span className="stat-label">Total Sales</span><span className="stat-number" style={{ color: 'var(--green)' }}>{sales?.totalSales || 0}</span></div>
        <div className="stat-card"><span className="stat-label">Total Revenue</span><span className="stat-number"><span className="money">${Number(sales?.totalAmount || 0).toFixed(2)} USD</span></span></div>
        <div className="stat-card"><span className="stat-label">Pending Handover</span><span className="stat-number" style={{ color: 'var(--orange)' }}><span className="money">${pendingHandoverTotal.toFixed(2)} USD</span></span></div>
        <div className="stat-card"><span className="stat-label">Approved Handover</span><span className="stat-number" style={{ color: 'var(--green)' }}><span className="money">${approvedHandoverTotal.toFixed(2)} USD</span></span></div>
      </div>

      <div className="auth-tabs" style={{ marginBottom: '1rem' }}>
        <button className={'auth-tab' + (tab === 'sales' ? ' active' : '')} onClick={() => setTab('sales')}>Voucher Sales</button>
        <button className={'auth-tab' + (tab === 'handover' ? ' active' : '')} onClick={() => setTab('handover')}>
          Available for Handover {availSales.length > 0 ? <span className="sidebar-badge" style={{ marginLeft: 6, display: 'inline-flex' }}>{availSales.length}</span> : ''}
        </button>
        <button className={'auth-tab' + (tab === 'history' ? ' active' : '')} onClick={() => setTab('history')}>Handover History</button>
      </div>

      {tab === 'sales' && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['today', 'week', 'month', 'all'] as Range[]).map(r => (
                  <button key={r} className={'btn-sm' + (range === r ? ' btn-approve' : '')} onClick={() => setRange(r)} style={{ textTransform: 'capitalize' }}>{r}</button>
                ))}
              </div>
              <input type="text" placeholder="Search by code or package..." value={search} onChange={e => setSearch(e.target.value)}
                style={{ flex: 1, minWidth: 180, padding: '7px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontFamily: 'var(--font-body)', fontSize: 13 }} />
            </div>
          </div>

          {packageBreakdown.length > 0 && (
            <div className="stats-grid stats-grid--compact" style={{ marginBottom: 16 }}>
              {packageBreakdown.map(([tier, data]) => (
                <div key={tier} className="stat-card">
                  <span className="stat-label">{tier}</span>
                  <span className="stat-number" style={{ fontSize: 13 }}>{data.count} sale(s)</span>
                  <span className="money money--sm" style={{ display: 'block', marginTop: 2 }}>${data.total.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>My Voucher Sales {filteredSales.length !== saleList.length ? <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>({filteredSales.length} of {saleList.length})</span> : ''}</div>
            {filteredSales.length === 0 ? (
              <EmptyState icon="💳" title="No Sales Yet" message="Vouchers you create will appear here." />
            ) : (
              <Table
                columns={[
                  { key: 'code', label: 'Code', width: '120px', render: (r: any) => <span className="code-cell">{r.code}</span> },
                  { key: 'package_tier', label: 'Package', width: '100px', render: (r: any) => r.package_tier || '—' },
                  { key: 'price_amount', label: 'Price', width: '110px', render: (r: any) => r.price_amount ? <span className="money money--sm">{'$' + Number(r.price_amount).toFixed(2) + ' USD'}</span> : '—' },
                  { key: 'used_count', label: 'Used', width: '70px', render: (r: any) => `${r.used_count || 0}/${r.max_uses || 1}` },
                  { key: 'created_at', label: 'Created', width: '160px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
                  { key: 'handover', label: 'Handover', width: '90px', render: (r: any) =>
                    r.handover_status === 'approved' ? <Badge variant="approved">Approved</Badge> :
                    r.handover_status === 'handed_over' ? <Badge variant="pending">Handed Over</Badge> :
                    r.handover_status === 'pending' ? <Badge variant="default">Pending</Badge> :
                    <Badge variant="default">—</Badge>
                  },
                ]}
                data={filteredSales}
              />
            )}
          </div>
        </>
      )}

      {tab === 'handover' && (
        <div className="card">
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Available for Handover {availSales.length > 0 ? <span style={{ color: 'var(--orange)' }}>({availSales.length} sale(s), <span className="money">{'$' + Number(totalAvailable).toFixed(2) + ' USD'}</span>)</span> : ''}</span>
            {availSales.length > 0 && (
              <button className="btn-primary" style={{ fontSize: '0.8rem', padding: '0.4rem 1rem' }} onClick={submitHandover} disabled={submitting}>
                {submitting ? 'Submitting...' : `Handover All (${availSales.length})`}
              </button>
            )}
          </div>
          {availSales.length === 0 ? (
            <EmptyState icon="✅" title="All Caught Up" message="All your sales have been handed over." />
          ) : (
            <div className="card-table">
              <table className="data-table">
                <thead><tr><th>Code</th><th>Package</th><th>Amount</th><th>Sold At</th></tr></thead>
                <tbody>
                  {availSales.map((s: any) => (
                    <tr key={s.id}>
                      <td><span className="code-cell">{s.voucher_code}</span></td>
                      <td>{s.package_tier || '—'}</td>
                      <td><span className="money money--sm">{'$' + Number(s.amount || 0).toFixed(2) + ' USD'}</span></td>
                      <td style={{ fontSize: 11, color: 'var(--text-dim)' }}>{s.sold_at ? new Date(s.sold_at).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {availSales.length > 0 && (
            <div style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
              All sales will be handed over when you click the button above
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="card">
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Cash Handover History</div>
          {handovers.length === 0 ? (
            <EmptyState icon="📋" title="No Handovers Yet" message="Handovers you submit will appear here." />
          ) : (
            <Table
              columns={[
                { key: 'created_at', label: 'Date', width: '170px', render: (r: any) => r.created_at ? new Date(r.created_at).toLocaleString() : '—' },
                { key: 'total_amount', label: 'Amount', width: '120px', render: (r: any) => <span className="money money--sm">{'$' + Number(r.total_amount || 0).toFixed(2) + ' USD'}</span> },
                { key: 'sale_count', label: 'Sales', width: '70px', render: (r: any) => r.sale_count || '—' },
                { key: 'status', label: 'Status', width: '100px', render: (r: any) =>
                  r.status === 'approved' ? <Badge variant="approved">Approved</Badge> :
                  r.status === 'rejected' ? <Badge variant="rejected">Rejected</Badge> :
                  <Badge variant="pending">Pending</Badge>
                },
                { key: 'approved_by', label: 'Approved By', render: (r: any) => r.approved_by_name || '—' },
              ]}
              data={handovers}
            />
          )}
        </div>
      )}
    </div>
  );
}
