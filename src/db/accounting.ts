import type { PoolClient } from 'pg';
import { pool } from './pool';
import {
  VAT_RATE_PCT,
  extractVatInclusive,
  classifyEntryType,
  normalizeRail,
  buildCyclePnL,
  isPesepayRail,
  roundMoney,
  type LedgerEntryType,
  type LedgerRail,
  type CycleAmounts,
} from '../services/revenueCycle';

export interface LedgerWriteInput {
  companyId: string;
  entryType: LedgerEntryType;
  rail: LedgerRail;
  documentId?: string | null;
  paymentId?: number | null;
  reference?: string | null;
  description?: string | null;
  grossAmount: number;
  taxAmount?: number;
  netAmount?: number;
  cogsAmount?: number;
  currency?: string;
  occurredAt?: Date | string | null;
  metadata?: Record<string, unknown>;
}

export interface OverviewResult {
  totalGrossRevenue: number;
  netSales: number;
  taxCollected: number;
  grossProfit: number;
  outstandingAr: number;
  todayTill: number;
  mtdRevenue: number;
  stockValuation: number;
  cashTotal: number;
  pesepayTotal: number;
  byRail: Record<string, number>;
  vatRate: number;
}

export interface LedgerRow {
  id: string;
  entry_type: string;
  rail: string;
  document_id: string | null;
  payment_id: number | null;
  reference: string | null;
  description: string | null;
  gross_amount: number;
  tax_amount: number;
  net_amount: number;
  cogs_amount: number;
  currency: string;
  occurred_at: string;
  doc_number?: string | null;
  doc_type?: string | null;
}

type Queryable = Pick<typeof pool, 'query'> | PoolClient;

/**
 * Ensure stock for a document has been decremented exactly once.
 * Uses pos_documents.stock_applied as the idempotency flag.
 */
export async function ensureStockDecremented(
  client: PoolClient,
  documentId: string,
  companyId: string
): Promise<{ applied: boolean; lines: number }> {
  const docs = await client.query(
    `SELECT id, stock_applied FROM pos_documents
      WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [documentId, companyId]
  );
  if (docs.rows.length === 0) {
    return { applied: false, lines: 0 };
  }
  if (docs.rows[0].stock_applied === true) {
    return { applied: false, lines: 0 };
  }

  const items = await client.query(
    `SELECT product_id, qty FROM pos_document_items
      WHERE document_id = $1 AND product_id IS NOT NULL`,
    [documentId]
  );

  let lines = 0;
  for (const it of items.rows) {
    const qty = Number(it.qty) || 0;
    if (qty <= 0) continue;
    const prod = await client.query(
      `SELECT track_stock, stock_qty, name FROM pos_products WHERE id = $1 FOR UPDATE`,
      [it.product_id]
    );
    if (prod.rows.length === 0 || !prod.rows[0].track_stock) continue;
    await client.query(
      `UPDATE pos_products
          SET stock_qty = stock_qty - $1, updated_at = NOW()
        WHERE id = $2 AND track_stock = TRUE`,
      [qty, it.product_id]
    );
    lines += 1;
  }

  await client.query(
    `UPDATE pos_documents SET stock_applied = TRUE, updated_at = NOW() WHERE id = $1`,
    [documentId]
  );

  return { applied: true, lines };
}

/** Mark stock already applied (e.g. after POS checkout decremented inline). */
export async function markStockApplied(
  client: PoolClient,
  documentId: string
): Promise<void> {
  await client.query(
    `UPDATE pos_documents SET stock_applied = TRUE, updated_at = NOW() WHERE id = $1`,
    [documentId]
  );
}

/** Compute COGS for a document from linked product cost_price × qty. */
export async function computeDocumentCogs(
  client: Queryable,
  documentId: string
): Promise<number> {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(COALESCE(p.cost_price, 0) * i.qty), 0)::numeric AS cogs
       FROM pos_document_items i
       LEFT JOIN pos_products p ON p.id = i.product_id
      WHERE i.document_id = $1`,
    [documentId]
  );
  return roundMoney(rows[0]?.cogs);
}

