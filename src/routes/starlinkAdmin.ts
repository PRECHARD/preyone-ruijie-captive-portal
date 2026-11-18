import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { requireAdminAuth, requireRole } from '../middleware/adminAuth';
import { getPlanCapacity } from '../db/starlink';
import { STARLINK_PLANS, getStarlinkPlan } from '../plans/starlinkPlans';
import {
  approvePlanApplication,
  rejectPlanApplication,
  PlanApplicationError,
} from '../services/starlinkPlanApplications';

/**
 * Admin console API for the Starlink customer book.
 *
 * Mounted at `/api/admin/starlink`. Reads and writes ONLY starlink_* tables.
 * WiFi, POS and transit tables are never referenced here.
 */
export const starlinkAdminRouter = Router();

starlinkAdminRouter.use(requireAdminAuth);
starlinkAdminRouter.use(requireRole('Manager', 'CEO'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INVOICE_KINDS = ['wallet_topup', 'data_topup', 'kit_purchase', 'service'];
const INVOICE_STATUSES = ['PENDING', 'PAID', 'FAILED'];
const KIT_STATUSES = ['active', 'paused'];
const MAX_CAPACITY = 100000;

function actorName(req: Request): string {
  const actor = req.adminUser;
  return String(actor?.fullName || actor?.email || 'admin');
}

function queryString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, '\\$&')}%`;
}

function money(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

function sendError(res: Response, label: string, err: unknown): void {
  if (err instanceof PlanApplicationError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(`Starlink admin ${label} error:`, err);
  res.status(500).json({ error: 'Starlink admin request failed' });
}

starlinkAdminRouter.get('/overview', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM starlink_customers) AS total_customers,
         (SELECT COUNT(*)::int FROM starlink_customers WHERE email_verified_at IS NOT NULL) AS verified_customers,
         (SELECT COUNT(*)::int FROM starlink_customers WHERE plan_code IS NOT NULL) AS customers_with_plan,
         (SELECT COUNT(*)::int FROM starlink_kits WHERE status = 'active') AS active_kits,
         (SELECT COUNT(*)::int FROM starlink_plan_applications WHERE status = 'PENDING') AS pending_applications,
         (SELECT COALESCE(SUM(amount), 0) FROM starlink_invoices
            WHERE status = 'PAID' AND paid_at >= date_trunc('month', NOW())) AS paid_this_month,
         (SELECT COUNT(*)::int FROM starlink_invoices WHERE status = 'PENDING') AS pending_invoices_count,
         (SELECT COALESCE(SUM(amount), 0) FROM starlink_invoices WHERE status = 'PENDING') AS pending_invoices_usd`
    );
    const { rows: planRows } = await pool.query(
      `SELECT plan_code, COUNT(*)::int AS n FROM starlink_customers WHERE plan_code IS NOT NULL GROUP BY plan_code`
    );
    const countByPlan = new Map<string, number>(planRows.map((r: any) => [String(r.plan_code), Number(r.n)]));
    const byPlan = STARLINK_PLANS.map((p) => ({
      code: p.code,
      name: p.name,
      priceUsd: p.priceUsd,
      subscribers: countByPlan.get(p.code) ?? 0,
    }));
    const mrr = byPlan.reduce((sum, p) => sum + p.priceUsd * p.subscribers, 0);
    const r = rows[0];
    res.json({
      totalCustomers: Number(r.total_customers),
      verifiedCustomers: Number(r.verified_customers),
      customersWithPlan: Number(r.customers_with_plan),
      activeKits: Number(r.active_kits),
      pendingApplications: Number(r.pending_applications),
      paidThisMonthUsd: money(r.paid_this_month),
      pendingInvoices: { count: Number(r.pending_invoices_count), usd: money(r.pending_invoices_usd) },
      monthlyRecurringUsd: money(mrr),
      byPlan,
    });
  } catch (err) {
    sendError(res, 'overview', err);
  }
});

