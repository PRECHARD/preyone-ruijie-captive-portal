import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { InvoiceTemplate } from './api';

/**
 * A4 document sheet.
 *
 * This is the exact house template from the previous Preyone invoice
 * deployment (`/opt/preyone-invoice/src/components/DocumentSheet.jsx` plus
 * `styles/document.css`), rebuilt for the v3.2 workspace:
 *
 *   brand lockup · wordmark + gradient number bar
 *   bill-to / document meta grid
 *   gradient item table with zebra rows (no empty filler rows)
 *   gradient grand total, paid/balance rows
 *   payment notes
 *   THANKS + terms + full-bleed footer band
 *
 * Every one of the 20 catalogue templates renders this same A4 structure.
 * The template only changes the gradient stops, the wordmark treatment and
 * the row density, which is what keeps the whole set in one visual genre.
 */

export interface SheetCompany {
  name?: string | null;
  tagline?: string | null;
  address?: string | null;
  email?: string | null;
  support_phone?: string | null;
  website?: string | null;
  logo_url?: string | null;
  logo_path?: string | null;
  terms_text?: string | null;
  receipt_footer?: string | null;
  currency?: string | null;
  branding?: {
    taxId?: string | null;
    registrationNumber?: string | null;
  } | null;
  invoice_settings?: Record<string, unknown> | null;
}

export interface SheetItem {
  description: string;
  /** Bullet details rendered under the item name, one per line. */
  details?: string[] | null;
  qty: number | string;
  price: number | string;
  line_total?: number | string;
}

export interface SheetDoc {
  docType: string;
  number: string;
  status: string;
  /** Globally unique PVN-… identifier printed in the bottom-left band. */
  verifyCode?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  customerName?: string | null;
  customerAddress?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  items: SheetItem[];
  notes?: string | null;
  poNumber?: string | null;
  reference?: string | null;
  subtotal: number;
  discountPct?: number;
  taxPct?: number;
  total: number;
  amountPaid?: number;
  /** Cash actually handed over and the change given, when paid in cash. */
  cashTendered?: number;
  cashChange?: number;
  currency: string;
}

const QUOTE_TYPES = new Set([
  'quote',
  'quotation',
  'estimate',
  'proforma',
  'purchase_order',
]);

function isQuoteFamily(type: string): boolean {
  return QUOTE_TYPES.has(type);
}

/* ── colour helpers ─────────────────────────────────────────────────── */

