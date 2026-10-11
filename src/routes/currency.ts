import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth, requireCompanyScope, auditLog } from './auth';

// ── GET /api/currency/rates ──────────────────────────────────────────────
// Fetches current active exchange rates scoped strictly by the authenticated
// user's company_id. Only rates with effective_date <= now are considered active.
router.get('/rates', requireAuth, requireCompanyScope, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT company_id, base_currency, target_currency, rate, effective_date
      FROM currency_rates
      WHERE company_id = $1
        AND effective_date <= NOW()
      ORDER BY base_currency, target_currency
    `, [req.user.company_id ?? null]);

    // If no company-scoped rates exist, fall back to the global default (USD->ZWG seed)
    if (rows.length === 0) {
      const { rows: defaultRows } = await pool.query(`
        SELECT company_id, base_currency, target_currency, rate
        FROM currency_rates
        WHERE base_currency = 'USD' AND target_currency = 'ZWG'
      `);
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
// Only users with company_id set (or the INVOICE_COMPANY_ID override) may write.
router.post('/rates', requireAuth, requireCompanyScope, async (req: Request, res: Response) => {
  const { target_currency, rate } = req.body as { target_currency: string; rate: number };
  if (!target_currency || rate == null) {
    return res.status(400).json({ error: 'target_currency and rate are required' });
  }
  if (typeof rate !== 'number' || rate <= 0) {
    return res.status(400).json({ error: 'rate must be a positive number' });
  }

  try {
    const companyId = req.user.company_id;
    // Allow write when there is a company override or a single company exists.
    let effectiveCompanyId = companyId;
    if (!effectiveCompanyId) {
      const { rows: companies } = await pool.query('SELECT id FROM companies ORDER BY created_at ASC LIMIT 1');
      if (rows.length === 0) return res.status(503).json({ error: 'No company exists' });
      if (rows.length > 1) return res.status(403).json({ error: 'Multiple companies exist; set INVOICE_COMPANY_ID or assign the account to a company.' });
      effectiveCompanyId = rows[0].id;
    }

    await pool.query(`
      INSERT INTO currency_rates (company_id, base_currency, target_currency, rate, effective_date)
      VALUES ($1, 'USD', $2, $3, NOW())
      ON CONFLICT (company_id, target_currency) DO UPDATE SET rate = $3, effective_date = NOW()
    `, [effectiveCompanyId, target_currency, rate]);

    auditLog(req.user, 'currency_rate_set', 'currency_rate', null, `${target_currency} ${rate}`);
    res.json({ success: true, company_id: effectiveCompanyId, target_currency, rate });
  } catch (e) {
    console.error('currency rate set failed:', (e as Error).message);
    res.status(500).json({ error: 'Failed to set currency rate' });
  }
});

export const router = Router();
router.use('/rates', requireAuth, requireCompanyScope, async (req: Request, res, next) => {
  // ensure company_id is available on req.user for downstream handlers
  if (req.user && req.user.company_id === undefined) {
    // fallback: look up the user's company from admin_users portal_company_id
    const { rows } = await pool.query('SELECT portal_company_id FROM admin_users WHERE id = $1', [req.user.id]);
    if (rows[0]?.portal_company_id) req.user.company_id = rows[0].portal_company_id;
  }
  next();
});