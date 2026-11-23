import { useCallback, useState, useEffect } from 'react';
import { api, type CheckoutResult, type CompanyProfile } from '../api';
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
  company?: CompanyProfile | null;
  onDone: () => void;
  date?: string;
}) {
  const [logoUri, setLogoUri] = useState<string>('');
  const [logoSize, setLogoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [pdfError, setPdfError] = useState('');
  const [liveCompany, setLiveCompany] = useState<CompanyProfile | null>(company ?? null);

  // Re-read the company on every receipt open. Settings & Branding can change
  // while a till is logged in; the receipt must never print yesterday's logo
  // or footer.
  useEffect(() => {
    let alive = true;
    api
      .company()
      .then((fresh) => {
        if (alive) setLiveCompany(fresh);
      })
      .catch(() => {
        if (alive && company) setLiveCompany(company);
      });
    return () => {
      alive = false;
    };
  }, [company]);

  const branded = liveCompany?.branding;
  const brandName = branded?.name || liveCompany?.name || 'Receipt';
  const brandTagline = branded?.tagline || liveCompany?.tagline || '';
  const brandPhone = branded?.phone || liveCompany?.support_phone || '';
  const brandEmail = branded?.email || liveCompany?.email || '';
  const brandWebsite = branded?.website || liveCompany?.website || '';
  const brandAddress = branded?.address || liveCompany?.address || '';
  const brandTaxLine = [
    branded?.taxId ? `VAT: ${branded.taxId}` : '',
    branded?.registrationNumber ? `Reg: ${branded.registrationNumber}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const brandFooter = branded?.footerText || liveCompany?.receipt_footer || '';
  const logoUrl =
    branded?.logoUrl ||
    liveCompany?.logo_url ||
    (liveCompany?.logo_path ? `/images/${liveCompany.logo_path}` : '/brand/Preyone.svg');

  useEffect(() => {
    let alive = true;
    if (!logoUrl) {
      setLogoUri('');
      setLogoSize({ w: 0, h: 0 });
      return;
    }
    fetch(logoUrl, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`Logo ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const nw = img.naturalWidth || img.width || 0;
            const nh = img.naturalHeight || img.height || 0;
            if (!alive || !nw || !nh) return;
            const scale = Math.min(1, 900 / Math.max(nw, nh));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(nw * scale));
            canvas.height = Math.max(1, Math.round(nh * scale));
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            setLogoUri(canvas.toDataURL('image/png'));
            setLogoSize({ w: nw, h: nh });
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          if (alive) {
            setLogoUri('');
            setLogoSize({ w: 0, h: 0 });
          }
        };
        img.src = objectUrl;
      })
      .catch(() => {
        if (alive) {
          setLogoUri('');
          setLogoSize({ w: 0, h: 0 });
        }
      });
    return () => {
      alive = false;
    };
  }, [logoUrl]);

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
      verifyCode: result.verify_code || undefined,
      date: when,
      customerName: result.customer_name,
      cashierName,
      items: result.items.map((i) => ({
        description: String(i.description),
        details: Array.isArray(i.details) ? i.details : [],
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
      company: {
        name: brandName,
        phone: brandPhone,
        website: brandWebsite,
        email: brandEmail,
        address: brandAddress,
        taxId: branded?.taxId || '',
        registrationNumber: branded?.registrationNumber || '',
        tagline: brandTagline,
        footerText: brandFooter,
      },
      logoDataUri: logoUri,
      logoNatural: logoSize.w > 0 ? logoSize : undefined,
    });
  }, [
    result,
    when,
    cashierName,
    cashTendered,
    change,
    brandName,
    brandPhone,
    brandWebsite,
    brandEmail,
    brandAddress,
    brandTaxLine,
    brandTagline,
    brandFooter,
    branded,
    logoUri,
    logoSize,
  ]);

  const downloadPdf = () => {
    setPdfError('');
    try {
      var doc = getPdfDoc();
      downloadReceiptPdf(doc, `${result.doc_number}.pdf`);
    } catch (e) {
      console.error('PDF download failed:', e);
      setPdfError('Could not generate the PDF. Please try again.');
    }
  };

  const printReceipt = () => {
    // Native Android APK bridges thermal printing through window.AndroidPOS.
    const bridge = (window as { AndroidPOS?: { printReceipt?: (json: string) => void } }).AndroidPOS;
    if (bridge?.printReceipt) {
      try {
        bridge.printReceipt(JSON.stringify(result));
      } catch (e) {
        console.error('Native print failed:', e);
        window.print();
      }
      return;
    }
    window.print();
  };

  const shareWhatsApp = async () => {
    setPdfError('');
    try {
      var doc = getPdfDoc();
      var blob = receiptPdfToBlob(doc);

      if (navigator.share) {
        try {
          var file = new File([blob], `${result.doc_number}.pdf`, { type: 'application/pdf' });
          if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({
              files: [file],
              text: `${brandName} — ${title} ${result.doc_number}`,
            });
            return;
          }
        } catch {
          // user cancelled, fall through
        }
      }

      downloadReceiptPdf(doc, `${result.doc_number}.pdf`);
      var msg = encodeURIComponent(
        `${brandName} — ${title} ${result.doc_number}\n` +
        `Total: ${money(result.total)}\n` +
        (result.balanceDue > 0 ? `Balance due: ${money(result.balanceDue)}` : 'PAID IN FULL') +
        `\n\nPDF receipt downloaded — please attach it.`
      );
      window.open(`https://wa.me/?text=${msg}`, '_blank');
    } catch (e) {
      console.error('WhatsApp share failed:', e);
      setPdfError('Could not generate the PDF. Please try again.');
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div id="receipt-print-area" className="receipt-paper">
          {/* B&W Logo */}
          <div className="receipt-center">
            <img
              src={logoUrl}
              alt={`${brandName} logo`}
              className="receipt-logo"
              style={{ filter: 'grayscale(100%) brightness(0)', height: 28, margin: '0 auto 4px' }}
            />
            <div className="receipt-brand">{brandName.toUpperCase()}</div>
            {brandTagline && <div className="receipt-muted" style={{ fontSize: '8px' }}>{brandTagline}</div>}
            <div className="receipt-muted" style={{ fontSize: '9px' }}>{brandEmail}</div>
            <div className="receipt-muted">{[brandPhone, brandWebsite].filter(Boolean).join(' · ')}</div>
            {brandAddress && <div className="receipt-muted">{brandAddress}</div>}
            {brandTaxLine && <div className="receipt-muted">{brandTaxLine}</div>}
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
                    {(i.details || []).length > 0 && (
                      <ul className="r-details">
                        {(i.details || []).map((d, j) => (
                          <li key={j}>{d}</li>
                        ))}
                      </ul>
                    )}
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
            <div style={{ fontWeight: 700, fontSize: '11px', marginBottom: 4 }}>
              {brandFooter || 'THANKS FOR YOUR PURCHASE'}
            </div>
            <div className="receipt-muted" style={{ fontSize: '8.5px' }}>
              {brandTagline || 'Terms & Conditions Apply'}
            </div>
            <div className="receipt-muted" style={{ fontSize: '8px', marginTop: 6 }}>
              {brandName} · {brandEmail}
            </div>
          </div>
          {result.verify_code && (
            <div className="r-verify">
              <span className="r-verify-label">Document ID</span>
              <span className="r-verify-code">{result.verify_code}</span>
              <span className="r-verify-url">preyone.com/verify</span>
            </div>
          )}
        </div>

        {pdfError && <div className="err-msg" style={{ marginTop: 8 }}>{pdfError}</div>}

        <div className="receipt-actions">
          <button onClick={printReceipt}>Print</button>
          <button onClick={downloadPdf}>Download PDF</button>
          <button onClick={shareWhatsApp}>WhatsApp PDF</button>
        </div>
        <button className="primary-btn" onClick={onDone}>New sale</button>
      </div>
    </div>
  );
}
