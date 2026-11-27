import { useCallback, useState, useEffect, useRef } from 'react';
import { api, type CheckoutResult, type CompanyProfile } from '../api';
import { generateReceiptPdf, downloadReceiptPdf, receiptPdfToBlob } from '../utils/receiptPdf';
import { buildReceiptPdfFromElement } from '../utils/receiptDomPdf';
import { code128Bars, verificationBarcodePayload } from '../utils/code128';
import ReceiptPoweredBy from './ReceiptPoweredBy';

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

/** Vector Code 128 strip: no image rasterisation, so thermal prints stay sharp. */
function ReceiptBarcode({ code }: { code: string }) {
  const payload = verificationBarcodePayload(code);
  const bars = payload ? code128Bars(payload) : '';
  if (!bars) return null;

  // Quiet zones are counted in modules (>=10x the narrowest bar).
  const quiet = 12;
  const units = bars.length + quiet * 2;
  let path = '';
  for (let i = 0; i < bars.length; i++) {
    if (bars[i] === '1') path += `M${i + quiet} 0h1v40h-1z`;
  }

  return (
    <div className="r-verify-strip" aria-label={`Verification barcode ${code}`}>
      <svg
        className="r-barcode"
        viewBox={`0 0 ${units} 40`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
        role="img"
      >
        <path d={path} fill="#0f172a" />
      </svg>
      <div className="r-barcode-label">SCAN TO VERIFY • preyone.com/verify</div>
    </div>
  );
}

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
  const receiptRef = useRef<HTMLDivElement>(null);

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

  // New rows carry cash_tendered/change_amount from checkout. Older rows
  // only have `amount`, so fall back to treating that as the cash handed over.
  const cashParts = (result.payments || []).filter((p) => p.method === 'cash');
  const cashTendered = Math.round(
    cashParts.reduce((sum, p) => sum + Number(p.cashTendered ?? p.amount), 0) * 100
  ) / 100;
  const change = Math.round(
    cashParts.reduce((sum, p) => {
      const tendered = Number(p.cashTendered ?? p.amount);
      return sum + Number(p.change ?? Math.max(0, tendered - Number(p.amount)));
    }, 0) * 100
  ) / 100;

  const getPdfDoc = useCallback(async () => {
    // Print targets this exact DOM node. Capture it for PDF too so the saved
    // file matches the modal card rather than a parallel vector layout.
    const element = receiptRef.current;
    if (element) {
      try {
        return await buildReceiptPdfFromElement(element);
      } catch (e) {
        console.error('Exact receipt capture failed; using vector fallback:', e);
        setPdfError('Showing the printable vector receipt; the preview capture was unavailable.');
      }
    }
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

  const downloadPdf = async () => {
    setPdfError('');
    try {
      const doc = await getPdfDoc();
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
      const doc = await getPdfDoc();
      const blob = receiptPdfToBlob(doc);

      if (navigator.share) {
        try {
          const file = new File([blob], `${result.doc_number}.pdf`, { type: 'application/pdf' });
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
      const msg = encodeURIComponent(
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
        <div id="receipt-print-area" ref={receiptRef} className="receipt-paper">
          {/* Compact emerald store header */}
          <div className="receipt-center receipt-header">
            <div className="receipt-top-rule" />
            <img
              src={logoUrl}
              alt={`${brandName} logo`}
              className="receipt-logo"
              style={{ filter: 'grayscale(100%) brightness(0)', height: 24, margin: '0 auto 3px' }}
            />
            <div className="receipt-brand">{brandName.toUpperCase()}</div>
            <div className="receipt-accent" />
            {brandTagline && <div className="receipt-subbrand receipt-tagline">{brandTagline}</div>}
            <div className="receipt-muted">{brandEmail}</div>
            <div className="receipt-muted">{[brandPhone, brandWebsite].filter(Boolean).join(' · ')}</div>
            {brandAddress && <div className="receipt-muted receipt-reserve">{brandAddress}</div>}
            {brandTaxLine && <div className="receipt-muted receipt-reserve">{brandTaxLine}</div>}
          </div>
          <hr className="r-rule" />

          {/* Document Info */}
          <table className="r-table r-meta">
            <tbody>
              <tr><td>{title} #</td><td className="r-num"><strong>{result.doc_number}</strong></td></tr>
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
                    <span className="r-item-name">{i.description}</span>
                    {(i.details || []).length > 0 && (
                      <ul className="r-details">
                        {(i.details || []).map((d, j) => (
                          <li key={j}>{d}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="r-num">
                    <span>{money(i.lineTotal)}</span>
                    <span className="r-item-qty">{i.qty} × {money(i.price)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <hr className="r-rule" />

          {/* Totals */}
          <table className="r-table r-totals">
            <tbody>
              <tr><td>Subtotal</td><td className="r-num">{money(result.subtotal)}</td></tr>
              {result.discount_pct > 0 && (
                <tr><td>Discount ({result.discount_pct}%)</td><td className="r-num">−{money((result.subtotal * result.discount_pct) / 100)}</td></tr>
              )}
              {result.tax_pct > 0 && (
                <tr><td>VAT ({result.tax_pct}%) incl.</td><td className="r-num">{money((Number(result.total) * Number(result.tax_pct)) / (100 + Number(result.tax_pct)))}</td></tr>
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
                <div className="r-paid-row">
                  <span className="r-paid-pill">PAID</span>
                </div>
                {cashTendered > 0 && (
                  <>
                    <br />
                    <span className="r-paid-cash">
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

          {/* Short thank-you directly above the full-width verification strip */}
          <div className="r-thanks">{brandFooter || 'THANKS FOR YOUR PURCHASE'}</div>
          <ReceiptPoweredBy website={brandWebsite} />
          {result.verify_code && <ReceiptBarcode code={result.verify_code} />}
        </div>

        {pdfError && <div className="err-msg" style={{ marginTop: 8 }}>{pdfError}</div>}

        <div className="receipt-actions">
          <button onClick={printReceipt}>Print</button>
          <button onClick={() => void downloadPdf()}>Download PDF</button>
          <button onClick={shareWhatsApp}>WhatsApp PDF</button>
        </div>
        <button className="primary-btn" onClick={onDone}>New sale</button>
      </div>
    </div>
  );
}
