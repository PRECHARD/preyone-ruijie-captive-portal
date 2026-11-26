/**
 * Dependency-free PDF receipt for a Preyone subscription payment.
 *
 * The server has no PDF library (browser-generated invoices are uploaded as
 * base64), but successful payments must be emailed with an invoice attached.
 * This writes a compact A4 PDF using Helvetica base-14 fonts, so it works on
 * the VPS without adding a native or headless-browser dependency.
 */

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

function date(value: Date): string {
  return ascii(
    new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  );
}

function money(amount: number, currency: string): string {
  return ascii(`${currency} ${Number(amount).toFixed(2)}`);
}

export function buildSubscriptionInvoicePdf(input: SubscriptionInvoicePdfInput): Buffer {
  const commands: string[] = [];
  const text = (x: number, y: number, size: number, font: 'F1' | 'F2', value: unknown, rgb = '0.06 0.12 0.10') =>
    commands.push(`BT ${rgb} rg /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${esc(value)}) Tj ET`);
  const rect = (x: number, y: number, w: number, h: number, rgb: string) =>
    commands.push(`${rgb} rg ${x} ${y} ${w} ${h} re f`);
  const rule = (y: number) => commands.push(`0.79 0.87 0.83 RG 0.7 w 42 ${y} m 553 ${y} l S`);

  // Emerald masthead.
  rect(0, 772, 595, 70, '0.02 0.36 0.26');
  text(42, 812, 22, 'F2', 'PREYONE', '1 1 1');
  text(42, 792, 9, 'F1', 'ENTERPRISES  |  INVOICE & POS', '0.75 0.95 0.86');
  text(553, 812, 16, 'F2', 'TAX INVOICE', '1 1 1');
  text(553, 794, 9, 'F1', esc(input.invoiceNumber), '0.75 0.95 0.86');

  text(42, 735, 11, 'F2', 'BILL TO');
  text(42, 717, 12, 'F2', input.companyName);
  text(42, 701, 10, 'F1', `Account no: ${input.accountNumber}`);
  if (input.billingName) text(42, 685, 10, 'F1', `Attention: ${input.billingName}`);
  if (input.billingEmail) text(42, 669, 10, 'F1', `Email: ${input.billingEmail}`);
  if (input.billingPhone) text(42, 653, 10, 'F1', `Phone: ${input.billingPhone}`);

  const right = (y: number, label: string, value: unknown) => {
    text(400, y, 9, 'F1', label, '0.35 0.45 0.41');
    text(553, y, 10, 'F2', value);
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

  text(50, 563, 11, 'F2', `${input.planName} subscription plan`);
  text(50, 547, 9, 'F1', `Access renewed for 30 days - up to ${input.devices} device(s)`);
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
  text(42, 415, 11, 'F2', 'PAYMENT DETAILS');
  const detail = (y: number, label: string, value: unknown) => {
    text(42, y, 10, 'F1', label, '0.35 0.45 0.41');
    text(220, y, 10, 'F2', value);
  };
  detail(397, 'Payment reference', input.reference);
  detail(381, 'Payment method', input.paymentMethod);
  detail(365, 'Access until', date(input.expiresAt));
  detail(349, 'Account number', input.accountNumber);

  rect(42, 100, 511, 62, '0.94 0.98 0.96');
  text(54, 143, 10, 'F2', 'Preyone Enterprises', '0.02 0.36 0.26');
  text(54, 126, 9, 'F1', 'Harare, Zimbabwe  |  support@preyone.com  |  +263 771 327 202');
  text(54, 111, 9, 'F1', 'This document is a computer-generated proof of payment and subscription invoice.');

  const stream = commands.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