starlinkAdminRouter.get('/customers', async (req: Request, res: Response) => {
  try {
    const search = queryString(req.query.search);
    const plan = queryString(req.query.plan);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) {
      params.push(likePattern(search));
      const p = `$${params.length}`;
      conditions.push(`(c.full_name ILIKE ${p} OR c.email ILIKE ${p} OR c.phone ILIKE ${p})`);
    }
    if (plan === 'none') {
      conditions.push('c.plan_code IS NULL');
    } else if (plan) {
      params.push(plan);
      conditions.push(`c.plan_code = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT c.id, c.full_name, c.email, c.phone, c.plan_code, c.email_verified_at,
              c.wallet_balance, c.created_at,
              (SELECT COUNT(*)::int FROM starlink_kits k WHERE k.customer_id = c.id) AS kit_count
         FROM starlink_customers c
         ${where}
        ORDER BY c.created_at DESC
        LIMIT 500`,
      params
    );
    res.json(
      rows.map((r: any) => ({
        id: r.id,
        fullName: r.full_name,
        email: r.email,
        phone: r.phone,
        planCode: r.plan_code,
        planName: getStarlinkPlan(r.plan_code)?.name ?? null,
        emailVerifiedAt: r.email_verified_at,
        walletBalance: money(r.wallet_balance),
        kitCount: Number(r.kit_count),
        createdAt: r.created_at,
      }))
    );
  } catch (err) {
    sendError(res, 'customers', err);
  }
});

