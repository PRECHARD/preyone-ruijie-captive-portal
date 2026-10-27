import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { pool } from '../db/pool';

/**
 * Reporting engine shared by the Month-End / Staff reports, the scheduler and
 * the on-demand exports.
 *
 * The column contract is the one the My Sales "Export Excel" uses, extended to
 * the full auditing set an accountant needs:
 *
 *   Timestamp · Voucher Code · Package Tier · Amount (USD/ZiG) ·
 *   Payment Rail · Staff / Sold By · Status
 *
 * Everything here is read-only: no route in this module writes to `sales`,
 * `vouchers`, `cash_handovers` or `staff_commissions`, so it cannot disturb the
 * live payment/session paths.
 */

export interface ReportColumn {
  header: string;
  width: number;
}

/** Exact column set required by the Month-End and Staff commission reports. */
export const SALES_REPORT_COLUMNS: ReportColumn[] = [
  { header: 'Timestamp', width: 22 },
  { header: 'Voucher Code', width: 20 },
  { header: 'Package Tier', width: 22 },
  { header: 'Amount (USD/ZiG)', width: 18 },
  { header: 'Payment Rail', width: 18 },
  { header: 'Staff / Sold By', width: 26 },
  { header: 'Status', width: 14 },
];

export interface SalesReportRow {
  /** ISO timestamp of the sale. */
  timestamp: string;
  voucherCode: string;
  packageTier: string;
  amount: number;
  currency: string;
  paymentRail: string;
  staffName: string;
  status: string;
  /** Raw sale type — 'new' | 'renewal'. */
  saleType: string;
  /** 'pending' | 'handed_over' — reconciliation input. */
  handoverStatus: string;
}

export interface ReportPeriod {
  /** Inclusive lower bound. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
  /** Human label, e.g. "September 2026". */
  label: string;
}

const BRAND_NAVY = 'FF0F172A';
const BRAND_DEEP = 'FF111C33';
const BRAND_LIGHT = 'FFF3F6FB';
const BRAND_WHITE = 'FFFFFFFF';
const BRAND_RED = 'FFB91C1C';
const BRAND_MUTED = 'FF64748B';

/**
 * Official Preyone logo for the workbook masthead. Resolved at call time (not
 * import time) so a missing asset degrades to a text-only header instead of
 * breaking report generation.
 */
const LOGO_CANDIDATES = [
  'staff-excel-preyonelogo.png',
  'preyonelogomainzw-email.png',
  'preyonelogomainzw.png',
];

function resolveBrandLogo(): string | null {
  const dir = path.join(__dirname, '..', '..', 'public', 'images');
  for (const name of LOGO_CANDIDATES) {
    const file = path.join(dir, name);
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      /* unreadable directory - keep trying */
    }
  }
  return null;
}

/** Whole previous calendar month in UTC (the scheduler's default window). */
export function previousMonthPeriod(now: Date = new Date()): ReportPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const label = start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { from: start, to: end, label };
}

/** Parse `?from=&to=` (ISO dates); defaults to the previous month. */
export function parseReportPeriod(fromRaw?: unknown, toRaw?: unknown, now: Date = new Date()): ReportPeriod {
  const fallback = previousMonthPeriod(now);
  // No explicit window at all: keep the friendly "September 2026" label the
  // scheduler and the email subject use, rather than a range string.
  if (fromRaw == null && toRaw == null) return fallback;
  const from = fromRaw ? new Date(String(fromRaw)) : fallback.from;
  const to = toRaw ? new Date(String(toRaw)) : fallback.to;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return fallback;
  const label = `${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`;
  return { from, to, label };
}

function deriveStatus(row: {
  is_disabled?: boolean | null;
  expires_at?: Date | string | null;
  used_count?: number | null;
  sale_type?: string | null;
  has_voucher?: boolean;
}, now: number = Date.now()): string {
  if (row.has_voucher === false) return 'Deleted';
  if (row.is_disabled) return 'Disabled';
  if (row.sale_type === 'renewal') return 'Renewal';
  const expiry = row.expires_at ? new Date(row.expires_at).getTime() : null;
  if (expiry != null && Number.isFinite(expiry) && expiry <= now) return 'Expired';
  if (Number(row.used_count ?? 0) === 0) return 'Unused';
  return 'Active';
}

