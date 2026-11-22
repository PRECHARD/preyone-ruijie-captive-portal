import { Router, Request, Response } from 'express';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { requireAdminAuth, requireRole } from '../middleware/adminAuth';
import { requireCompany } from '../middleware/company';
import {
  getAccountingOverview,
  getAccountingLedger,
  getAccountingPnL,
  getTaxSummary,
} from '../db/accounting';
import { pool } from '../db/pool';
import { VAT_RATE_PCT } from '../services/revenueCycle';

/**
 * Tenant-scoped enterprise accounting API.
 * Auth + company middleware mirror /api/pos — never trust body/query for tenant.
 */

const router = Router();

const VIEW_ROLES = ['CEO', 'Manager', 'Staff', 'Cashier'];
const FULL_ROLES = ['CEO', 'Manager'];

function tenantId(req: Request): string {
  return req.company!.id;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

interface AccountRecordRow {
  doc_number: string;
  customer_name: string;
  total: string | number;
  amount_paid: string | number;
  owed: string | number;
  cost: string | number;
  inventory_id: string | null;
  issue_date: string;
  description: string | null;
  verify_code: string | null;
  currency: string;
}

interface ZarTotalRow {
  currency: string;
  sales_total: string | number;
  funds_total: string | number;
  balance_total: string | number;
  source: string | null;
  as_of: string | null;
}

async function getAccountRecord(companyId: string, from?: string, to?: string): Promise<AccountRecordRow[]> {
  const { rows } = await pool.query<AccountRecordRow>(
    `SELECT d.doc_number,
            COALESCE(c.name, 'Walk-in client') AS customer_name,
            d.total,
            d.amount_paid,
            ROUND(d.total - d.amount_paid, 2) AS owed,
            COALESCE(
              NULLIF(d.doc_meta->'import'->>'originalCost', '')::numeric,
              (SELECT COALESCE(SUM(COALESCE(p.cost_price, 0) * i.qty), 0)
                 FROM pos_document_items i
                 LEFT JOIN pos_products p ON p.id = i.product_id
                WHERE i.document_id = d.id),
              0
            ) AS cost,
            NULLIF(d.doc_meta->'import'->>'inventoryId', '') AS inventory_id,
            to_char(d.issue_date, 'YYYY-MM-DD') AS issue_date,
            (SELECT string_agg(i.description, '; ' ORDER BY i.position)
               FROM pos_document_items i WHERE i.document_id = d.id) AS description,
            d.verify_code,
            COALESCE(d.currency, 'USD') AS currency
       FROM pos_documents d
       LEFT JOIN pos_customers c ON c.id = d.customer_id
      WHERE d.company_id = $1
        AND d.doc_type IN ('invoice', 'tax_invoice', 'proforma', 'sales_receipt', 'sale')
        AND d.status <> 'void'
        AND d.currency = 'USD'
        AND ($2::date IS NULL OR d.issue_date >= $2::date)
        AND ($3::date IS NULL OR d.issue_date <= $3::date)
      ORDER BY d.issue_date ASC, d.created_at ASC
      LIMIT 5000`,
    [companyId, from || null, to || null]
  );
  return rows;
}

async function getZarTotals(companyId: string): Promise<ZarTotalRow | null> {
  const { rows } = await pool.query<ZarTotalRow>(
    `SELECT currency, sales_total, funds_total, balance_total, source,
            to_char(as_of, 'YYYY-MM-DD') AS as_of
       FROM legacy_currency_totals
      WHERE company_id = $1 AND currency = 'ZAR'
      LIMIT 1`,
    [companyId]
  );
  return rows[0] ?? null;
}

const num = (v: unknown): number => Math.round((Number(v) || 0) * 100) / 100;
const csvEscape = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function totalsOf(rows: AccountRecordRow[]) {
  return rows.reduce(
    (acc, row) => {
      acc.sales = num(acc.sales + num(row.total));
      acc.paid = num(acc.paid + num(row.amount_paid));
      acc.owed = num(acc.owed + num(row.owed));
      acc.cost = num(acc.cost + num(row.cost));
      return acc;
    },
    { sales: 0, paid: 0, owed: 0, cost: 0 }
  );
}

router.use(requireAdminAuth, requireCompany);

/** GET /api/accounting/overview */
router.get('/overview', requireRole(...VIEW_ROLES), async (req: Request, res: Response) => {
  const from = str(req.query.from) || undefined;
  const to = str(req.query.to) || undefined;
  const overview = await getAccountingOverview(tenantId(req), { from, to });

  // Cashiers only see till-drawer summary KPIs.
  if (req.adminUser?.role === 'Cashier') {
    res.json({
      role: 'Cashier',
      todayTill: overview.todayTill,
      cashTotal: overview.cashTotal,
      pesepayTotal: overview.pesepayTotal,
      byRail: overview.byRail,
      vatRate: overview.vatRate,
    });
    return;
  }

  res.json({ role: req.adminUser?.role, ...overview });
});

/** GET /api/accounting/ledger */
router.get('/ledger', requireRole(...FULL_ROLES), async (req: Request, res: Response) => {
  const result = await getAccountingLedger(tenantId(req), {
    from: str(req.query.from) || undefined,
    to: str(req.query.to) || undefined,
    rail: str(req.query.rail) || undefined,
    type: str(req.query.type) || undefined,
    limit: Number(req.query.limit) || 100,
    offset: Number(req.query.offset) || 0,
  });
  res.json(result);
});

/** GET /api/accounting/pnl — grouped by 3rd-to-3rd revenueCycle rules */
router.get('/pnl', requireRole(...FULL_ROLES), async (req: Request, res: Response) => {
  const pnl = await getAccountingPnL(tenantId(req), {
    from: str(req.query.from) || undefined,
    to: str(req.query.to) || undefined,
  });
  res.json({ vatRate: VAT_RATE_PCT, ...pnl });
});

/** GET /api/accounting/tax-summary — VAT liability: POS receipts vs Tax Invoices */
router.get('/tax-summary', requireRole(...FULL_ROLES), async (req: Request, res: Response) => {
  const summary = await getTaxSummary(tenantId(req), {
    from: str(req.query.from) || undefined,
    to: str(req.query.to) || undefined,
  });
  res.json(summary);
});

/**
 * Client Account Record export — mirrors the historical ZIM workbook layout.
 * The CSV is the flat equivalent (no styling is possible in CSV); the XLSX
 * version carries the Preyone logo, brand colours and the ZAR summary sheet.
 */
router.get('/export.csv', requireRole(...FULL_ROLES), async (req: Request, res: Response) => {
  const from = str(req.query.from) || undefined;
  const to = str(req.query.to) || undefined;
  const rows = await getAccountRecord(tenantId(req), from, to);
  const totals = totalsOf(rows);
  const header = [
    'Receipt #',
    'Client Name',
    'Purchase Amount',
    'Amount Paid',
    'Amount Owed',
    'Cost Incurred',
    'Inventory ID',
    'Date',
    'Description',
    'Document ID',
    'Currency',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.doc_number,
        row.customer_name,
        num(row.total),
        num(row.amount_paid),
        num(row.owed),
        num(row.cost),
        row.inventory_id || '',
        row.issue_date,
        row.description || '',
        row.verify_code || '',
        row.currency,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  lines.push(
    ['TOTAL', '', totals.sales, totals.paid, totals.owed, totals.cost, '', '', '', '', 'USD']
      .map(csvEscape)
      .join(',')
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="preyone-client-account-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.send(`\uFEFF${lines.join('\n')}`);
});

/** Ledger-only CSV retained for accounting reconciliation workflows. */
router.get('/export-ledger.csv', requireRole(...FULL_ROLES), async (req: Request, res: Response) => {
  const result = await getAccountingLedger(tenantId(req), {
    from: str(req.query.from) || undefined,
    to: str(req.query.to) || undefined,
    rail: str(req.query.rail) || undefined,
    type: str(req.query.type) || undefined,
    limit: 5000,
    offset: 0,
  });
  const header = [
    'occurred_at',
    'entry_type',
    'rail',
    'doc_number',
    'doc_type',
    'reference',
    'description',
    'gross',
    'tax',
    'net',
    'cogs',
    'currency',
  ];
  const lines = [header.join(',')];
  for (const r of result.rows) {
    lines.push(
      [
        r.occurred_at,
        r.entry_type,
        r.rail,
        r.doc_number,
        r.doc_type,
        r.reference,
        r.description,
        r.gross_amount,
        r.tax_amount,
        r.net_amount,
        r.cogs_amount,
        r.currency,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="preyone-ledger-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.send(lines.join('\n'));
});

const BRAND = {
  ink: 'FF241B3A',
  purple: 'FF36116A',
  plum: 'FF7A0E57',
  header: 'FF2A0B4E',
  headerAccent: 'FF7A0E57',
  lavender: 'FFF5F0FF',
  lavender2: 'FFEDE4FB',
  white: 'FFFFFFFF',
  muted: 'FF6D6786',
  line: 'FFE2D8F2',
  total: 'FFFFE7F8',
};

const moneyFmt = '"$"#,##0.00';
const zarFmt = '"R"#,##0.00';

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function borderThin(argb = BRAND.line): Partial<ExcelJS.Borders> {
  return {
    top: { style: 'thin', color: { argb } },
    left: { style: 'thin', color: { argb } },
    bottom: { style: 'thin', color: { argb } },
    right: { style: 'thin', color: { argb } },
  };
}

function logoPath(): string {
  return path.join(__dirname, '..', '..', 'public', 'images', 'preyonelogomainzw-email.png');
}

function addBrandHeader(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  title: string,
  subtitle: string,
  columns = 11
) {
  const lastCol = String.fromCharCode(64 + columns);
  sheet.views = [{ state: 'frozen', ySplit: 6, showGridLines: false }];
  for (let r = 1; r <= 2; r += 1) {
    for (let c = 1; c <= columns; c += 1) {
      sheet.getCell(r, c).fill = fill(BRAND.header);
    }
  }
  sheet.mergeCells(`B1:${lastCol}1`);
  sheet.mergeCells(`B2:${lastCol}2`);
  sheet.getCell('B1').value = title;
  sheet.getCell('B1').font = { name: 'Calibri', size: 18, bold: true, color: { argb: BRAND.white } };
  sheet.getCell('B1').alignment = { vertical: 'middle' };
  sheet.getCell('B2').value = subtitle;
  sheet.getCell('B2').font = { name: 'Calibri', size: 10, color: { argb: 'FFE7D7FF' } };
  sheet.getCell('B2').alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 34;
  sheet.getRow(2).height = 20;
  if (fs.existsSync(logoPath())) {
    const imageId = workbook.addImage({ filename: logoPath(), extension: 'png' });
    sheet.addImage(imageId, {
      tl: { col: 0.18, row: 0.12 },
      ext: { width: 88, height: 49 },
    });
  }
}

function styleHeaderRow(sheet: ExcelJS.Worksheet, rowNumber: number, columns: number) {
  const row = sheet.getRow(rowNumber);
  row.height = 22;
  for (let c = 1; c <= columns; c += 1) {
    const cell = row.getCell(c);
    cell.fill = fill(BRAND.headerAccent);
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: BRAND.white } };
    cell.alignment = { vertical: 'middle', horizontal: c >= 3 && c <= 6 ? 'right' : 'left' };
    cell.border = borderThin('FF9B5A9A');
  }
}

function styleTotalsRow(sheet: ExcelJS.Worksheet, rowNumber: number, columns: number) {
  const row = sheet.getRow(rowNumber);
  row.height = 22;
  for (let c = 1; c <= columns; c += 1) {
    const cell = row.getCell(c);
    cell.fill = fill(BRAND.total);
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: BRAND.ink } };
    cell.border = borderThin();
    if (c >= 3 && c <= 6) cell.numFmt = moneyFmt;
  }
}

/** GET /api/accounting/export.xlsx — branded Client Account Record workbook */
router.get('/export.xlsx', requireRole(...FULL_ROLES), async (req: Request, res: Response) => {
  const companyId = tenantId(req);
  const from = str(req.query.from) || undefined;
  const to = str(req.query.to) || undefined;
  const [rows, zar, pnl, ledger] = await Promise.all([
    getAccountRecord(companyId, from, to),
    getZarTotals(companyId),
    getAccountingPnL(companyId, { from, to }),
    getAccountingLedger(companyId, { from, to, limit: 5000, offset: 0 }),
  ]);
  const totals = totalsOf(rows);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Preyone Invoicing';
  workbook.created = new Date();

  /* ── USD client account record ── */
  const sheet = workbook.addWorksheet('USD Account Record', {
    properties: { defaultRowHeight: 18 },
  });
  sheet.columns = [
    { width: 15 },
    { width: 30 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 20 },
    { width: 13 },
    { width: 52 },
    { width: 30 },
    { width: 10 },
  ];
  addBrandHeader(
    workbook,
    sheet,
    'Preyone Enterprises — Client Account Record',
    `USD ledger · ${rows.length} invoices · generated ${new Date().toLocaleDateString('en-GB')}`
  );

  sheet.getCell('B4').value = 'Total Sales USD';
  sheet.getCell('C4').value = totals.sales;
  sheet.getCell('D4').value = 'Total Paid';
  sheet.getCell('E4').value = totals.paid;
  sheet.getCell('F4').value = 'Total Owed';
  sheet.getCell('G4').value = totals.owed;
  sheet.getCell('H4').value = 'Total Costs';
  sheet.getCell('I4').value = totals.cost;
  for (const ref of ['B4', 'D4', 'F4', 'H4']) {
    sheet.getCell(ref).font = { name: 'Calibri', size: 10, bold: true, color: { argb: BRAND.muted } };
  }
  for (const ref of ['C4', 'E4', 'G4', 'I4']) {
    sheet.getCell(ref).font = { name: 'Calibri', size: 12, bold: true, color: { argb: BRAND.purple } };
    sheet.getCell(ref).numFmt = moneyFmt;
  }
  sheet.getRow(4).height = 24;

  const headers = [
    'Receipt #',
    'Client Name',
    'Purchase Amount',
    'Amount Paid',
    'Amount Owed',
    'Cost Incurred',
    'Inventory ID',
    'Date',
    'Description Of Purchase',
    'Document ID',
    'Currency',
  ];
  sheet.addRow([]);
  sheet.addRow(headers);
  styleHeaderRow(sheet, 6, headers.length);

  rows.forEach((row, index) => {
    const r = sheet.addRow([
      row.doc_number,
      row.customer_name,
      num(row.total),
      num(row.amount_paid),
      num(row.owed),
      num(row.cost),
      row.inventory_id || '',
      row.issue_date,
      row.description || '',
      row.verify_code || '',
      row.currency,
    ]);
    r.height = 19;
    for (let c = 1; c <= headers.length; c += 1) {
      const cell = r.getCell(c);
      cell.border = borderThin();
      cell.font = { name: 'Calibri', size: 10, color: { argb: BRAND.ink } };
      if (index % 2 === 1) cell.fill = fill(BRAND.lavender);
      if (c >= 3 && c <= 6) {
        cell.numFmt = moneyFmt;
        cell.alignment = { horizontal: 'right' };
      }
      if (c === 5 && num(row.owed) > 0) {
        cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFB3261E' } };
      }
    }
  });

  const totalRow = sheet.addRow([
    'TOTAL',
    '',
    totals.sales,
    totals.paid,
    totals.owed,
    totals.cost,
    '',
    '',
    `${rows.length} invoices`,
    '',
    'USD',
  ]);
  styleTotalsRow(sheet, totalRow.number, headers.length);
  sheet.autoFilter = { from: 'A6', to: `K${6 + rows.length}` };
  sheet.getCell(`A${totalRow.number + 2}`).value =
    'Document IDs can be verified worldwide at https://preyone.com/verify';
  sheet.mergeCells(`A${totalRow.number + 2}:K${totalRow.number + 2}`);
  sheet.getCell(`A${totalRow.number + 2}`).font = {
    name: 'Calibri',
    size: 9,
    italic: true,
    color: { argb: BRAND.muted },
  };

  /* ── ZAR summary tab ── */
  const zarSheet = workbook.addWorksheet('ZAR Summary');
  zarSheet.columns = [{ width: 24 }, { width: 22 }, { width: 22 }, { width: 44 }];
  addBrandHeader(
    workbook,
    zarSheet,
    'Preyone Enterprises - ZAR Account Summary',
    'Rand totals kept separate from the USD ledger',
    4
  );
  zarSheet.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  const zarRows: Array<[string, number | string, string?]> = [
    ['ZAR sales', num(zar?.sales_total), zarFmt],
    ['Funds received', num(zar?.funds_total), zarFmt],
    ['Balance', num(zar?.balance_total), zarFmt],
    ['Currency', 'ZAR'],
    ['Source', zar?.source || 'Preyone ZIM Clients Account Record.xlsx'],
    ['As of', zar?.as_of || '—'],
  ];
  zarRows.forEach(([label, value, fmt], index) => {
    const r = zarSheet.addRow([label, value]);
    r.height = 22;
    r.getCell(1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: BRAND.muted } };
    r.getCell(2).font = { name: 'Calibri', size: 12, bold: true, color: { argb: BRAND.purple } };
    r.getCell(2).alignment = { horizontal: 'right' };
    if (fmt) r.getCell(2).numFmt = fmt;
    if (index % 2 === 0) {
      r.getCell(1).fill = fill(BRAND.lavender);
      r.getCell(2).fill = fill(BRAND.lavender);
    }
  });

  /* ── P&L sheet ── */
  const pnlSheet = workbook.addWorksheet('P&L');
  pnlSheet.columns = [{ width: 34 }, { width: 22 }];
  pnlSheet.columns = [{ width: 34 }, { width: 22 }, { width: 12 }, { width: 12 }, { width: 12 }];
  addBrandHeader(workbook, pnlSheet, 'Profit & Loss', '3rd-to-3rd revenue cycle', 5);
  pnlSheet.addRow([]);
  pnlSheet.addRow([]);
  pnlSheet.addRow([]);
  pnlSheet.addRow(['Line', 'Amount']);
  styleHeaderRow(pnlSheet, 6, 2);
  const pnlLines: Array<[string, number]> = [
    ['Gross Revenue', pnl.grossRevenue],
    ['Credit Notes', pnl.creditNotes],
    ['Adjusted Gross', pnl.adjustedGross],
    [`VAT (${VAT_RATE_PCT}%)`, pnl.taxCollected],
    ['Net Sales', pnl.netSales],
    ['COGS', pnl.cogs],
    ['Gross Profit', pnl.grossProfit],
    ['Expenses', pnl.expenses],
    ['Operating Profit', pnl.operatingProfit],
  ];
  pnlLines.forEach(([label, value], index) => {
    const r = pnlSheet.addRow([label, num(value)]);
    r.height = 20;
    for (let c = 1; c <= 2; c += 1) {
      const cell = r.getCell(c);
      cell.border = borderThin();
      cell.font = { name: 'Calibri', size: 10, color: { argb: BRAND.ink } };
      if (index % 2 === 1) cell.fill = fill(BRAND.lavender);
    }
    r.getCell(1).font = {
      name: 'Calibri',
      size: 10,
      bold: label === 'Operating Profit',
      color: { argb: label === 'Operating Profit' ? BRAND.purple : BRAND.ink },
    };
    r.getCell(2).numFmt = moneyFmt;
    r.getCell(2).alignment = { horizontal: 'right' };
  });

  /* ── Ledger sheet ── */
  const ledgerSheet = workbook.addWorksheet('General Ledger');
  ledgerSheet.columns = [
    { width: 22 },
    { width: 20 },
    { width: 12 },
    { width: 18 },
    { width: 16 },
    { width: 26 },
    { width: 40 },
    { width: 14 },
    { width: 12 },
    { width: 14 },
    { width: 12 },
    { width: 10 },
  ];
  addBrandHeader(workbook, ledgerSheet, 'General Ledger', 'Every posted accounting entry', 12);
  ledgerSheet.addRow([]);
  ledgerSheet.addRow([]);
  ledgerSheet.addRow([]);
  ledgerSheet.addRow([
    'Occurred At',
    'Entry Type',
    'Rail',
    'Document',
    'Document Type',
    'Reference',
    'Description',
    'Gross',
    'Tax',
    'Net',
    'COGS',
    'Currency',
  ]);
  styleHeaderRow(ledgerSheet, 6, 12);
  (ledger.rows || []).forEach((row: any, index: number) => {
    const r = ledgerSheet.addRow([
      row.occurred_at ? new Date(row.occurred_at).toISOString() : '',
      row.entry_type,
      row.rail,
      row.doc_number || '',
      row.doc_type || '',
      row.reference || '',
      row.description || '',
      num(row.gross_amount),
      num(row.tax_amount),
      num(row.net_amount),
      num(row.cogs_amount),
      row.currency,
    ]);
    r.height = 18;
    for (let c = 1; c <= 12; c += 1) {
      const cell = r.getCell(c);
      cell.border = borderThin();
      cell.font = { name: 'Calibri', size: 9, color: { argb: BRAND.ink } };
      if (index % 2 === 1) cell.fill = fill(BRAND.lavender);
      if (c >= 8 && c <= 11) {
        cell.numFmt = moneyFmt;
        cell.alignment = { horizontal: 'right' };
      }
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="preyone-client-account-${new Date().toISOString().slice(0, 10)}.xlsx"`
  );
  res.send(Buffer.from(buffer));
});

export { router as accountingRouter };