starlinkAdminRouter.get('/customers/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (!UUID_RE.test(id)) { res.status(404).json({ error: 'Customer not found' }); return; }
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, plan_code, to_char(plan_renews_at, 'YYYY-MM-DD') AS plan_renews_at,
              email_verified_at, wallet_balance, created_at
         FROM starlink_customers WHERE id = $1`,
      [id]
    );
    const c = rows[0];
    if (!c) { res.status(404).json({ error: 'Customer not found' }); return; }

    const [kits, invoices, applications] = await Promise.all([
      pool.query(
        `SELECT id, kit_number, nickname, data_usage_gb, data_credit_gb, status, created_at
           FROM starlink_kits WHERE customer_id = $1 ORDER BY created_at ASC`,
        [id]
      ),
      pool.query(
        `SELECT id, invoice_number, amount, currency, description, kind, status, pese_reference,
                to_char(issued_date, 'YYYY-MM-DD') AS issued_date, to_char(due_date, 'YYYY-MM-DD') AS due_date,
                paid_at, created_at
           FROM starlink_invoices WHERE customer_id = $1
          ORDER BY created_at DESC LIMIT 20`,
        [id]
      ),
      pool.query(
        `SELECT id, from_plan_code, to_plan_code, to_char(requested_start, 'YYYY-MM-DD') AS requested_start,
                status, decided_at, decided_by, decision_note, created_at
           FROM starlink_plan_applications WHERE customer_id = $1
          ORDER BY created_at DESC LIMIT 20`,
        [id]
      ),
    ]);

    res.json({
      id: c.id,
      fullName: c.full_name,
      email: c.email,
      phone: c.phone,
      planCode: c.plan_code,
      planName: getStarlinkPlan(c.plan_code)?.name ?? null,
      planRenewsAt: c.plan_renews_at,
      emailVerifiedAt: c.email_verified_at,
      walletBalance: money(c.wallet_balance),
      createdAt: c.created_at,
      kits: kits.rows.map(mapKit),
      invoices: invoices.rows.map(mapInvoice),
      applications: applications.rows.map(mapApplication),
    });
  } catch (err) {
    sendError(res, 'customer detail', err);
  }
});

function mapKit(r: any) {
  return {
    id: r.id,
    customerId: r.customer_id,
    customerName: r.customer_name ?? undefined,
    customerEmail: r.customer_email ?? undefined,
    kitNumber: r.kit_number,
    nickname: r.nickname,
    status: r.status,
    dataUsageGb: Number(r.data_usage_gb),
    dataCreditGb: Number(r.data_credit_gb),
    createdAt: r.created_at,
  };
}

function mapInvoice(r: any) {
  return {
    id: r.id,
    invoiceNumber: r.invoice_number,
    customerId: r.customer_id,
    customerName: r.customer_name ?? undefined,
    customerEmail: r.customer_email ?? undefined,
    amount: money(r.amount),
    currency: r.currency,
    description: r.description,
    kind: r.kind,
    status: r.status,
    paymentReference: r.pese_reference ?? null,
    issuedDate: r.issued_date,
    dueDate: r.due_date,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  };
}

function mapApplication(r: any) {
  return {
    id: r.id,
    customerId: r.customer_id ?? undefined,
    customerName: r.customer_name ?? undefined,
    customerEmail: r.customer_email ?? undefined,
    customerPhone: r.customer_phone ?? undefined,
    fromPlanCode: r.from_plan_code,
    fromPlanName: r.from_plan_code ? getStarlinkPlan(r.from_plan_code)?.name ?? r.from_plan_code : null,
    toPlanCode: r.to_plan_code,
    toPlanName: getStarlinkPlan(r.to_plan_code)?.name ?? r.to_plan_code,
    requestedStart: r.requested_start,
    status: r.status,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
  };
}

starlinkAdminRouter.get('/applications', async (req: Request, res: Response) => {
  try {
    const status = queryString(req.query.status).toUpperCase() || 'ALL';
    if (status !== 'ALL' && !['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
      res.status(400).json({ error: 'Invalid status filter' });
      return;
    }
    const params: unknown[] = [];
    let where = '';
    if (status !== 'ALL') {
      params.push(status);
      where = `WHERE a.status = $1`;
    }
    const { rows } = await pool.query(
      `SELECT a.id, a.customer_id, c.full_name AS customer_name, c.email AS customer_email,
              c.phone AS customer_phone, a.from_plan_code, a.to_plan_code,
              to_char(a.requested_start, 'YYYY-MM-DD') AS requested_start, a.status,
              a.decided_at, a.decided_by, a.decision_note, a.created_at
         FROM starlink_plan_applications a
         JOIN starlink_customers c ON c.id = a.customer_id
         ${where}
        ORDER BY (a.status = 'PENDING') DESC, a.created_at DESC
        LIMIT 500`,
      params
    );
    res.json(rows.map(mapApplication));
  } catch (err) {
    sendError(res, 'applications', err);
  }
});

starlinkAdminRouter.post('/applications/:id/approve', async (req: Request, res: Response) => {
  try {
    if (!UUID_RE.test(req.params.id)) { res.status(404).json({ error: 'Application not found' }); return; }
    await approvePlanApplication(req.params.id, actorName(req));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 'approve application', err);
  }
});

starlinkAdminRouter.post('/applications/:id/reject', async (req: Request, res: Response) => {
  try {
    if (!UUID_RE.test(req.params.id)) { res.status(404).json({ error: 'Application not found' }); return; }
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (note.length < 3) { res.status(400).json({ error: 'Enter a short note for the customer' }); return; }
    await rejectPlanApplication(req.params.id, actorName(req), note);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 'reject application', err);
  }
});

interface TransactionFilters {
  kind: string;
  status: string;
  from: string;
  to: string;
}

function parseTransactionFilters(query: Request['query']): TransactionFilters | string {
  const kind = queryString(query.kind);
  const status = queryString(query.status).toUpperCase();
  const from = queryString(query.from);
  const to = queryString(query.to);
  if (kind && !INVOICE_KINDS.includes(kind)) return 'Invalid kind filter';
  if (status && !INVOICE_STATUSES.includes(status)) return 'Invalid status filter';
  if (from && !DATE_RE.test(from)) return 'Invalid start date';
  if (to && !DATE_RE.test(to)) return 'Invalid end date';
  return { kind, status, from, to };
}

async function queryTransactions(filters: TransactionFilters, limit: number) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.kind) {
    params.push(filters.kind);
    conditions.push(`i.kind = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`i.status = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    conditions.push(`i.created_at >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`i.created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT i.id, i.invoice_number, i.customer_id, c.full_name AS customer_name, c.email AS customer_email,
            i.amount, i.currency, i.description, i.kind, i.status, i.pese_reference,
            to_char(i.issued_date, 'YYYY-MM-DD') AS issued_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
            i.paid_at, i.created_at
       FROM starlink_invoices i
       JOIN starlink_customers c ON c.id = i.customer_id
       ${where}
      ORDER BY i.created_at DESC
      LIMIT ${limit}`,
    params
  );
  return rows.map(mapInvoice);
}

starlinkAdminRouter.get('/transactions', async (req: Request, res: Response) => {
  try {
    const filters = parseTransactionFilters(req.query);
    if (typeof filters === 'string') { res.status(400).json({ error: filters }); return; }
    res.json(await queryTransactions(filters, 1000));
  } catch (err) {
    sendError(res, 'transactions', err);
  }
});

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

