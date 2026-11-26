/**
 * Dependency-free PDF invoice for a Preyone subscription payment.
 *
 * Uses Helvetica base-14 fonts plus one embedded JPEG of the house voucher
 * logo, so the VPS needs no headless browser or PDF package. The layout is the
 * Preyone "classic" paper invoice with an emerald-to-cyan gradient hairline —
 * no solid green masthead, no clipped columns.
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

/** Keep text inside its column — the main cause of "cut off" PDFs. */
function fit(value: unknown, maxChars: number): string {
  const text = String(value ?? '');
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}.`;
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
  const text = (
    x: number,
    y: number,
    size: number,
    font: 'F1' | 'F2',
    value: unknown,
    rgb = '0.06 0.12 0.10'
  ) => commands.push(`BT ${rgb} rg /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${esc(value)}) Tj ET`);
  const rect = (x: number, y: number, w: number, h: number, rgb: string) =>
    commands.push(`${rgb} rg ${x} ${y} ${w} ${h} re f`);
  const rule = (y: number) => commands.push('0.79 0.87 0.83 RG 0.7 w 42 ' + y + ' m 553 ' + y + ' l S');

  // Classic paper header with a fine emerald-to-cyan gradient band.
  const stops: Array<[number, number, number]> = [
    [0.02, 0.36, 0.26],
    [0.04, 0.52, 0.42],
    [0.02, 0.62, 0.58],
    [0.05, 0.65, 0.82],
    [0.12, 0.45, 0.86],
  ];
  const bandY = 826;
  const bandH = 16;
  const strip = 595 / stops.length;
  stops.forEach((rgb, i) => rect(i * strip, bandY, strip + 0.6, bandH, rgb.join(' ')));

  const logo = loadLogo();
  const logoW = 66;
  const logoH = 37;
  if (logo) commands.push(`q ${logoW} 0 0 ${logoH} 42 778 cm /Im1 Do Q`);

  text(118, 800, 19, 'F2', 'PREYONE', '0.06 0.22 0.17');
  text(118, 784, 8, 'F1', 'ENTERPRISES  |  INVOICE & POS', '0.36 0.48 0.43');
  text(553, 800, 15, 'F2', 'TAX INVOICE', '0.06 0.22 0.17');
  text(553, 784, 9, 'F1', fit(input.invoiceNumber, 22), '0.36 0.48 0.43');
  commands.push('0.05 0.52 0.38 RG 1.4 w 42 770 m 553 770 l S');

  text(42, 735, 11, 'F2', 'BILL TO', '0.06 0.22 0.17');
  text(42, 717, 12, 'F2', fit(input.companyName, 46));
  text(42, 701, 10, 'F1', `Account no: ${fit(input.accountNumber, 34)}`);
  if (input.billingName) text(42, 685, 10, 'F1', `Attention: ${fit(input.billingName, 38)}`);
  if (input.billingEmail) text(42, 669, 10, 'F1', `Email: ${fit(input.billingEmail, 40)}`);
  if (input.billingPhone) text(42, 653, 10, 'F1', `Phone: ${fit(input.billingPhone, 28)}`);

  const right = (y: number, label: string, value: unknown) => {
    text(400, y, 9, 'F1', label, '0.35 0.45 0.41');
    text(553, y, 10, 'F2', fit(value, 22));
  };
  right(735, 'ISSUED', date(input.issuedAt));
  right(717, 'STATUS', 'PAID');
  right(699, 'REFERENCE', input.reference);
  right(681, 'METHOD', input.paymentMethod);

  rect(42, 585, 511, 26, '0.93 0.98 0.95');
  text(50, 595, 9, 'F2', 'DESCRIPTION', '0.05 0.30 0.22');
  text(345, 595, 9, 'F2', 'QTY', '0.05 0.30 0.22');
  text(425, 595, 9, 'F2', 'UNIT PRICE', '0.05 0.30 0.22');
  text(553, 595, 9, 'F2', 'AMOUNT', '0.05 0.30 0.22');

  text(50, 563, 11, 'F2', fit(`${input.planName} subscription plan`, 42));
  text(50, 547, 9, 'F1', fit(`Access renewed for 30 days - up to ${input.devices} device(s)`, 46));
  text(345, 563, 10, 'F1', '1');
  text(425, 563, 10, 'F1', money(input.amount, input.currency));
  text(553, 563, 11, 'F2', money(input.amount, input.currency));
  rule(525);

  text(430, 503, 10, 'F1', 'Subtotal');
  text(553, 503, 10, 'F1', money(input.amount, input.currency));
  text(430, 480, 11, 'F2', 'TOTAL PAID');
  rect(405, 462, 148, 30, '0.02 0.36 0.26');
  text(415, 472, 13, 'F2', money(input.amount, input.currency), '1 1 1');

  rule(435);
  text(42, 415, 11, 'F2', 'PAYMENT DETAILS', '0.06 0.22 0.17');
  const detail = (y: number, label: string, value: unknown) => {
    text(42, y, 10, 'F1', label, '0.35 0.45 0.41');
    text(220, y, 10, 'F2', fit(value, 50));
  };
  detail(397, 'Payment reference', input.reference);
  detail(381, 'Payment method', input.paymentMethod);
  detail(365, 'Access until', date(input.expiresAt));
  detail(349, 'Account number', input.accountNumber);

  rect(42, 100, 511, 62, '0.94 0.98 0.96');
  text(54, 143, 10, 'F2', 'Preyone Enterprises', '0.02 0.36 0.26');
  text(54, 126, 9, 'F1', 'Harare, Zimbabwe  |  support@preyone.com  |  +263 771 327 202');
  text(54, 111, 9, 'F1', 'Computer-generated proof of payment and subscription invoice.');

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
