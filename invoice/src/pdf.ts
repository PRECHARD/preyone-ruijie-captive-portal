/**
 * Vector PDF export for the A4 document sheet.
 *
 * The on-screen/print path is html + `window.print()`; this module renders the
 * same invoice to a real PDF file so staff can download and e-mail it without
 * going through the browser print dialog. Layout mirrors `DocumentSheet`:
 * brand header, bill-to / details, ruled item table, totals, payment notes and
 * the footer band.
 */
import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';
import type { InvoiceTemplate } from './api';
import type { SheetCompany, SheetDoc } from './DocumentSheet';

const PAGE_W = 210;
const M = 15;
const RIGHT = PAGE_W - M;
const CONTENT_W = PAGE_W - M * 2;
const CONTENT_BOTTOM = 252;

type RGB = [number, number, number];

const INK: RGB = [32, 27, 52];
const MUTED: RGB = [110, 104, 130];
const RULE: RGB = [222, 217, 232];
const LEGACY_ACCENT: RGB = [54, 17, 106];

function hexToRgb(hex?: string | null): RGB | null {
  const value = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) return null;
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function accentRgb(template?: InvoiceTemplate | null): RGB {
  if (!template || template.id === 1 || String(template.accentColor).toLowerCase() === '#7a0e57') {
    return LEGACY_ACCENT;
  }
  return hexToRgb(template.accentColor) ?? LEGACY_ACCENT;
}

function tint(rgb: RGB, amount: number): RGB {
  const keep = Math.max(0, Math.min(1, amount));
  return [
    Math.round(rgb[0] * keep + 255 * (1 - keep)),
    Math.round(rgb[1] * keep + 255 * (1 - keep)),
    Math.round(rgb[2] * keep + 255 * (1 - keep)),
  ];
}

/** jsPDF's core fonts are WinAnsi; map typographic marks to safe equivalents. */
function plain(value: unknown): string {
  return String(value ?? '')
    .replace(/\u2014|\u2013/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2022\u00B7]/g, '-')
    .replace(/\u2212/g, '-');
}

