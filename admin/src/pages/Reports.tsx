import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { showToast } from '../utils/toast';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Badge from '../components/Badge';

export default function Reports() {
  const [tab, setTab] = useState('revenue');
  const [revenue, setRevenue] = useState<any>(null);
  const [staffSales, setStaffSales] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try { setRevenue(await api.get('/revenue')); } catch { /* ignore */ }
    try { setStaffSales(await api.get('/staff-sales')); } catch { /* ignore */ }
    try { setPending(await api.get('/cash-handovers/pending')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); const t = setInterval(loadData, 30000); return () => clearInterval(t); }, [loadData]);

  const approveHandover = async (id: string) => {
    try { await api.post(`/cash-handovers/${id}/approve`); showToast({ title: 'Approved', message: 'Handover approved successfully', type: 'success' }); } catch { /* ignore */ }
    loadData();
  };
  const rejectHandover = async (id: string) => {
    try { await api.post(`/cash-handovers/${id}/reject`); showToast({ title: 'Rejected', message: 'Handover rejected', type: 'warning' }); } catch { /* ignore */ }
    loadData();
  };

  const exportStaffMember = async (staffId: string, staffName: string) => {
    const token = api.getToken();
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/staff-sales/export/${staffId}`, {
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
      a.download = `Preyone_Sales_${staffName.replace(/\s+/g, '_')}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      showToast({ title: 'Export Failed', message: e.message, type: 'error' });
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Reports</h2>
          <p className="page-desc">Revenue, Sales & Handover Management</p>
        </div>
      </div>

      <div className="auth-tabs" style={{ marginBottom: 16 }}>
        <button className={`auth-tab ${tab === 'revenue' ? 'active' : ''}`} onClick={() => setTab('revenue')}>Revenue</button>
        <button className={`auth-tab ${tab === 'sales' ? 'active' : ''}`} onClick={() => setTab('sales')}>Staff Sales</button>
        <button className={`auth-tab ${tab === 'handovers' ? 'active' : ''}`} onClick={() => setTab('handovers')}>Handovers ({pending.length})</button>
      </div>

      {tab === 'revenue' && revenue && (
        <>
          <div className="stats-grid stats-grid--compact" style={{ marginBottom: 20 }}>
            <div className="stat-card stat-green"><span className="stat-label">Total Revenue</span><span className="stat-number"><span className="money">${Number(revenue.combinedRevenue || revenue.totalRevenue || 0).toFixed(2)} USD</span></span></div>
            <div className="stat-card stat-orange"><span className="stat-label">Pending</span><span className="stat-number"><span className="money">${Number(revenue.pendingRevenue || 0).toFixed(2)} USD</span></span></div>
            <div className="stat-card stat-blue"><span className="stat-label">Handover Approved</span><span className="stat-number"><span className="money">${Number(revenue.handoverApproved || 0).toFixed(2)} USD</span></span></div>
            <div className="stat-card"><span className="stat-label">Handover Pending</span><span className="stat-number"><span className="money">${Number(revenue.handoverPending || 0).toFixed(2)} USD</span></span></div>
          </div>

          {revenue.byTier && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Revenue by Package Tier</div>
              <div style={{ padding: 16 }}>
                {Object.entries(revenue.byTier).map(([tier, amount]: any) => (
                  <div key={tier} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontWeight: 600 }}>{tier}</span>
                    <span className="money">${Number(amount).toFixed(2)} USD</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {revenue.recentTransactions?.length > 0 && (
            <div className="card">
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Recent Transactions</div>
              <div className="card-table">
                <table className="data-table">
                  <thead><tr><th>Date</th><th>Voucher</th><th>Package</th><th>Amount</th><th>Sold By</th><th>Status</th></tr></thead>
                  <tbody>
                    {revenue.recentTransactions.map((t: any, i: number) => (
                      <tr key={i}>
                        <td>{t.created_at ? new Date(t.created_at).toLocaleString() : '—'}</td>
                        <td><span className="code-cell">{t.code || t.voucher_code}</span></td>
                        <td>{t.package_tier || t.tier || '—'}</td>
                        <td><span className="money money--sm">${Number(t.price_amount || t.amount || 0).toFixed(2)} USD</span></td>
                        <td>{t.sold_by_name || t.sold_by || '—'}</td>
                        <td>{t.handover_status === 'approved' ? <Badge variant="approved">Approved</Badge> : t.handover_status === 'pending' ? <Badge variant="pending">Pending</Badge> : <Badge variant="default">—</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'sales' && staffSales && (
        <>
          {staffSales.staffSummary?.length > 0 && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Staff Performance</div>
              <div className="card-table">
                <table className="data-table">
                  <thead><tr><th>Staff</th><th>Role</th><th>Total Sales</th><th>Total Amount</th><th></th></tr></thead>
                  <tbody>
                    {staffSales.staffSummary.map((s: any, i: number) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{s.full_name}</td>
                        <td><Badge variant={s.role === 'Manager' ? 'info' : 'default'}>{s.role}</Badge></td>
                        <td>{s.total_sales || 0}</td>
                        <td><span className="money money--sm">${Number(s.total_amount || 0).toFixed(2)} USD</span></td>
                        <td><button className="btn-sm" style={{ background: 'linear-gradient(135deg, var(--purple), var(--pink))', border: 'none', color: '#fff' }} onClick={() => exportStaffMember(s.id, s.full_name)} title="Download staff sales">Download Sales Excel</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {staffSales.allSales?.length > 0 && (
            <div className="card">
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>All Sales</div>
              <div className="card-table">
                <table className="data-table">
                  <thead><tr><th>Date</th><th>Voucher</th><th>Package</th><th>Amount</th><th>Sold By</th></tr></thead>
                  <tbody>
                    {staffSales.allSales.map((s: any, i: number) => (
                      <tr key={i}>
                        <td>{s.created_at ? new Date(s.created_at).toLocaleString() : '—'}</td>
                        <td><span className="code-cell">{s.code}</span></td>
                        <td>{s.package_tier || '—'}</td>
                        <td><span className="money money--sm">${Number(s.price_amount || 0).toFixed(2)} USD</span></td>
                        <td>{s.sold_by_name || s.sold_by || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {staffSales.dailyBreakdown?.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Daily Sales Breakdown</div>
              <div className="card-table">
                <table className="data-table">
                  <thead><tr><th>Date</th><th>Staff</th><th>Role</th><th>Sales</th><th>Amount</th></tr></thead>
                  <tbody>
                    {staffSales.dailyBreakdown.map((d: any, i: number) => (
                      <tr key={i}>
                        <td>{d.sale_date ? new Date(d.sale_date).toLocaleDateString() : '—'}</td>
                        <td style={{ fontWeight: 600 }}>{d.full_name}</td>
                        <td><Badge variant={d.role === 'Manager' ? 'info' : 'default'}>{d.role}</Badge></td>
                        <td>{d.sales_count || 0}</td>
                        <td><span className="money money--sm">${Number(d.total_amount || 0).toFixed(2)} USD</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'handovers' && (
        pending.length === 0 ? (
          <EmptyState icon="✅" title="No Pending Handovers" message="All cash handovers have been processed." />
        ) : (
          <div className="card">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
              Pending Cash Handovers ({pending.length})
            </div>
            {pending.map((h: any) => (
              <div key={h.id} className="alert-row">
                <div style={{ flex: 1 }}>
                  <div className="alert-title">{h.staff_name || 'Staff'} — <span className="money">${Number(h.total_amount || 0).toFixed(2)} USD</span></div>
                  <div className="alert-meta">{h.created_at ? new Date(h.created_at).toLocaleString() : ''} · {h.sale_count || h.sales?.length || 0} sale(s)</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-sm btn-approve" onClick={() => approveHandover(h.id)}>Approve Handover</button>
                  <button className="btn-sm btn-reject" onClick={() => rejectHandover(h.id)}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
