import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { requireAdminAuth } from '../middleware/adminAuth';

// ── GET /api/currency/rates ──────────────────────────────────────────────
// Fetches current active exchange rates scoped strictly by the authenticated
// user's company_id. Only rates with effective_date <= now are considered active.
export const currencyRouter = Router();

currencyRouter.get('/rates', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const companyId = (req.adminUser as { portalCompanyId?: string | null })?.portalCompanyId ?? null;
    const { rows } = await pool.query(
      `SELECT company_id, base_currency, target_currency, rate, effective_date
         FROM currency_rates
        WHERE company_id = $1
          AND effective_date <= NOW()
        ORDER BY base_currency, target_currency`,
      [companyId]
    );

    // If no company-scoped rates exist, fall back to the global default (USD->ZWG seed)
    if (rows.length === 0) {
      const { rows: defaultRows } = await pool.query(
        `SELECT company_id, base_currency, target_currency, rate
           FROM currency_rates
          WHERE base_currency = 'USD' AND target_currency = 'ZWG'`
      );
      res.json({ rates: defaultRows.length ? defaultRows : [], fallback: true });
    } else {
      res.json({ rates: rows, fallback: false });
    }
  } catch (e) {
    console.error('currency rates fetch failed:', (e as Error).message);
    res.status(500).json({ error: 'Failed to fetch currency rates' });
  }
});

// ── POST /api/currency/rates ─────────────────────────────────────────────
// Enables company admins (CEO / Manager) to set / update target currency rates.
// Body: { target_currency: 'ZWG', rate: 26.5 }
currencyRouter.post('/rates', requireAdminAuth, async (req: Request, res: Response) => {
  const { target_currency, rate } = req.body as { target_currency: string; rate: number };
  if (!target_currency || rate == null) {
    res.status(400).json({ error: 'target_currency and rate are required' }); return;
  }
  if (typeof rate !== 'number' || rate <= 0) {
    res.status(400).json({ error: 'rate must be a positive number' }); return;
  }

  try {
    const companyId = (req.adminUser as { portalCompanyId?: string | null })?.portalCompanyId ?? null;
    // Allow write when there is a company override or a single company exists.
    let effectiveCompanyId = companyId;
    if (!effectiveCompanyId) {
      const { rows: companies } = await pool.query('SELECT id FROM companies ORDER BY created_at ASC LIMIT 1');
      if (companies.length === 0) { res.status(503).json({ error: 'No company exists' }); return; }
      if (companies.length > 1) {
        res.status(403).json({ error: 'Multiple companies exist; set INVOICE_COMPANY_ID or assign the account to a company.' });
        return;
      }
      effectiveCompanyId = companies[0].id;
    }

    await pool.query(
      `INSERT INTO currency_rates (company_id, base_currency, target_currency, rate, effective_date)
       VALUES ($1, 'USD', $2, $3, NOW())
       ON CONFLICT (company_id, target_currency) DO UPDATE SET rate = $3, effective_date = NOW()`,
      [effectiveCompanyId, target_currency, rate]
    );

    // Audit log (best-effort; do not fail the request)
    try {
      await pool.query(
        `INSERT INTO audit_logs (admin_id, admin_name, action, target_type, target_id, detail)
         VALUES ($1, $2, 'currency_rate_set', 'currency_rate', NULL, $3)`,
        [(req.adminUser as { id?: string })?.id ?? null, (req.adminUser as { fullName?: string })?.fullName ?? null, `${target_currency} ${rate}`]
      );
    } catch { /* audit is non-critical */ }

    res.json({ success: true, company_id: effectiveCompanyId, target_currency, rate });
  } catch (e) {
    console.error('currency rate set failed:', (e as Error).message);
    res.status(500).json({ error: 'Failed to set currency rate' });
  }
});

export default currencyRouter;
