/**
 * Dependency-free PDF invoice for a Preyone subscription payment.
 *
 * Uses Helvetica base-14 fonts plus one embedded JPEG of the house voucher
 * logo, so the VPS needs no headless browser or PDF package. The layout is the
 * Preyone executive paper invoice: crisp white, emerald structure, right-ruled
 * numeric columns, and the same angled PAID stamp geometry as the standard A4
 * invoice. No PDF objects are added, so existing parsers and tests stay valid.
 */

import fs from 'fs';
import path from 'path';

export interface SubscriptionInvoicePdfInput {
  invoiceNumber: string;
  issuedAt: Date;
  companyName: string;
  accountNumber: string;
  billingName?: string | null;
  billingEmail?: string | null;
  billingPhone?: string | null;
  planName: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  reference: string;
  expiresAt: Date;
  devices: number;
}

/** Base-14 Helvetica is WinAnsi; drop anything it cannot draw. */
function ascii(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7E]/g, '?');
}

function esc(value: unknown): string {
  return ascii(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Adobe core-14 advance widths (1/1000 em), ASCII 32..126. Digits are all
// 556 in both faces, which gives us the same tabular-numeral behaviour the
// browser gets from `font-variant-numeric: tabular-nums`.
const REGULAR_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

function measure(value: unknown, size: number, font: 'F1' | 'F2'): number {
  const widths = font === 'F2' ? BOLD_WIDTHS : REGULAR_WIDTHS;
  let units = 0;
  for (const char of ascii(value)) {
    const index = char.charCodeAt(0) - 32;
    units += index >= 0 && index < widths.length ? widths[index] : 556;
  }
  return (units * size) / 1000;
}

/**
 * Wrap on words/hyphens instead of slicing at a fixed character count. This is
 * what keeps `up to 9999 devices` and long Pesepay references intact.
 */
function wrap(value: unknown, maxWidth: number, size: number, font: 'F1' | 'F2'): string[] {
  const words = ascii(value).trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  const flush = () => {
    if (line) lines.push(line);
    line = '';
  };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, size, font) <= maxWidth) {
      line = candidate;
      continue;
    }
    flush();
    // Hyphenated identifiers (PINV-..., PREYONE-SUB-...) must break at a
    // hyphen, never in the middle of a word or reference segment.
    const parts = word.match(/[^-\s]+-|[^-\s]+$/g) || [word];
    let partLine = '';
    for (const part of parts) {
      const joined = partLine ? `${partLine}${part}` : part;
      if (measure(joined, size, font) <= maxWidth) {
        partLine = joined;
        continue;
      }
      if (partLine) {
        lines.push(partLine);
        partLine = '';
      }
      if (measure(part, size, font) <= maxWidth) {
        partLine = part;
        continue;
      }
      // Last resort for an unbreakable token: hard wrap only to stay on-page.
      let chunk = '';
      for (const char of part) {
        if (chunk && measure(chunk + char, size, font) > maxWidth) {
          lines.push(chunk);
          chunk = '';
        }
        chunk += char;
      }
      partLine = chunk;
    }
    line = partLine;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function date(value: Date): string {
  return ascii(
    new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  );
}

function money(amount: number, currency: string): string {
  return ascii(`${currency} ${Number(amount).toFixed(2)}`);
}

function loadLogo(): Buffer | null {
  try {
    const file = path.join(__dirname, '..', '..', 'public', 'images', 'preyone-techy-voucher-invoice.jpg');
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}

export function buildSubscriptionInvoicePdf(input: SubscriptionInvoicePdfInput): Buffer {
  const commands: string[] = [];

  // #ECFDF5 mint, #D1FAE5 hairline, #059669 emerald, #047857 deep emerald.
  const C = {
    white: '1 1 1',
    ink: '0.06 0.12 0.10',
    muted: '0.29 0.40 0.35',
    emerald: '0.0196 0.5882 0.4118',
    deep: '0.0157 0.4706 0.3412',
    deepSoft: '0.02 0.36 0.26',
    mint: '0.9255 0.9922 0.9608',
    line: '0.8196 0.9804 0.8980',
  };

  const text = (
    x: number,
    y: number,
    size: number,
    font: 'F1' | 'F2',
    value: unknown,
    rgb = C.ink
  ) => commands.push(`BT ${rgb} rg /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${esc(value)}) Tj ET`);

  /** Right edge is fixed, so every figure lines up with the AMOUNT column. */
  const rightText = (
    rightX: number,
    y: number,
    size: number,
    font: 'F1' | 'F2',
    value: unknown,
    rgb = C.ink
  ) => text(rightX - measure(value, size, font), y, size, font, value, rgb);

  const centerText = (
    centerX: number,
    y: number,
    size: number,
    font: 'F1' | 'F2',
    value: unknown,
    rgb = C.ink
  ) => text(centerX - measure(value, size, font) / 2, y, size, font, value, rgb);

  const rect = (x: number, y: number, w: number, h: number, rgb: string) =>
    commands.push(`${rgb} rg ${x} ${y} ${w} ${h} re f`);

  const outline = (x: number, y: number, w: number, h: number, rgb: string, width = 0.7) =>
    commands.push(`${rgb} RG ${width} w ${x} ${y} ${w} ${h} re S`);

  const rule = (y: number) => commands.push(`${C.line} RG 0.7 w 42 ${y} m 553 ${y} l S`);

  const lines = (
    entries: string[],
    x: number,
    startY: number,
    size: number,
    font: 'F1' | 'F2',
    rgb = C.ink,
    gap = 14
  ) => {
    entries.forEach((entry, index) => text(x, startY - index * gap, size, font, entry, rgb));
    return startY - entries.length * gap;
  };

  // Executive header: emerald gradient hairline, house logo, sharp PAID badge.
  const stops: Array<[number, number, number]> = [
    [0.02, 0.36, 0.26],
    [0.02, 0.47, 0.34],
    [0.02, 0.59, 0.42],
    [0.05, 0.52, 0.40],
    [0.02, 0.36, 0.26],
  ];
  const bandY = 826;
  const bandH = 16;
  const strip = 595 / stops.length;
  stops.forEach((rgb, i) => rect(i * strip, bandY, strip + 0.6, bandH, rgb.join(' ')));

  const logo = loadLogo();
  const logoW = 66;
  const logoH = 37;
  if (logo) commands.push(`q ${logoW} 0 0 ${logoH} 42 778 cm /Im1 Do Q`);

  text(118, 800, 19, 'F2', 'PREYONE', C.deepSoft);
  text(118, 784, 8, 'F1', 'ENTERPRISES  |  INVOICE & POS', C.muted);
  rightText(553, 800, 15, 'F2', 'TAX INVOICE', C.deepSoft);
  rightText(553, 784, 9, 'F1', input.invoiceNumber, C.muted);
  commands.push(`${C.emerald} RG 1.4 w 42 770 m 553 770 l S`);

  // Balanced BILL TO / INVOICE METADATA cards.
  rect(42, 625, 255, 125, C.mint);
  outline(42, 625, 255, 125, C.line);
  rect(307, 625, 246, 125, C.mint);
  outline(307, 625, 246, 125, C.line);

  text(52, 732, 9, 'F2', 'BILL TO', C.emerald);
  let billY = lines(wrap(input.companyName, 230, 11, 'F2'), 52, 713, 11, 'F2', C.ink, 14);
  billY = lines([`Account no: ${input.accountNumber}`], 52, billY - 2, 9, 'F1', C.ink, 14);
  if (input.billingName) {
    billY = lines(wrap(`Attention: ${input.billingName}`, 230, 9, 'F1'), 52, billY - 2, 9, 'F1', C.ink, 13);
  }
  if (input.billingEmail) {
    billY = lines(wrap(`Email: ${input.billingEmail}`, 230, 8.5, 'F1'), 52, billY - 2, 8.5, 'F1', C.ink, 13);
  }
  if (input.billingPhone) {
    lines(wrap(`Phone: ${input.billingPhone}`, 230, 9, 'F1'), 52, billY - 2, 9, 'F1', C.ink, 13);
  }

  text(317, 732, 9, 'F2', 'INVOICE METADATA', C.emerald);
  text(317, 713, 9, 'F1', 'ISSUED', C.muted);
  rightText(543, 713, 9.5, 'F2', date(input.issuedAt));
  text(317, 694, 9, 'F1', 'STATUS', C.muted);
  rect(470, 687, 73, 18, C.mint);
  outline(470, 687, 73, 18, C.emerald, 1);
  centerText(506.5, 692, 9, 'F2', 'PAID', C.deep);
  text(317, 671, 9, 'F1', 'REFERENCE', C.muted);
  lines(wrap(input.reference, 136, 8.5, 'F1'), 407, 671, 8.5, 'F1', C.ink, 13);
  text(317, 638, 9, 'F1', 'METHOD', C.muted);
  rightText(543, 638, 8.5, 'F2', input.paymentMethod);

  // Tabular line-item table. Every numeric header and figure shares a right
  // edge with the TOTAL PAID amount below.
  rect(42, 585, 511, 26, C.mint);
  outline(42, 585, 511, 26, C.line);
  text(52, 595, 9, 'F2', 'DESCRIPTION', C.deep);
  rightText(372, 595, 9, 'F2', 'QTY', C.deep);
  rightText(470, 595, 9, 'F2', 'UNIT PRICE', C.deep);
  rightText(543, 595, 9, 'F2', 'AMOUNT', C.deep);

  lines(wrap(`${input.planName} subscription plan`, 285, 11, 'F2'), 52, 563, 11, 'F2', C.ink, 15);
  lines(
    wrap(`Access renewed for 30 days - up to ${input.devices} devices`, 285, 9, 'F1'),
    52,
    547,
    9,
    'F1',
    C.muted,
    13
  );
  rightText(372, 563, 10, 'F1', '1');
  rightText(470, 563, 10, 'F1', money(input.amount, input.currency));
  rightText(543, 563, 11, 'F2', money(input.amount, input.currency));
  rule(525);

  rightText(470, 503, 10, 'F1', 'Subtotal', C.muted);
  rightText(543, 503, 10, 'F1', money(input.amount, input.currency));
  rect(42, 452, 511, 36, C.deep);
  text(52, 466, 11, 'F2', 'TOTAL PAID (USD)', C.white);
  rightText(543, 466, 13, 'F2', money(input.amount, input.currency), C.white);

  // Angled PAID stamp. `invoice/public/brand/PAID.svg` (the standard A4 stamp)
  // uses a 15.87-degree banner at 17% opacity. PDF content is non-interactive
  // (the equivalent of pointer-events:none); the pale red is pre-blended and
  // drawn *before* the detail text so every figure underneath stays legible.
  const stampAngle = (15.87 * Math.PI) / 180;
  const cos = Math.cos(stampAngle).toFixed(4);
  const sin = Math.sin(stampAngle).toFixed(4);
  commands.push(`q ${cos} ${sin} -${sin} ${cos} 300 363 cm`);
  commands.push(`0.98 0.86 0.86 rg -115 -15 230 30 re f`);
  commands.push(`0.86 0.35 0.35 RG 1.1 w -115 -15 230 30 re S`);
  centerText(0, -14, 40, 'F2', 'PAID', '0.72 0.14 0.14');
  commands.push('Q');

  rule(435);
  rect(42, 300, 511, 125, C.white);
  outline(42, 300, 511, 125, C.line);
  commands.push(`${C.line} RG 0.6 w 302 310 m 302 415 l S`);
  commands.push(`${C.line} RG 0.6 w 52 360 m 543 360 l S`);

  text(52, 415, 11, 'F2', 'PAYMENT DETAILS', C.deep);
  text(52, 394, 9, 'F1', 'Payment Reference', C.muted);
  lines(wrap(input.reference, 235, 9, 'F2'), 52, 379, 9, 'F2', C.ink, 13);
  text(317, 394, 9, 'F1', 'Payment Method', C.muted);
  lines(wrap(input.paymentMethod, 220, 9, 'F2'), 317, 379, 9, 'F2', C.ink, 13);
  text(52, 348, 9, 'F1', 'Access Valid Until', C.muted);
  text(52, 333, 9.5, 'F2', date(input.expiresAt));
  text(317, 348, 9, 'F1', 'Account Number', C.muted);
  text(317, 333, 9.5, 'F2', input.accountNumber);

  rect(42, 100, 511, 62, C.mint);
  outline(42, 100, 511, 62, C.line);
  rect(42, 161, 511, 2, C.emerald);
  text(54, 143, 10, 'F2', 'Preyone Enterprises', C.deep);
  text(54, 126, 9, 'F1', 'Harare, Zimbabwe  |  support@preyone.com  |  +263 771 327 202', C.ink);
  text(54, 111, 8.5, 'F1', 'Computer-generated proof of payment and subscription invoice.', C.muted);

  const stream = commands.join('\n');
  const xobjects = logo ? ' /XObject << /Im1 7 0 R >>' : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /ProcSet [/PDF /Text /ImageC] /Resources << /Font << /F1 5 0 R /F2 6 0 R >>${xobjects} >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  if (logo) {
    const [w, h] = [300, 169];
    objects.push(
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.length} >>\nstream\n`
    );
  }

  // Assemble as buffers so the embedded JPEG keeps its exact bytes and every
  // xref offset still points at the start of its object.
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const append = (value: string | Buffer, recordOffset: boolean) => {
    const buf = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
    if (recordOffset) offsets.push(length);
    chunks.push(buf);
    length += buf.length;
  };

  append('%PDF-1.4\n', false);
  objects.forEach((body, index) => {
    if (index === 6 && logo) {
      append(`7 0 obj\n${body}`, true);
      append(logo, false);
      append('\nendstream\nendobj\n', false);
      return;
    }
    append(`${index + 1} 0 obj\n${body}\nendobj\n`, true);
  });

  const xrefStart = length;
  append(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, false);
  for (const offset of offsets) append(`${String(offset).padStart(10, '0')} 00000 n \n`, false);
  append(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`, false);
  return Buffer.concat(chunks);
}
