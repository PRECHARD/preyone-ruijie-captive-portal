import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { posApi, money } from '../api/pos';
import { showToast } from '../utils/toast';
import Table from '../components/Table';
import Badge from '../components/Badge';

const statusVariant: Record<string, string> = {
  paid: 'active',
  partial: 'pending',
  unpaid: 'warning',
  sent: 'info',
  draft: 'default',
  void: 'inactive',
};

export default function PosSales() {
  const { user } = useAuth();
  const [docs, setDocs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const canVoid = user?.role === 'Manager' || user?.role === 'CEO';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (status) params.set('status', status);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (q.trim()) params.set('q', q.trim());
      params.set('limit', '200');
      setDocs(await posApi.get(`/documents?${params.toString()}`));
    } catch (e: any) {
      showToast({ title: 'Load failed', message: e.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [type, status, from, to, q]);

  useEffect(() => { load(); }, [load]);

  const doVoid = async (row: any) => {
    if (!window.confirm(`Void ${row.doc_number}? Stock will be returned and the sale cancelled.`)) return;
    try {
      await posApi.post(`/documents/${row.id}/void`, {});
      showToast({ title: 'Document voided', message: `${row.doc_number} cancelled, stock restored`, type: 'success' });
      load();
    } catch (e: any) {
      showToast({ title: 'Void failed', message: e.message, type: 'error' });
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">POS Sales History</h1>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Every till receipt, invoice and quotation</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <select value={type} onChange={e => setType(e.target.value)} style={{ padding: '8px 10px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <option value="">All types</option>
          <option value="sale">Receipts</option>
          <option value="invoice">Invoices</option>
          <option value="quotation">Quotations</option>
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)} style={{ padding: '8px 10px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <option value="">All statuses</option>
          <option value="paid">Paid</option>
          <option value="partial">Partially paid</option>
          <option value="unpaid">Unpaid</option>
          <option value="void">Void</option>
        </select>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ padding: '8px 10px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8 }} />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ padding: '8px 10px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8 }} />
        <input placeholder="Search doc # or customer…" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 180, padding: '8px 10px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8 }} />
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : (
        <Table
          data={docs}
          emptyMessage="No sales match these filters"
          columns={[
            { key: 'doc_number', label: 'DOC #' },
            { key: 'doc_type', label: 'TYPE', render: r => <Badge variant="info">{r.doc_type}</Badge> },
            { key: 'customer_name', label: 'CUSTOMER' },
            { key: 'cashier_name', label: 'CASHIER' },
            { key: 'created_at', label: 'DATE', render: r => new Date(r.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) },
            { key: 'total', label: 'TOTAL', render: r => <strong>{money(r.total)}</strong> },
            { key: 'amount_paid', label: 'PAID', render: r => money(r.amount_paid) },
            { key: 'status', label: 'STATUS', render: r => <Badge variant={statusVariant[r.status] || 'default'}>{r.status}</Badge> },
            ...(canVoid ? [{
              key: '_void', label: '',
              render: (r: any) => r.status !== 'void' ? (
                <button onClick={() => doVoid(r)} style={{ background: 'rgba(255,23,68,0.12)', color: 'var(--red)', border: 'none', padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: '0.7rem', fontWeight: 600 }}>VOID</button>
              ) : null,
            }] : []),
          ]}
        />
      )}
    </div>
  );
}
