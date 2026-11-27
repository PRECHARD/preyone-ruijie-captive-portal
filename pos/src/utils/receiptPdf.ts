import jsPDF from 'jspdf';
import { code128Bars, verificationBarcodePayload } from './code128.ts';
import { RECEIPT_POWERED_BY, receiptFooterWebsite } from './receiptPoweredBy.ts';

export interface ReceiptPdfOptions {
  docNumber: string;
  docType: string;
  verifyCode?: string;
  date: string;
  customerName?: string;
  cashierName: string;
  items: Array<{ description: string; details?: string[]; qty: number; price: number; lineTotal: number }>;
  subtotal: number;
  discountPct: number;
  taxPct: number;
  total: number;
  cashTendered: number;
  change: number;
  balanceDue: number;
  amountPaid: number;
  payments: Array<{ amount: number; method: string }>;
  company: {
    name: string;
    phone: string;
    website: string;
    email: string;
    address?: string;
    taxId?: string;
    registrationNumber?: string;
    tagline?: string;
    footerText?: string;
  };
  logoDataUri?: string;
  logoNatural?: { w: number; h: number };
}

/** High-Tech Emerald palette shared with invoice.preyone.com documents. */
const C = {
  white: [255, 255, 255] as const,
  deep: [4, 120, 87] as const,       // #047857
  emerald: [5, 150, 105] as const,   // #059669
  mint: [236, 253, 245] as const,    // #ECFDF5
  mintLine: [209, 250, 229] as const,
  ink: [15, 23, 42] as const,        // crisp dark slate
  muted: [71, 85, 105] as const,
  red: [185, 28, 28] as const,
  redWash: [254, 226, 226] as const,
};

const money = (value: number) => `$${(Number(value) || 0).toFixed(2)}`;

function setFill(doc: jsPDF, rgb: readonly [number, number, number]) {
  doc.setFillColor(rgb[0], rgb[1], rgb[2]);
}

function setText(doc: jsPDF, rgb: readonly [number, number, number]) {
  doc.setTextColor(rgb[0], rgb[1], rgb[2]);
}

/** Draw a centred line or two, shrinking once instead of clipping the value. */
function centeredLines(
  doc: jsPDF,
  value: string,
  centerX: number,
  startY: number,
  maxWidth: number,
  size: number,
  rgb: readonly [number, number, number],
  bold = false
): number {
  if (!value) return startY;
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  let lines = doc.splitTextToSize(value, maxWidth) as string[];
  let fontSize = size;
  if (lines.length > 2) {
    fontSize = Math.max(5, size - 1);
    doc.setFontSize(fontSize);
    lines = doc.splitTextToSize(value, maxWidth) as string[];
  }
  setText(doc, rgb);
  lines.slice(0, 2).forEach((line, index) => {
    doc.text(String(line), centerX, startY + index * (fontSize * 0.42), { align: 'center' });
  });
  return startY + Math.min(lines.length, 2) * (fontSize * 0.42);
}

/**
 * Single draw pass shared by the measuring document and the final document.
 * `ph` is deliberately large while measuring, so the exact bottom is known
 * before the real page is created and the roll can be cut immediately after
 * the verification micro-label.
 */