const SALES_SQL = `
  SELECT s.sold_at,
         s.voucher_code,
         s.amount,
         s.currency,
         s.payment_method,
         s.sale_type,
         s.handover_status,
         COALESCE(NULLIF(s.sold_by_name, ''), a.full_name, 'Online') AS staff_name,
         v.id IS NOT NULL        AS has_voucher,
         v.package_tier,
         v.is_disabled,
         v.expires_at,
         v.used_count
    FROM sales s
    LEFT JOIN vouchers v ON v.id = s.voucher_id
    LEFT JOIN admin_users a ON a.id = s.sold_by AND a.deleted_at IS NULL
   WHERE s.sold_at >= $1 AND s.sold_at < $2
   ORDER BY s.sold_at ASC`;

/** One row per sale in the period, shaped for the report columns. */
export async function fetchSalesReportRows(period: ReportPeriod): Promise<SalesReportRow[]> {
  const { rows } = await pool.query(SALES_SQL, [period.from, period.to]);
  const now = Date.now();
  return rows.map((r: any) => ({
    timestamp: r.sold_at ? new Date(r.sold_at).toISOString() : '',
    voucherCode: String(r.voucher_code ?? ''),
    packageTier: String(r.package_tier ?? ''),
    amount: r.amount == null ? 0 : Number(r.amount),
    currency: String(r.currency ?? 'USD'),
    paymentRail: String(r.payment_method ?? 'Cash'),
    staffName: String(r.staff_name ?? 'Online'),
    status: deriveStatus(r, now),
    saleType: String(r.sale_type ?? 'new'),
    handoverStatus: String(r.handover_status ?? 'pending'),
  }));
}

function amountCell(row: SalesReportRow): string {
  return `${row.amount.toFixed(2)} ${row.currency}`;
}

/** Map a row onto the column order above (pure, exported for tests). */
export function toReportCells(row: SalesReportRow): (string | number)[] {
  return [
    row.timestamp,
    row.voucherCode,
    row.packageTier,
    amountCell(row),
    row.paymentRail,
    row.staffName,
    row.status,
  ];
}

function money(value: number, currency: string): string {
  return `${Number(value).toFixed(2)} ${currency}`;
}

/**
 * Build the styled workbook shared by every report. Returns an ExcelJS
 * workbook so the HTTP route can stream it and the scheduler can attach the
 * buffer directly.
 */
