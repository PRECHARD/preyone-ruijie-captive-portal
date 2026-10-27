import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth } from '../middleware/adminAuth';
import { PERMISSIONS, requirePermission } from '../middleware/rbac';
import {
  buildMonthEndSummary,
  buildSalesCsv,
  buildSalesWorkbookBuffer,
  fetchSalesReportRows,
  parseReportPeriod,
  previousMonthPeriod,
  SALES_REPORT_COLUMNS,
  toReportCells,
} from '../services/exportService';
import { buildMonthEndEmailHtml, sendMonthEndReportEmail } from '../services/email';
import { getSchedulerStatus } from '../services/scheduler';
import { loadRevenueTarget, parseRevenueTarget, saveRevenueTarget } from '../services/revenueTarget';

/**
 * Admin reporting endpoints (additive, read-only except the explicit "send now"
 * action).
 *
 * Mounted at `/api/admin/reports` AFTER the main admin router, mirroring the
 * voucher-analytics mount, so nothing existing can be shadowed.
 *
 *   GET  /api/admin/reports/month-end           → JSON summary
 *   GET  /api/admin/reports/month-end.xlsx      → Excel ledger (streamed)
 *   GET  /api/admin/reports/month-end.csv       → CSV ledger
 *   GET  /api/admin/reports/staff.xlsx          → Staff commission workbook
 *   GET  /api/admin/reports/preview             → rendered email HTML
 *   POST /api/admin/reports/month-end/send      → send now (CEO)
 *   GET  /api/admin/reports/schedule            → scheduler state
 */
export const reportsRouter = Router();

reportsRouter.use(requireAdminAuth);

reportsRouter.use(rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many report requests. Try again shortly.' },
}));

const requireReports = requirePermission(PERMISSIONS.COMPANY_ADMIN, PERMISSIONS.SYSTEM_DEVELOPER);

async function companyHeader(): Promise<{ name?: string; tagline?: string; email?: string; website?: string } | null> {
  try {
    const { rows } = await pool.query('SELECT * FROM companies ORDER BY created_at LIMIT 1');
    const row = rows[0];
    if (!row) return null;
    return {
      name: row.name ?? row.company_name ?? null,
      tagline: row.tagline ?? null,
      email: row.email ?? row.support_email ?? null,
      website: row.website ?? null,
    };
  } catch {
    return null;
  }
}

function periodFromQuery(req: Request) {
  return parseReportPeriod(req.query.from, req.query.to);
}

function sendWorkbook(res: Response, buffer: Buffer, fileName: string): void {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.end(buffer);
}

function sendCsv(res: Response, csv: string, fileName: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(csv);
}

// ── JSON summary ────────────────────────────────────────────────────────────
reportsRouter.get('/month-end', requireReports, async (req: Request, res: Response) => {
  const period = periodFromQuery(req);
  const summary = await buildMonthEndSummary(period);
  res.json({
    period: {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      label: period.label,
    },
    currency: summary.currency,
    totalRevenue: summary.totalRevenue,
    salesCount: summary.salesCount,
    averageSale: summary.averageSale,
    activeHandovers: summary.activeHandovers,
    activeHandoverValue: summary.activeHandoverValue,
    staffCommissions: summary.staffCommissions,
    staffCommissionTotal: summary.staffCommissionTotal,
    reconciledValue: summary.reconciledValue,
    approvedHandoverValue: summary.approvedHandoverValue,
    reconciliationDifference: summary.reconciliationDifference,
    reconciliationStatus: summary.reconciliationStatus,
    columns: SALES_REPORT_COLUMNS.map((c) => c.header),
    rows: summary.rows.map(toReportCells),
  });
});

// ── Excel ledger ────────────────────────────────────────────────────────────
reportsRouter.get('/month-end.xlsx', requireReports, async (req: Request, res: Response) => {
  const period = periodFromQuery(req);
  const summary = await buildMonthEndSummary(period);
  const company = await companyHeader();
  const buffer = await buildSalesWorkbookBuffer({
    sheetName: 'Month-End Sales',
    rows: summary.rows,
    title: 'Month-End Sales & Reconciliation Ledger',
    subtitle: `Period: ${period.label} · Revenue ${summary.totalRevenue.toFixed(2)} ${summary.currency}`,
    company,
    commissions: {
      lines: summary.staffCommissions,
      total: summary.staffCommissionTotal,
      currency: summary.currency,
      subtitle: `Period: ${period.label} · Commission due ${summary.staffCommissionTotal.toFixed(2)} ${summary.currency}`,
    },
  });
  const stamp = period.from.toISOString().slice(0, 10);
  sendWorkbook(res, buffer, `preyone-month-end-${stamp}.xlsx`);
});

// ── CSV ledger ──────────────────────────────────────────────────────────────
reportsRouter.get('/month-end.csv', requireReports, async (req: Request, res: Response) => {
  const period = periodFromQuery(req);
  const rows = await fetchSalesReportRows(period);
  sendCsv(res, buildSalesCsv(rows), `preyone-month-end-${period.from.toISOString().slice(0, 10)}.csv`);
});

