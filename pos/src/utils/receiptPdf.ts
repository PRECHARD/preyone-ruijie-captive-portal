import jsPDF from 'jspdf';

export function generateReceiptPdf(opts: {
  docNumber: string;
  docType: string;
  date: string;
  customerName?: string;
  cashierName: string;
  items: Array<{ description: string; qty: number; price: number; lineTotal: number }>;
  subtotal: number;
  discountPct: number;
  taxPct: number;
  total: number;
  cashTendered: number;
  change: number;
  balanceDue: number;
  amountPaid: number;
  payments: Array<{ amount: number; method: string }>;
  company: { name: string; phone: string; website: string; email: string };
  logoDataUri?: string;
  logoNatural?: { w: number; h: number };
}): jsPDF {
  var pw = 80;
  var ph = 200;
  var doc = new jsPDF({ unit: 'mm', format: [pw, ph] });
  var m = 4;
  var y = 4;

  // White background (default)

  // Logo (centered, proportional)
  if (opts.logoDataUri) {
    try {
      var maxW = 36;
      var maxH = 28;
      var lw: number;
      var lh: number;
      if (opts.logoNatural && opts.logoNatural.w > 0 && opts.logoNatural.h > 0) {
        var ratio = opts.logoNatural.w / opts.logoNatural.h;
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
      doc.addImage(opts.logoDataUri, 'PNG', (pw - lw) / 2, y, lw, lh);
      y += lh + 2;
    } catch { /* skip */ }
  }

  // Company name — large capital letters, brand purple
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(54, 17, 106);
  doc.text(opts.company.name.toUpperCase(), pw / 2, y + 4, { align: 'center' });
  y += 7;

  // Email
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(68, 68, 68);
  doc.text(opts.company.email, pw / 2, y + 2, { align: 'center' });
  y += 3;

  // Phone · Website
  doc.text(opts.company.phone + ' · ' + opts.company.website, pw / 2, y + 2, { align: 'center' });
  y += 4;

  // Dashed rule
  doc.setDrawColor(153, 153, 153);
  doc.setLineDashPattern([2, 1], 0);
  doc.line(m, y, pw - m, y);
  doc.setLineDashPattern([], 0);
  y += 4;

  // Document type
  var title = opts.docType === 'invoice' ? 'INVOICE' : opts.docType === 'quotation' ? 'QUOTATION' : 'RECEIPT';

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(0, 0, 0);
  doc.text(title, m, y + 2);
  doc.setFont('helvetica', 'bold');
  doc.text(opts.docNumber, pw - m, y + 2, { align: 'right' });
  y += 4;

  // Date
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(0, 0, 0);
  doc.text('Date', m, y + 2);
  doc.setTextColor(68, 68, 68);
  doc.text(opts.date, pw - m, y + 2, { align: 'right' });
  y += 4;

  // Customer (if any)
  if (opts.customerName) {
    doc.setTextColor(0, 0, 0);
    doc.text('Customer', m, y + 2);
    doc.setTextColor(68, 68, 68);
    doc.text(opts.customerName, pw - m, y + 2, { align: 'right' });
    y += 4;
  }

  // Served by
  doc.setTextColor(0, 0, 0);
  doc.text('Served by', m, y + 2);
  doc.setTextColor(68, 68, 68);
  doc.text(opts.cashierName, pw - m, y + 2, { align: 'right' });
  y += 4;

  // Dashed rule
  doc.setDrawColor(153, 153, 153);
  doc.setLineDashPattern([2, 1], 0);
  doc.line(m, y, pw - m, y);
  doc.setLineDashPattern([], 0);
  y += 4;

  // Items
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  for (var j = 0; j < opts.items.length; j++) {
    var item = opts.items[j];
    doc.setTextColor(0, 0, 0);
    doc.text(item.description, m, y + 2);
    doc.text('$' + item.lineTotal.toFixed(2), pw - m, y + 2, { align: 'right' });
    y += 3;
    doc.setTextColor(100, 100, 100);
    doc.setFontSize(6);
    doc.text(item.qty + ' x $' + item.price.toFixed(2), m, y + 2);
    doc.setFontSize(7);
    y += 4;
  }

  // Dashed rule
  doc.setDrawColor(153, 153, 153);
  doc.setLineDashPattern([2, 1], 0);
  doc.line(m, y, pw - m, y);
  doc.setLineDashPattern([], 0);
  y += 4;

  // Subtotal
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(0, 0, 0);
  doc.text('Subtotal', m, y + 2);
  doc.text('$' + opts.subtotal.toFixed(2), pw - m, y + 2, { align: 'right' });
  y += 4;

  // Discount
  if (opts.discountPct > 0) {
    doc.text('Discount (' + opts.discountPct + '%)', m, y + 2);
    doc.text('-$' + ((opts.subtotal * opts.discountPct) / 100).toFixed(2), pw - m, y + 2, { align: 'right' });
    y += 4;
  }

  // Tax (VAT is included in the charge — extract the portion from within)
  if (opts.taxPct > 0) {
    var taxAmt = (opts.total * opts.taxPct) / (100 + opts.taxPct);
    doc.text('VAT (' + opts.taxPct + '%)', m, y + 2);
    doc.text('$' + taxAmt.toFixed(2), pw - m, y + 2, { align: 'right' });
    y += 4;
  }

  // TOTAL (bold, larger)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(0, 0, 0);
  doc.text('TOTAL', m, y + 3);
  doc.text('$' + opts.total.toFixed(2), pw - m, y + 3, { align: 'right' });
  y += 5;

  // Dashed rule
  doc.setDrawColor(153, 153, 153);
  doc.setLineDashPattern([2, 1], 0);
  doc.line(m, y, pw - m, y);
  doc.setLineDashPattern([], 0);
  y += 4;

  // Payment summary
  if (opts.balanceDue > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(0, 0, 0);
    doc.text('BALANCE DUE: $' + opts.balanceDue.toFixed(2), pw / 2, y + 2, { align: 'center' });
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(68, 68, 68);
    doc.text('Paid so far: $' + opts.amountPaid.toFixed(2), pw / 2, y + 2, { align: 'center' });
    y += 4;
  } else {
    // PAID IN FULL
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(0, 0, 0);
    doc.text('* PAID IN FULL *', pw / 2, y + 2, { align: 'center' });
    y += 5;

    if (opts.cashTendered > 0) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6);
      doc.setTextColor(68, 68, 68);
      doc.text('Cash Tendered: $' + opts.cashTendered.toFixed(2), pw / 2, y + 2, { align: 'center' });
      y += 3;
      if (opts.change > 0) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7);
        doc.setTextColor(0, 0, 0);
        doc.text('Change: $' + opts.change.toFixed(2), pw / 2, y + 2, { align: 'center' });
        y += 4;
      }
    }

    if (opts.payments.length > 1) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.5);
      doc.setTextColor(100, 100, 100);
      var payStr = '';
      for (var k = 0; k < opts.payments.length; k++) {
        if (k > 0) payStr += ' + ';
        payStr += opts.payments[k].method + ': $' + opts.payments[k].amount.toFixed(2);
      }
      doc.text(payStr, pw / 2, y + 2, { align: 'center' });
      y += 3;
    }
  }

  // Dashed rule
  y += 1;
  doc.setDrawColor(153, 153, 153);
  doc.setLineDashPattern([2, 1], 0);
  doc.line(m, y, pw - m, y);
  doc.setLineDashPattern([], 0);
  y += 4;

  // Thanks
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(0, 0, 0);
  doc.text('THANKS FOR YOUR PURCHASE', pw / 2, y + 2, { align: 'center' });
  y += 4;

  // Terms
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5.5);
  doc.setTextColor(68, 68, 68);
  doc.text('Terms & Conditions Apply', pw / 2, y + 2, { align: 'center' });
  y += 4;

  // Company footer
  doc.text(opts.company.name + ' · ' + opts.company.email, pw / 2, y + 1, { align: 'center' });
  y += 3;

  return doc;
}

export function downloadReceiptPdf(doc: jsPDF, filename: string) {
  doc.save(filename);
}

export function receiptPdfToBlob(doc: jsPDF): Blob {
  var buf = doc.output('arraybuffer');
  return new Blob([buf], { type: 'application/pdf' });
}