starlinkAdminRouter.get('/transactions.csv', async (req: Request, res: Response) => {
  try {
    const filters = parseTransactionFilters(req.query);
    if (typeof filters === 'string') { res.status(400).json({ error: filters }); return; }
    const rows = await queryTransactions(filters, 50000);
    const header = [
      'invoice_number', 'issued_date', 'paid_at', 'customer_name', 'customer_email',
      'kind', 'description', 'amount_usd', 'status', 'payment_reference',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.invoiceNumber, r.issuedDate, r.paidAt, r.customerName, r.customerEmail,
        r.kind, r.description, r.amount, r.status, r.paymentReference,
      ].map(csvCell).join(','));
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="starlink-transactions-${stamp}.csv"`);
    res.send('\ufeff' + lines.join('\r\n') + '\r\n');
  } catch (err) {
    sendError(res, 'transactions csv', err);
  }
});

starlinkAdminRouter.get('/kits', async (req: Request, res: Response) => {
  try {
    const search = queryString(req.query.search);
    const params: unknown[] = [];
    let where = '';
    if (search) {
      params.push(likePattern(search));
      const p = `$${params.length}`;
      where = `WHERE (k.kit_number ILIKE ${p} OR k.nickname ILIKE ${p} OR c.full_name ILIKE ${p} OR c.email ILIKE ${p})`;
    }
    const { rows } = await pool.query(
      `SELECT k.id, k.customer_id, c.full_name AS customer_name, c.email AS customer_email,
              k.kit_number, k.nickname, k.status, k.data_usage_gb, k.data_credit_gb, k.created_at
         FROM starlink_kits k
         JOIN starlink_customers c ON c.id = k.customer_id
         ${where}
        ORDER BY k.created_at DESC
        LIMIT 500`,
      params
    );
    res.json(rows.map(mapKit));
  } catch (err) {
    sendError(res, 'kits', err);
  }
});

starlinkAdminRouter.patch('/kits/:id', async (req: Request, res: Response) => {
  try {
    if (!UUID_RE.test(req.params.id)) { res.status(404).json({ error: 'Kit not found' }); return; }
    const status = typeof req.body?.status === 'string' ? req.body.status.trim() : '';
    if (!KIT_STATUSES.includes(status)) { res.status(400).json({ error: 'Status must be active or paused' }); return; }
    const { rows } = await pool.query(
      `UPDATE starlink_kits k SET status = $2
         FROM starlink_customers c
        WHERE k.id = $1 AND c.id = k.customer_id
        RETURNING k.id, k.customer_id, c.full_name AS customer_name, c.email AS customer_email,
                  k.kit_number, k.nickname, k.status, k.data_usage_gb, k.data_credit_gb, k.created_at`,
      [req.params.id, status]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Kit not found' }); return; }
    res.json(mapKit(rows[0]));
  } catch (err) {
    sendError(res, 'update kit', err);
  }
});

starlinkAdminRouter.get('/plans', async (_req: Request, res: Response) => {
  try {
    const plans = await Promise.all(
      STARLINK_PLANS.map(async (p) => {
        const cap = await getPlanCapacity(p.code);
        return {
          code: p.code,
          name: p.name,
          priceUsd: p.priceUsd,
          cadence: p.cadence,
          rank: p.rank,
          perks: p.perks,
          capacity: cap.capacity,
          active: cap.active,
          seatsLeft: Math.max(0, cap.capacity - cap.active),
        };
      })
    );
    res.json(plans);
  } catch (err) {
    sendError(res, 'plans', err);
  }
});

starlinkAdminRouter.put('/plans/:code/capacity', async (req: Request, res: Response) => {
  try {
    const plan = getStarlinkPlan(req.params.code);
    if (!plan) { res.status(404).json({ error: 'Package not found' }); return; }
    const raw = req.body?.capacity;
    const capacity = typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : raw;
    if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 0 || capacity > MAX_CAPACITY) {
      res.status(400).json({ error: `Capacity must be a whole number between 0 and ${MAX_CAPACITY.toLocaleString('en-US')}` });
      return;
    }
    const current = await getPlanCapacity(plan.code);
    if (capacity < current.active) {
      res.status(409).json({ error: `Capacity cannot be below the ${current.active} active subscriber(s) on ${plan.name}` });
      return;
    }
    await pool.query(
      `INSERT INTO starlink_plan_capacity (plan_code, capacity, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (plan_code) DO UPDATE SET capacity = EXCLUDED.capacity, updated_at = NOW()`,
      [plan.code, capacity]
    );
    const cap = await getPlanCapacity(plan.code);
    res.json({
      code: plan.code,
      name: plan.name,
      priceUsd: plan.priceUsd,
      capacity: cap.capacity,
      active: cap.active,
      seatsLeft: Math.max(0, cap.capacity - cap.active),
    });
  } catch (err) {
    sendError(res, 'plan capacity', err);
  }
});
