import { useCallback, useEffect, useState } from 'react';
import { api, type PosDocument } from '../api';
import ReceiptModal from './ReceiptModal';
import PaymentModal from './PaymentModal';

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

type Filter = '' | 'sale' | 'invoice' | 'quotation';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: '', label: 'All' },
  { key: 'sale', label: 'Sales' },
  { key: 'invoice', label: 'Invoices' },
  { key: 'quotation', label: 'Quotations' },
];

export interface HistoryViewProps {
  notify: (msg: string, kind?: 'ok' | 'error') => void;
  onApiError: (e: unknown) => boolean;
}

const COMPANY = {
  name: 'Preyone enterprise',
  phone: '+263 77 132 7202',
  website: 'www.preyone.com',
  email: 'info@preyone.com',
};

const balanceOf = (d: PosDocument): number =>
  Math.max((Number(d.total) || 0) - (Number(d.amount_paid) || 0), 0);

export default function HistoryView({ notify, onApiError }: HistoryViewProps) {
  const [docs, setDocs] = useState<PosDocument[]>([]);
  const [filter, setFilter] = useState<Filter>('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<PosDocument | null>(null);
  const [payFor, setPayFor] = useState<PosDocument | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (f: Filter = filter) => {
      try {
        setLoading(true);
        setDocs(await api.documents(f || undefined, 100));
      } catch (e) {
        if (!onApiError(e)) notify('Could not load history', 'error');
      } finally {
        setLoading(false);
      }
    },
    [filter, notify, onApiError]
  );

  useEffect(() => {
    load(filter);
  }, [load, filter]);

  const openDoc = async (d: PosDocument) => {
    try {
      const full = await api.document(d.id);
      setOpen({
        ...full,
        balanceDue: Math.max(Number(full.total) - Number(full.amount_paid), 0),
      });
    } catch (e) {
      if (!onApiError(e)) notify('Could not open receipt', 'error');
    }
  };

  const afterPayment = async (updated: PosDocument) => {
    setPayFor(null);
    notify(`Payment recorded on ${updated.doc_number}`, 'ok');
    await load();
    if (open && open.id === updated.id) {
      try {
        const full = await api.document(updated.id);
        setOpen({
          ...full,
          balanceDue: Math.max(Number(full.total) - Number(full.amount_paid), 0),
        });
      } catch {
        setOpen(null);
      }
    }
  };

  const fmtDate = (t: string): string =>
    !t || Number.isNaN(Date.parse(t))
      ? t || ''
      : new Date(t).toLocaleString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });

  const q = search.trim().toLowerCase();
  const visible = q
    ? docs.filter(
        (d) =>
          d.doc_number.toLowerCase().includes(q) ||
          (d.customer_name || '').toLowerCase().includes(q) ||
          (d.cashier_name || '').toLowerCase().includes(q) ||
          d.doc_type.toLowerCase().includes(q) ||
          d.status.toLowerCase().includes(q)
      )
    : docs;

  const convert = async (d: PosDocument) => {
    setConvertingId(d.id);
    try {
      const updated = await api.convertToInvoice(d.id);
      notify(`${d.doc_number} converted to ${updated.doc_number}`, 'ok');
      await load();
    } catch (e) {
      if (!onApiError(e)) notify(e instanceof Error ? e.message : 'Conversion failed', 'error');
    } finally {
      setConvertingId(null);
    }
  };

  const emptyText =
    q ? 'No documents match your search.'
    : filter === 'invoice' ? 'No invoices yet.'
    : filter === 'quotation' ? 'No quotations yet.'
    : filter === 'sale' ? 'No sales yet.'
    : 'No documents yet.';

  return (
    <div className="history-pane">
      <div className="history-head">
        <span className="history-title">SALES &amp; DOCUMENTS</span>
        <div className="history-filters">
          <input
            className="hist-search"
            placeholder="Search number or customer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`hist-tab${filter === f.key ? ' on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
          <button className="ghost-btn" onClick={() => load()}>Refresh</button>
        </div>
      </div>

      {loading ? (
        <div className="empty-note">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="empty-note">{emptyText}</div>
      ) : (
        <div className="history-list">
          {visible.map((d) => {
            const due = balanceOf(d);
            const payable = due > 0 && d.status !== 'void';
            const convertible = (d.doc_type === 'quotation' || d.doc_type === 'sale') && d.status !== 'void';
            return (
              <div className="history-item" key={d.id}>
                <button className="history-row" onClick={() => openDoc(d)}>
                  <div className="history-row-main">
                    <span className="hr-no">{d.doc_number}</span>
                    {d.doc_type !== 'sale' && (
                      <span className={`hr-tag ${d.doc_type}`}>{d.doc_type}</span>
                    )}
                    <span className={`hr-status ${d.status}`}>{d.status}</span>
                    <span className="hr-amt">{money(d.total)}</span>
                    <span className="hr-arrow">›</span>
                  </div>
                  <div className="hr-sub">
                    {payable ? `due ${money(due)} • ` : ''}
                    {fmtDate(d.created_at)}
                    {d.cashier_name ? ` • Served by: ${d.cashier_name}` : ''}
                    {d.customer_name ? ` • ${d.customer_name}` : ''}
                  </div>
                </button>
                <div className="hr-actions">
                  {convertible && (
                    <button
                      className="hr-convert"
                      disabled={convertingId === d.id}
                      onClick={() => convert(d)}
                      title="Convert this quotation or sale into an invoice"
                    >
                      {convertingId === d.id ? '…' : '→ Invoice'}
                    </button>
                  )}
                  {payable && (
                    <button className="hr-pay" onClick={() => setPayFor(d)}>
                      Take payment
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <ReceiptModal
          result={{
            id: open.id,
            doc_number: open.doc_number,
            doc_type: open.doc_type,
            status: open.status,
            subtotal: Number(open.subtotal),
            discount_pct: Number(open.discount_pct),
            tax_pct: Number(open.tax_pct),
            total: Number(open.total),
            amount_paid: Number(open.amount_paid),
            balanceDue: balanceOf(open),
            items: (open.items || []).map((i) => ({
              description: String(i.description),
              price: Number(i.price),
              qty: Number(i.qty),
              lineTotal: Number(i.lineTotal ?? i.line_total ?? i.price * i.qty),
            })),
            payments: (open.payments || []).map((p) => ({
              amount: Number(p.amount),
              method: String(p.method),
              reference: p.reference,
            })),
            customer_name: open.customer_name || undefined,
          }}
          cashierName={open.cashier_name || '—'}
          company={COMPANY}
          date={open.created_at}
          onDone={() => setOpen(null)}
        />
      )}

      {payFor && (
        <PaymentModal
          doc={payFor}
          onCancel={() => setPayFor(null)}
          onSaved={afterPayment}
        />
      )}
    </div>
  );
}
