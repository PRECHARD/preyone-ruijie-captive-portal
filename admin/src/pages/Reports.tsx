import { useState, useEffect, useCallback } from 'react';
import { api, ruijieApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { showToast } from '../utils/toast';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Badge from '../components/Badge';
import Modal from '../components/Modal';

type Props = { onNavigate?: (s: string) => void; canPeakHours?: boolean };

export default function Reports({ onNavigate, canPeakHours }: Props = {}) {
  const { user } = useAuth();
  // "Send Now" hits a SYSTEM_DEVELOPER endpoint (CEO/developer only). Managers
  // can read every report but must not be shown a button that 403s.
  const canSendReport = ['CEO', 'SUPER_ADMIN', 'COMPANY_ADMIN'].includes(user?.role || '');
  const [tab, setTab] = useState('revenue');
  const [revenue, setRevenue] = useState<any>(null);
  const [staffSales, setStaffSales] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // â”€â”€ Ruijie accounting sub-tab â”€â”€
  const [acctStatus, setAcctStatus] = useState<any>(null);
  const [acctVouchers, setAcctVouchers] = useState<any[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [voucherSyncBusy, setVoucherSyncBusy] = useState<string | null>(null);
  const [voucherDetail, setVoucherDetail] = useState<any>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  // â”€â”€ Month-End report sub-tab â”€â”€
  const [monthEnd, setMonthEnd] = useState<any>(null);
  const [sendingReport, setSendingReport] = useState(false);

  const loadAccounting = useCallback(() => {
    ruijieApi.get('/status').then(setAcctStatus).catch(() => {});
    api.get<{ vouchers: any[] }>('/vouchers')
      .then((d) => setAcctVouchers((d.vouchers || []).filter((v) => v.data_consumed_mb != null)))
      .catch(() => {});
  }, []);

  useEffect(() => { if (tab === 'accounting') loadAccounting(); }, [tab, loadAccounting]);

  const runAccountingSync = async () => {
    setSyncing(true);
    try {
      const r = await ruijieApi.post<{
        skipped?: boolean; reason?: string; onlineUsers?: number;
        accountingRecords?: number; matchedVouchers?: number; updated?: number; errors?: string[];
      }>('/accounting/sync');
      if (r?.skipped) {
        showToast({ title: 'Sync Skipped', message: r.reason || 'Ruijie Cloud not configured', type: 'warning' });
      } else if (r?.errors?.length) {
        showToast({ title: 'Sync Finished With Errors', message: `${r.updated ?? 0} updated Â· ${r.errors[0]}`, type: 'warning' });
      } else {
        showToast({
          title: 'Accounting Synced',
          message: `${r.updated ?? 0} voucher(s) updated from ${r.accountingRecords ?? 0} cloud records`,
          type: 'success',
        });
      }
    } catch (e: any) {
      showToast({ title: 'Sync Failed', message: e.message || 'Accounting sync failed', type: 'error' });
    } finally {
      setSyncing(false);
      loadAccounting();
    }
  };

  // Client-side CSV â€” no backend round-trip, works while offline.
  const exportAccountingCsv = () => {
    if (acctVouchers.length === 0) {
      showToast({ title: 'Nothing To Export', message: 'No vouchers have usage data yet', type: 'warning' });
      return;
    }
    const esc = (x: any) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const header = ['Code', 'Holder', 'Phone', 'Package', 'Price USD', 'Data Used MB', 'Last Sync', 'Sync Status'];
    const lines = [
      header.map(esc).join(','),
      ...acctVouchers.map((v) => [
        v.code, v.holder_name, v.holder_phone, v.package_tier, v.price_amount,
        v.data_consumed_mb, v.last_accounting_sync, v.ruijie_sync_status,
      ].map(esc).join(',')),
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Preyone_Accounting_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const loadData = useCallback(async () => {
    try { setRevenue(await api.get('/revenue')); } catch { /* ignore */ }
    try { setStaffSales(await api.get('/staff-sales')); } catch { /* ignore */ }
    try { setPending(await api.get('/cash-handovers/pending')); } catch { /* ignore */ }
    try { setMonthEnd(await api.get('/reports/month-end')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); const t = setInterval(loadData, 30000); return () => clearInterval(t); }, [loadData]);

  /** Stream an authenticated report file (Excel/CSV) to the device. */
  const downloadReport = async (path: string, fileName: string) => {
    const token = api.getToken();
    if (!token) return;
    try {
      const res = await fetch(`/api/admin${path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        let msg = 'Download failed';
        try { const err = await res.json(); msg = err.error || msg; } catch { /* non-JSON */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      showToast({ title: 'Download Failed', message: e.message, type: 'error' });
    }
  };

  const sendMonthEndNow = async () => {
    setSendingReport(true);
    try {
      const result = await api.post<any>('/reports/month-end/send', {});
      showToast({
        title: result?.sent ? 'Report Sent' : 'Report Not Sent',
        message: result?.sent
          ? `Delivered to ${(result.recipients || []).join(', ')}`
          : (result?.error || 'SMTP is not configured on this server.'),
        type: result?.sent ? 'success' : 'warning',
      });
    } catch (e: any) {
      showToast({ title: 'Send Failed', message: e.message, type: 'error' });
    } finally {
      setSendingReport(false);
    }
  };

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

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportAllStaffSales = async () => {
    const token = api.getToken();
    if (!token) return;
    setExporting('all-staff');
    try {
      const res = await fetch('/api/admin/staff-sales/export', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        let msg = 'Export failed';
        try { const err = await res.json(); msg = err.error || msg; } catch {}
        throw new Error(msg);
      }
      downloadBlob(await res.blob(), 'Preyone_All_Staff_Sales.xlsx');
      showToast({ title: 'Exported', message: 'All-staff sales workbook downloaded', type: 'success' });
    } catch (e: any) {
      showToast({ title: 'Export Failed', message: e.message, type: 'error' });
    } finally {
      setExporting(null);
    }
  };

  const exportRevenueCsv = async () => {
    const token = api.getToken();
    if (!token) return;
    setExporting('revenue');
    try {
      const res = await fetch('/api/admin/revenue/export', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        let msg = 'Export failed';
        try { const err = await res.json(); msg = err.error || msg; } catch {}
        throw new Error(msg);
      }
      downloadBlob(await res.blob(), `Preyone_Revenue_${new Date().toISOString().slice(0, 10)}.csv`);
      showToast({ title: 'Exported', message: 'Revenue CSV downloaded', type: 'success' });
    } catch (e: any) {
      showToast({ title: 'Export Failed', message: e.message, type: 'error' });
    } finally {
      setExporting(null);
    }
  };

  // â”€â”€ Per-voucher Ruijie verify (POST /vouchers/:code/sync) â”€â”€
  const verifyVoucherOnRuijie = async (code: string) => {
    setVoucherSyncBusy(code);
    try {
      const r = await ruijieApi.post<any>(`/vouchers/${encodeURIComponent(code)}/sync`);
      if (r?.skipped) {
        showToast({ title: 'Skipped', message: r.reason || 'Ruijie Cloud not configured', type: 'warning' });
      } else if (r?.found === false || r?.status === 'missing') {
        showToast({ title: 'Not Found on Ruijie', message: `Voucher ${code} is missing from Ruijie Cloud`, type: 'warning' });
      } else {
        showToast({ title: 'Synced', message: `Voucher ${code} verified on Ruijie Cloud`, type: 'success' });
      }
    } catch (e: any) {
      showToast({ title: 'Sync Failed', message: e.message || 'Voucher sync failed', type: 'error' });
    } finally {
      setVoucherSyncBusy(null);
      loadAccounting();
    }
  };

  const openVoucherDetail = async (code: string) => {
    try {
      const r = await ruijieApi.get<any>(`/vouchers/${encodeURIComponent(code)}`);
      setVoucherDetail(r);
    } catch (e: any) {
      showToast({ title: 'Lookup Failed', message: e.message, type: 'error' });
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Payment Logs</h2>
          <p className="page-desc">Revenue, staff sales, cash handovers and Ruijie accounting reconciliation.</p>
        </div>
        {canPeakHours && onNavigate && (
          <div className="page-header-extra">
            <button className="btn-sm" onClick={() => onNavigate('peak-hours')}>Peak Hours</button>
          </div>
        )}
      </div>

      <div className="glass-tabs" style={{ marginBottom: 16 }} role="tablist" aria-label="Payment log sections">
        <button type="button" role="tab" aria-selected={tab === 'revenue'} className={'glass-tab' + (tab === 'revenue' ? ' active' : '')} onClick={() => setTab('revenue')}>Revenue</button>
        <button type="button" role="tab" aria-selected={tab === 'sales'} className={'glass-tab' + (tab === 'sales' ? ' active' : '')} onClick={() => setTab('sales')}>Staff Sales</button>
        <button type="button" role="tab" aria-selected={tab === 'handovers'} className={'glass-tab' + (tab === 'handovers' ? ' active' : '')} onClick={() => setTab('handovers')}>Handovers ({pending.length})</button>
        <button type="button" role="tab" aria-selected={tab === 'accounting'} className={'glass-tab' + (tab === 'accounting' ? ' active' : '')} onClick={() => setTab('accounting')}>Accounting</button>
        <button type="button" role="tab" aria-selected={tab === 'month-end'} className={'glass-tab' + (tab === 'month-end' ? ' active' : '')} onClick={() => setTab('month-end')}>Month-End</button>
      </div>

      {tab === 'revenue' && revenue && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn-sm" onClick={exportRevenueCsv} disabled={exporting === 'revenue'} title="Download completed transactions as CSV">
              {exporting === 'revenue' ? 'Exporting…' : 'Export Revenue CSV'}
            </button>
          </div>
          <div className="glass-stats">
            <div className="glass-stat glass-stat--gold">
              <span className="glass-stat__label">Total Revenue</span>
              <span className="glass-stat__value glass-stat__value--gold">${Number(revenue.combinedRevenue || revenue.totalRevenue || 0).toFixed(2)}</span>
              <span className="glass-stat__meta">USD · vouchers + online</span>
            </div>
            <div className="glass-stat">
              <span className="glass-stat__label">Pending</span>
              <span className="glass-stat__value glass-stat__value--cyan">${Number(revenue.pendingRevenue || 0).toFixed(2)}</span>
              <span className="glass-stat__meta">Awaiting capture</span>
            </div>
            <div className="glass-stat glass-stat--green">
              <span className="glass-stat__label">Handover Approved</span>
              <span className="glass-stat__value glass-stat__value--green">${Number(revenue.handoverApproved || 0).toFixed(2)}</span>
              <span className="glass-stat__meta">Reconciled</span>
            </div>
            <div className="glass-stat glass-stat--violet">
              <span className="glass-stat__label">Handover Pending</span>
              <span className="glass-stat__value glass-stat__value--violet">${Number(revenue.handoverPending || 0).toFixed(2)}</span>
              <span className="glass-stat__meta">With staff</span>
            </div>
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
<thead><tr><th>Date</th><th>Voucher</th><th>Client</th><th>Package</th><th>Amount</th><th>Method</th><th>Sold By</th><th>Status</th></tr></thead>
                  <tbody>
                    {revenue.recentTransactions.map((t: any, i: number) => (
                      <tr key={i}>
                        <td>{t.created_at ? new Date(t.created_at).toLocaleString() : '-'}</td>
                        <td><span className="code-cell">{t.code || t.voucher_code || '-'}</span></td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{t.user_name || 'â€”'}</div>
                          {t.user_phone && <div className="muted">{t.user_phone}</div>}
                        </td>
                        <td>{t.package_tier || t.tier || '-'}</td>
                        <td><span className="money money--sm">${Number(t.price_amount || t.amount || 0).toFixed(2)} {t.currency || 'USD'}</span></td>
                        <td>{t.payment_method || '-'}{t.payment_reference ? <div className="muted">{t.payment_reference}</div> : null}</td>
                        <td>{t.sold_by_name || t.sold_by || '-'}</td>
                        <td>{t.status === 'completed' ? <Badge variant="approved">Completed</Badge> : t.status === 'pending' ? <Badge variant="pending">Pending</Badge> : <Badge variant="default">{t.status || '-'}</Badge>}</td>
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn-sm" onClick={exportAllStaffSales} disabled={exporting === 'all-staff'} title="Download every staff member's sales in one workbook">
              {exporting === 'all-staff' ? 'Exportingâ€¦' : 'Export All Staff Sales (Excel)'}
            </button>
          </div>
          {staffSales.staffSummary?.length > 0 && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Staff Performance</div>
              <div className="card-table">
                <table className="data-table">
                  <thead><tr><th>Staff</th><th>Role</th><th>Total Sales</th><th>Total Amount</th><th>Comm. %</th><th>Commission Due</th><th></th></tr></thead>
                  <tbody>
                    {staffSales.staffSummary.map((s: any, i: number) => (
                      <tr key={s.id || i} style={(s.role || '').toUpperCase() === 'CEO' ? { background: 'rgba(212,175,55,0.08)' } : undefined}>
                        <td style={{ fontWeight: 600 }}>
                          {(s.role || '').toUpperCase() === 'CEO' ? 'ðŸ‘‘ ' : ''}{s.full_name}
                        </td>
                        <td><Badge variant={s.role === 'CEO' ? 'gold' : s.role === 'Manager' ? 'info' : 'default'}>{s.role}</Badge></td>
                        <td>{s.total_sales || 0}</td>
                        <td><span className="money money--sm">${Number(s.total_amount || 0).toFixed(2)} USD</span></td>
                        <td>{Number(s.commission_pct || 0).toFixed(2)}%</td>
                        <td><span className="money money--sm money--gold">${Number(s.commission_due || 0).toFixed(2)} USD</span></td>
                        <td><button className="btn-sm" style={{ background: 'linear-gradient(135deg, var(--purple), var(--pink))', border: 'none', color: '#fff' }} onClick={() => exportStaffMember(s.id, s.full_name)} title="Download staff sales">Download Sales Excel</button></td>
                      </tr>
                    ))}
                  </tbody>
                  {staffSales.totals && (
                    <tfoot>
                      <tr>
                        <td style={{ fontWeight: 700 }}>TOTAL</td>
                        <td />
                        <td style={{ fontWeight: 700 }}>{staffSales.totals.sales ?? 0}</td>
                        <td><span className="money money--sm">${Number(staffSales.totals.amount || 0).toFixed(2)} USD</span></td>
                        <td />
                        <td><span className="money money--sm money--gold">${Number(staffSales.totals.commissionDue || 0).toFixed(2)} USD</span></td>
                        <td />
                      </tr>
                    </tfoot>
                  )}
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
                        <td>{s.created_at ? new Date(s.created_at).toLocaleString() : 'â€”'}</td>
                        <td><span className="code-cell">{s.code}</span></td>
                        <td>{s.package_tier || 'â€”'}</td>
                        <td><span className="money money--sm">${Number(s.price_amount || 0).toFixed(2)} USD</span></td>
                        <td>{s.sold_by_name || s.sold_by || 'â€”'}</td>
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
                        <td>{d.sale_date ? new Date(d.sale_date).toLocaleDateString() : 'â€”'}</td>
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
          <EmptyState icon="âœ…" title="No Pending Handovers" message="All cash handovers have been processed." />
        ) : (
          <div className="card">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
              Pending Cash Handovers ({pending.length})
            </div>
            {pending.map((h: any) => (
              <div key={h.id} className="alert-row">
                <div style={{ flex: 1 }}>
                  <div className="alert-title">{h.staff_name || 'Staff'} â€” <span className="money">${Number(h.total_amount || 0).toFixed(2)} USD</span></div>
                  <div className="alert-meta">{h.created_at ? new Date(h.created_at).toLocaleString() : ''} Â· {h.sale_count || h.sales?.length || 0} sale(s)</div>
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
      {tab === 'accounting' && (
        <>
          <div className="glass-stats">
            <div className="glass-stat">
              <span className="glass-stat__label">Vouchers With Usage</span>
              <span className="glass-stat__value glass-stat__value--cyan">{acctStatus?.vouchers?.withUsage ?? 'â€”'}</span>
            </div>
            <div className="glass-stat glass-stat--green">
              <span className="glass-stat__label">Synced To Cloud</span>
              <span className="glass-stat__value glass-stat__value--green">{acctStatus?.vouchers?.bySyncStatus?.synced ?? 'â€”'}</span>
            </div>
            <div className="glass-stat glass-stat--gold">
              <span className="glass-stat__label">Missing / Pending</span>
              <span className="glass-stat__value glass-stat__value--gold" style={{ fontSize: '1.5rem' }}>
                {acctStatus ? `${acctStatus.vouchers.bySyncStatus.missing} / ${acctStatus.vouchers.bySyncStatus.pending}` : 'â€”'}
              </span>
            </div>
            <div className="glass-stat glass-stat--violet">
              <span className="glass-stat__label">Last Accounting Sync</span>
              <span className="glass-stat__value glass-stat__value--violet" style={{ fontSize: '1.05rem', fontWeight: 700 }}>
                {acctStatus?.lastAccountingSync ? new Date(acctStatus.lastAccountingSync).toLocaleString() : 'never'}
              </span>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1 }}>Ruijie Accounting Reconciliation</span>
              <button className="btn-sm" onClick={exportAccountingCsv} title="Download usage CSV">Export CSV</button>
              <button
                className="btn-sm btn-approve"
                onClick={runAccountingSync}
                disabled={syncing}
                title="Pull live usage from Ruijie Cloud into voucher records"
              >
                {syncing ? 'Syncingâ€¦' : 'Sync Now'}
              </button>
            </div>
            <div style={{ padding: '10px 16px', fontSize: 11.5, color: 'var(--text-dim)' }}>
              Reconciles cumulative data usage from Ruijie Cloud into local vouchers (never touches expiry, PIN or uses).
              Auto-sync runs every {acctStatus?.pollingIntervalMin ?? '5'} min when cloud credentials are configured.
              {!acctStatus?.configured && <strong style={{ color: 'var(--orange)' }}> Cloud is not configured â€” sync will be skipped.</strong>}
            </div>
            {acctVouchers.length === 0 ? (
              <div className="table-empty"><p>No vouchers have usage data yet.</p></div>
            ) : (
              <div className="card-table">
                <table className="data-table">
                  <thead><tr><th>Voucher</th><th>Holder</th><th>Data Used</th><th>Last Sync</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {acctVouchers.map((v: any) => (
                      <tr key={v.id}>
                        <td><span className="code-cell">{v.code}</span></td>
                        <td>{v.holder_name || 'â€”'}{v.holder_phone && <span className="muted" style={{ display: 'block', fontSize: 11 }}>{v.holder_phone}</span>}</td>
                        <td><span className="money money--sm">{v.data_consumed_mb >= 1024 ? (v.data_consumed_mb / 1024).toFixed(1) + ' GB' : Number(v.data_consumed_mb).toFixed(1) + ' MB'}</span></td>
                        <td className="muted" style={{ fontSize: 12 }}>{v.last_accounting_sync ? new Date(v.last_accounting_sync).toLocaleString() : 'â€”'}</td>
                        <td>
                          <Badge variant={v.ruijie_sync_status === 'synced' ? 'approved' : v.ruijie_sync_status === 'missing' ? 'rejected' : 'pending'}>
                            {v.ruijie_sync_status || 'never'}
                          </Badge>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              className="btn-sm"
                              disabled={voucherSyncBusy === v.code}
                              onClick={() => verifyVoucherOnRuijie(v.code)}
                              title="Verify this voucher exists on Ruijie Cloud"
                            >
                              {voucherSyncBusy === v.code ? 'â€¦' : 'Verify on Ruijie'}
                            </button>
                            <button className="btn-sm" onClick={() => openVoucherDetail(v.code)} title="View local + Ruijie audit record">
                              Details
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <Modal open={!!voucherDetail} onClose={() => setVoucherDetail(null)} title={voucherDetail?.voucher ? `Voucher ${voucherDetail.voucher.code}` : 'Voucher Details'}>
            {voucherDetail && (
              <div className="auth-form">
                {!voucherDetail.configured && (
                  <div style={{ color: 'var(--orange)', fontSize: 13, marginBottom: 8 }}>
                    Ruijie Cloud is not configured â€” audit record may be unavailable.
                  </div>
                )}
                <div className="auth-field">
                  <label>Local Voucher</label>
                  <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                    <div><b>Code:</b> {voucherDetail.voucher?.code}</div>
                    <div><b>Package:</b> {voucherDetail.voucher?.package_tier || 'â€”'}</div>
                    <div><b>Holder:</b> {voucherDetail.voucher?.holder_name || 'â€”'}{voucherDetail.voucher?.holder_phone ? ` (${voucherDetail.voucher.holder_phone})` : ''}</div>
                    <div><b>Data used:</b> {voucherDetail.voucher?.data_consumed_mb != null ? `${Number(voucherDetail.voucher.data_consumed_mb).toFixed(1)} MB` : 'â€”'}</div>
                    <div><b>Uses:</b> {voucherDetail.voucher?.used_count ?? 'â€”'}</div>
                    <div><b>Sync status:</b> {voucherDetail.voucher?.ruijie_sync_status || 'never'}</div>
                    <div><b>Last accounting sync:</b> {voucherDetail.voucher?.last_accounting_sync ? new Date(voucherDetail.voucher.last_accounting_sync).toLocaleString() : 'â€”'}</div>
                    <div><b>Expires:</b> {voucherDetail.voucher?.expires_at ? new Date(voucherDetail.voucher.expires_at).toLocaleString() : 'â€”'}</div>
                    <div><b>Disabled:</b> {voucherDetail.voucher?.is_disabled ? 'Yes' : 'No'}</div>
                  </div>
                </div>
                <div className="auth-field">
                  <label>Ruijie Audit Record</label>
                  {voucherDetail.ruijie ? (
                    <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                      <div><b>Code No:</b> {voucherDetail.ruijie.code_no}</div>
                      <div><b>Group ID:</b> {voucherDetail.ruijie.user_group_id || 'â€”'}</div>
                      <div><b>Profile UUID:</b> {voucherDetail.ruijie.profile_uuid || 'â€”'}</div>
                      <div><b>Expiry:</b> {voucherDetail.ruijie.ruijie_expiry ? new Date(voucherDetail.ruijie.ruijie_expiry).toLocaleString() : 'â€”'}</div>
                      <div><b>Source:</b> {voucherDetail.ruijie.source || 'â€”'}</div>
                      <div><b>Created:</b> {voucherDetail.ruijie.created_at ? new Date(voucherDetail.ruijie.created_at).toLocaleString() : 'â€”'}</div>
                      <div><b>Comment:</b> {voucherDetail.ruijie.comment || 'â€”'}</div>
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: 13 }}>No Ruijie audit record found for this code.</div>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                  <button className="btn-sm" onClick={() => setVoucherDetail(null)}>Close</button>
                  <button
                    className="btn-sm btn-approve"
                    disabled={voucherSyncBusy === voucherDetail.voucher?.code}
                    onClick={() => { verifyVoucherOnRuijie(voucherDetail.voucher.code); }}
                  >
                    {voucherSyncBusy === voucherDetail.voucher?.code ? 'Verifyingâ€¦' : 'Verify on Ruijie'}
                  </button>
                </div>
              </div>
            )}
          </Modal>
        </>
      )}
      {tab === 'month-end' && (
        <>
          <div className="glass-stats">
            <div className="glass-stat glass-stat--gold">
              <span className="glass-stat__label">Period Revenue</span>
              <span className="glass-stat__value glass-stat__value--gold">
                ${Number(monthEnd?.totalRevenue || 0).toFixed(2)}
              </span>
              <span className="glass-stat__meta">{monthEnd?.period?.label || 'Previous cycle'}</span>
            </div>
            <div className="glass-stat">
              <span className="glass-stat__label">Sales Count</span>
              <span className="glass-stat__value glass-stat__value--cyan">{monthEnd?.salesCount ?? 'â€”'}</span>
              <span className="glass-stat__meta">
                Avg ${Number(monthEnd?.averageSale || 0).toFixed(2)}
              </span>
            </div>
            <div className="glass-stat glass-stat--violet">
              <span className="glass-stat__label">Staff Commissions</span>
              <span className="glass-stat__value glass-stat__value--violet">
                ${Number(monthEnd?.staffCommissionTotal || 0).toFixed(2)}
              </span>
              <span className="glass-stat__meta">{monthEnd?.staffCommissions?.length ?? 0} staff with a rate</span>
            </div>
            <div className="glass-stat glass-stat--green">
              <span className="glass-stat__label">Reconciliation</span>
              <span className="glass-stat__value glass-stat__value--green" style={{ fontSize: '1.6rem' }}>
                {monthEnd?.reconciliationStatus || 'â€”'}
              </span>
              <span className="glass-stat__meta">
                Difference ${Number(monthEnd?.reconciliationDifference || 0).toFixed(2)}
              </span>
            </div>
          </div>

          <div className="glass-panel" style={{ marginBottom: 20 }}>
            <div className="glass-panel__head">
              <span>Month-End Report Â· runs automatically on the 3rd at 08:00</span>
            </div>
            <div className="glass-panel__body">
              <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.7 }}>
                The auto-email covers the trading cycle that closed on the 3rd (3rd of the previous month
                to the 3rd of this month) and attaches the same ledger these buttons download. Columns:
                Timestamp Â· Voucher Code Â· Package Tier Â· Amount Â· Payment Rail Â· Staff / Sold By Â· Status.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button
                  type="button"
                  className="btn-glass btn-glass--gold"
                  onClick={() => downloadReport('/reports/month-end.xlsx', `Preyone_MonthEnd_${(monthEnd?.period?.label || 'report').replace(/\s+/g, '_')}.xlsx`)}
                >
                  Download Excel
                </button>
                <button
                  type="button"
                  className="btn-glass"
                  onClick={() => downloadReport('/reports/month-end.csv', `Preyone_MonthEnd_${(monthEnd?.period?.label || 'report').replace(/\s+/g, '_')}.csv`)}
                >
                  Download CSV
                </button>
                <button
                  type="button"
                  className="btn-glass"
                  onClick={() => {
                    const token = api.getToken();
                    if (!token) return;
                    fetch('/api/admin/reports/preview', { headers: { Authorization: `Bearer ${token}` } })
                      .then((res) => res.text())
                      .then((html) => {
                        const w = window.open('', '_blank', 'noopener,noreferrer,width=900,height=800');
                        if (w) { w.document.write(html); w.document.close(); }
                      })
                      .catch(() => showToast({ title: 'Preview Failed', message: 'Could not render the report email.', type: 'error' }));
                  }}
                >
                  Preview Email
                </button>
                <button
                  type="button"
                  className="btn-glass"
                  onClick={() => downloadReport('/reports/staff.xlsx', `Preyone_StaffReport_${(monthEnd?.period?.label || 'report').replace(/\s+/g, '_')}.xlsx`)}
                >
                  Staff Commission Excel
                </button>
                {canSendReport && (
                  <button
                    type="button"
                    className="btn-glass btn-glass--gold"
                    onClick={sendMonthEndNow}
                    disabled={sendingReport}
                  >
                    {sendingReport ? 'Sendingâ€¦' : 'Send Now'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {monthEnd?.rows?.length > 0 && (
            <div className="card">
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
                Ledger Preview ({monthEnd.rows.length} row{monthEnd.rows.length === 1 ? '' : 's'})
              </div>
              <div className="card-table">
                <table className="data-table">
                  <thead>
                    <tr>{(monthEnd.columns || []).map((c: string) => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {monthEnd.rows.slice(0, 100).map((row: (string | number)[], i: number) => (
                      <tr key={i}>
                        {row.map((cell, j) => <td key={j}>{String(cell)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
