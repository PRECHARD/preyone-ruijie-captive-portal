import type { PoolClient } from 'pg';

/**
 * Document (invoice / POS sale) settlement.
 *
 * One payment confirmation — whichever surface produced it (Pesepay webhook,
 * status poll, or a manual payment recorded at the till) — must leave the same
 * four facts behind, atomically:
 *
 *   1. the document's `amount_paid` / `status` are advanced,
 *   2. the money is booked in the `sales` ledger,
 *   3. tracked stock is decremented exactly once,
 *   4. the caller can broadcast the resulting movements to dashboards.
 *
 * Money safety properties:
 *   • the document row is locked (`FOR UPDATE`), so two workers cannot settle
 *     the same invoice concurrently;
 *   • the ledger insert is idempotent on `(document_id, payment_reference)`;
 *   • stock is gated by `pos_documents.stock_applied_at`, so a replayed
 *     webhook, a poll that races it, or a second manual payment never
 *     decrements twice;
 *   • a document already `paid` at creation (till checkout) sets
 *     `stock_applied_at` up front, so settlement skips its stock entirely.
 *
 * Nothing here commits: the caller owns the transaction and must broadcast
 * only after a successful COMMIT.
 */

export interface StockMovement {
  productId: string;
  name: string;
  sku: string | null;
  qty: number;
  previous: number;
  next: number;
  lowStockThreshold: number;
  lowStock: boolean;
}

export interface DocumentSettlement {
  documentId: string;
  documentNumber: string;
  companyId: string | null;
  status: string;
  amountPaid: number;
  total: number;
  currency: string;
  paymentMethod: string;
  /** True when this call was the one that first moved the document to paid. */
  transitionedToPaid: boolean;
  /** False when the ledger row already existed for this reference. */
  saleRecorded: boolean;
  saleId: string | null;
  stockApplied: boolean;
  stockMovements: StockMovement[];
}

export interface SettleDocumentInput {
  documentId: string;
  /** Amount received by this payment (not the document total). */
  amount: number;
  paymentMethod: string;
  /** Gateway reference, or a stable id for a manually recorded payment. */
  paymentReference: string;
  /** When the money was received. Defaults to now. */
  paidAt?: Date;
  /** Admin that took the payment, when known (manual till payment). */
  soldById?: string | null;
  soldByName?: string | null;
  /** Set false when the caller has already applied stock (till checkout). */
  applyStock?: boolean;
}

const RAIL_LABELS: Record<string, string> = {
  ecocash: 'EcoCash',
  innbucks: 'InnBucks',
  innbucks_usd: 'InnBucks',
  omari: 'Omari',
  omari_usd: 'Omari',
  paygo: 'PayGo',
  cash: 'Cash',
  card: 'Card',
  bank: 'Bank',
  pesepay: 'Pesepay',
  on_account: 'On Account',
  other: 'Other',
};