export function buildSalesWorkbook(opts: {
  sheetName: string;
  rows: SalesReportRow[];
  title: string;
  subtitle?: string | null;
  company?: { name?: string | null; tagline?: string | null; email?: string | null; website?: string | null } | null;
  columns?: ReportColumn[];
  /** Optional second sheet: the staff commission split (Month-End / Staff reports). */
  commissions?: CommissionSheetInput | null;
}): ExcelJS.Workbook {
  const columns = opts.columns ?? SALES_REPORT_COLUMNS;
  const lastCol = String.fromCharCode(64 + columns.length);
  const company = opts.company ?? {};
  const brand = String(company.name || 'Preyone');

  const wb = new ExcelJS.Workbook();
  wb.creator = brand;
  wb.created = new Date();
  const ws = wb.addWorksheet(opts.sheetName.slice(0, 31));
  ws.columns = columns.map((c) => ({ header: c.header, width: c.width, key: undefined }));

  // Hide the auto header row + grid lines behind the masthead block.
  for (let i = 1; i <= columns.length; i++) ws.getRow(1).getCell(i).value = '';
  for (let r = 1; r <= 9; r++) {
    for (let c = 1; c <= columns.length; c++) {
      ws.getRow(r).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_WHITE } };
    }
  }

  // Masthead: official logo on the left, company name beside it (row 1).
  // Resolve + register the logo once: the Commissions sheet reuses the same
  // media id so the emailed workbook carries one copy, not two (~140 KB saved).
  const logoFile = resolveBrandLogo();
  let logoId: number | null = null;
  if (logoFile) {
    try {
      logoId = wb.addImage({ filename: logoFile, extension: 'png' });
      ws.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 168, height: 63 } });
      ws.getRow(1).height = 50;
    } catch {
      /* corrupt/unreadable image - fall back to a text header */
      logoId = null;
    }
  }
  const brandFirstCol = logoId != null && columns.length >= 4 ? 3 : 1;
  const brandCell = `${String.fromCharCode(64 + brandFirstCol)}1`;
  ws.mergeCells(`${brandCell}:${lastCol}1`);
  ws.getCell(brandCell).value = brand;
  ws.getCell(brandCell).font = { name: 'Calibri', size: 20, bold: true, color: { argb: BRAND_NAVY } };
  ws.getCell(brandCell).alignment = { vertical: 'middle', horizontal: 'right' };

  ws.mergeCells(`A2:${lastCol}2`);
  ws.getCell('A2').value = opts.title;
  ws.getCell('A2').font = { name: 'Calibri', size: 14, bold: true, color: { argb: BRAND_DEEP } };

  let r = 3;
  if (opts.subtitle) {
    ws.mergeCells(`A${r}:${lastCol}${r}`);
    ws.getCell(`A${r}`).value = opts.subtitle;
    ws.getCell(`A${r}`).font = { name: 'Calibri', size: 11, color: { argb: BRAND_MUTED } };
    r += 1;
  }

  ws.mergeCells(`A${r}:${lastCol}${r}`);
  ws.getCell(`A${r}`).value = `Generated: ${new Date().toLocaleString()}`;
  ws.getCell(`A${r}`).font = { name: 'Calibri', size: 10, italic: true, color: { argb: BRAND_MUTED } };
  r += 1;

  const contact = [company.email, company.website].filter(Boolean).join('  ·  ');
  if (contact) {
    ws.mergeCells(`A${r}:${lastCol}${r}`);
    ws.getCell(`A${r}`).value = contact;
    ws.getCell(`A${r}`).font = { name: 'Calibri', size: 9, italic: true, color: { argb: BRAND_MUTED } };
    r += 1;
  }

  const headerRowNumber = r + 1;
  const headerRow = ws.getRow(headerRowNumber);
  headerRow.values = columns.map((c) => c.header);
  headerRow.height = 28;
  for (let i = 1; i <= columns.length; i++) {
    const cell = headerRow.getCell(i);
    cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: BRAND_WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_NAVY } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: BRAND_NAVY } },
      bottom: { style: 'medium', color: { argb: BRAND_DEEP } },
      left: { style: 'thin', color: { argb: BRAND_NAVY } },
      right: { style: 'thin', color: { argb: BRAND_NAVY } },
    };
  }
  ws.views = [{ state: 'frozen', ySplit: headerRowNumber }];

  let rowNumber = headerRowNumber + 1;
  for (const row of opts.rows) {
    const dataRow = ws.getRow(rowNumber);
    dataRow.values = toReportCells(row);
    dataRow.height = 20;
    const alt = rowNumber % 2 === 0;
    for (let i = 1; i <= columns.length; i++) {
      const cell = dataRow.getCell(i);
      cell.font = { name: 'Calibri', size: 10, color: { argb: BRAND_NAVY } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
      if (alt) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_LIGHT } };
    }
    dataRow.getCell(2).font = { name: 'Consolas', size: 10, bold: true, color: { argb: BRAND_DEEP } };
    rowNumber += 1;
  }

  // Total row.
  const total = opts.rows.reduce((sum, row) => sum + row.amount, 0);
  const currency = opts.rows[0]?.currency || 'USD';
  const totalRow = ws.getRow(rowNumber);
  totalRow.height = 26;
  for (let i = 1; i <= columns.length; i++) totalRow.getCell(i).value = '';
  totalRow.getCell(2).value = 'TOTAL';
  totalRow.getCell(4).value = money(total, currency);
  for (let i = 1; i <= columns.length; i++) {
    const cell = totalRow.getCell(i);
    cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: BRAND_WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_RED } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  totalRow.getCell(4).font = { name: 'Calibri', size: 14, bold: true, color: { argb: BRAND_WHITE } };

  if (opts.commissions) {
    addCommissionSheet(wb, opts.commissions, { brand, company }, logoId);
  }

  return wb;
}

export interface CommissionSheetInput {
  lines: StaffCommissionLine[];
  total: number;
  currency: string;
  title?: string | null;
  subtitle?: string | null;
}