// ── Staff commission workbook ───────────────────────────────────────────────
reportsRouter.get('/staff.xlsx', requireReports, async (req: Request, res: Response) => {
  const period = periodFromQuery(req);
  const rows = await fetchSalesReportRows(period);
  const company = await companyHeader();
  const summary = await buildMonthEndSummary(period, rows);

  // One "All Sales" ledger sheet is what accountants reconcile against; the
  // second sheet carries the per-staff commission split (CEO included).
  const buffer = await buildSalesWorkbookBuffer({
    sheetName: 'Staff Sales',
    rows,
    title: 'Staff Sales & Commission Report',
    subtitle:
      `Period: ${period.label} · Gross ${summary.totalRevenue.toFixed(2)} ${summary.currency}` +
      ` · Commission due ${summary.staffCommissionTotal.toFixed(2)} ${summary.currency}`,
    company,
    commissions: {
      lines: summary.staffCommissions,
      total: summary.staffCommissionTotal,
      currency: summary.currency,
      title: 'Staff Sales & Commission Report',
      subtitle:
        `Period: ${period.label} · Gross ${summary.totalRevenue.toFixed(2)} ${summary.currency}` +
        ` · Commission due ${summary.staffCommissionTotal.toFixed(2)} ${summary.currency}`,
    },
  });
  sendWorkbook(res, buffer, `preyone-staff-report-${period.from.toISOString().slice(0, 10)}.xlsx`);
});

// ── Email preview (same HTML the scheduler sends) ───────────────────────────
reportsRouter.get('/preview', requireReports, async (req: Request, res: Response) => {
  const period = periodFromQuery(req);
  const summary = await buildMonthEndSummary(period);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildMonthEndEmailHtml(summary));
});

// ── Send now ────────────────────────────────────────────────────────────────
reportsRouter.post(
  '/month-end/send',
  requirePermission(PERMISSIONS.SYSTEM_DEVELOPER),
  async (req: Request, res: Response) => {
    const period = periodFromQuery(req);
    const summary = await buildMonthEndSummary(period);
    const company = await companyHeader();
    const attachment = await buildSalesWorkbookBuffer({
      sheetName: 'Month-End Sales',
      rows: summary.rows,
      title: 'Month-End Sales & Reconciliation Ledger',
      subtitle: `Period: ${period.label} · Revenue ${summary.totalRevenue.toFixed(2)} ${summary.currency}`,
      company,
      commissions: {
        lines: summary.staffCommissions,
        total: summary.staffCommissionTotal,
        currency: summary.currency,
        subtitle: `Period: ${period.label} · Commission due ${summary.staffCommissionTotal.toFixed(2)} ${summary.currency}`,
      },
    });

    const bodyRecipients = Array.isArray(req.body?.recipients)
      ? (req.body.recipients as unknown[]).map(String)
      : typeof req.body?.recipients === 'string'
        ? String(req.body.recipients).split(',')
        : [];
    const { rows } = await pool.query(
      `SELECT value FROM settings WHERE key = 'month_end_report_recipients'`
    );
    const configured = String(rows[0]?.value ?? 'admin@preyone.com')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const recipients = (bodyRecipients.length > 0 ? bodyRecipients : configured)
      .map((value) => value.trim())
      .filter(Boolean);

    const result = await sendMonthEndReportEmail({
      recipients,
      summary,
      attachment,
      attachmentName: `preyone-month-end-${period.from.toISOString().slice(0, 7)}.xlsx`,
    });

    if (!result.sent) {
      res.status(502).json({
        error: 'Report could not be emailed. Check SMTP configuration.',
        retryable: true,
        ...result,
      });
      return;
    }
    res.json({ ok: true, ...result });
  }
);

// ── Monthly revenue target ──────────────────────────────────────────────────
//
// One company-wide target, stored in `settings` (additive key, no schema
// change) and rendered by the Dashboard + My Sales progress widgets. GET is
// open to every authenticated admin so Staff can see how the month is tracking;
// PUT is COMPANY_ADMIN only.
//
// The canonical path is `/api/admin/revenue-target` (admin router). These two
// routes stay as an alias for the first release of the widget; both delegate to
// `src/services/revenueTarget.ts` so there is exactly one implementation.

reportsRouter.get('/revenue-target', async (_req: Request, res: Response) => {
  res.json(await loadRevenueTarget());
});

reportsRouter.put('/revenue-target', requireReports, async (req: Request, res: Response) => {
  const parsed = parseRevenueTarget((req.body ?? {}).target);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const actor = req.adminUser;
  const actorName = String(actor?.fullName || actor?.email || 'admin');
  res.json({ ok: true, ...(await saveRevenueTarget(parsed.value, actorName)) });
});

// ── Scheduler status ────────────────────────────────────────────────────────
reportsRouter.get('/schedule', requireReports, async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key LIKE 'month_end_report_%'`
  );
  const settings: Record<string, string> = {};
  for (const row of rows) settings[String(row.key)] = String(row.value);
  res.json({
    cron: '0 8 3 * *',
    description: 'Runs on the 3rd of every month at 08:00 (server local time).',
    defaultPeriod: previousMonthPeriod().label,
    settings,
    status: getSchedulerStatus(),
  });
});
