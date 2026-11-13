import { Router, Request, Response } from 'express';
import { requireAdminAuth, requireRole } from '../middleware/adminAuth';
import { requireCompany } from '../middleware/company';
import {
  getAccountingOverview,
  getAccountingLedger,
  getAccountingPnL,
  getTaxSummary,
} from '../db/accounting';
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

/** GET /api/accounting/export.csv — one-click CSV of the ledger */
router.get('/export.csv', requireRole(...FULL_ROLES), async (req: Request, res: Response) => {
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
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
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
        .map(escape)
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

export { router as accountingRouter };
