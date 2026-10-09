import { useCallback, useEffect, useState } from 'react';
import { posApi, money } from '../api/pos';
import { showToast } from '../utils/toast';
import Table from '../components/Table';
import Badge from '../components/Badge';
import Modal from '../components/Modal';

const statusVariant: Record<string, string> = {
  paid: 'active', partial: 'pending', unpaid: 'warning', sent: 'info', draft: 'default', void: 'inactive',
};

export default function PosCustomers() {
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [statement, setStatement] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setCustomers(await posApi.get('/customers')); }
    catch (e: any) { showToast({ title: 'Load failed', message: e.message, type: 'error' }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openStatement = async (c: any) => {
    try { setStatement(await posApi.get(`/customers/${c.id}/statement`)); }
    catch (e: any) { showToast({ title: 'Statement failed', message: e.message, type: 'error' }); }
  };

  const sendReminder = () => {
    if (!statement) return;
    const openDocs = statement.documents.filter((d: any) => d.status !== 'void' && Number(d.balance) > 0);
    const lines = openDocs.map((d: any) => `${d.doc_number} — ${money(d.balance)} due`).join('\n');
    const text = encodeURIComponent(
      `Dear ${statement.customer.name},\n\nThis is a friendly reminder from Preyone enterprise.\n` +
      (lines ? `Outstanding balance:\n${lines}\nTotal due: ${money(statement.totalBalance)}` : `Your account is settled — thank you!`) +
      `\n\nKind regards,\nPreyone enterprise\n+263 77 132 7202`
    );
    window.open(`https://wa.me/${(statement.customer.phone || '').replace(/[^0-9]/g, '')}?text=${text}`, '_blank');
  };

  const filtered = customers.filter(c =>
    !q.trim() || c.name.toLowerCase().includes(q.toLowerCase()) || (c.phone || '').includes(q.trim())
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">POS Customers</h1>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Client book with credit balances and statements</p>
        </div>
      </div>

      <input placeholder="Search name or phone…" value={q} onChange={e => setQ(e.target.value)}
        style={{ padding: '8px 10px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 16 }} />

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : (
        <Table
          data={filtered}
          emptyMessage="No customers yet — they're captured automatically on till invoices"
          onRowClick={openStatement}
          columns={[
            { key: 'name', label: 'CUSTOMER' },
            { key: 'phone', label: 'PHONE' },
            { key: 'email', label: 'EMAIL' },
            { key: '_hint', label: '', render: () => <span style={{ color: 'var(--cyan)', fontSize: '0.72rem' }}>view statement →</span> },
          ]}
        />
      )}

      <Modal open={!!statement} onClose={() => setStatement(null)} title={`Statement · ${statement?.customer?.name || ''}`} wide>
        {statement && (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
              <div style={{ background: 'rgba(255,145,0,0.12)', borderRadius: 10, padding: '12px 20px' }}>
                <div style={{ fontSize: '0.65rem', color: 'var(--orange)', letterSpacing: 1 }}>TOTAL BALANCE DUE</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 700, fontFamily: 'var(--font-display)' }}>{money(statement.totalBalance)}</div>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
                {statement.customer.phone || 'no phone'}{statement.customer.email ? ` · ${statement.customer.email}` : ''}
              </div>
              <button onClick={sendReminder}
                style={{ marginLeft: 'auto', background: '#25D366', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontWeight: 600, cursor: 'pointer' }}>
                WhatsApp reminder
              </button>
            </div>

            <h4 style={{ margin: '8px 0' }}>Documents</h4>
            <Table
              data={statement.documents}
              emptyMessage="No documents for this customer"
              columns={[
                { key: 'doc_number', label: 'DOC #' },
                { key: 'doc_type', label: 'TYPE', render: r => <Badge variant="info">{r.doc_type}</Badge> },
                { key: 'created_at', label: 'DATE', render: r => new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) },
                { key: 'total', label: 'TOTAL', render: r => money(r.total) },
                { key: 'amount_paid', label: 'PAID', render: r => money(r.amount_paid) },
                { key: 'balance', label: 'BALANCE', render: r => <strong style={{ color: Number(r.balance) > 0 && r.status !== 'void' ? 'var(--orange)' : undefined }}>{money(r.balance)}</strong> },
                { key: 'status', label: 'STATUS', render: r => <Badge variant={statusVariant[r.status] || 'default'}>{r.status}</Badge> },
              ]}
            />

            <h4 style={{ margin: '16px 0 8px' }}>Payment history</h4>
            {statement.payments.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No payments recorded.</p>
            ) : (
              <Table
                data={statement.payments}
                columns={[
                  { key: 'paid_at', label: 'DATE', render: r => new Date(r.paid_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) },
                  { key: 'doc_number', label: 'AGAINST' },
                  { key: 'method', label: 'METHOD' },
                  { key: 'reference', label: 'REFERENCE', render: r => r.reference || '—' },
                  { key: 'amount', label: 'AMOUNT', render: r => <strong>{money(r.amount)}</strong> },
                ]}
              />
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