/**
 * Second worksheet in the Month-End / Staff workbook: one line per selling
 * account (CEO included) with gross, commission % and commission due. Styled to
 * match the ledger sheet and the month-end email template.
 */
function addCommissionSheet(
  wb: ExcelJS.Workbook,
  input: CommissionSheetInput,
  branding: { brand: string; company: { name?: string | null; email?: string | null; website?: string | null } },
  /** Media id already registered on the workbook; reusing it avoids a duplicate image. */
  logoId: number | null = null
): void {
  const headers = ['Staff', 'Role', 'Sales', 'Gross', 'Commission %', 'Commission Due'];
  const widths = [30, 14, 10, 18, 16, 18];
  const ws = wb.addWorksheet('Commissions');
  ws.columns = headers.map((header, i) => ({ header, width: widths[i], key: undefined }));

  for (let i = 1; i <= headers.length; i++) ws.getRow(1).getCell(i).value = '';
  for (let r = 1; r <= 9; r++) {
    for (let c = 1; c <= headers.length; c++) {
      ws.getRow(r).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_WHITE } };
    }
  }

  if (logoId != null) {
    try {
      ws.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 168, height: 63 } });
      ws.getRow(1).height = 50;
    } catch {
      /* text-only header */
    }
  }

  ws.mergeCells(`C1:F1`);
  ws.getCell('C1').value = branding.brand;
  ws.getCell('C1').font = { name: 'Calibri', size: 20, bold: true, color: { argb: BRAND_NAVY } };
  ws.getCell('C1').alignment = { vertical: 'middle', horizontal: 'right' };

  ws.mergeCells('A2:F2');
  ws.getCell('A2').value = input.title || 'Staff Sales & Commission Report';
  ws.getCell('A2').font = { name: 'Calibri', size: 14, bold: true, color: { argb: BRAND_DEEP } };

  ws.mergeCells('A3:F3');
  ws.getCell('A3').value =
    input.subtitle ||
    `Commission payable ${money(input.total, input.currency)} · Generated: ${new Date().toLocaleString()}`;
  ws.getCell('A3').font = { name: 'Calibri', size: 11, color: { argb: BRAND_MUTED } };

  const contact = [branding.company.email, branding.company.website].filter(Boolean).join('  ·  ');
  if (contact) {
    ws.mergeCells('A4:F4');
    ws.getCell('A4').value = contact;
    ws.getCell('A4').font = { name: 'Calibri', size: 9, italic: true, color: { argb: BRAND_MUTED } };
  }

  const headerRowNumber = 6;
  const headerRow = ws.getRow(headerRowNumber);
  headerRow.values = headers;
  headerRow.height = 28;
  for (let i = 1; i <= headers.length; i++) {
    const cell = headerRow.getCell(i);
    cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: BRAND_WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_NAVY } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: BRAND_NAVY } },
      bottom: { style: 'medium', color: { argb: BRAND_DEEP } },
      left: { style: 'thin', color: { argb: BRAND_NAVY } },
      right: { style: 'thin', color: { argb: BRAND_NAVY } },
    };
  }
  ws.views = [{ state: 'frozen', ySplit: headerRowNumber }];

  let rowNumber = headerRowNumber + 1;
  for (const line of input.lines) {
    const dataRow = ws.getRow(rowNumber);
    dataRow.values = [
      line.staffName,
      line.role || '—',
      line.salesCount,
      money(line.gross, input.currency),
      `${line.commissionPct.toFixed(2)}%`,
      money(line.commissionDue, input.currency),
    ];
    dataRow.height = 20;
    const alt = rowNumber % 2 === 0;
    for (let i = 1; i <= headers.length; i++) {
      const cell = dataRow.getCell(i);
      cell.font = { name: 'Calibri', size: 10, color: { argb: BRAND_NAVY } };
      cell.alignment = { horizontal: i === 1 || i === 2 ? 'left' : 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
      if (alt) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_LIGHT } };
    }
    // Highlight the CEO line so the ownership split is unmistakable.
    if ((line.role || '').toUpperCase() === 'CEO') {
      dataRow.getCell(1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: BRAND_DEEP } };
    }
    rowNumber += 1;
  }

  const totalRow = ws.getRow(rowNumber);
  totalRow.height = 26;
  for (let i = 1; i <= headers.length; i++) totalRow.getCell(i).value = '';
  totalRow.getCell(1).value = 'TOTAL';
  totalRow.getCell(4).value = money(
    input.lines.reduce((sum, line) => sum + line.gross, 0),
    input.currency
  );
  totalRow.getCell(6).value = money(input.total, input.currency);
  for (let i = 1; i <= headers.length; i++) {
    const cell = totalRow.getCell(i);
    cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: BRAND_WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_RED } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  totalRow.getCell(6).font = { name: 'Calibri', size: 14, bold: true, color: { argb: BRAND_WHITE } };
}

