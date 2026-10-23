import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { showToast } from '../utils/toast';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';
import './MySales.css';

type Tab = 'sales' | 'handover' | 'history';
type Range = 'today' | 'week' | 'month' | 'all';

const tooltipStyle = {
  background: '#0b1222',
  border: '1px solid #1e2c45',
  borderRadius: 8,
  color: '#e2e8f0',
  fontSize: 12,
};

const PAYMENT_COLORS = ['#00ccff', '#ff2d95', '#a855f7', '#22e6a8'];

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

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
    filteredSales.forEach((s: any) => {
      const tier = s.package_tier || 'Bulk Sales';
      if (!map[tier]) map[tier] = { count: 0, total: 0 };
      map[tier].count++;
      map[tier].total += money(s.price_amount);
    });
    return Object.entries(map).sort((a, b) => b[1].total - a[1].total);
  }, [filteredSales]);

  const revenueTrend = useMemo(() => {
    const map = new Map<string, { day: string; label: string; revenue: number; sales: number }>();
    for (const sale of filteredSales) {
      if (!sale.created_at) continue;
      const at = new Date(sale.created_at);
      if (Number.isNaN(at.getTime())) continue;
      const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
      const entry = map.get(day) ?? {
        day,
        label: at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        revenue: 0,
        sales: 0,
      };
      entry.revenue += parseFloat(sale.price_amount || '0') || 0;
      entry.sales += 1;
      map.set(day, entry);
    }
    return [...map.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-30);
  }, [filteredSales]);

  const paymentMix = useMemo(() => {
    const map = new Map<string, { name: string; value: number; amount: number }>();
    for (const sale of filteredSales) {
      const name = sale.payment_method || 'Cash';
      const entry = map.get(name) ?? { name, value: 0, amount: 0 };
      entry.value += 1;
      entry.amount += parseFloat(sale.price_amount || '0') || 0;
      map.set(name, entry);
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [filteredSales]);

  const pendingHandoverTotal = handovers.filter((h: any) => h.status === 'pending').reduce((sum, h) => sum + money(h.total_amount), 0);
  const approvedHandoverTotal = handovers.filter((h: any) => h.status === 'approved').reduce((sum, h) => sum + money(h.total_amount), 0);

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">My Sales</h2>
          <p className="page-desc">{sales?.totalSales || 0} sale(s) · {sales?.totalAmount ? <span className="money">${money(sales.totalAmount).toFixed(2)} {sales.currency || 'USD'}</span> : '—'}</p>
        </div>
        {tab === 'sales' && filteredSales.length > 0 && (
            <button className="btn-secondary" onClick={exportExcel}>

            Export Excel
          </button>
        )}
      </div>

      <div className="stats-grid stats-grid--compact stats-grid--hero" style={{ marginBottom: 20 }}>
        <div className="stat-card stat-violet"><span className="stat-label">Total Sales</span><span className="stat-number">{sales?.totalSales || 0}</span></div>
        <div className="stat-card stat-gold"><span className="stat-label">Total Revenue</span><span className="stat-number"><span className="money">${money(sales?.totalAmount).toFixed(2)} USD</span></span></div>
        <div className="stat-card stat-cyan"><span className="stat-label">Pending Handover</span><span className="stat-number"><span className="money">${money(pendingHandoverTotal).toFixed(2)} USD</span></span></div>
        <div className="stat-card stat-green"><span className="stat-label">Approved Handover</span><span className="stat-number"><span className="money">${money(approvedHandoverTotal).toFixed(2)} USD</span></span></div>
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

          {(revenueTrend.length > 0 || paymentMix.length > 0) && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)',
                gap: 16,
                marginBottom: 16,
              }}
              className="my-sales-charts"
            >
              <div className="card" style={{ padding: 8 }}>
                <div className="section-header" style={{ border: 'none', padding: '4px 8px 0' }}>
                  Revenue Trend
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)', fontWeight: 500 }}>
                    {revenueTrend.reduce((sum, d) => sum + d.revenue, 0).toFixed(2)} USD
                  </span>
                </div>
                <ResponsiveContainer width="100%" height={210}>
                  <AreaChart data={revenueTrend} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="mySalesRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#00ccff" stopOpacity={0.42} />
                        <stop offset="100%" stopColor="#00ccff" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={false} width={38} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value: any, name: any) => [
                        name === 'revenue' ? `$${Number(value).toFixed(2)}` : value,
                        name === 'revenue' ? 'Revenue' : 'Sales',
                      ]}
                    />
                    <Area type="monotone" dataKey="revenue" stroke="#00ccff" strokeWidth={2} fill="url(#mySalesRevenue)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="card" style={{ padding: 8 }}>
                <div className="section-header" style={{ border: 'none', padding: '4px 8px 0' }}>
                  Payment Mix
                </div>
                <ResponsiveContainer width="100%" height={210}>
                  <PieChart>
                    <Pie
                      data={paymentMix}
                      dataKey="amount"
                      nameKey="name"
                      innerRadius={52}
                      outerRadius={76}
                      paddingAngle={3}
                      stroke="transparent"
                    >
                      {paymentMix.map((entry, index) => (
                        <Cell key={entry.name} fill={PAYMENT_COLORS[index % PAYMENT_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value: any, name: any) => [`$${Number(value).toFixed(2)}`, name]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 10, padding: '0 8px 8px' }}>
                  {paymentMix.map((entry, index) => (
                    <span key={entry.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--text-muted)' }}>
                      <i style={{ width: 7, height: 7, borderRadius: 999, background: PAYMENT_COLORS[index % PAYMENT_COLORS.length] }} />
                      {entry.name} ({entry.value})
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

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
                  { key: 'payment_method', label: 'Paid Via', width: '110px', render: (r: any) => {
                    const m = r.payment_method || 'Cash';
                    return m === 'Cash'
                      ? <Badge variant="approved">Cash</Badge>
                      : <Badge variant="pending">📱 {m}</Badge>;
                  } },
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