function money(value: unknown, currency: string): string {
  const n = Number(value) || 0;
  const formatted = n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${String(currency || 'USD').toUpperCase()} ${formatted}`;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return plain(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function safeFilename(name: string): string {
  return plain(name).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'document';
}

interface LogoImage {
  dataUrl: string;
  ratio: number;
}

/**
 * Rasterise the company logo so jsPDF can embed it. Fetching and drawing via a
 * canvas also converts WebP/SVG marks (which jsPDF cannot embed directly) into
 * a PNG data URL. Failure is non-fatal: the PDF falls back to a monogram.
 */
async function loadLogo(company: SheetCompany): Promise<LogoImage | null> {
  const source = company.logo_url || (company.logo_path ? `/images/${company.logo_path}` : '');
  if (!source) return null;
  let objectUrl: string | null = null;
  try {
    const res = await fetch(source, { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;
    objectUrl = URL.createObjectURL(blob);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = objectUrl as string;
    });
    const nw = img.naturalWidth || img.width || 0;
    const nh = img.naturalHeight || img.height || 0;
    if (!nw || !nh) return null;
    const scale = Math.min(1, 900 / Math.max(nw, nh));
    const w = Math.max(1, Math.round(nw * scale));
    const h = Math.max(1, Math.round(nh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL('image/png'), ratio: nw / nh };
  } catch {
    return null;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export interface InvoicePdfInput {
  doc: SheetDoc;
  company: SheetCompany;
  template?: InvoiceTemplate | null;
  /** Human label for the document type ("Invoice", "Tax Invoice", ...). */
  title?: string;
  /**
   * The live `.a4-sheet` element to snapshot. When present the PDF is a
   * pixel-for-pixel copy of the preview (same fonts, colours, logo, spacing);
   * the vector renderer below is only a fallback for environments without a
   * DOM (tests) or if the canvas capture is unavailable.
   */
  element?: HTMLElement | null;
}

/** Build the PDF without saving it (exported for tests/tooling). */
export async function buildInvoicePdf({ doc, company, template, title }: InvoicePdfInput): Promise<jsPDF> {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const accent = accentRgb(template);
  const zebra = tint(accent, 0.055);
  const soft = tint(accent, 0.12);
  const logo = template?.showLogo === false ? null : await loadLogo(company);

  const items = Array.isArray(doc.items) ? doc.items : [];
  const subtotal = Number.isFinite(doc.subtotal)
    ? doc.subtotal
    : items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
  const discountPct = Number(doc.discountPct) || 0;
  const taxPct = Number(doc.taxPct) || 0;
  const discountAmount = (subtotal * discountPct) / 100;
  const net = subtotal - discountAmount;
  const taxAmount = taxPct > 0 ? (net * taxPct) / (100 + taxPct) : 0;
  const total = Number.isFinite(doc.total) ? doc.total : net;
  const amountPaid = Number(doc.amountPaid) || 0;
  const balance = Math.max(total - amountPaid, 0);
  const paid = doc.status === 'paid' || (total > 0 && amountPaid >= total - 0.005);

  const companyName = plain(company.name || 'Preyone');
  const addressLines = plain(company.address || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const titleText = plain(title || (isQuoteType(doc.docType) ? 'Quotation' : 'Invoice')).toUpperCase();

  let page = 1;
  let y = 0;

  const setInk = (rgb: RGB) => pdf.setTextColor(rgb[0], rgb[1], rgb[2]);
  const setFill = (rgb: RGB) => pdf.setFillColor(rgb[0], rgb[1], rgb[2]);
  const setStroke = (rgb: RGB) => pdf.setDrawColor(rgb[0], rgb[1], rgb[2]);
  const font = (style: 'normal' | 'bold' | 'italic', size: number) => {
    pdf.setFont('helvetica', style);
    pdf.setFontSize(size);
  };

  const drawMonogram = (x: number, yy: number, size: number) => {
    setFill(accent);
    pdf.roundedRect(x, yy, size, size, 2, 2, 'F');
    pdf.setTextColor(255, 255, 255);
    font('bold', size * 1.6);
    pdf.text(companyName.slice(0, 1).toUpperCase(), x + size / 2, yy + size / 2 + size * 0.28, { align: 'center' });
  };

  const drawContinuationHeader = () => {
    setFill(accent);
    pdf.rect(0, 0, PAGE_W, 3, 'F');
    font('bold', 10);
    setInk(INK);
    pdf.text(companyName, M, 14);
    font('normal', 8);
    setInk(MUTED);
    pdf.text(`${titleText}  |  No. ${plain(doc.number)}`, RIGHT, 14, { align: 'right' });
    setStroke(RULE);
    pdf.setLineWidth(0.3);
    pdf.line(M, 18, RIGHT, 18);
    y = 26;
  };

  const drawTableHead = () => {
    setFill(accent);
    pdf.rect(M, y, CONTENT_W, 9, 'F');
    pdf.setTextColor(255, 255, 255);
    font('bold', 7.5);
    pdf.text(isQuoteType(doc.docType) ? 'DESCRIPTION' : 'PRODUCT', M + 3, y + 6);
    pdf.text('PRICE', 133, y + 6, { align: 'right' });
    pdf.text('QTY', 158, y + 6, { align: 'right' });
    pdf.text('TOTAL', RIGHT - 3, y + 6, { align: 'right' });
    y += 9;
  };

  /* ── page 1 header ────────────────────────────────────────────────── */

  let leftY = 16;
  if (logo) {
    const maxW = 70;
    const maxH = 20;
    const ratio = logo.ratio > 0 ? logo.ratio : 1;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    try {
      pdf.addImage(logo.dataUrl, 'PNG', M, leftY, w, h);
    } catch {
      drawMonogram(M, leftY, 16);
    }
    leftY += h + 6;
  } else {
    drawMonogram(M, leftY, 16);
    leftY += 22;
  }

  font('bold', 12);
  setInk(INK);
  pdf.text(companyName, M, leftY);
  leftY += 5;
  font('normal', 7.6);
  setInk(MUTED);
  for (const line of addressLines.slice(0, 3)) {
    pdf.text(line, M, leftY);
    leftY += 3.8;
  }
  const contact = [company.support_phone, company.email].map(plain).filter(Boolean).join('  |  ');
  if (contact) {
    pdf.text(contact, M, leftY);
    leftY += 3.8;
  }
  if (company.website) {
    pdf.text(plain(company.website), M, leftY);
    leftY += 3.8;
  }

  font('bold', 20);
  setInk(accent);
  pdf.text(titleText, RIGHT, 25, { align: 'right' });

  setFill(accent);
  pdf.roundedRect(RIGHT - 64, 29, 64, 8, 1.5, 1.5, 'F');
  pdf.setTextColor(255, 255, 255);
  font('bold', 8);
  pdf.text(`No. ${plain(doc.number)}`, RIGHT - 3, 34.3, { align: 'right' });

  if (paid) {
    setStroke([22, 138, 88]);
    pdf.setLineWidth(0.5);
    pdf.roundedRect(RIGHT - 26, 40, 26, 7, 1.5, 1.5, 'S');
    setInk([22, 138, 88]);
    font('bold', 8);
    pdf.text('PAID', RIGHT - 13, 44.9, { align: 'center' });
  }

  y = Math.max(leftY, paid ? 50 : 42) + 2;
  setStroke(RULE);
  pdf.setLineWidth(0.4);
  pdf.line(M, y, RIGHT, y);
  y += 10;

  /* ── bill-to + details ────────────────────────────────────────────── */

  const metaTop = y;
  font('bold', 6.8);
  setInk(accent);
  pdf.text('BILL TO', M, metaTop);
  font('bold', 10.5);
  setInk(INK);
  pdf.text(plain(doc.customerName || '-'), M, metaTop + 6);

  const clientLines = [doc.customerAddress, doc.customerEmail, doc.customerPhone]
    .map(plain)
    .filter((v) => v.trim());
  font('normal', 8);
  setInk(MUTED);
  let leftBottom = metaTop + 6;
  for (const raw of clientLines) {
    const lines = pdf.splitTextToSize(raw, 92) as string[];
    for (const line of lines.slice(0, 3)) {
      leftBottom += 4.2;
      pdf.text(line, M, leftBottom);
    }
  }

  const detailX = 118;
  const valueX = RIGHT;
  let detailY = metaTop;
  font('bold', 6.8);
  setInk(accent);
  pdf.text(isQuoteType(doc.docType) ? 'QUOTE DETAILS' : 'INVOICE DETAILS', detailX, detailY);
  detailY += 6;

  const details: Array<[string, string]> = [
    ['Date', fmtDate(doc.issueDate)],
    [isQuoteType(doc.docType) ? 'Valid Until' : 'Due Date', fmtDate(doc.dueDate)],
    ['Status', plain(doc.status).replace(/^\w/, (c) => c.toUpperCase())],
  ];
  if (doc.poNumber) details.push(['PO No.', plain(doc.poNumber)]);
  if (doc.reference) details.push(['Reference', plain(doc.reference)]);

  for (const [label, value] of details) {
    font('normal', 8);
    setInk(MUTED);
    pdf.text(label, detailX, detailY);
    font('bold', 8);
    setInk(INK);
    pdf.text(value, valueX, detailY, { align: 'right' });
    detailY += 5;
  }

  y = Math.max(leftBottom, detailY) + 8;

  /* ── item table ───────────────────────────────────────────────────── */

  drawTableHead();
  const descWidth = 105;

  items.forEach((item, index) => {
    const description = plain(item.description || '-');
    let descLines = pdf.splitTextToSize(description, descWidth) as string[];
    if (descLines.length > 3) descLines = [...descLines.slice(0, 2), `${descLines[2].replace(/\s+\S*$/, '')}...`];
    const rowH = Math.max(9, descLines.length * 4.3 + 4.6);

    if (y + rowH > CONTENT_BOTTOM) {
      pdf.addPage();
      page += 1;
      drawContinuationHeader();
      drawTableHead();
    }

    if (index % 2 === 1) {
      setFill(zebra);
      pdf.rect(M, y, CONTENT_W, rowH, 'F');
    }

    font('normal', 8.5);
    setInk(INK);
    descLines.forEach((line, i) => pdf.text(line, M + 3, y + 5.4 + i * 4.2));

    font('normal', 8.2);
    pdf.text(money(item.price, doc.currency), 133, y + 5.4, { align: 'right' });
    pdf.text(plain(Number(item.qty) || 0), 158, y + 5.4, { align: 'right' });
    font('bold', 8.2);
    pdf.text(money(item.line_total ?? (Number(item.price) || 0) * (Number(item.qty) || 0), doc.currency), RIGHT - 3, y + 5.4, {
      align: 'right',
    });

    setStroke([238, 234, 246]);
    pdf.setLineWidth(0.2);
    pdf.line(M, y + rowH, RIGHT, y + rowH);
    y += rowH;
  });

  /* ── totals ───────────────────────────────────────────────────────── */

  const rows: Array<{ label: string; value: string; kind?: 'muted' | 'grand' | 'paid' | 'balance' }> = [
    { label: 'Subtotal', value: money(subtotal, doc.currency) },
  ];
  if (discountPct > 0) {
    rows.push({ label: `Discount (${discountPct}%)`, value: `-${money(discountAmount, doc.currency)}`, kind: 'muted' });
  }
  if (taxPct > 0) {
    rows.push({ label: `VAT (${taxPct}%) Incl.`, value: money(taxAmount, doc.currency), kind: 'muted' });
  }
  rows.push({ label: 'Total', value: money(total, doc.currency), kind: 'grand' });
  if (amountPaid > 0) {
    rows.push({ label: 'Amount Paid', value: `-${money(amountPaid, doc.currency)}`, kind: 'paid' });
    rows.push({ label: 'Balance Due', value: money(balance, doc.currency), kind: 'balance' });
  }

  const blockW = 79;
  const blockX = RIGHT - blockW;
  const totalsH = rows.reduce((sum, row) => sum + (row.kind === 'grand' ? 11 : 6.4), 6);

  if (y + totalsH > CONTENT_BOTTOM) {
    pdf.addPage();
    page += 1;
    drawContinuationHeader();
  }

  y += 6;
  for (const row of rows) {
    if (row.kind === 'grand') {
      setStroke(accent);
      pdf.setLineWidth(0.5);
      pdf.line(blockX, y - 3, RIGHT, y - 3);
      font('bold', 11);
      setInk(accent);
      pdf.text(row.label, blockX, y + 3);
      pdf.text(row.value, RIGHT, y + 3, { align: 'right' });
      y += 11;
      continue;
    }
    if (row.kind === 'balance') {
      setFill(soft);
      pdf.roundedRect(blockX, y - 2.6, blockW, 8.6, 1.2, 1.2, 'F');
      font('bold', 9.6);
      setInk(accent);
      pdf.text(row.label, blockX + 3, y + 3.2);
      pdf.text(row.value, RIGHT - 3, y + 3.2, { align: 'right' });
      y += 8;
      continue;
    }
    font('normal', row.kind === 'paid' ? 8.4 : 8.6);
    setInk(row.kind === 'muted' || row.kind === 'paid' ? MUTED : INK);
    pdf.text(row.label, blockX, y + 2);
    pdf.text(row.value, RIGHT, y + 2, { align: 'right' });
    y += 6.4;
  }

  /* ── payment notes ────────────────────────────────────────────────── */

  if (doc.notes) {
    const noteLines = pdf.splitTextToSize(plain(doc.notes), CONTENT_W) as string[];
    const noteH = 6 + noteLines.length * 4.1;
    if (y + noteH > CONTENT_BOTTOM) {
      pdf.addPage();
      page += 1;
      drawContinuationHeader();
    }
    y += 9;
    font('bold', 6.8);
    setInk(accent);
    pdf.text('PAYMENT INFORMATION', M, y);
    y += 4.5;
    font('normal', 8.2);
    setInk(MUTED);
    noteLines.forEach((line) => {
      pdf.text(line, M, y);
      y += 4.1;
    });
  }

  /* ── footer (every page) ──────────────────────────────────────────── */

  const totalPages = pdf.getNumberOfPages();
  const terms = plain(company.terms_text || '');
  const termsLines = terms ? (pdf.splitTextToSize(terms, 168) as string[]).slice(0, 3) : [];
  const tagline = plain(company.tagline || '');

  for (let p = 1; p <= totalPages; p += 1) {
    pdf.setPage(p);
    let fy = 256;
    setStroke(RULE);
    pdf.setLineWidth(0.3);
    pdf.line(M, fy, RIGHT, fy);
    fy += 4;

    font('bold', 6.2);
    setInk(MUTED);
    pdf.text('TERMS & CONDITIONS', M, fy);
    fy += 3.4;
    font('normal', 6.2);
    setInk(MUTED);
    for (const line of termsLines) {
      pdf.text(line, M, fy);
      fy += 3.1;
    }
    if (tagline) {
      font('italic', 7);
      setInk(accent);
      pdf.text(tagline, RIGHT, 269, { align: 'right' });
    }

    setFill(accent);
    pdf.rect(0, 278, PAGE_W, 10, 'F');
    pdf.setTextColor(255, 255, 255);
    font('bold', 6.4);
    pdf.text(companyName, M, 283.2);
    if (addressLines.length) {
      font('normal', 5.9);
      pdf.text(addressLines.slice(0, 2).join('  |  '), M, 286.4);
    }
    font('normal', 6);
    const bandContact = [company.support_phone, company.email, company.website].map(plain).filter(Boolean).join('  |  ');
    if (bandContact) pdf.text(bandContact, RIGHT, 283.2, { align: 'right' });
    font('bold', 6.2);
    pdf.text(`Page ${p} of ${totalPages}`, RIGHT, 286.4, { align: 'right' });
  }

  return pdf;
}

export async function downloadInvoicePdf(input: InvoicePdfInput): Promise<void> {
  const filename = `${safeFilename(input.doc.number || 'document')}.pdf`;
  const sheet =
    input.element ??
    (document.querySelector('.a4-print-host .a4-sheet') as HTMLElement | null);

  if (sheet) {
    try {
      const pdf = await sheetToPdf(sheet);
      pdf.save(filename);
      return;
    } catch (err) {
      // Canvas capture can fail on locked-down browsers; fall through to the
      // vector renderer so the download still works.
      console.warn('[invoice] sheet snapshot failed, using vector fallback', err);
    }
  }

  const pdf = await buildInvoicePdf(input);
  pdf.save(filename);
}

/**
 * Snapshot the exact preview sheet with html2canvas and lay the bitmap over
 * A4 pages. Rasterising the real DOM is what guarantees the download matches
 * the on-screen template (gradients, logo, fonts, spacing, footer band).
 */
export async function sheetToPdf(sheet: HTMLElement): Promise<jsPDF> {
  const host = sheet.closest('.a4-print-host') as HTMLElement | null;
  const previousStyle = host?.getAttribute('style') ?? null;

  if (host) {
    // `.a4-print-host` is display:none on screen (it only exists for print),
    // so expose it to layout for the duration of the capture.
    host.style.display = 'block';
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.top = '0';
    host.style.width = '210mm';
    host.style.zIndex = '-1';
    host.style.pointerEvents = 'none';
    host.style.background = '#fff';
  }

  try {
    await document.fonts?.ready?.catch(() => undefined);
    await Promise.all(
      Array.from(sheet.querySelectorAll('img')).map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete) return resolve();
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          })
      )
    );

    const width = Math.ceil(sheet.scrollWidth || sheet.getBoundingClientRect().width);
    const height = Math.ceil(sheet.scrollHeight || sheet.getBoundingClientRect().height);

    const canvas = await html2canvas(sheet, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      width,
      height,
      windowWidth: width,
      windowHeight: height,
      scrollX: 0,
      scrollY: 0,
    });

    const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const pageHeightMm = 297;
    const mmPerPx = PAGE_W / canvas.width;
    const pageHeightPx = Math.max(1, Math.ceil(pageHeightMm / mmPerPx));
    let pages = Math.max(1, Math.ceil(canvas.height / pageHeightPx));
    // A perfect A4 sheet lands one or two pixels over the computed page height;
    // don't let rounding emit a blank trailing page.
    if (pages > 1 && canvas.height - (pages - 1) * pageHeightPx <= 2) pages -= 1;

    for (let page = 0; page < pages; page += 1) {
      if (page > 0) pdf.addPage();
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = Math.min(pageHeightPx, canvas.height - page * pageHeightPx);
      const ctx = slice.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, -page * pageHeightPx);
      pdf.addImage(
        slice.toDataURL('image/jpeg', 0.94),
        'JPEG',
        0,
        0,
        PAGE_W,
        slice.height * mmPerPx,
        undefined,
        'FAST'
      );
    }

    return pdf;
  } finally {
    if (host) {
      if (previousStyle === null) host.removeAttribute('style');
      else host.setAttribute('style', previousStyle);
    }
  }
}

function isQuoteType(type: string): boolean {
  return ['quote', 'quotation', 'estimate', 'proforma', 'purchase_order'].includes(String(type));
}