/** Render the workbook to a Buffer (used for email attachments). */
export async function buildSalesWorkbookBuffer(opts: Parameters<typeof buildSalesWorkbook>[0]): Promise<Buffer> {
  const wb = buildSalesWorkbook(opts);
  const data = await wb.xlsx.writeBuffer();
  return Buffer.from(data as ArrayBuffer);
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Plain CSV with the same column contract (no styling). */
export function buildSalesCsv(rows: SalesReportRow[], columns: ReportColumn[] = SALES_REPORT_COLUMNS): string {
  const header = columns
    .map((c) => (c.header === 'Amount (USD/ZiG)' ? 'Amount (USD/ZiG)' : c.header))
    .join(',');
  const body = rows.map((row) => toReportCells(row).map(csvCell).join(',')).join('\n');
  return `${header}\n${body}${body ? '\n' : ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Month-end aggregates
// ─────────────────────────────────────────────────────────────────────────────

export interface StaffCommissionLine {
  staffId: string | null;
  staffName: string;
  /** admin_users.role (CEO / Manager / Staff / Cashier) when the line is a real account. */
  role: string | null;
  salesCount: number;
  gross: number;
  commissionPct: number;
  commissionDue: number;
}

export interface MonthEndSummary {
  period: ReportPeriod;
  currency: string;
  totalRevenue: number;
  salesCount: number;
  averageSale: number;
  activeHandovers: number;
  activeHandoverValue: number;
  staffCommissions: StaffCommissionLine[];
  staffCommissionTotal: number;
  /** Sales already marked `handed_over`. */
  reconciledValue: number;
  /** Approved cash handovers raised inside the period. */
  approvedHandoverValue: number;
  reconciliationDifference: number;
  reconciliationStatus: 'Reconciled' | 'Pending' | 'Overpaid' | 'Shortfall';
  rows: SalesReportRow[];
}

export async function buildMonthEndSummary(
  period: ReportPeriod,
  rows?: SalesReportRow[]
): Promise<MonthEndSummary> {
  const salesRows = rows ?? (await fetchSalesReportRows(period));
  const totalRevenue = salesRows.reduce((sum, row) => sum + row.amount, 0);

  const [handovers, commissions, reconciled] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS active_count, COALESCE(SUM(total_amount), 0)::float AS active_value
         FROM cash_handovers WHERE status = 'pending'`
    ),
    // Every selling account belongs on the commission sheet — including the CEO.
    // The old query joined `staff_commissions` INNER-style, so an account with
    // no commission row (or whose commission row was never created) silently
    // vanished from the report. The period's sales are aggregated here too, so
    // a line cannot be split by a staff-name collision.
    pool.query(
      `SELECT a.id AS staff_id,
              a.role,
              COALESCE(NULLIF(a.full_name, ''), a.email, 'Unknown staff') AS staff_name,
              COALESCE(sc.commission_pct, 0)::float AS commission_pct,
              COALESCE(sa.sales_count, 0)::int    AS sales_count,
              COALESCE(sa.gross, 0)::float        AS gross
         FROM admin_users a
         LEFT JOIN staff_commissions sc ON sc.staff_id = a.id
         LEFT JOIN (
               SELECT s.sold_by,
                      COUNT(*)::int AS sales_count,
                      COALESCE(SUM(s.amount), 0)::float AS gross
                 FROM sales s
                WHERE s.sold_by IS NOT NULL
                  AND s.sold_at >= $1 AND s.sold_at < $2
                GROUP BY s.sold_by
             ) sa ON sa.sold_by = a.id
        WHERE a.deleted_at IS NULL
          AND (a.role IN ('CEO', 'Manager', 'Staff', 'Cashier')
               OR sc.staff_id IS NOT NULL
               OR sa.sold_by IS NOT NULL)`,
      [period.from, period.to]
    ),
    pool.query(
      `SELECT COALESCE(SUM(total_amount), 0)::float AS approved_value
         FROM cash_handovers
        WHERE status = 'approved'
          AND COALESCE(approved_at, created_at) >= $1
          AND COALESCE(approved_at, created_at) < $2`,
      [period.from, period.to]
    ),
  ]);

  const byStaff = new Map<string, { name: string; count: number; gross: number }>();
  for (const row of salesRows) {
    const key = row.staffName || 'Online';
    const entry = byStaff.get(key) || { name: key, count: 0, gross: 0 };
    entry.count += 1;
    entry.gross += row.amount;
    byStaff.set(key, entry);
  }

  const staffCommissions: StaffCommissionLine[] = commissions.rows.map((c: any) => {
    const name = String(c.staff_name ?? 'Unknown staff');
    const pct = Number(c.commission_pct) || 0;
    const gross = Number(c.gross) || 0;
    return {
      staffId: c.staff_id ?? null,
      staffName: name,
      role: c.role ? String(c.role) : null,
      salesCount: Number(c.sales_count) || 0,
      gross: Math.round(gross * 100) / 100,
      commissionPct: pct,
      commissionDue: Math.round(gross * (pct / 100) * 100) / 100,
    };
  });

  // Sales booked under a name that no longer maps to an admin account (legacy
  // `sold_by_name`, deleted users) still count toward revenue. The unattributed
  // "Online" bucket is not a person, so it is never given a commission line.
  const knownNames = new Set(staffCommissions.map((line) => line.staffName));
  for (const [name, entry] of byStaff.entries()) {
    if (name === 'Online' || knownNames.has(name)) continue;
    staffCommissions.push({
      staffId: null,
      staffName: name,
      role: null,
      salesCount: entry.count,
      gross: Math.round(entry.gross * 100) / 100,
      commissionPct: 0,
      commissionDue: 0,
    });
  }

  staffCommissions.sort((a, b) => b.gross - a.gross || a.staffName.localeCompare(b.staffName));

  const reconciledValue = salesRows
    .filter((row) => row.handoverStatus === 'handed_over')
    .reduce((sum, row) => sum + row.amount, 0);
  const approvedHandoverValue = Number(reconciled.rows[0]?.approved_value ?? 0);
  const difference = Math.round((reconciledValue - approvedHandoverValue) * 100) / 100;

  let reconciliationStatus: MonthEndSummary['reconciliationStatus'] = 'Reconciled';
  if (Math.abs(difference) >= 0.01) reconciliationStatus = difference > 0 ? 'Pending' : 'Overpaid';

  return {
    period,
    currency: salesRows[0]?.currency || 'USD',
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    salesCount: salesRows.length,
    averageSale: salesRows.length ? Math.round((totalRevenue / salesRows.length) * 100) / 100 : 0,
    activeHandovers: Number(handovers.rows[0]?.active_count ?? 0),
    activeHandoverValue: Number(handovers.rows[0]?.active_value ?? 0),
    staffCommissions,
    staffCommissionTotal: Math.round(staffCommissions.reduce((s, c) => s + c.commissionDue, 0) * 100) / 100,
    reconciledValue: Math.round(reconciledValue * 100) / 100,
    approvedHandoverValue: Math.round(approvedHandoverValue * 100) / 100,
    reconciliationDifference: difference,
    reconciliationStatus,
    rows: salesRows,
  };
}

/** Per-staff sheet rows: one line per staff member's sales. */
export async function buildStaffReport(period: ReportPeriod): Promise<{
  summary: MonthEndSummary;
  byStaff: Map<string, SalesReportRow[]>;
}> {
  const summary = await buildMonthEndSummary(period);
  const byStaff = new Map<string, SalesReportRow[]>();
  for (const row of summary.rows) {
    const key = row.staffName || 'Online';
    const list = byStaff.get(key) ?? [];
    list.push(row);
    byStaff.set(key, list);
  }
  return { summary, byStaff };
}