/**
 * Idempotent ledger write. Unique on (company_id, document_id, payment_id, entry_type)
 * so Pesepay callbacks and checkout retries never double-post.
 */
export async function recordLedgerEntry(
  client: Queryable,
  input: LedgerWriteInput
): Promise<{ id: string; created: boolean }> {
  const taxPct = VAT_RATE_PCT;
  const split =
    input.taxAmount != null && input.netAmount != null
      ? {
          gross: roundMoney(input.grossAmount),
          tax: roundMoney(input.taxAmount),
          net: roundMoney(input.netAmount),
        }
      : extractVatInclusive(input.grossAmount, taxPct);

  const idempotencyKey = [
    input.companyId,
    input.documentId || 'none',
    input.paymentId != null ? String(input.paymentId) : 'none',
    input.entryType,
  ].join(':');

  const { rows } = await client.query(
    `INSERT INTO accounting_ledger
       (company_id, entry_type, rail, document_id, payment_id, reference, description,
        gross_amount, tax_amount, net_amount, cogs_amount, currency, occurred_at, metadata, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz, NOW()),$14::jsonb,$15)
     ON CONFLICT (idempotency_key)
       DO UPDATE SET description = EXCLUDED.description
     RETURNING id, (xmax = 0) AS inserted`,
    [
      input.companyId,
      input.entryType,
      input.rail,
      input.documentId || null,
      input.paymentId ?? null,
      input.reference || null,
      input.description || null,
      split.gross,
      split.tax,
      split.net,
      roundMoney(input.cogsAmount || 0),
      input.currency || 'USD',
      input.occurredAt || null,
      JSON.stringify(input.metadata || {}),
      idempotencyKey,
    ]
  );
  return { id: rows[0].id, created: Boolean(rows[0].inserted) };
}

/**
 * Record a sale/payment into the ledger and ensure stock is decremented.
 * Call inside an existing DB transaction after the payment row is written.
 */
export async function syncSaleToLedgerAndStock(
  client: PoolClient,
  opts: {
    companyId: string;
    documentId: string;
    paymentId?: number | null;
    amount: number;
    method: string;
    docType?: string | null;
    docNumber?: string | null;
    reference?: string | null;
    taxPct?: number;
    currency?: string;
    alreadyDecrementedStock?: boolean;
  }
): Promise<{ ledgerId: string; stockApplied: boolean }> {
  const rail = normalizeRail(opts.method);
  const entryType = classifyEntryType({ docType: opts.docType, method: opts.method });
  const split = extractVatInclusive(opts.amount, opts.taxPct ?? VAT_RATE_PCT);
  const cogs = await computeDocumentCogs(client, opts.documentId);

  // Pro-rate COGS to this payment share when the document total exceeds the payment.
  let cogsShare = cogs;
  const doc = await client.query(
    `SELECT total, tax_pct, currency FROM pos_documents WHERE id = $1`,
    [opts.documentId]
  );
  const docTotal = Number(doc.rows[0]?.total) || 0;
  if (docTotal > 0 && opts.amount < docTotal) {
    cogsShare = roundMoney((cogs * opts.amount) / docTotal);
  }

  const { id } = await recordLedgerEntry(client, {
    companyId: opts.companyId,
    entryType,
    rail,
    documentId: opts.documentId,
    paymentId: opts.paymentId ?? null,
    reference: opts.reference || null,
    description: `${opts.docType || 'sale'} ${opts.docNumber || opts.documentId} via ${rail}`,
    grossAmount: split.gross,
    taxAmount: split.tax,
    netAmount: split.net,
    cogsAmount: cogsShare,
    currency: opts.currency || doc.rows[0]?.currency || 'USD',
    metadata: { docType: opts.docType, method: opts.method },
  });

  let stockApplied = false;
  if (opts.alreadyDecrementedStock) {
    await markStockApplied(client, opts.documentId);
  } else {
    const stock = await ensureStockDecremented(client, opts.documentId, opts.companyId);
    stockApplied = stock.applied;
  }

  return { ledgerId: id, stockApplied };
}

