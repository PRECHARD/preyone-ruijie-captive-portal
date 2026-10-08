import { useMemo, useState } from 'react';
import { jsPDF } from 'jspdf';
import {
  FiFileText, FiDownload, FiPrinter, FiEye, FiRefreshCw, FiCreditCard,
} from 'react-icons/fi';
import { fmtDate, fmtMoney, type SlInvoice, type SlCustomer } from './api';

type StatusFilter = 'ALL' | 'PENDING' | 'PAID' | 'FAILED';

const KIND_LABEL: Record<string, string> = {
  wallet_topup: 'Wallet Top-Up',
  data_topup: 'Data Top-Up',
  kit_purchase: 'Kit Purchase',
  service: 'Service',
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] || kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusClass(status: string): string {
  if (status === 'PAID') return 'sp-badge-pill--paid';
  if (status === 'FAILED') return 'sp-badge-pill--failed';
  return 'sp-badge-pill--pending';
}

/* ── PDF helpers (jsPDF) ─────────────────────────────────── */

const NAVY: [number, number, number] = [13, 15, 24];
const CYAN: [number, number, number] = [0, 189, 211];
const PURPLE: [number, number, number] = [168, 85, 247];
const SLATE: [number, number, number] = [100, 116, 139];

function pdfHeader(doc: jsPDF, subtitle: string, rightTop: string, rightBottom: string): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, w, 86, 'F');
  doc.setFillColor(...CYAN);
  doc.rect(0, 86, w, 3, 'F');
  doc.setFillColor(...PURPLE);
  doc.rect(w * 0.55, 86, w * 0.45, 3, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(21);
  doc.text('PREYONE ENTERPRISES', 40, 40);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0, 229, 255);
  doc.text('STARLINK CUSTOMER PORTAL  ·  starlink.preyone.com', 40, 56);
  doc.setTextColor(148, 163, 184);
  doc.text('USD billing · Pese payment gateway', 40, 70);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text(subtitle, w - 40, 40, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(148, 163, 184);
  doc.text(rightTop, w - 40, 56, { align: 'right' });
  doc.text(rightBottom, w - 40, 70, { align: 'right' });

  return 118;
}

function pdfFooter(doc: jsPDF, note: string): void {
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  doc.setDrawColor(226, 232, 240);
  doc.line(40, h - 46, w - 40, h - 46);
  doc.setFontSize(8);
  doc.setTextColor(...SLATE);
  doc.text(note, 40, h - 32);
  doc.text(`Generated ${new Date().toLocaleString('en-GB')}`, w - 40, h - 32, { align: 'right' });
}

function downloadInvoicePdf(inv: SlInvoice, customer: SlCustomer): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const w = doc.internal.pageSize.getWidth();

  let y = pdfHeader(doc, 'INVOICE', inv.invoice_number, fmtDate(inv.issued_date));

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('Billed to', 40, y + 6);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(customer.fullName, 40, y + 24);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...SLATE);
  doc.text(customer.email, 40, y + 38);
  doc.text(customer.phone, 40, y + 50);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text('Status', w - 190, y + 6);
  doc.text('Issued', w - 190, y + 30);
  doc.text('Due', w - 190, y + 54);
  doc.setFont('helvetica', 'normal');
  doc.text(inv.status, w - 140, y + 6);
  doc.text(fmtDate(inv.issued_date), w - 140, y + 30);
  doc.text(inv.due_date ? fmtDate(inv.due_date) : 'On receipt', w - 140, y + 54);

  y += 78;
  doc.setFillColor(241, 245, 249);
  doc.rect(40, y, w - 80, 24, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text('DESCRIPTION', 52, y + 16);
  doc.text('QTY', w - 210, y + 16);
  doc.text('AMOUNT', w - 52, y + 16, { align: 'right' });

  y += 24;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(`${inv.description} (${kindLabel(inv.kind)})`, 52, y + 18);
  doc.text('1', w - 210, y + 18);
  doc.text(fmtMoney(Number(inv.amount), inv.currency), w - 52, y + 18, { align: 'right' });
  doc.setDrawColor(226, 232, 240);
  doc.line(40, y + 30, w - 40, y + 30);

  y += 54;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  const tx = w - 200;
  doc.text('Subtotal', tx, y);
  doc.text(fmtMoney(Number(inv.amount), inv.currency), w - 52, y, { align: 'right' });
  doc.text('Tax (0%)', tx, y + 18);
  doc.text(fmtMoney(0), w - 52, y + 18, { align: 'right' });
  doc.setDrawColor(148, 163, 184);
  doc.line(tx, y + 28, w - 40, y + 28);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text('TOTAL', tx, y + 48);
  doc.setTextColor(0, 150, 173);
  doc.text(fmtMoney(Number(inv.amount), inv.currency), w - 52, y + 48, { align: 'right' });

  y += 76;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  if (inv.pese_reference || inv.meta?.pese_reference) {
    const ref = String(inv.pese_reference || (inv.meta as any).pese_reference);
    doc.text(`Pese reference: ${ref}`, 40, y);
    y += 14;
  }
  if (inv.paid_at) {
    doc.text(`Paid on ${fmtDate(inv.paid_at)}`, 40, y);
    y += 14;
  }
  doc.text('Settled through Pese (EcoCash · InnBucks · Omari) in USD.', 40, y);

  pdfFooter(doc, `Invoice ${inv.invoice_number} · Preyone Enterprises (Pvt) Ltd · Generated by Starlink Portal`);
  doc.save(`${inv.invoice_number}.pdf`);
}