function drawReceipt(doc: jsPDF, opts: ReceiptPdfOptions, pw: number, m: number): number {
  const right = pw - m;
  const center = pw / 2;
  const inner = pw - m * 2;
  let y = 3;

  // Emerald header edge, then a compact branded store block.
  setFill(doc, C.deep);
  doc.rect(0, 0, pw, 1.6, 'F');

  if (opts.logoDataUri) {
    try {
      const maxW = 22;
      const maxH = 14;
      let lw: number;
      let lh: number;
      if (opts.logoNatural && opts.logoNatural.w > 0 && opts.logoNatural.h > 0) {
        const ratio = opts.logoNatural.w / opts.logoNatural.h;
        if (ratio >= 1) {
          lw = Math.min(maxW, maxH * ratio);
          lh = lw / ratio;
        } else {
          lh = Math.min(maxH, maxW / ratio);
          lw = lh * ratio;
        }
      } else {
        lw = maxW;
        lh = maxH;
      }
      doc.addImage(opts.logoDataUri, 'PNG', center - lw / 2, y, lw, lh);
      y += lh + 0.8;
    } catch {
      // A corrupt logo must never stop a sale from printing.
    }
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  y = centeredLines(doc, String(opts.company.name || '').toUpperCase(), center, y + 4, inner, 12.5, C.deep, true) + 1.2;

  setFill(doc, C.emerald);
  doc.rect(center - 9, y, 18, 0.7, 'F');
  y += 2.2;

  doc.setFontSize(6.2);
  y = centeredLines(doc, opts.company.email, center, y + 1.8, inner, 6.2, C.muted) + 0.9;
  doc.setFontSize(6.2);
  y = centeredLines(
    doc,
    [opts.company.phone, opts.company.website].filter(Boolean).join(' · '),
    center,
    y + 1.8,
    inner,
    6.2,
    C.muted
  );

  // Keep reserve data, but only as a single compact line so the roll stays short.
  const reserve = [
    opts.company.address ? String(opts.company.address).replace(/\r?\n/g, ' · ') : '',
    opts.company.taxId ? `VAT: ${opts.company.taxId}` : '',
    opts.company.registrationNumber ? `Reg: ${opts.company.registrationNumber}` : '',
  ].filter(Boolean).join(' · ');
  if (reserve) {
    doc.setFontSize(5.6);
    y = centeredLines(doc, reserve, center, y + 2.2, inner, 5.6, C.muted) + 0.6;
  }
  y += 1.2;

  doc.setDrawColor(C.mintLine[0], C.mintLine[1], C.mintLine[2]);
  doc.setLineWidth(0.5);
  doc.line(m, y, right, y);
  y += 2.8;

  // Two-column metadata card. Helvetica digits are already tabular; right
  // alignment fixes the common right edge for every figure in the column.
  const title = opts.docType === 'invoice' ? 'INVOICE' : opts.docType === 'quotation' ? 'QUOTATION' : 'RECEIPT';
  const metaRows: Array<[string, string, boolean]> = [
    [`${title} #`, opts.docNumber, true],
    ['Date', opts.date, false],
  ];
  if (opts.customerName) metaRows.push(['Customer', opts.customerName, false]);
  metaRows.push(['Served by', opts.cashierName, false]);
  const rowH = 3.5;
  const metaTop = y;
  setFill(doc, C.mint);
  doc.roundedRect(m, metaTop, inner, metaRows.length * rowH + 1.6, 1.2, 1.2, 'F');
  y = metaTop + 2.2;
  metaRows.forEach(([label, value, strong]) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.4);
    setText(doc, C.muted);
    doc.text(label, m + 2, y + 1.6);
    doc.setFont('helvetica', strong ? 'bold' : 'normal');
    doc.setFontSize(strong ? 7 : 6.4);
    setText(doc, strong ? C.deep : C.ink);
    doc.text(value, right - 2, y + 1.6, { align: 'right' });
    y += rowH;
  });
  y += 0.8;

  // Items. Description is flush left; qty/price and line total share the right
  // edge used by the totals and final amount below.
  doc.line(m, y, right, y);
  y += 3;
  opts.items.forEach((item) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    setText(doc, C.ink);
    const descriptionLines = doc.splitTextToSize(item.description, inner - 20) as string[];
    descriptionLines.slice(0, 2).forEach((line, index) => {
      doc.text(line, m, y + 2 + index * 2.6);
    });
    doc.text(money(item.lineTotal), right, y + 2, { align: 'right' });
    y += Math.max(3.2, descriptionLines.length * 2.6 + 0.6);

    const details = Array.isArray(item.details) ? item.details : [];
    details.forEach((detail) => {
      const wrapped = doc.splitTextToSize(`• ${detail}`, inner - 3) as string[];
      wrapped.slice(0, 3).forEach((line) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6);
        setText(doc, C.muted);
        doc.text(line, m + 1.5, y + 2);
        y += 2.8;
      });
    });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.2);
    setText(doc, C.muted);
    doc.text(`${Number(item.qty)} x ${money(item.price)}`, right, y + 2, { align: 'right' });
    y += 3.4;
  });

  // Totals.
  doc.line(m, y, right, y);
  y += 3;
  const totalRow = (label: string, value: string, strong = false) => {
    doc.setFont('helvetica', strong ? 'bold' : 'normal');
    doc.setFontSize(strong ? 8.5 : 7);
    setText(doc, strong ? C.white : C.ink);
    doc.text(label, m + 2, y + 2.4);
    doc.text(value, right - 2, y + 2.4, { align: 'right' });
    y += strong ? 6.2 : 3.6;
  };
  totalRow('Subtotal', money(opts.subtotal));
  if (Number(opts.discountPct) > 0) {
    totalRow(`Discount (${opts.discountPct}%)`, `-${money((opts.subtotal * opts.discountPct) / 100)}`);
  }
  if (Number(opts.taxPct) > 0) {
    const taxAmt = (opts.total * opts.taxPct) / (100 + opts.taxPct);
    totalRow(`VAT (${opts.taxPct}%) incl.`, money(taxAmt));
  }

  const totalTop = y;
  setFill(doc, C.deep);
  doc.roundedRect(m, totalTop, inner, 7.2, 1.3, 1.3, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  setText(doc, C.white);
  doc.text('TOTAL', m + 2, totalTop + 4.9);
  doc.text(money(opts.total), right - 2, totalTop + 4.9, { align: 'right' });
  y = totalTop + 9;

  // Payment status: emerald pill plus the same 15.87-degree translucent red
  // PAID stamp used on the main A4 invoice. It sits above the cash line so no
  // figure is ever covered.
  y += 1;
  if (Number(opts.balanceDue) > 0) {
    setFill(doc, C.mint);
    doc.roundedRect(m, y, inner, 6.2, 1.4, 1.4, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    setText(doc, C.deep);
    doc.text(`BALANCE DUE: ${money(opts.balanceDue)}`, center, y + 4, { align: 'center' });
    y += 7;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.2);
    setText(doc, C.muted);
    doc.text(`Paid so far: ${money(opts.amountPaid)}`, center, y + 2, { align: 'center' });
    y += 3.6;
  } else {
    const pillW = 21;
    const pillH = 5.8;
    setFill(doc, C.deep);
    doc.roundedRect(m + 2, y, pillW, pillH, pillH / 2, pillH / 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    setText(doc, C.white);
    doc.text('PAID', m + 2 + pillW / 2, y + 4, { align: 'center' });

    // jsPDF's high-level text/rect helpers pre-flip their Y coordinates, so
    // rotate the stamp with raw PDF primitives inside a saved graphics state.
    // The matrix is the same 15.87-degree banner angle as the A4 invoice stamp.
    const scale = doc.internal.scaleFactor;
    const pageHeightPt = doc.internal.pageSize.getHeight() * scale;
    const angle = (15.87 * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const halfW = 13 * scale;
    const halfH = 3.4 * scale;
    doc.saveGraphicsState();
    doc.setCurrentTransformationMatrix(
      doc.Matrix(cos, sin, -sin, cos, (right - 19) * scale, pageHeightPt - (y + 3) * scale)
    );
    doc.setGState(doc.GState({ opacity: 0.28 }));
    const write = (doc as unknown as { internal: { write: (data: string) => void } }).internal.write;
    write.call(doc.internal, `1 0.89 0.89 rg ${-halfW} ${-halfH} ${halfW * 2} ${halfH * 2} re f`);
    write.call(doc.internal, `0.73 0.11 0.11 RG 0.35 w ${-halfW} ${-halfH} ${halfW * 2} ${halfH * 2} re S`);
    write.call(doc.internal, 'BT 0.73 0.11 0.11 rg /F2 10 Tf 1 0 0 1 -12.2 -3 Tm (PAID) Tj ET');
    doc.restoreGraphicsState();

    // Leave room for the rotated stamp's full bounding box before the cash line.
    y += 11;

    if (Number(opts.cashTendered) > 0) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.4);
      setText(doc, C.ink);
      doc.text(`Cash Tendered: ${money(opts.cashTendered)}`, center, y + 2, { align: 'center' });
      y += 3.4;
      if (Number(opts.change) > 0) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.8);
        setText(doc, C.deep);
        doc.text(`Change: ${money(opts.change)}`, center, y + 2, { align: 'center' });
        y += 3.4;
      }
    }

    if (opts.payments.length > 1) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.6);
      setText(doc, C.muted);
      doc.text(
        opts.payments.map((p) => `${p.method}: ${money(p.amount)}`).join(' + '),
        center,
        y + 2,
        { align: 'center' }
      );
      y += 3.2;
    }
  }

  // Short thank-you, immediately above the verification strip. No repeated
  // merchant block, document-ID heading or detached verification URL.
  doc.line(m, y, right, y);
  y += 3.4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  setText(doc, C.deep);
  doc.text(opts.company.footerText || 'THANKS FOR YOUR PURCHASE', center, y + 2, { align: 'center' });
  y += 3.6;

  // Locked transit-matched footer: Powered by / brand / website. Kept in the
  // vector fallback too, so PDFs still match if DOM capture is unavailable.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.2);
  setText(doc, RECEIPT_POWERED_BY.mutedRgb);
  doc.text(RECEIPT_POWERED_BY.label, center, y + 1.7, { align: 'center' });
  y += 2.2;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.2);
  setText(doc, RECEIPT_POWERED_BY.navyRgb);
  doc.text(RECEIPT_POWERED_BY.brand, center, y + 2, { align: 'center' });
  y += 2.6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  setText(doc, RECEIPT_POWERED_BY.mutedRgb);
  doc.text(receiptFooterWebsite(opts.company.website), center, y + 1.6, { align: 'center' });
  y += 2.2;

  const payload = verificationBarcodePayload(opts.verifyCode || '');
  if (payload) {
    const bars = code128Bars(payload);
    if (bars) {
      const quiet = 1.8;
      const module = (inner - quiet * 2) / bars.length;
      doc.setFillColor(C.ink[0], C.ink[1], C.ink[2]);
      for (let i = 0; i < bars.length; i++) {
        if (bars[i] === '1') {
          doc.rect(m + quiet + i * module, y, Math.max(module, 0.08), 9, 'F');
        }
      }
      y += 10.2;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.2);
      setText(doc, C.muted);
      doc.text('SCAN TO VERIFY • preyone.com/verify', center, y + 1.4, { align: 'center' });
      y += 2.6;
    }
  }

  // No trailing page break: the measuring pass already proved this content
  // fits the final page height, including the verification micro-label.
  return y;
}

/** Final drawn y coordinate on an uncut roll; exported for verification tools. */
export function estimateReceiptContentBottom(opts: ReceiptPdfOptions): number {
  const probe = new jsPDF({ unit: 'mm', format: [80, 1200], compress: true });
  return drawReceipt(probe, opts, 80, 4);
}

/** Exact roll height needed for this receipt; exported for verification tools. */
export function estimateReceiptHeight(opts: ReceiptPdfOptions): number {
  return Math.max(72, Math.ceil(estimateReceiptContentBottom(opts) + 1.5));
}

export function generateReceiptPdf(opts: ReceiptPdfOptions): jsPDF {
  const pw = 80;
  const m = 4;
  const ph = estimateReceiptHeight(opts);
  const doc = new jsPDF({ unit: 'mm', format: [pw, ph], compress: true });
  drawReceipt(doc, opts, pw, m);
  return doc;
}

export function downloadReceiptPdf(doc: jsPDF, filename: string) {
  doc.save(filename);
}

export function receiptPdfToBlob(doc: jsPDF): Blob {
  const buf = doc.output('arraybuffer');
  return new Blob([buf], { type: 'application/pdf' });
}