/** Present a gateway rail code the way the ledger/report expects it. */
export function ledgerPaymentMethod(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim();
  if (!value) return 'Cash';
  const lower = value.toLowerCase();
  if (RAIL_LABELS[lower]) return RAIL_LABELS[lower];
  // Gateways return labels like 'EcoCash (Pesepay)'.
  if (lower.includes('ecocash')) return 'EcoCash';
  if (lower.includes('innbucks') || lower.includes('inn bucks')) return 'InnBucks';
  if (lower.includes('omari')) return 'Omari';
  if (lower.includes('paygo') || lower.includes('pay go')) return 'PayGo';
  return value;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Same rule as `statusForPaid` in routes/pos.ts. */
function statusFor(total: number, paid: number, current: string): string {
  if (current === 'void') return 'void';
  if (total > 0 && paid >= total - 0.005) return 'paid';
  if (paid > 0) return 'partial';
  return current === 'paid' ? 'unpaid' : current;
}

/**
 * Advance a document by one payment and record every side effect.
 *
 * Runs inside the caller's transaction; the caller must ROLLBACK on throw.
 */
export async function settleDocumentPayment(
  client: PoolClient,
  input: SettleDocumentInput
): Promise<DocumentSettlement> {
  const { rows } = await client.query(
    `SELECT id, doc_number, company_id, total, amount_paid, status,
            currency, exchange_rate, stock_applied_at, cashier_id
       FROM pos_documents
      WHERE id = $1
      FOR UPDATE`,
    [input.documentId]
  );

  if (rows.length === 0) {
    throw new Error('Document not found');
  }

  const doc = rows[0];
  const amount = round2(Math.max(0, Number(input.amount) || 0));
  const total = round2(Number(doc.total) || 0);
  const priorPaid = round2(Number(doc.amount_paid) || 0);
  const nextPaid = Math.min(total, round2(priorPaid + amount));
  const priorStatus = String(doc.status);
  const nextStatus = statusFor(total, nextPaid, priorStatus);
  const transitionedToPaid = priorStatus !== 'paid' && nextStatus === 'paid';
  const currency = String(doc.currency || 'USD').toUpperCase();

  // ── 1. Stock (first paid transition only) ────────────────────────────────
  let stockApplied = false;
  const stockMovements: StockMovement[] = [];
  const shouldApplyStock = input.applyStock !== false && doc.stock_applied_at == null;

  if (shouldApplyStock && transitionedToPaid) {
    const items = await client.query(
      `SELECT i.product_id, SUM(i.qty) AS qty
         FROM pos_document_items i
        WHERE i.document_id = $1 AND i.product_id IS NOT NULL
        GROUP BY i.product_id`,
      [doc.id]
    );

    for (const item of items.rows) {
      const qty = Number(item.qty) || 0;
      if (qty <= 0) continue;
      // Row-lock the product, floor at zero, and read the threshold in one
      // statement so the response describes exactly what the writes did.
      const moved = await client.query(
        `UPDATE pos_products
            SET stock_qty = GREATEST(0, stock_qty - $1),
                updated_at = NOW()
          WHERE id = $2 AND track_stock = TRUE
          RETURNING id, name, sku, stock_qty + $1 AS previous_qty,
                    stock_qty AS next_qty, low_stock_threshold`,
        [qty, item.product_id]
      );
      const row = moved.rows[0];
      if (!row) continue;
      const next = Number(row.next_qty) || 0;
      stockMovements.push({
        productId: row.id,
        name: row.name,
        sku: row.sku ?? null,
        qty,
        previous: Number(row.previous_qty) || 0,
        next,
        lowStockThreshold: Number(row.low_stock_threshold) || 0,
        lowStock: next <= (Number(row.low_stock_threshold) || 0),
      });
    }
    stockApplied = true;
  }

  // ── 2. Document state ────────────────────────────────────────────────────
  const updated = await client.query(
    `UPDATE pos_documents
        SET amount_paid = $2,
            status = $3,
            stock_applied_at = CASE WHEN $4::boolean THEN NOW() ELSE stock_applied_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING status, amount_paid`,
    [doc.id, nextPaid, nextStatus, stockApplied]
  );

  // ── 3. Sales ledger (idempotent per payment reference) ───────────────────
  const method = ledgerPaymentMethod(input.paymentMethod);
  const soldAt = input.paidAt ?? new Date();
  const soldById = input.soldById ?? doc.cashier_id ?? null;

  let soldByName = input.soldByName ?? null;
  if (!soldByName && soldById) {
    const owner = await client.query(
      'SELECT full_name FROM admin_users WHERE id = $1 LIMIT 1',
      [soldById]
    );
    soldByName = owner.rows[0]?.full_name ?? null;
  }

  const sale = await client.query(
    `INSERT INTO sales
       (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency,
        payment_method, payment_reference, sold_at, document_id, source)
     VALUES (NULL, NULL, $1, $2, $3, $4, $5, $6, $7, $8, 'invoice')
     ON CONFLICT (document_id, payment_reference)
       WHERE document_id IS NOT NULL AND payment_reference IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      soldById,
      soldByName,
      amount,
      currency,
      method,
      input.paymentReference,
      soldAt,
      doc.id,
    ]
  );

  return {
    documentId: doc.id,
    documentNumber: doc.doc_number,
    companyId: doc.company_id ?? null,
    status: String(updated.rows[0]?.status ?? nextStatus),
    amountPaid: round2(Number(updated.rows[0]?.amount_paid ?? nextPaid)),
    total,
    currency,
    paymentMethod: method,
    transitionedToPaid,
    saleRecorded: sale.rows.length > 0,
    saleId: sale.rows[0]?.id ?? null,
    stockApplied,
    stockMovements,
  };
}

/**
 * Low-stock snapshot, used by the dashboards' stock cards and to enrich the
 * post-settlement telemetry event. `pos_products` is a single catalogue (it
 * has no company_id column), so this is deliberately not tenant-filtered —
 * matching the existing `/products/low-stock` queries in routes/pos.ts.
 */
export async function listLowStock(
  client: Pick<PoolClient, 'query'>,
  limit = 20
): Promise<Array<{ id: string; name: string; sku: string | null; stockQty: number; lowStockThreshold: number }>> {
  const { rows } = await client.query(
    `SELECT id, name, sku, stock_qty, low_stock_threshold
       FROM pos_products
      WHERE active = TRUE AND track_stock = TRUE
        AND stock_qty <= low_stock_threshold
      ORDER BY (stock_qty - low_stock_threshold) ASC, name ASC
      LIMIT $1`,
    [limit]
  );
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    sku: r.sku ?? null,
    stockQty: Number(r.stock_qty) || 0,
    lowStockThreshold: Number(r.low_stock_threshold) || 0,
  }));
}
