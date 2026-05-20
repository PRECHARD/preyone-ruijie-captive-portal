import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Badge from '../components/Badge';

export default function Reports() {
  const { user } = useAuth();
  const isCEO = user?.role === 'CEO';
  const [tab, setTab] = useState('revenue');
  const [revenue, setRevenue] = useState<any>(null);
  const [staffSales, setStaffSales] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try { setRevenue(await api.get('/revenue')); } catch { /* ignore */ }
    try { setStaffSales(await api.get('/staff-sales')); } catch { /* ignore */ }
    try { setPending(await api.get('/cash-handovers/pending')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); const t = setInterval(fetch, 30000); return () => clearInterval(t); }, [fetch]);

  const approveHandover = async (id: string) => { await api.post(`/cash-handovers/${id}/approve`); fetch(); };
  const rejectHandover = async (id: string) => { await api.post(`/cash-handovers/${id}/reject`); fetch(); };
  const exportCsv = () => { window.open('/api/admin/revenue/export', '_blank'); };

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Reports</h2>
          <p className="page-desc">Revenue, Sales & Handover Management</p>
        </div>
        {isCEO && <button className="btn-primary" onClick={exportCsv}>Export CSV</button>}
      </div>

      <div className="auth-tabs" style={{ marginBottom: 16 }}>
        <button className={`auth-tab ${tab === 'revenue' ? 'active' : ''}`} onClick={() => setTab('revenue')}>Revenue</button>
        <button className={`auth-tab ${tab === 'sales' ? 'active' : ''}`} onClick={() => setTab('sales')}>Staff Sales</button>
        <button className={`auth-tab ${tab === 'handovers' ? 'active' : ''}`} onClick={() => setTab('handovers')}>Handovers ({pending.length})</button>
      </div>

      {tab === 'revenue' && revenue && (
        <>
          <div className="stats-grid stats-grid--compact" style={{ marginBottom: 20 }}>
            <div className="stat-card stat-green"><span className="stat-label">Total Revenue</span><span className="stat-number">{Number(revenue.combinedRevenue || revenue.totalRevenue || 0).toFixed(2)} USD</span></div>
            <div className="stat-card stat-orange"><span className="stat-label">Pending</span><span className="stat-number">{Number(revenue.pendingRevenue || 0).toFixed(2)} USD</span></div>
            <div className="stat-card stat-blue"><span className="stat-label">Handover Approved</span><span className="stat-number">{Number(revenue.handoverApproved || 0).toFixed(2)} USD</span></div>
            <div className="stat-card"><span className="stat-label">Handover Pending</span><span className="stat-number">{Number(revenue.handoverPending || 0).toFixed(2)} USD</span></div>
          </div>

          {revenue.byTier && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Revenue by Package Tier</div>
              <div style={{ padding: 16 }}>
                {Object.entries(revenue.byTier).map(([tier, amount]: any) => (
                  <div key={tier} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontWeight: 600 }}>{tier}</span>
                    <span style={{ color: 'var(--cyan)' }}>{Number(amount).toFixed(2)} USD</span>
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
                        <td style={{ color: 'var(--cyan)' }}>{Number(t.price_amount || t.amount || 0).toFixed(2)} USD</td>
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
                  <thead><tr><th>Staff</th><th>Total Sales</th><th>Total Amount</th></tr></thead>
                  <tbody>
                    {staffSales.staffSummary.map((s: any, i: number) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{s.full_name}</td>
                        <td>{s.total_sales || 0}</td>
                        <td style={{ color: 'var(--cyan)' }}>{Number(s.total_amount || 0).toFixed(2)} USD</td>
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
                        <td style={{ color: 'var(--cyan)' }}>{Number(s.price_amount || 0).toFixed(2)} USD</td>
                        <td>{s.sold_by_name || s.sold_by || '—'}</td>
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
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Pending Cash Handovers</div>
            {pending.map((h: any) => (
              <div key={h.id} className="alert-row">
                <div style={{ flex: 1 }}>
                  <div className="alert-title">{h.admin_name || h.staff_name || 'Staff'} — {Number(h.amount || 0).toFixed(2)} USD</div>
                  <div className="alert-meta">{h.created_at ? new Date(h.created_at).toLocaleString() : ''} · {h.sales?.length || 0} sale(s)</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-sm btn-approve" onClick={() => approveHandover(h.id)}>Approve</button>
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
