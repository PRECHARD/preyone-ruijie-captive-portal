import { useCallback, useState, useEffect } from 'react';
import type { CheckoutResult } from '../api';
import { generateReceiptPdf, downloadReceiptPdf, receiptPdfToBlob } from '../utils/receiptPdf';

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

export default function ReceiptModal({
  result,
  cashierName,
  company,
  onDone,
  date,
}: {
  result: CheckoutResult;
  cashierName: string;
  company: { name: string; phone: string; website: string; email: string };
  onDone: () => void;
  date?: string;
}) {
  const [logoUri, setLogoUri] = useState<string>('');
  const [logoSize, setLogoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    fetch('/preyone-logo-color.png')
      .then((r) => r.blob())
      .then((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          setLogoUri(reader.result as string);
          const img = new Image();
          img.onload = () => setLogoSize({ w: img.naturalWidth, h: img.naturalHeight });
          img.src = reader.result as string;
        };
        reader.readAsDataURL(blob);
      })
      .catch(() => {});
  }, []);

  const nowFmt = () =>
    new Date().toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  const when = date && !Number.isNaN(Date.parse(date))
    ? new Date(date).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : nowFmt();

  const title =
    result.doc_type === 'invoice'
      ? 'INVOICE'
      : result.doc_type === 'quotation'
        ? 'QUOTATION'
        : 'RECEIPT';

  const cashPayment = result.payments?.find((p) => p.method === 'cash');
  const cashTendered = cashPayment ? Number(cashPayment.amount) : 0;
  const change = Math.max(0, cashTendered - Number(result.total));

  const getPdfDoc = useCallback(() => {
    return generateReceiptPdf({
      docNumber: result.doc_number,
      docType: result.doc_type,
      date: when,
      customerName: result.customer_name,
      cashierName,
      items: result.items.map((i) => ({
        description: String(i.description),
        qty: Number(i.qty),
        price: Number(i.price),
        lineTotal: Number(i.lineTotal),
      })),
      subtotal: Number(result.subtotal),
      discountPct: Number(result.discount_pct),
      taxPct: Number(result.tax_pct),
      total: Number(result.total),
      cashTendered,
      change,
      balanceDue: Number(result.balanceDue),
      amountPaid: Number(result.amount_paid),
      payments: (result.payments || []).map((p) => ({ amount: Number(p.amount), method: String(p.method) })),
      company,
      logoDataUri: logoUri,
      logoNatural: logoSize.w > 0 ? logoSize : undefined,
    });
  }, [result, when, cashierName, cashTendered, change, company, logoUri, logoSize]);

  const downloadPdf = () => {
    try {
      var doc = getPdfDoc();
      downloadReceiptPdf(doc, `${result.doc_number}.pdf`);
    } catch (e) {
      console.error('PDF download failed:', e);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const shareWhatsApp = async () => {
    try {
      var doc = getPdfDoc();
      var blob = receiptPdfToBlob(doc);

      if (navigator.share) {
        try {
          var file = new File([blob], `${result.doc_number}.pdf`, { type: 'application/pdf' });
          if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({
              files: [file],
              text: `${company.name} — ${title} ${result.doc_number}`,
            });
            return;
          }
        } catch {
          // user cancelled, fall through
        }
      }

      downloadReceiptPdf(doc, `${result.doc_number}.pdf`);
      var msg = encodeURIComponent(
        `${company.name} — ${title} ${result.doc_number}\n` +
        `Total: ${money(result.total)}\n` +
        (result.balanceDue > 0 ? `Balance due: ${money(result.balanceDue)}` : 'PAID IN FULL') +
        `\n\nPDF receipt downloaded — please attach it.`
      );
      window.open(`https://wa.me/?text=${msg}`, '_blank');
    } catch (e) {
      console.error('WhatsApp share failed:', e);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div id="receipt-print-area" className="receipt-paper">
          {/* B&W Logo */}
          <div className="receipt-center">
            <img
              src="/Preyone.svg"
              alt="Preyone"
              className="receipt-logo"
              style={{ filter: 'grayscale(100%) brightness(0)', height: 28, margin: '0 auto 4px' }}
            />
            <div className="receipt-brand">{company.name.toUpperCase()}</div>
            <div className="receipt-muted" style={{ fontSize: '9px' }}>{company.email}</div>
            <div className="receipt-muted">{company.phone} · {company.website}</div>
          </div>
          <hr className="r-rule" />

          {/* Document Info */}
          <table className="r-table">
            <tbody>
              <tr><td>{title}</td><td className="r-num"><strong>{result.doc_number}</strong></td></tr>
              <tr><td>Date</td><td className="r-num">{when}</td></tr>
              {result.customer_name && (
                <tr><td>Customer</td><td className="r-num">{result.customer_name}</td></tr>
              )}
              <tr><td>Served by</td><td className="r-num">{cashierName}</td></tr>
            </tbody>
          </table>
          <hr className="r-rule" />

          {/* Items */}
          <table className="r-table">
            <tbody>
              {result.items.map((i, idx) => (
                <tr key={idx}>
                  <td>
                    {i.description}
                    <br />
                    <span className="receipt-muted">{i.qty} × {money(i.price)}</span>
                  </td>
                  <td className="r-num">{money(i.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <hr className="r-rule" />

          {/* Totals */}
          <table className="r-table">
            <tbody>
              <tr><td>Subtotal</td><td className="r-num">{money(result.subtotal)}</td></tr>
              {result.discount_pct > 0 && (
                <tr><td>Discount ({result.discount_pct}%)</td><td className="r-num">−{money((result.subtotal * result.discount_pct) / 100)}</td></tr>
              )}
              {result.tax_pct > 0 && (
                <tr><td>VAT ({result.tax_pct}%)</td><td className="r-num">{money((Number(result.total) * Number(result.tax_pct)) / (100 + Number(result.tax_pct)))}</td></tr>
              )}
              <tr><td className="r-grand">TOTAL</td><td className="r-num r-grand">{money(result.total)}</td></tr>
            </tbody>
          </table>
          <hr className="r-rule" />

          {/* Payment Summary */}
          <div className="receipt-center">
            {result.balanceDue > 0 ? (
              <>
                <strong>BALANCE DUE: {money(result.balanceDue)}</strong>
                <br />
                <span className="receipt-muted">Paid so far: {money(result.amount_paid)}</span>
              </>
            ) : (
              <>
                <strong style={{ fontSize: '13px' }}>* PAID IN FULL *</strong>
                {cashTendered > 0 && (
                  <>
                    <br />
                    <span className="receipt-muted" style={{ fontSize: '10px' }}>
                      Cash Tendered: {money(cashTendered)}
                    </span>
                    {change > 0 && (
                      <>
                        <br />
                        <span style={{ fontWeight: 700, fontSize: '12px' }}>
                          Change: {money(change)}
                        </span>
                      </>
                    )}
                  </>
                )}
                {result.payments && result.payments.length > 1 && (
                  <>
                    <br />
                    <span className="receipt-muted" style={{ fontSize: '9px' }}>
                      {result.payments.map((p) => `${p.method}: ${money(p.amount)}`).join(' + ')}
                    </span>
                  </>
                )}
              </>
            )}
          </div>
          <hr className="r-rule" />

          {/* Footer */}
          <div className="receipt-center">
            <div style={{ fontWeight: 700, fontSize: '11px', marginBottom: 4 }}>THANKS FOR YOUR PURCHASE</div>
            <div className="receipt-muted" style={{ fontSize: '8.5px' }}>Terms &amp; Conditions Apply</div>
            <div className="receipt-muted" style={{ fontSize: '8px', marginTop: 6 }}>
              {company.name} · {company.email}
            </div>
          </div>
        </div>

        <div className="receipt-actions">
          <button onClick={() => window.print()}>Print</button>
          <button onClick={downloadPdf}>Download PDF</button>
          <button onClick={shareWhatsApp}>WhatsApp PDF</button>
        </div>
        <button className="primary-btn" onClick={onDone}>New sale</button>
      </div>
    </div>
  );
}