function dateBounds(from?: string, to?: string): { fromSql: string; toSql: string; params: string[] } {
  const params: string[] = [];
  let fromSql = `-infinity`;
  let toSql = `infinity`;
  if (from) {
    params.push(from);
    fromSql = `$${params.length}::date`;
  }
  if (to) {
    params.push(to);
    toSql = `($${params.length}::date + INTERVAL '1 day')`;
  }
  return { fromSql, toSql, params };
}

export async function getAccountingOverview(
  companyId: string,
  opts: { from?: string; to?: string } = {}
): Promise<OverviewResult> {
  const { fromSql, toSql, params: dateParams } = dateBounds(opts.from, opts.to);
  const baseParams: unknown[] = [companyId, ...dateParams];
  // company is $1; date params follow
  const fromIdx = opts.from ? 2 : null;
  const toIdx = opts.to ? (opts.from ? 3 : 2) : null;
  const occurredClause =
    fromIdx || toIdx
      ? `AND l.occurred_at >= ${fromSql === '-infinity' ? `'-infinity'::timestamptz` : fromSql}
         AND l.occurred_at < ${toSql === 'infinity' ? `'infinity'::timestamptz` : toSql}`
      : '';

  const { rows: agg } = await pool.query(
    `SELECT
        COALESCE(SUM(l.gross_amount) FILTER (
          WHERE l.entry_type IN ('pos_sale','invoice_payment','pesepay_collection')
        ), 0)::numeric AS gross,
        COALESCE(SUM(l.tax_amount) FILTER (
          WHERE l.entry_type IN ('pos_sale','invoice_payment','pesepay_collection')
        ), 0)::numeric AS tax,
        COALESCE(SUM(l.net_amount) FILTER (
          WHERE l.entry_type IN ('pos_sale','invoice_payment','pesepay_collection')
        ), 0)::numeric AS net,
        COALESCE(SUM(l.cogs_amount) FILTER (
          WHERE l.entry_type IN ('pos_sale','invoice_payment','pesepay_collection')
        ), 0)::numeric AS cogs,
        COALESCE(SUM(l.gross_amount) FILTER (WHERE l.entry_type = 'credit_note'), 0)::numeric AS credits,
        COALESCE(SUM(l.gross_amount) FILTER (WHERE l.entry_type = 'expense'), 0)::numeric AS expenses
       FROM accounting_ledger l
      WHERE l.company_id = $1
        ${occurredClause}`,
    baseParams
  );

  const pnl = buildCyclePnL({
    grossRevenue: Number(agg[0]?.gross) || 0,
    creditNotes: Number(agg[0]?.credits) || 0,
    taxCollected: Number(agg[0]?.tax) || 0,
    cogs: Number(agg[0]?.cogs) || 0,
    expenses: Number(agg[0]?.expenses) || 0,
  });

  const { rows: ar } = await pool.query(
    `SELECT COALESCE(SUM(GREATEST(total - amount_paid, 0)), 0)::numeric AS outstanding
       FROM pos_documents
      WHERE company_id = $1
        AND doc_type IN ('invoice', 'sale')
        AND status IN ('unpaid', 'partial', 'sent')`,
    [companyId]
  );

  const { rows: today } = await pool.query(
    `SELECT COALESCE(SUM(gross_amount), 0)::numeric AS till
       FROM accounting_ledger
      WHERE company_id = $1
        AND entry_type IN ('pos_sale','invoice_payment','pesepay_collection')
        AND occurred_at >= CURRENT_DATE
        AND occurred_at < CURRENT_DATE + INTERVAL '1 day'`,
    [companyId]
  );

  const { rows: mtd } = await pool.query(
    `SELECT COALESCE(SUM(gross_amount), 0)::numeric AS revenue
       FROM accounting_ledger
      WHERE company_id = $1
        AND entry_type IN ('pos_sale','invoice_payment','pesepay_collection')
        AND occurred_at >= DATE_TRUNC('month', CURRENT_DATE)`,
    [companyId]
  );

  const { rows: stock } = await pool.query(
    `SELECT COALESCE(SUM(
        CASE WHEN track_stock THEN GREATEST(stock_qty, 0) * COALESCE(cost_price, 0) ELSE 0 END
      ), 0)::numeric AS valuation
       FROM pos_products
      WHERE active = TRUE`
  );

  const { rows: rails } = await pool.query(
    `SELECT rail, COALESCE(SUM(gross_amount), 0)::numeric AS amount
       FROM accounting_ledger
      WHERE company_id = $1
        AND entry_type IN ('pos_sale','invoice_payment','pesepay_collection')
        ${occurredClause.replace(/l\./g, '')}
      GROUP BY rail`,
    baseParams
  );

  const byRail: Record<string, number> = {};
  let cashTotal = 0;
  let pesepayTotal = 0;
  for (const r of rails) {
    const amt = roundMoney(r.amount);
    byRail[r.rail] = amt;
    if (isPesepayRail(r.rail)) pesepayTotal = roundMoney(pesepayTotal + amt);
    else cashTotal = roundMoney(cashTotal + amt);
  }

  return {
    totalGrossRevenue: pnl.grossRevenue,
    netSales: pnl.netSales,
    taxCollected: pnl.taxCollected,
    grossProfit: pnl.grossProfit,
    outstandingAr: roundMoney(ar[0]?.outstanding),
    todayTill: roundMoney(today[0]?.till),
    mtdRevenue: roundMoney(mtd[0]?.revenue),
    stockValuation: roundMoney(stock[0]?.valuation),
    cashTotal,
    pesepayTotal,
    byRail,
    vatRate: VAT_RATE_PCT,
  };
}