function hexToHsl(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean.padEnd(6, '0').slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

/** Deep, white-text-safe band built from one accent colour. */
export function gradientFromAccent(accent: string): string {
  const [h, s] = hexToHsl(accent);
  const sat = Math.max(38, s);
  return [
    `hsl(${h} ${sat}% 11%) 0%`,
    `hsl(${h} ${sat}% 16%) 18%`,
    `hsl(${h} ${sat}% 24%) 38%`,
    `hsl(${h} ${sat}% 30%) 58%`,
    `hsl(${h} ${sat}% 26%) 78%`,
    `hsl(${h} ${sat}% 21%) 100%`,
  ].reduce((acc, stop, i) => acc + (i ? ', ' : '') + stop, 'linear-gradient(100deg, ') + ')';
}

/** The literal gradient shipped by the previous deployment. */
export const LEGACY_GRADIENT =
  'linear-gradient(100deg,#14002e 0%,#170133 7%,#200644 17%,#300e5f 28%,#36116a 32%,#4a1064 43%,#640e5d 61%,#740e58 77%,#7a0e57 90%)';

/** Template id 1 is the house template and keeps the exact legacy gradient. */
export function isLegacyTemplate(template?: InvoiceTemplate | null): boolean {
  if (!template) return false;
  return template.id === 1 || String(template.accentColor).toLowerCase() === '#7a0e57';
}

/** Mix `a` towards `b`; `keep` is the weight of `a` (0..1). */
function mixHex(a: string, b: string, keep: number): string {
  const parse = (hex: string): [number, number, number] | null => {
    const clean = String(hex || '').trim().replace(/^#/, '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    if (!/^[0-9a-f]{6}$/i.test(full)) return null;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  };
  const from = parse(a);
  const to = parse(b);
  if (!from || !to) return a;
  const weight = Math.max(0, Math.min(1, keep));
  const channel = (i: number) =>
    Math.round(from[i] * weight + to[i] * (1 - weight))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function rgbaOf(hex: string, alpha: number): string {
  const clean = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return `rgba(54, 17, 106, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function templateVars(template?: InvoiceTemplate | null): CSSProperties {
  const accent = template?.accentColor || '#7a0e57';
  const legacy = isLegacyTemplate(template);
  const grad = legacy ? LEGACY_GRADIENT : gradientFromAccent(accent);
  // Pre-mix the derived tint colours here rather than in CSS: html2canvas
  // (used by the Download PDF path) cannot evaluate `color-mix()`.
  const deep = legacy ? '#36116a' : mixHex(accent, '#14002e', 0.72);
  // Detail bullets use the template's own purple + navy pairing. The legacy
  // house template gets the exact Preyone purple/navy; every other template
  // derives both stops from its accent so the spec panel always belongs to
  // the chosen design instead of importing a fixed colour from another theme.
  const detailNavy = legacy ? '#122b70' : mixHex(accent, '#122b70', 0.58);
  return {
    '--doc-grad': grad,
    '--doc-row-tint': `linear-gradient(rgba(255, 255, 255, .57), rgba(255, 255, 255, .57)), ${grad}`,
    '--doc-accent': deep,
    '--doc-thanks': legacy ? '#122b70' : mixHex(accent, '#14002e', 0.55),
    '--doc-detail-navy': detailNavy,
    '--doc-detail-border': rgbaOf(deep, 0.62),
    '--doc-detail-glow': rgbaOf(deep, 0.18),
    '--doc-halo': rgbaOf(deep, 0.12),
    '--doc-halo-soft': rgbaOf(deep, 0.1),
    '--doc-row-soft': mixHex(deep, '#ffffff', 0.07),
  } as CSSProperties;
}

export function templateClass(template?: InvoiceTemplate | null): string {
  return `layout-${template?.layout || 'standard'}`;
}

/* ── formatting ─────────────────────────────────────────────────────── */

function money(value: unknown, currency: string): string {
  const n = Number(value) || 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency || 'USD'} ${n.toFixed(2)}`;
  }
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ── component ──────────────────────────────────────────────────────── */

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function DocumentSheet({
  doc,
  company,
  template,
  className = '',
  id,
  printRoot = false,
}: {
  doc: SheetDoc;
  company: SheetCompany;
  template?: InvoiceTemplate | null;
  className?: string;
  id?: string;
  /** Adds the class the print stylesheet promotes to the only visible node. */
  printRoot?: boolean;
}) {
  const quote = isQuoteFamily(doc.docType);
  const items = Array.isArray(doc.items) ? doc.items : [];

  // The subtotal must be the sum of exactly what the Total column shows. Use
  // the stored line_total when present (rounded per line), otherwise a rounded
  // price x qty, and only fall back to the saved subtotal for item-less legacy
  // documents. This prevents the printed subtotal drifting a cent from the
  // visible line totals.
  const lineTotalOf = (item: SheetItem) => {
    const stored = Number(item.line_total);
    if (Number.isFinite(stored)) return round2(stored);
    return round2((Number(item.price) || 0) * (Number(item.qty) || 0));
  };
  const computedSubtotal = round2(items.reduce((sum, item) => sum + lineTotalOf(item), 0));
  const storedSubtotal = Number(doc.subtotal);
  const subtotal = items.length
    ? computedSubtotal
    : Number.isFinite(storedSubtotal)
      ? round2(storedSubtotal)
      : 0;
  const discountPct = Number(doc.discountPct) || 0;
  const taxPct = Number(doc.taxPct) || 0;
  const discountAmount = round2((subtotal * discountPct) / 100);
  const net = round2(subtotal - discountAmount);
  const taxAmount = taxPct > 0 ? round2((net * taxPct) / (100 + taxPct)) : 0;
  const netOfTax = round2(net - taxAmount);
  const storedTotal = Number(doc.total);
  const total = items.length
    ? net
    : Number.isFinite(storedTotal)
      ? round2(storedTotal)
      : net;
  const amountPaid = Number(doc.amountPaid) || 0;
  const cashTendered = Number(doc.cashTendered) || 0;
  const cashChange = Number(doc.cashChange) || 0;
  const balance = Math.max(round2(total - amountPaid), 0);
  const paid = doc.status === 'paid' || (total > 0 && amountPaid >= total - 0.005);

  const addressLines = String(company.address || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const inlineBranding =
    company.invoice_settings && typeof company.invoice_settings === 'object'
      ? (company.invoice_settings.branding as Record<string, unknown> | undefined)
      : undefined;
  const taxId = String(inlineBranding?.taxId || company.branding?.taxId || '').trim();
  const registrationNumber = String(
    inlineBranding?.registrationNumber || company.branding?.registrationNumber || ''
  ).trim();
  const bandAddress = [
    company.name,
    ...addressLines,
    taxId ? `VAT: ${taxId}` : '',
    registrationNumber ? `Reg: ${registrationNumber}` : '',
  ].filter(Boolean) as string[];
  const hasContact = Boolean(company.support_phone || company.email || company.website);
  const contactLine = [company.support_phone].filter(Boolean).join('  |  ');

  const logo =
    company.logo_url || (company.logo_path ? `/images/${company.logo_path}` : null) || '/brand/Preyone.svg';
  const showLogo = template?.showLogo !== false;
  const legacy = isLegacyTemplate(template);
  const docLabel = quote ? 'Quotation' : 'Invoice';

  const customerLines = [doc.customerAddress, doc.customerEmail, doc.customerPhone]
    .filter((value) => String(value || '').trim())
    .join('\n');

  const [pageChunks, setPageChunks] = useState<Array<{ start: number; end: number }> | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const signature = useMemo(
    () =>
      JSON.stringify({
        number: doc.number,
        status: doc.status,
        issueDate: doc.issueDate,
        dueDate: doc.dueDate,
        customerName: doc.customerName,
        customerAddress: doc.customerAddress,
        customerEmail: doc.customerEmail,
        customerPhone: doc.customerPhone,
        notes: doc.notes,
        poNumber: doc.poNumber,
        reference: doc.reference,
        subtotal: doc.subtotal,
        discountPct: doc.discountPct,
        taxPct: doc.taxPct,
        total: doc.total,
        amountPaid: doc.amountPaid,
        currency: doc.currency,
        items: items.map((item) => ({
          description: item.description,
          details: item.details || [],
          qty: item.qty,
          price: item.price,
          line_total: item.line_total,
        })),
        company: {
          name: company.name,
          tagline: company.tagline,
          address: company.address,
          email: company.email,
          support_phone: company.support_phone,
          website: company.website,
          logo_url: company.logo_url,
          logo_path: company.logo_path,
          terms_text: company.terms_text,
          receipt_footer: company.receipt_footer,
          currency: company.currency,
        },
        template: template
          ? {
              id: template.id,
              accentColor: template.accentColor,
              layout: template.layout,
              showLogo: template.showLogo,
            }
          : null,
      }),
    [doc, company, template, items]
  );

  // Content changed: rebuild the page split from a single continuous sheet.
  useLayoutEffect(() => {
    setPageChunks(null);
  }, [signature]);

  // Measure the real rendered sheet and split it into A4 pages. This keeps the
  // preview, browser print and generated PDF identical: items flow onto extra
  // pages, totals follow the last item, and every page gets the footer.
  useLayoutEffect(() => {
    if (pageChunks !== null) return;
    const sheet = sheetRef.current;
    if (!sheet) return;

    const groups = Array.from(sheet.querySelectorAll<HTMLElement>('[data-item-group]'));
    if (items.length === 0 || groups.length !== items.length) {
      setPageChunks([{ start: 0, end: items.length }]);
      return;
    }

    const sheetRect = sheet.getBoundingClientRect();
    if (sheetRect.width < 1 || sheetRect.height < 1) return;

    const mm = sheetRect.width / 210;
    const pageHeight = 297 * mm;
    const header = sheet.querySelector<HTMLElement>('.a4-doc-head');
    const thead = sheet.querySelector<HTMLElement>('.a4-items-table thead');
    const footer = sheet.querySelector<HTMLElement>('.a4-sheet-footer');
    const totals = sheet.querySelector<HTMLElement>('.a4-totals-wrap');
    const notes = sheet.querySelector<HTMLElement>('.a4-notes-block');

    const headerTop = header ? header.getBoundingClientRect().top - sheetRect.top : 0;
    const headerHeight = header ? header.getBoundingClientRect().height : 0;
    const theadHeight = thead ? thead.getBoundingClientRect().height : 0;
    const footerHeight = footer ? footer.getBoundingClientRect().height : 0;
    const totalsHeight = totals ? totals.getBoundingClientRect().height : 0;
    const notesHeight = notes ? notes.getBoundingClientRect().height : 0;

    // Reserve the totals/notes block on every page. The last page then always
    // has room for it, even when the final item ends near the bottom edge.
    const tailHeight = totalsHeight + notesHeight + 10 * mm;
    const safety = 6 * mm;
    const tableGap = 9 * mm;

    const capacityFirst = Math.max(
      30 * mm,
      pageHeight - headerTop - footerHeight - tailHeight - safety
    );
    const capacityNext = Math.max(
      30 * mm,
      pageHeight - headerTop - headerHeight - tableGap - theadHeight - footerHeight - tailHeight - safety
    );

    const heights = groups.map((group) => Math.max(1, group.getBoundingClientRect().height));
    const chunks: Array<{ start: number; end: number }> = [];
    let index = 0;
    while (index < heights.length) {
      const capacity = chunks.length === 0 ? capacityFirst : capacityNext;
      const start = index;
      let used = 0;
      while (index < heights.length) {
        const height = heights[index];
        if (used + height > capacity && index > start) break;
        used += height;
        index += 1;
        // A single item taller than the page still gets its own page.
        if (used > capacity && index === start + 1) break;
      }
      chunks.push({ start, end: index });
    }

    setPageChunks(chunks.length ? chunks : [{ start: 0, end: items.length }]);
  }, [items.length, pageChunks, signature]);

  const totalPages = pageChunks?.length ?? 1;
  const renderedChunks = pageChunks ?? [{ start: 0, end: items.length }];

  const renderHeader = () => (
    <header className="a4-doc-head">
      <div className="a4-brand">
        {showLogo ? (
          <img
            className="a4-brand-logo"
            src={logo}
            alt={company.name || 'Company logo'}
            crossOrigin="anonymous"
          />
        ) : (
          <div className="a4-brand-fallback">{(company.name || 'P').slice(0, 1).toUpperCase()}</div>
        )}
      </div>
      <div className="a4-doc-mark">
        {legacy ? (
          <img
            className="a4-wordmark"
            src={quote ? '/brand/quotation-wordmark.svg' : '/brand/invoice-wordmark.svg'}
            alt={docLabel}
          />
        ) : (
          <span className="a4-wordmark-text">{docLabel}</span>
        )}
        <div className="a4-number-bar">No. {doc.number}</div>
      </div>
    </header>
  );

  const renderMeta = () => (
    <section className="a4-doc-meta">
      <div className="a4-bill-to">
        <div className="a4-meta-label">Bill To</div>
        <div className="a4-client-name">{doc.customerName || '—'}</div>
        <div className="a4-client-lines">{customerLines}</div>
      </div>
      <div>
        <div className="a4-meta-label">{quote ? 'Quote Details' : 'Invoice Details'}</div>
        <dl className="a4-meta-grid">
          <dt>Date</dt>
          <dd>{fmtDate(doc.issueDate)}</dd>
          {doc.dueDate && (
            <>
              <dt>{quote ? 'Valid Until' : 'Due Date'}</dt>
              <dd>{fmtDate(doc.dueDate)}</dd>
            </>
          )}
          <dt>Status</dt>
          <dd style={{ textTransform: 'capitalize' }}>{doc.status}</dd>
          {doc.poNumber && (
            <>
              <dt>PO No.</dt>
              <dd>{doc.poNumber}</dd>
            </>
          )}
          {doc.reference && (
            <>
              <dt>Reference</dt>
              <dd>{doc.reference}</dd>
            </>
          )}
        </dl>
      </div>
    </section>
  );

  const renderItems = (chunk: { start: number; end: number }) => (
    <table className="a4-items-table">
      <colgroup>
        <col className="a4-c-product" />
        <col className="a4-c-price" />
        <col className="a4-c-qty" />
        <col className="a4-c-total" />
      </colgroup>
      <thead>
        <tr>
          <th>{quote ? 'Description' : 'Product'}</th>
          <th>Price</th>
          <th>Qty</th>
          <th>Total</th>
        </tr>
      </thead>
      {items.slice(chunk.start, chunk.end).map((item, localIndex) => {
        const index = chunk.start + localIndex;
        const details = Array.isArray(item.details)
          ? item.details.map((detail) => String(detail || '').trim()).filter(Boolean)
          : [];
        const alt = index % 2 === 0;
        return (
          <tbody key={index} data-item-group={index}>
            <tr className={`a4-item-main${alt ? ' a4-item-alt' : ''}`}>
              <td className={`a4-item-cell${details.length ? ' has-details' : ''}`}>
                <div className="a4-item-name">{item.description || '—'}</div>
              </td>
              <td className="a4-num">{money(item.price, doc.currency)}</td>
              <td className="a4-num">{Number(item.qty) || 0}</td>
              <td className="a4-num">
                {money(lineTotalOf(item), doc.currency)}
              </td>
            </tr>
            {details.length > 0 && (
              <tr className="a4-item-detail-row">
                <td colSpan={4}>
                  <div className="a4-item-details">
                    <div className="a4-detail-head">
                      <span className="a4-detail-label">Details</span>
                      <span className="a4-detail-rule" aria-hidden />
                    </div>
                    <ul className={details.length > 4 ? 'is-columns' : ''}>
                      {details.map((detail, detailIndex) => (
                        <li key={detailIndex}>
                          <span className="a4-detail-mark" aria-hidden>
                            <span />
                          </span>
                          <span>{detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        );
      })}
    </table>
  );

  const renderTotals = () => (
    <div className="a4-totals-wrap">
      <div className="a4-totals">
        <div className="a4-row">
          <span className="a4-lbl">Subtotal{taxPct > 0 ? ' (incl. VAT)' : ''}</span>
          <span className="a4-val">{money(subtotal, doc.currency)}</span>
        </div>
        {discountPct > 0 && (
          <div className="a4-row">
            <span className="a4-lbl">Discount ({discountPct}%)</span>
            <span className="a4-val">−{money(discountAmount, doc.currency)}</span>
          </div>
        )}
        {taxPct > 0 && (
          <>
            <div className="a4-row a4-info">
              <span className="a4-lbl">Net of VAT</span>
              <span className="a4-val">{money(netOfTax, doc.currency)}</span>
            </div>
            <div className="a4-row a4-info">
              <span className="a4-lbl">VAT ({taxPct}%) included</span>
              <span className="a4-val">{money(taxAmount, doc.currency)}</span>
            </div>
          </>
        )}
        <div className="a4-row a4-grand">
          <span className="a4-lbl">Total</span>
          <span className="a4-val">{money(total, doc.currency)}</span>
        </div>
        {amountPaid > 0 && (
          <>
            <div className="a4-row a4-paid-row">
              <span className="a4-lbl">Amount Paid</span>
              <span className="a4-val">−{money(amountPaid, doc.currency)}</span>
            </div>
            <div className="a4-row a4-balance">
              <span className="a4-lbl">Balance Due</span>
              <span className="a4-val">{money(balance, doc.currency)}</span>
            </div>
            {cashTendered > 0 && (
              <div className="a4-row a4-cash-row">
                <span className="a4-lbl">Cash Tendered</span>
                <span className="a4-val">{money(cashTendered, doc.currency)}</span>
              </div>
            )}
            {cashChange > 0 && (
              <div className="a4-row a4-cash-row">
                <span className="a4-lbl">Change</span>
                <span className="a4-val">{money(cashChange, doc.currency)}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  const renderNotes = () =>
    doc.notes ? (
      <div className="a4-notes-block">
        <div className="a4-meta-label">Payment Information</div>
        <p>{doc.notes}</p>
      </div>
    ) : null;

  const renderFooter = (page: number, pages: number) => (
    <footer className="a4-sheet-footer">
      <div className="a4-page-marker">
        Page {page} of {pages}
      </div>
      <div className="a4-thanks">THANKS FOR YOUR PURCHASE</div>
      <div className="a4-terms-note">Terms &amp; conditions</div>
      {company.terms_text && <p className="a4-terms-text">{company.terms_text}</p>}
      {company.tagline && <div className="a4-tagline">{company.tagline}</div>}
      <div className={`a4-footer-band ${legacy ? 'a4-legacy-band' : ''}`}>
        {doc.verifyCode && (
          <div className="a4-band-verify">
            <span className="a4-band-verify-line">
              <span className="a4-band-verify-label">Document ID</span>
              <span className="a4-band-verify-code">{doc.verifyCode}</span>
            </span>
            <span className="a4-band-verify-url">preyone.com/verify</span>
          </div>
        )}
        {bandAddress.length > 0 && (
          <div className="a4-band-col a4-band-address">
            {bandAddress.map((line, lineIndex) => (
              <span key={lineIndex}>{line}</span>
            ))}
          </div>
        )}
        {(bandAddress.length > 0 || hasContact) && <div className="a4-band-divider" />}
        {hasContact && (
          <div className="a4-band-col a4-band-contact">
            {contactLine && <span>{contactLine}</span>}
            {company.email && <span className="a4-email">{company.email}</span>}
            {company.website && <span>{company.website}</span>}
          </div>
        )}
      </div>
    </footer>
  );

  return (
    <div
      id={id}
      className={`a4-doc ${templateClass(template)} ${printRoot ? 'a4-print' : ''} ${className}`.trim()}
      style={templateVars(template)}
    >
      {renderedChunks.map((chunk, index) => {
        const first = index === 0;
        const last = index === totalPages - 1;
        return (
          <div
            className="a4-sheet"
            data-page={index + 1}
            data-pages={totalPages}
            key={index}
            ref={first ? sheetRef : undefined}
          >
            {first && paid && <img src="/brand/PAID.svg" alt="PAID" className="a4-stamp" />}
            {/* Shown on every finished sheet only while the tenant's plan is
                expired/suspended. Driven by a root data attribute so the PDF
                and print clones inherit it automatically. */}
            <div className="a4-plan-watermark" aria-hidden="true">
              <span>Unlimited Plan reached</span>
              <small>Renew your Preyone plan to remove this notice</small>
            </div>
            {renderHeader()}
            {first && renderMeta()}
            {renderItems(chunk)}
            {last ? (
              <div className="a4-close-block">
                {renderTotals()}
                {renderNotes()}
                {renderFooter(index + 1, totalPages)}
              </div>
            ) : (
              renderFooter(index + 1, totalPages)
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── picker thumbnails ──────────────────────────────────────────────── */

export function TemplateThumb({ template }: { template: InvoiceTemplate }) {
  const legacy = isLegacyTemplate(template);
  return (
    <div
      className={`a4-thumb ${templateClass(template)} ${legacy ? 'legacy' : ''}`}
      style={templateVars(template)}
      aria-hidden="true"
    >
      <div className="a4-thumb-sheet">
        <div className="a4-thumb-head">
          <i className="a4-thumb-logo" />
          <i className="a4-thumb-word" />
        </div>
        <div className="a4-thumb-meta">
          <i />
          <i />
        </div>
        <div className="a4-thumb-band" />
        <div className="a4-thumb-row" />
        <div className="a4-thumb-row alt" />
        <div className="a4-thumb-row" />
        <div className="a4-thumb-total" />
        <div className="a4-thumb-foot" />
      </div>
    </div>
  );
}

export default DocumentSheet;
