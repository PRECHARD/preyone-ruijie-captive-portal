import { useCallback, useEffect, useState } from 'react';
import { api, type PosDocument } from '../api';
import ReceiptModal from './ReceiptModal';

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

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

export default function HistoryView({ notify, onApiError }: HistoryViewProps) {
  const [docs, setDocs] = useState<PosDocument[]>([]);
  const [open, setOpen] = useState<PosDocument | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setDocs(await api.documents('sale', 100));
    } catch (e) {
      if (!onApiError(e)) notify('Could not load history', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify, onApiError]);

  useEffect(() => {
    load();
  }, [load]);

  const openDoc = async (d: PosDocument) => {
    try {
      const full = await api.document(d.id);
      setOpen(full);
    } catch (e) {
      if (!onApiError(e)) notify('Could not open receipt', 'error');
    }
  };

  const fmtDate = (t: string): string =>
    !t || Number.isNaN(Date.parse(t))
      ? t || ''
      : new Date(t).toLocaleString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });

  return (
    <div className="history-pane">
      <div className="history-head">
        <span className="history-title">SALES &amp; RECEIPTS</span>
        <button className="ghost-btn" onClick={load}>Refresh</button>
      </div>

      {loading ? (
        <div className="empty-note">Loading history…</div>
      ) : docs.length === 0 ? (
        <div className="empty-note">No sales yet.</div>
      ) : (
        <div className="history-list">
          {docs.map((d) => (
            <button key={d.id} className="history-row" onClick={() => openDoc(d)}>
              <div className="history-row-main">
                <span className="hr-no">{d.doc_number}</span>
                <span className="hr-amt">{money(d.total)}</span>
                <span className="hr-arrow">›</span>
              </div>
              <div className="hr-sub">
                {d.status} • {fmtDate(d.created_at)}{' '}
                {d.cashier_name ? `• Served by: ${d.cashier_name}` : ''}
              </div>
            </button>
          ))}
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
            balanceDue: Number(open.balanceDue),
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
    </div>
  );
}