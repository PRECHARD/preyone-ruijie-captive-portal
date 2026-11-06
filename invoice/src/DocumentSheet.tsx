import type { CSSProperties } from 'react';
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
 *   gradient item table with zebra fillers
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
}

export interface SheetItem {
  description: string;
  qty: number | string;
  price: number | string;
  line_total?: number | string;
}

export interface SheetDoc {
  docType: string;
  number: string;
  status: string;
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

export function templateVars(template?: InvoiceTemplate | null): CSSProperties {
  const accent = template?.accentColor || '#7a0e57';
  const legacy = isLegacyTemplate(template);
  const grad = legacy ? LEGACY_GRADIENT : gradientFromAccent(accent);
  return {
    '--doc-grad': grad,
    '--doc-row-tint': `linear-gradient(rgba(255, 255, 255, .57), rgba(255, 255, 255, .57)), ${grad}`,
    '--doc-accent': legacy ? '#36116a' : `color-mix(in srgb, ${accent} 72%, #14002e)`,
    '--doc-thanks': legacy ? '#122b70' : `color-mix(in srgb, ${accent} 55%, #14002e)`,
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

/* ── filler-row maths (ported from the old docLayout.js) ────────────── */

const INNER_MM = 272;
const HEAD_MM = 16;
const META_GAP_MM = 10;
const TABLE_GAP_MM = 9;
const HEADER_ROW_MM = 11.2;
const ROW_MM = 9.6;
const TOTALS_GAP_MM = 7;
const NOTES_GAP_MM = 8;
const FOOTER_MM = 64.8;
const TOTALS_BASE_MM = 31.5;
const PAYED_MM = 20.9;
const NOTES_ROW_MM = 9.4;
const MIN_TOTAL_ROWS = 6;

function metaLines(doc: SheetDoc): number {
  const addr = String(doc.customerAddress || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;
  const extras = [doc.customerEmail, doc.customerPhone].filter((x) => String(x || '').trim()).length;
  return 1 + addr + extras;
}

function fillerRows(doc: SheetDoc, itemCount: number): number {
  const amountPaid = Number(doc.amountPaid) || 0;
  const meta = 4.8 + metaLines(doc) * 5.1;
  const totals =
    TOTALS_BASE_MM +
    (Number(doc.discountPct) > 0 ? 8.7 : 0) +
    (amountPaid > 0 ? PAYED_MM : 0);
  const notes = doc.notes
    ? NOTES_ROW_MM + Math.max(0, String(doc.notes).split(/\r?\n/).filter((l) => l.trim()).length - 1) * 4.6
    : 0;
  const used =
    HEAD_MM +
    META_GAP_MM + meta +
    TABLE_GAP_MM + HEADER_ROW_MM +
    TOTALS_GAP_MM + totals +
    (notes ? NOTES_GAP_MM + notes : 0) +
    FOOTER_MM;
  const availRows = Math.floor((INNER_MM - used) / ROW_MM);
  const maxByDesign = Math.max(0, MIN_TOTAL_ROWS - itemCount);
  return Math.max(0, Math.min(maxByDesign, availRows - itemCount));
}

/* ── component ──────────────────────────────────────────────────────── */

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
  const subtotal =
    Number.isFinite(doc.subtotal) ? doc.subtotal : items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
  const discountPct = Number(doc.discountPct) || 0;
  const taxPct = Number(doc.taxPct) || 0;
  const discountAmount = (subtotal * discountPct) / 100;
  const net = subtotal - discountAmount;
  const taxAmount = taxPct > 0 ? (net * taxPct) / (100 + taxPct) : 0;
  const total = Number.isFinite(doc.total) ? doc.total : net;
  const amountPaid = Number(doc.amountPaid) || 0;
  const balance = Math.max(total - amountPaid, 0);
  const paid = doc.status === 'paid' || (total > 0 && amountPaid >= total - 0.005);
  const fillers = fillerRows(doc, items.length);

  const addressLines = String(company.address || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const bandAddress = [company.name, ...addressLines].filter(Boolean) as string[];
  const hasContact = Boolean(company.support_phone || company.email || company.website);
  const contactLine = [company.support_phone].filter(Boolean).join('  |  ');

  const logo =
    company.logo_url || (company.logo_path ? `/images/${company.logo_path}` : null) || '/brand/Preyone.svg';
  const showLogo = template?.showLogo !== false;
  const legacy = isLegacyTemplate(template);
  const docLabel = quote ? 'Quotation' : 'Invoice';

  const customerLines = [doc.customerAddress, doc.customerEmail, doc.customerPhone]
    .filter((v) => String(v || '').trim())
    .join('\n');

  return (
    <div
      id={id}
      className={`a4-doc ${templateClass(template)} ${printRoot ? 'a4-print' : ''} ${className}`.trim()}
      style={templateVars(template)}
    >
      <div className="a4-sheet" data-type={doc.docType}>
        {paid && <img src="/brand/PAID.svg" alt="PAID" className="a4-stamp" />}

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
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td>{it.description || '—'}</td>
                <td className="a4-num">{money(it.price, doc.currency)}</td>
                <td className="a4-num">{Number(it.qty) || 0}</td>
                <td className="a4-num">
                  {money(it.line_total ?? (Number(it.price) || 0) * (Number(it.qty) || 0), doc.currency)}
                </td>
              </tr>
            ))}
            {Array.from({ length: fillers }, (_, i) => (
              <tr className="a4-filler" key={`filler-${i}`}>
                <td>&nbsp;</td>
                <td className="a4-num">&nbsp;</td>
                <td className="a4-num">&nbsp;</td>
                <td className="a4-num">&nbsp;</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="a4-totals-wrap">
          <div className="a4-totals">
            <div className="a4-row">
              <span className="a4-lbl">Subtotal</span>
              <span className="a4-val">{money(subtotal, doc.currency)}</span>
            </div>
            {discountPct > 0 && (
              <div className="a4-row">
                <span className="a4-lbl">Discount ({discountPct}%)</span>
                <span className="a4-val">−{money(discountAmount, doc.currency)}</span>
              </div>
            )}
            {taxPct > 0 && (
              <div className="a4-row">
                <span className="a4-lbl">VAT ({taxPct}%) Incl.</span>
                <span className="a4-val">{money(taxAmount, doc.currency)}</span>
              </div>
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
              </>
            )}
          </div>
        </div>

        {doc.notes && (
          <div className="a4-notes-block">
            <div className="a4-meta-label">Payment Information</div>
            <p>{doc.notes}</p>
          </div>
        )}

        <footer className="a4-sheet-footer">
          <div className="a4-thanks">THANKS FOR YOUR PURCHASE</div>
          <div className="a4-terms-note">Terms &amp; conditions</div>
          {company.terms_text && <p className="a4-terms-text">{company.terms_text}</p>}
          {company.tagline && <div className="a4-tagline">{company.tagline}</div>}
          <div className={`a4-footer-band ${legacy ? 'a4-legacy-band' : ''}`}>
            {bandAddress.length > 0 && (
              <div className="a4-band-col a4-band-address">
                {bandAddress.map((line, i) => (
                  <span key={i}>{line}</span>
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
      </div>
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