function downloadStatementPdf(invoices: SlInvoice[], customer: SlCustomer): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const w = doc.internal.pageSize.getWidth();
  const now = new Date();

  let y = pdfHeader(
    doc,
    'ACCOUNT STATEMENT',
    customer.fullName,
    `${fmtDate(now.toISOString())} · ${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`
  );

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...SLATE);
  doc.text(`${customer.email} · ${customer.phone}`, 40, y);
  y += 24;

  const paid = invoices.filter((i) => i.status === 'PAID');
  const pending = invoices.filter((i) => i.status === 'PENDING');
  const failed = invoices.filter((i) => i.status === 'FAILED');
  const sum = (list: SlInvoice[]) => list.reduce((s, i) => s + Number(i.amount), 0);

  doc.setFillColor(241, 245, 249);
  doc.rect(40, y, w - 80, 30, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text('INVOICE', 50, y + 19);
  doc.text('DATE', 160, y + 19);
  doc.text('DESCRIPTION', 250, y + 19);
  doc.text('STATUS', w - 200, y + 19);
  doc.text('AMOUNT', w - 50, y + 19, { align: 'right' });

  y += 30;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  for (const inv of invoices.slice(0, 40)) {
    if (y > doc.internal.pageSize.getHeight() - 90) {
      pdfFooter(doc, 'Account statement · Preyone Enterprises (Pvt) Ltd');
      doc.addPage();
      y = 60;
    }
    doc.setTextColor(15, 23, 42);
    doc.text(inv.invoice_number, 50, y + 18);
    doc.text(fmtDate(inv.issued_date), 160, y + 18);
    doc.text(inv.description.slice(0, 38), 250, y + 18);
    doc.setTextColor(...SLATE);
    doc.text(inv.status, w - 200, y + 18);
    doc.setTextColor(15, 23, 42);
    doc.text(fmtMoney(Number(inv.amount), inv.currency), w - 50, y + 18, { align: 'right' });
    doc.setDrawColor(226, 232, 240);
    doc.line(40, y + 26, w - 40, y + 26);
    y += 26;
  }

  y += 14;
  const rows: Array<[string, string]> = [
    ['Paid total', fmtMoney(sum(paid))],
    ['Outstanding (pending)', fmtMoney(sum(pending))],
    ['Failed', fmtMoney(sum(failed))],
  ];
  const tx = w - 220;
  for (const [k, v] of rows) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text(k, tx, y);
    doc.text(v, w - 50, y, { align: 'right' });
    y += 18;
  }
  doc.setDrawColor(148, 163, 184);
  doc.line(tx, y - 8, w - 40, y - 8);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text('Lifetime billed', tx, y + 12);
  doc.setTextColor(0, 150, 173);
  doc.text(fmtMoney(sum(invoices)), w - 50, y + 12, { align: 'right' });

  pdfFooter(doc, `Account statement · ${customer.fullName} · Preyone Enterprises (Pvt) Ltd`);
  doc.save(`preyone-starlink-statement-${now.toISOString().slice(0, 10)}.pdf`);
}

/* ── Component ───────────────────────────────────────────── */

