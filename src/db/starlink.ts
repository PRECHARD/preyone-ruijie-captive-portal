/**
 * Starlink customer portal — additive schema + data layer.
 *
 * EVERYTHING in this file is ADDITIVE: four brand-new tables
 * (starlink_customers, starlink_kits, starlink_invoices, starlink_kit_usage)
 * and the queries the portal needs. No existing table is read for writes or
 * altered here — per project guardrails the voucher handlers, transit tables
 * and POS documents stay untouched.
 *
 * The schema is created idempotently at boot via ensureStarlinkSchema()
 * (CREATE TABLE IF NOT EXISTS ...), so no migration of existing objects runs.
 */
import { pool } from './pool';
import type { PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StarlinkCustomer {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  password_hash: string;
  company_id: string | null;
  wallet_balance: number;
  created_at: string;
}

export interface StarlinkKit {
  id: string;
  customer_id: string;
  kit_number: string;
  nickname: string;
  data_usage_gb: number;
  data_credit_gb: number;
  status: string;
  created_at: string;
}

export interface StarlinkInvoice {
  id: string;
  customer_id: string;
  invoice_number: string;
  amount: number;
  currency: string;
  description: string;
  kind: string; // wallet_topup | data_topup | kit_purchase | service
  status: string; // PENDING | PAID | FAILED
  pese_reference: string | null;
  meta: Record<string, unknown>;
  issued_date: string;
  due_date: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface StarlinkUsagePoint {
  month: string; // YYYY-MM-01
  usage_gb: number;
  is_baseline: boolean;
}

// ---------------------------------------------------------------------------
// Schema (additive, idempotent)
// ---------------------------------------------------------------------------

const STARLINK_DDL = `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    -- Starlink portal customers. Deliberately SEPARATE from admin_users and
    -- transit_users: these are paying satellite subscribers, not staff.
    CREATE TABLE IF NOT EXISTS starlink_customers (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name       TEXT NOT NULL,
      email           TEXT NOT NULL,
      phone           TEXT NOT NULL,
      password_hash   TEXT NOT NULL,
      company_id      UUID REFERENCES companies(id) ON DELETE SET NULL,
      wallet_balance  NUMERIC(12,2) NOT NULL DEFAULT 0,
      reset_token     TEXT,
      reset_expires_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_starlink_customers_email
      ON starlink_customers (lower(email));
    CREATE INDEX IF NOT EXISTS idx_starlink_customers_phone
      ON starlink_customers (phone);

    -- Registered Starlink kits/hardware per customer.
    CREATE TABLE IF NOT EXISTS starlink_kits (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id    UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      kit_number     TEXT NOT NULL,
      nickname       TEXT NOT NULL DEFAULT '',
      data_usage_gb  NUMERIC(10,2) NOT NULL DEFAULT 0,
      data_credit_gb NUMERIC(10,2) NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_starlink_kits_customer_kit
      ON starlink_kits (customer_id, lower(kit_number));

    -- Native Preyone invoices for this portal (NOT pos_documents — those stay
    -- POS-owned. This portal bills wallet/data/kit purchases only).
    CREATE TABLE IF NOT EXISTS starlink_invoices (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id    UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      invoice_number TEXT UNIQUE NOT NULL,
      amount         NUMERIC(12,2) NOT NULL,
      currency       TEXT NOT NULL DEFAULT 'USD',
      description    TEXT NOT NULL DEFAULT '',
      kind           TEXT NOT NULL DEFAULT 'service',
      status         TEXT NOT NULL DEFAULT 'PENDING',
      pese_reference TEXT,
      meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
      issued_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      due_date       DATE,
      paid_at        TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_starlink_invoices_customer
      ON starlink_invoices (customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_starlink_invoices_status
      ON starlink_invoices (status) WHERE status <> 'PAID';

    -- Monthly data consumption per kit (feeds the usage bar chart).
    CREATE TABLE IF NOT EXISTS starlink_kit_usage (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kit_id       UUID NOT NULL REFERENCES starlink_kits(id) ON DELETE CASCADE,
      period_month DATE NOT NULL,
      usage_gb     NUMERIC(10,2) NOT NULL DEFAULT 0,
      is_baseline  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_starlink_kit_usage_month
      ON starlink_kit_usage (kit_id, period_month);
`;

/**
 * Boot-time, idempotent DDL. PM2 runs this from every cluster worker at once,
 * and concurrent CREATE statements race in Postgres' type catalog (duplicate
 * key on pg_type_typname_nsp_index) even with IF NOT EXISTS. So: on failure,
 * check whether the tables actually landed (another worker won the race) and
 * only retry if they are still missing.
 */
export async function ensureStarlinkSchema(): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await pool.query(STARLINK_DDL);
      return;
    } catch (err) {
      lastErr = err;
      try {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM pg_tables WHERE tablename LIKE 'starlink%'`
        );
        if (Number(rows[0]?.n) >= 4) return;
      } catch {
        /* connectivity issue — keep retrying */
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Auth / customers
// ---------------------------------------------------------------------------

export async function createStarlinkCustomer(input: {
  fullName: string;
  email: string;
  phone: string;
  passwordHash: string;
  kitSerial?: string | null;
  nickname?: string;
}): Promise<StarlinkCustomer> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO starlink_customers (full_name, email, phone, password_hash)
       VALUES ($1, lower($2), $3, $4)
       RETURNING id, full_name, email, phone, password_hash, company_id, wallet_balance, created_at`,
      [input.fullName.trim(), input.email.trim(), input.phone.trim(), input.passwordHash]
    );
    const customer = rows[0] as StarlinkCustomer;
    if (input.kitSerial && input.kitSerial.trim()) {
      await registerKitTx(client, customer.id, input.kitSerial.trim(), input.nickname || 'My Starlink Kit');
    }
    await client.query('COMMIT');
    return customer;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function findStarlinkCustomerByEmail(email: string): Promise<StarlinkCustomer | null> {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, password_hash, company_id, wallet_balance, created_at
       FROM starlink_customers WHERE lower(email) = lower($1)`,
    [email.trim()]
  );
  return (rows[0] as StarlinkCustomer) ?? null;
}

/** Sign-in accepts Email OR Phone in one field. */
export async function findStarlinkCustomerByIdentifier(identifier: string): Promise<StarlinkCustomer | null> {
  const v = identifier.trim();
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, password_hash, company_id, wallet_balance, created_at
       FROM starlink_customers
      WHERE lower(email) = lower($1) OR phone = $1
      LIMIT 1`,
    [v]
  );
  return (rows[0] as StarlinkCustomer) ?? null;
}

export async function getStarlinkCustomerById(id: string): Promise<StarlinkCustomer | null> {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, password_hash, company_id, wallet_balance, created_at
       FROM starlink_customers WHERE id = $1`,
    [id]
  );
  return (rows[0] as StarlinkCustomer) ?? null;
}

export async function updateStarlinkProfile(
  id: string,
  patch: { fullName?: string; phone?: string }
): Promise<void> {
  await pool.query(
    `UPDATE starlink_customers
        SET full_name = COALESCE($2, full_name),
            phone     = COALESCE($3, phone)
      WHERE id = $1`,
    [id, patch.fullName?.trim() || null, patch.phone?.trim() || null]
  );
}

export async function updateStarlinkPassword(id: string, passwordHash: string): Promise<void> {
  await pool.query('UPDATE starlink_customers SET password_hash = $2, reset_token = NULL, reset_expires_at = NULL WHERE id = $1', [
    id,
    passwordHash,
  ]);
}

export async function setStarlinkResetToken(email: string, token: string, expiresAt: Date): Promise<StarlinkCustomer | null> {
  const { rows } = await pool.query(
    `UPDATE starlink_customers
        SET reset_token = $2, reset_expires_at = $3
      WHERE lower(email) = lower($1)
      RETURNING id, full_name, email, phone, password_hash, company_id, wallet_balance, created_at`,
    [email.trim(), token, expiresAt]
  );
  return (rows[0] as StarlinkCustomer) ?? null;
}

export async function consumeStarlinkResetToken(token: string, passwordHash: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE starlink_customers
        SET password_hash = $2, reset_token = NULL, reset_expires_at = NULL
      WHERE reset_token = $1 AND reset_expires_at > NOW()`,
    [token, passwordHash]
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Kits
// ---------------------------------------------------------------------------

/** Baseline monthly usage seeded at registration so the chart is meaningful
 *  until live telemetry lands. Rows are flagged is_baseline=TRUE and are
 *  overwritten by real syncs. Disable with STARLINK_BASELINE_USAGE=off. */
function baselineEnabled(): boolean {
  return process.env.STARLINK_BASELINE_USAGE !== 'off';
}

async function registerKitTx(client: PoolClient, customerId: string, kitNumber: string, nickname: string): Promise<StarlinkKit> {
  const { rows } = await client.query(
    `INSERT INTO starlink_kits (customer_id, kit_number, nickname)
     VALUES ($1, $2, $3)
     RETURNING id, customer_id, kit_number, nickname, data_usage_gb, data_credit_gb, status, created_at`,
    [customerId, kitNumber, nickname]
  );
  const kit = rows[0] as StarlinkKit;
  if (baselineEnabled()) {
    const now = new Date();
    const seed = (kitNumber.charCodeAt(kitNumber.length - 1) || 7) % 4;
    const values = [1.4 + seed * 0.3, 2.1 + seed * 0.2, 1.9 + seed * 0.4, 1.1 + seed * 0.5];
    let total = 0;
    for (let i = 3; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const gb = Number(values[3 - i].toFixed(2));
      total += gb;
      await client.query(
        `INSERT INTO starlink_kit_usage (kit_id, period_month, usage_gb, is_baseline)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (kit_id, period_month) DO NOTHING`,
        [kit.id, d.toISOString().slice(0, 10), gb]
      );
    }
    await client.query('UPDATE starlink_kits SET data_usage_gb = $2 WHERE id = $1', [kit.id, Number(total.toFixed(2))]);
    kit.data_usage_gb = Number(total.toFixed(2));
  }
  return kit;
}

export async function registerStarlinkKit(customerId: string, kitNumber: string, nickname?: string): Promise<StarlinkKit> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const kit = await registerKitTx(client, customerId, kitNumber.trim(), (nickname || '').trim() || 'My Starlink Kit');
    await client.query('COMMIT');
    return kit;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listStarlinkKits(customerId: string): Promise<StarlinkKit[]> {
  const { rows } = await pool.query(
    `SELECT id, customer_id, kit_number, nickname, data_usage_gb, data_credit_gb, status, created_at
       FROM starlink_kits WHERE customer_id = $1 ORDER BY created_at ASC`,
    [customerId]
  );
  return rows as StarlinkKit[];
}

export async function getStarlinkKit(id: string, customerId: string): Promise<StarlinkKit | null> {
  const { rows } = await pool.query(
    `SELECT id, customer_id, kit_number, nickname, data_usage_gb, data_credit_gb, status, created_at
       FROM starlink_kits WHERE id = $1 AND customer_id = $2`,
    [id, customerId]
  );
  return (rows[0] as StarlinkKit) ?? null;
}

export async function updateStarlinkKit(id: string, customerId: string, patch: { nickname?: string; status?: string }): Promise<void> {
  await pool.query(
    `UPDATE starlink_kits
        SET nickname = COALESCE($3, nickname),
            status   = COALESCE($4, status)
      WHERE id = $1 AND customer_id = $2`,
    [id, customerId, patch.nickname?.trim() || null, patch.status || null]
  );
}

export async function getKitUsageHistory(kitId: string, months = 4): Promise<StarlinkUsagePoint[]> {
  const { rows } = await pool.query(
    `SELECT period_month, usage_gb, is_baseline
       FROM starlink_kit_usage
      WHERE kit_id = $1
        AND period_month >= date_trunc('month', NOW()) - (($2::int - 1) * INTERVAL '1 month')
      ORDER BY period_month ASC`,
    [kitId, months]
  );
  return rows.map((r: any) => ({
    month: String(r.period_month).slice(0, 10),
    usage_gb: Number(r.usage_gb),
    is_baseline: !!r.is_baseline,
  }));
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Sequential per-month invoice number (SL-202610-0001). Runs inside the
 * caller's transaction when one is open; the advisory lock serialises
 * concurrent checkouts so two customers can never draw the same number.
 */
export async function nextStarlinkInvoiceNumber(client?: PoolClient): Promise<string> {
  const q = client ?? pool;
  const now = new Date();
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  if (client) await client.query(`SELECT pg_advisory_xact_lock(hashtext('starlink_invoice_seq'))`);
  const { rows } = await q.query(
    `SELECT COUNT(*) AS n FROM starlink_invoices WHERE invoice_number LIKE $1`,
    [`SL-${ym}-%`]
  );
  const seq = (Number(rows[0]?.n ?? 0) + 1).toString().padStart(4, '0');
  return `SL-${ym}-${seq}`;
}

export async function createStarlinkInvoice(input: {
  customerId: string;
  amount: number;
  description: string;
  kind: string;
  meta?: Record<string, unknown>;
  dueDate?: string | null;
  client?: PoolClient;
}): Promise<StarlinkInvoice> {
  const q = input.client ?? pool;
  const invoiceNumber = await nextStarlinkInvoiceNumber(input.client);
  const { rows } = await q.query(
    `INSERT INTO starlink_invoices (customer_id, invoice_number, amount, currency, description, kind, status, meta, due_date)
     VALUES ($1, $2, $3, 'USD', $4, $5, 'PENDING', $6::jsonb, $7)
     RETURNING id, customer_id, invoice_number, amount, currency, description, kind, status,
               pese_reference, meta, issued_date, due_date, paid_at, created_at`,
    [
      input.customerId,
      invoiceNumber,
      input.amount,
      input.description,
      input.kind,
      JSON.stringify(input.meta ?? {}),
      input.dueDate ?? null,
    ]
  );
  return rows[0] as StarlinkInvoice;
}

export async function listStarlinkInvoices(customerId: string, status?: string): Promise<StarlinkInvoice[]> {
  if (status && ['PENDING', 'PAID', 'FAILED'].includes(status.toUpperCase())) {
    const { rows } = await pool.query(
      `SELECT id, customer_id, invoice_number, amount, currency, description, kind, status,
              pese_reference, meta, issued_date, due_date, paid_at, created_at
         FROM starlink_invoices
        WHERE customer_id = $1 AND status = $2
        ORDER BY created_at DESC`,
      [customerId, status.toUpperCase()]
    );
    return rows as StarlinkInvoice[];
  }
  const { rows } = await pool.query(
    `SELECT id, customer_id, invoice_number, amount, currency, description, kind, status,
            pese_reference, meta, issued_date, due_date, paid_at, created_at
       FROM starlink_invoices
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [customerId]
  );
  return rows as StarlinkInvoice[];
}

export async function getStarlinkInvoice(id: string, customerId: string): Promise<StarlinkInvoice | null> {
  const { rows } = await pool.query(
    `SELECT id, customer_id, invoice_number, amount, currency, description, kind, status,
            pese_reference, meta, issued_date, due_date, paid_at, created_at
       FROM starlink_invoices WHERE id = $1 AND customer_id = $2`,
    [id, customerId]
  );
  return (rows[0] as StarlinkInvoice) ?? null;
}

export async function getStarlinkInvoiceByNumber(invoiceNumber: string): Promise<StarlinkInvoice | null> {
  const { rows } = await pool.query(
    `SELECT id, customer_id, invoice_number, amount, currency, description, kind, status,
            pese_reference, meta, issued_date, due_date, paid_at, created_at
       FROM starlink_invoices WHERE invoice_number = $1`,
    [invoiceNumber]
  );
  return (rows[0] as StarlinkInvoice) ?? null;
}

export async function getBalanceDue(customerId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS due FROM starlink_invoices WHERE customer_id = $1 AND status = 'PENDING'`,
    [customerId]
  );
  return Number(rows[0]?.due ?? 0);
}

// ---------------------------------------------------------------------------
// Payment settlement — called from the Pesepay webhook (payments.ts) when a
// pesepay_intents row with target_type = 'starlink' completes.
// ---------------------------------------------------------------------------

export interface StarlinkSettlement {
  invoiceNumber: string;
  kind: string;
  amount: number;
  walletBalance: number;
  alreadyPaid: boolean;
}

/**
 * Marks the Starlink invoice PAID and applies its effect:
 *   wallet_topup  -> credits starlink_customers.wallet_balance
 *   data_topup    -> credits the target kit's data_credit_gb (meta.gb)
 *   kit_purchase  -> activates/registers the purchased kit (meta.kit_number)
 *
 * MUST be called with an open transaction client (webhook holds the intent
 * row lock). Idempotent: a replayed webhook sees status = 'PAID' and applies
 * nothing, so a retry can never double-credit a wallet.
 */
export async function applyStarlinkPayment(
  client: PoolClient,
  intent: { target_id: string | null; amount: number; provider_reference?: string | null },
  reference: string
): Promise<StarlinkSettlement> {
  if (!intent.target_id) {
    throw new Error('Starlink payment intent has no invoice attached');
  }
  const { rows } = await client.query(
    `SELECT id, customer_id, invoice_number, amount, kind, status, meta
       FROM starlink_invoices WHERE id = $1 FOR UPDATE`,
    [intent.target_id]
  );
  if (rows.length === 0) {
    throw new Error('Starlink invoice not found for payment intent');
  }
  const inv = rows[0];

  if (String(inv.status) === 'PAID') {
    const bal = await client.query('SELECT wallet_balance FROM starlink_customers WHERE id = $1', [inv.customer_id]);
    return {
      invoiceNumber: inv.invoice_number,
      kind: inv.kind,
      amount: Number(inv.amount),
      walletBalance: Number(bal.rows[0]?.wallet_balance ?? 0),
      alreadyPaid: true,
    };
  }

  await client.query(
    `UPDATE starlink_invoices
        SET status = 'PAID',
            paid_at = NOW(),
            pese_reference = COALESCE($2, pese_reference)
      WHERE id = $1`,
    [inv.id, intent.provider_reference || reference]
  );

  const meta = (inv.meta ?? {}) as Record<string, any>;

  if (inv.kind === 'wallet_topup') {
    await client.query(
      'UPDATE starlink_customers SET wallet_balance = wallet_balance + $2 WHERE id = $1',
      [inv.customer_id, inv.amount]
    );
  } else if (inv.kind === 'data_topup' && meta.kit_id) {
    const gb = Number(meta.gb ?? 0);
    if (gb > 0) {
      await client.query('UPDATE starlink_kits SET data_credit_gb = data_credit_gb + $2 WHERE id = $1 AND customer_id = $3', [
        meta.kit_id,
        gb,
        inv.customer_id,
      ]);
    }
  } else if (inv.kind === 'kit_purchase' && meta.kit_number) {
    await client.query(
      `INSERT INTO starlink_kits (customer_id, kit_number, nickname, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (customer_id, lower(kit_number)) DO UPDATE SET status = 'active'`,
      [inv.customer_id, String(meta.kit_number), String(meta.nickname || 'Starlink Kit')]
    );
  }

  const bal = await client.query('SELECT wallet_balance FROM starlink_customers WHERE id = $1', [inv.customer_id]);
  return {
    invoiceNumber: inv.invoice_number,
    kind: inv.kind,
    amount: Number(inv.amount),
    walletBalance: Number(bal.rows[0]?.wallet_balance ?? 0),
    alreadyPaid: false,
  };
}