export async function getAccountingLedger(
  companyId: string,
  opts: { from?: string; to?: string; rail?: string; type?: string; limit?: number; offset?: number } = {}
): Promise<{ rows: LedgerRow[]; total: number }> {
  const clauses = ['l.company_id = $1'];
  const params: unknown[] = [companyId];
  if (opts.from) {
    params.push(opts.from);
    clauses.push(`l.occurred_at >= $${params.length}::date`);
  }
  if (opts.to) {
    params.push(opts.to);
    clauses.push(`l.occurred_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  if (opts.rail) {
    params.push(opts.rail.toLowerCase());
    clauses.push(`l.rail = $${params.length}`);
  }
  if (opts.type) {
    params.push(opts.type.toLowerCase());
    clauses.push(`l.entry_type = $${params.length}`);
  }
  const where = clauses.join(' AND ');
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM accounting_ledger l WHERE ${where}`,
    params
  );

  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT l.id, l.entry_type, l.rail, l.document_id, l.payment_id, l.reference,
            l.description, l.gross_amount, l.tax_amount, l.net_amount, l.cogs_amount,
            l.currency, l.occurred_at, d.doc_number, d.doc_type
       FROM accounting_ledger l
       LEFT JOIN pos_documents d ON d.id = l.document_id
      WHERE ${where}
      ORDER BY l.occurred_at DESC, l.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    total: count.rows[0]?.n || 0,
    rows: rows.map((r) => ({
      ...r,
      gross_amount: Number(r.gross_amount),
      tax_amount: Number(r.tax_amount),
      net_amount: Number(r.net_amount),
      cogs_amount: Number(r.cogs_amount),
    })),
  };
}