export default function InvoicesView({
  customer,
  invoices,
  loading = false,
  kinds,
  showStatement = true,
  onRefresh,
  onPay,
}: {
  customer: SlCustomer;
  invoices: SlInvoice[];
  loading?: boolean;
  kinds?: string[];
  showStatement?: boolean;
  onRefresh?: () => void;
  onPay?: () => void;
}) {
  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [selected, setSelected] = useState<SlInvoice | null>(null);

  const scoped = useMemo(
    () => (kinds ? invoices.filter((i) => kinds.includes(i.kind)) : invoices),
    [invoices, kinds]
  );

  const rows = useMemo(
    () => (filter === 'ALL' ? scoped : scoped.filter((i) => i.status === filter)),
    [scoped, filter]
  );

  const counts = useMemo(() => ({
    ALL: scoped.length,
    PENDING: scoped.filter((i) => i.status === 'PENDING').length,
    PAID: scoped.filter((i) => i.status === 'PAID').length,
    FAILED: scoped.filter((i) => i.status === 'FAILED').length,
  }), [scoped]);

  return (
    <>
      <div className="sp-panel-head">
        <div className="sp-filters">
          {(['ALL', 'PENDING', 'PAID', 'FAILED'] as StatusFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={'sp-chip' + (filter === f ? ' is-active' : '')}
              onClick={() => setFilter(f)}
            >
              {f === 'ALL' ? 'All' : f[0] + f.slice(1).toLowerCase()} ({counts[f]})
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          {onRefresh && (
            <button type="button" className="sp-icon-btn" onClick={onRefresh}>
              <FiRefreshCw /> Refresh
            </button>
          )}
          {onPay && (
            <button type="button" className="sp-icon-btn" onClick={onPay}>
              <FiCreditCard /> Pay an invoice
            </button>
          )}
          {showStatement && scoped.length > 0 && (
            <button type="button" className="sp-icon-btn" onClick={() => downloadStatementPdf(scoped, customer)}>
              <FiDownload /> Statement
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="sp-empty"><p>Loading invoices…</p></div>
      ) : rows.length === 0 ? (
        <div className="sp-empty">
          <FiFileText size={34} />
          <p>No invoices in this view yet.</p>
        </div>
      ) : (
        <div className="sp-table-wrap">
          <table className="sp-table">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Date</th>
                <th>Description</th>
                <th>Amount</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <tr key={inv.id}>
                  <td><b>{inv.invoice_number}</b></td>
                  <td className="is-muted">{fmtDate(inv.issued_date)}</td>
                  <td>{inv.description}<div className="is-muted">{kindLabel(inv.kind)}</div></td>
                  <td className="is-money">{fmtMoney(Number(inv.amount), inv.currency)}</td>
                  <td>
                    <span className={`sp-badge-pill ${statusClass(inv.status)}`}>{inv.status}</span>
                  </td>
                  <td>
                    <div className="sp-row-actions" style={{ justifyContent: 'flex-end' }}>
                      <button type="button" className="sp-icon-btn" onClick={() => setSelected(inv)}>
                        <FiEye /> View
                      </button>
                      <button type="button" className="sp-icon-btn" onClick={() => downloadInvoicePdf(inv, customer)}>
                        <FiDownload /> PDF
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label={`Invoice ${selected.invoice_number}`} onClick={() => setSelected(null)}>
          <div className="sp-modal sp-modal--wide" onClick={(e) => e.stopPropagation()}>
            <div className="sp-modal-head">
              <h3>{selected.invoice_number}</h3>
              <button type="button" className="sp-modal-close" onClick={() => setSelected(null)} aria-label="Close invoice">✕</button>
            </div>
            <div className="sp-modal-body">
              <div className="sp-invoice-doc">
                <div className="sp-inv-letterhead">
                  <div>
                    <h4>Preyone Enterprises</h4>
                    <p>Starlink Customer Portal · starlink.preyone.com</p>
                    <p>USD billing · Pese payment gateway</p>
                  </div>
                  <div className="sp-inv-meta">
                    <div>Invoice <b>{selected.invoice_number}</b></div>
                    <div>Issued {fmtDate(selected.issued_date)}</div>
                    <div>Due {selected.due_date ? fmtDate(selected.due_date) : 'on receipt'}</div>
                  </div>
                </div>

                <table className="sp-inv-lines">
                  <thead>
                    <tr><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        {selected.description}
                        <div style={{ fontSize: 12, color: 'var(--sp-dim)', marginTop: 3 }}>
                          {kindLabel(selected.kind)}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>
                        {fmtMoney(Number(selected.amount), selected.currency)}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div className="sp-inv-totals">
                  <div><span>Subtotal</span><span>{fmtMoney(Number(selected.amount), selected.currency)}</span></div>
                  <div><span>Tax (0%)</span><span>{fmtMoney(0)}</span></div>
                  <div className="is-grand">
                    <span>Total</span>
                    <span>{fmtMoney(Number(selected.amount), selected.currency)}</span>
                  </div>
                  <div>
                    <span>Status</span>
                    <span className={selected.status === 'PAID' ? 'is-paid' : ''}>{selected.status}</span>
                  </div>
                </div>

                {(selected.pese_reference || (selected.meta as any)?.pese_reference) && (
                  <div className="sp-pese-ref">
                    <FiCreditCard />
                    Pese ref: {String(selected.pese_reference || (selected.meta as any).pese_reference)}
                  </div>
                )}
              </div>
            </div>
            <div className="sp-modal-foot">
              <button type="button" className="sp-btn sp-btn--ghost" onClick={() => window.print()}>
                <FiPrinter /> Print
              </button>
              <button type="button" className="sp-btn sp-btn--primary" style={{ width: 'auto' }} onClick={() => downloadInvoicePdf(selected, customer)}>
                <FiDownload /> Download PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