export async function getAccountingPnL(
  companyId: string,
  opts: { from?: string; to?: string } = {}
): Promise<CycleAmounts & { period: { from: string | null; to: string | null }; byChannel: Record<string, number> }> {
  const overview = await getAccountingOverview(companyId, opts);
  const { fromSql, toSql, params: dateParams } = dateBounds(opts.from, opts.to);
  const baseParams: unknown[] = [companyId, ...dateParams];
  const occurredClause =
    dateParams.length > 0
      ? `AND l.occurred_at >= ${fromSql === '-infinity' ? `'-infinity'::timestamptz` : fromSql}
         AND l.occurred_at < ${toSql === 'infinity' ? `'infinity'::timestamptz` : toSql}`
      : '';

  const { rows: credits } = await pool.query(
    `SELECT COALESCE(SUM(gross_amount), 0)::numeric AS v
       FROM accounting_ledger l
      WHERE company_id = $1 AND entry_type = 'credit_note' ${occurredClause}`,
    baseParams
  );
  const { rows: expenses } = await pool.query(
    `SELECT COALESCE(SUM(gross_amount), 0)::numeric AS v
       FROM accounting_ledger l
      WHERE company_id = $1 AND entry_type = 'expense' ${occurredClause}`,
    baseParams
  );
  const { rows: cogs } = await pool.query(
    `SELECT COALESCE(SUM(cogs_amount), 0)::numeric AS v
       FROM accounting_ledger l
      WHERE company_id = $1
        AND entry_type IN ('pos_sale','invoice_payment','pesepay_collection')
        ${occurredClause}`,
    baseParams
  );
  const { rows: channels } = await pool.query(
    `SELECT COALESCE(d.channel, 'unknown') AS channel,
            COALESCE(SUM(l.gross_amount), 0)::numeric AS amount
       FROM accounting_ledger l
       LEFT JOIN pos_documents d ON d.id = l.document_id
      WHERE l.company_id = $1
        AND l.entry_type IN ('pos_sale','invoice_payment','pesepay_collection')
        ${occurredClause}
      GROUP BY 1`,
    baseParams
  );

  const pnl = buildCyclePnL({
    grossRevenue: overview.totalGrossRevenue,
    creditNotes: Number(credits[0]?.v) || 0,
    taxCollected: overview.taxCollected,
    cogs: Number(cogs[0]?.v) || 0,
    expenses: Number(expenses[0]?.v) || 0,
  });

  const byChannel: Record<string, number> = {};
  for (const c of channels) byChannel[c.channel] = roundMoney(c.amount);

  return {
    ...pnl,
    period: { from: opts.from || null, to: opts.to || null },
    byChannel,
  };
}

export async function getTaxSummary(
  companyId: string,
  opts: { from?: string; to?: string } = {}
): Promise<{
  vatRate: number;
  posReceipts: { gross: number; vat: number; net: number; count: number };
  taxInvoices: { gross: number; vat: number; net: number; count: number };
  totalVatLiability: number;
}> {
  const { fromSql, toSql, params: dateParams } = dateBounds(opts.from, opts.to);
  const baseParams: unknown[] = [companyId, ...dateParams];
  const occurredClause =
    dateParams.length > 0
      ? `AND l.occurred_at >= ${fromSql === '-infinity' ? `'-infinity'::timestamptz` : fromSql}
         AND l.occurred_at < ${toSql === 'infinity' ? `'infinity'::timestamptz` : toSql}`
      : '';

  const { rows } = await pool.query(
    `SELECT
        CASE WHEN COALESCE(d.doc_type, 'sale') = 'sale' THEN 'pos' ELSE 'invoice' END AS bucket,
        COUNT(*)::int AS count,
        COALESCE(SUM(l.gross_amount), 0)::numeric AS gross,
        COALESCE(SUM(l.tax_amount), 0)::numeric AS vat,
        COALESCE(SUM(l.net_amount), 0)::numeric AS net
       FROM accounting_ledger l
       LEFT JOIN pos_documents d ON d.id = l.document_id
      WHERE l.company_id = $1
        AND l.entry_type IN ('pos_sale','invoice_payment','pesepay_collection')
        ${occurredClause}
      GROUP BY 1`,
    baseParams
  );

  const empty = { gross: 0, vat: 0, net: 0, count: 0 };
  const posReceipts = { ...empty };
  const taxInvoices = { ...empty };
  for (const r of rows) {
    const target = r.bucket === 'pos' ? posReceipts : taxInvoices;
    target.gross = roundMoney(r.gross);
    target.vat = roundMoney(r.vat);
    target.net = roundMoney(r.net);
    target.count = Number(r.count) || 0;
  }

  return {
    vatRate: VAT_RATE_PCT,
    posReceipts,
    taxInvoices,
    totalVatLiability: roundMoney(posReceipts.vat + taxInvoices.vat),
  };
}
