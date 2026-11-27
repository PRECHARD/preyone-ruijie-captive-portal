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
  plan_code: string | null;
  plan_renews_at: string | null;
  email_verified_at: string | null;
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

/** Additive customer-facing feed. Categories are fixed by the DB enum below. */
export type StarlinkNotificationCategory =
  | 'PAYMENT'
  | 'USAGE_ALERT'
  | 'AUTO_TOPUP'
  | 'COMMAND'
  | 'TICKET'
  | 'FLEET';

export interface StarlinkNotification {
  id: string;
  customer_id: string;
  category: StarlinkNotificationCategory;
  event_key: string;
  title: string;
  body: string;
  link_url: string | null;
  meta: Record<string, unknown>;
  is_read: boolean;
  email_status: string;
  email_sent_at: string | null;
  created_at: string;
}

export interface StarlinkPendingIntent {
  intent_id: string;
  invoice_id: string;
  invoice_number: string;
  reference: string;
  amount: number;
  created_at: string;
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

    ALTER TABLE starlink_customers ADD COLUMN IF NOT EXISTS plan_code TEXT;
    ALTER TABLE starlink_customers ADD COLUMN IF NOT EXISTS plan_renews_at DATE;
    ALTER TABLE starlink_customers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    ALTER TABLE starlink_customers ADD COLUMN IF NOT EXISTS email_verify_token_hash TEXT;
    ALTER TABLE starlink_customers ADD COLUMN IF NOT EXISTS email_verify_expires_at TIMESTAMPTZ;

    -- Starlink checkouts record their intents as target_type = 'starlink'. The
    -- original constraint (migrate.ts) predates that rail, so widen it here.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'pesepay_intents_target_type_check'
           AND pg_get_constraintdef(oid) LIKE '%starlink%'
      ) THEN
        ALTER TABLE pesepay_intents DROP CONSTRAINT IF EXISTS pesepay_intents_target_type_check;
        ALTER TABLE pesepay_intents ADD CONSTRAINT pesepay_intents_target_type_check
          CHECK (target_type IN ('invoice', 'shift', 'subscription', 'starlink'));
      END IF;
    END $$;

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

    -- Plan switch applications. Submitted by customers, decided by an admin
    -- against the seat capacity of the requested package.
    CREATE TABLE IF NOT EXISTS starlink_plan_capacity (
      plan_code  TEXT PRIMARY KEY,
      capacity   INTEGER NOT NULL DEFAULT 100,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS starlink_plan_applications (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id     UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      from_plan_code  TEXT,
      to_plan_code    TEXT NOT NULL,
      requested_start DATE NOT NULL,
      status          TEXT NOT NULL DEFAULT 'PENDING',
      decided_at      TIMESTAMPTZ,
      decided_by      TEXT,
      decision_note   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_starlink_plan_applications_status
      ON starlink_plan_applications (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_starlink_plan_applications_customer
      ON starlink_plan_applications (customer_id, created_at DESC);

    -- Customer notification feed. The enum type is created defensively: PM2
    -- runs this DDL from every worker, so the advisory lock serialises the
    -- CREATE TYPE before the idempotent IF NOT EXISTS check.
    DO $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('preyone:starlink_notification_category'));
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'starlink_notification_category') THEN
        CREATE TYPE starlink_notification_category AS ENUM
          ('PAYMENT', 'USAGE_ALERT', 'AUTO_TOPUP', 'COMMAND', 'TICKET', 'FLEET');
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS starlink_notifications (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id   UUID NOT NULL REFERENCES starlink_customers(id) ON DELETE CASCADE,
      category      starlink_notification_category NOT NULL DEFAULT 'PAYMENT',
      event_key     TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL,
      link_url      TEXT,
      meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_read       BOOLEAN NOT NULL DEFAULT FALSE,
      read_at       TIMESTAMPTZ,
      email_status  TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
      email_sent_at TIMESTAMPTZ,
      email_error   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_starlink_notifications_customer
      ON starlink_notifications (customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_starlink_notifications_unread
      ON starlink_notifications (customer_id) WHERE is_read = FALSE;
    CREATE INDEX IF NOT EXISTS idx_starlink_notifications_mail
      ON starlink_notifications (email_status) WHERE email_status = 'PENDING';
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
          `SELECT COUNT(*)::int AS n FROM pg_tables
            WHERE tablename IN (
              'starlink_customers', 'starlink_kits', 'starlink_invoices',
              'starlink_kit_usage', 'starlink_plan_capacity',
              'starlink_plan_applications', 'starlink_notifications'
            )`
        );
        if (Number(rows[0]?.n) >= 7) return;
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
       RETURNING id, full_name, email, phone, password_hash, company_id, wallet_balance, plan_code, plan_renews_at, email_verified_at, created_at`,
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
    `SELECT id, full_name, email, phone, password_hash, company_id, wallet_balance, plan_code, plan_renews_at, email_verified_at, created_at
       FROM starlink_customers WHERE lower(email) = lower($1)`,
    [email.trim()]
  );
  return (rows[0] as StarlinkCustomer) ?? null;
}

/** Sign-in accepts Email OR Phone in one field. */
export async function findStarlinkCustomerByIdentifier(identifier: string): Promise<StarlinkCustomer | null> {
  const v = identifier.trim();
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, password_hash, company_id, wallet_balance, plan_code, plan_renews_at, email_verified_at, created_at
       FROM starlink_customers
      WHERE lower(email) = lower($1) OR phone = $1
      LIMIT 1`,
    [v]
  );
  return (rows[0] as StarlinkCustomer) ?? null;
}

export async function getStarlinkCustomerById(id: string): Promise<StarlinkCustomer | null> {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, password_hash, company_id, wallet_balance, plan_code, plan_renews_at, email_verified_at, created_at
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
      RETURNING id, full_name, email, phone, password_hash, company_id, wallet_balance, plan_code, plan_renews_at, email_verified_at, created_at`,
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

function starlinkActionLabel(kind: string): string {
  switch (kind) {
    case 'wallet_topup': return 'Wallet top-up';
    case 'data_topup': return 'Data top-up';
    case 'kit_purchase': return 'Starlink kit purchase';
    case 'plan_change': return 'Plan change';
    case 'plan_renewal': return 'Plan renewal';
    default: return 'Starlink service payment';
  }
}

export interface StarlinkSettlement {
  invoiceNumber: string;
  kind: string;
  amount: number;
  currency: string;
  walletBalance: number;
  dataBalance?: number;
  kitSerial?: string | null;
  kitNickname?: string | null;
  alreadyPaid: boolean;
  /** Unique notification key for the post-commit receipt dispatch. */
  receiptEventKey?: string;
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
    `SELECT id, customer_id, invoice_number, amount, currency, kind, status, meta
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
      currency: String(inv.currency || 'USD'),
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

  if (inv.kind === 'plan_change' && meta.plan_code) {
    await client.query(
      `UPDATE starlink_customers
          SET plan_code = $2, plan_renews_at = CURRENT_DATE + INTERVAL '30 days'
        WHERE id = $1`,
      [inv.customer_id, String(meta.plan_code)]
    );
  } else if (inv.kind === 'plan_renewal') {
    await client.query(
      `UPDATE starlink_customers
          SET plan_renews_at = GREATEST(COALESCE(plan_renews_at, CURRENT_DATE), CURRENT_DATE) + INTERVAL '30 days'
        WHERE id = $1`,
      [inv.customer_id]
    );
  } else if (inv.kind === 'wallet_topup') {
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

  const bal = await client.query(
    'SELECT wallet_balance, plan_code, plan_renews_at FROM starlink_customers WHERE id = $1',
    [inv.customer_id]
  );
  const customer = (bal.rows[0] ?? {}) as Record<string, any>;

  const kitId = meta.kit_id ? String(meta.kit_id) : null;
  const kitNumber = meta.kit_number ? String(meta.kit_number) : null;
  let kitRow: Record<string, any> | null = null;
  if (kitId || kitNumber) {
    const { rows: kitRows } = await client.query(
      `SELECT kit_number, nickname, data_credit_gb FROM starlink_kits
        WHERE customer_id = $1
          AND (($2::uuid IS NOT NULL AND id = $2) OR ($3::text IS NOT NULL AND lower(kit_number) = lower($3)))
        ORDER BY created_at DESC LIMIT 1`,
      [inv.customer_id, kitId, kitNumber]
    );
    kitRow = (kitRows[0] as Record<string, any>) ?? null;
  }

  const receiptEventKey = `starlink-payment:${inv.id}`;
  const noticeMeta = {
    customerId: inv.customer_id,
    invoiceNumber: inv.invoice_number,
    kind: inv.kind,
    amount: Number(inv.amount),
    currency: String(inv.currency || 'USD'),
    providerReference: intent.provider_reference || reference,
    walletBalance: Number(customer.wallet_balance ?? 0),
    dataBalance: kitRow ? Number(kitRow.data_credit_gb ?? 0) : null,
    kitSerial: kitRow?.kit_number ?? kitNumber ?? null,
    kitNickname: (kitRow?.nickname ?? String(meta.nickname || '')) || null,
    planCode: customer.plan_code ?? null,
    planRenewsAt: customer.plan_renews_at ? String(customer.plan_renews_at) : null,
  };
  const portalBase = (process.env.STARLINK_BASE_URL || 'https://starlink.preyone.com').replace(/\/$/, '');

  // Written inside the settlement transaction. The unique event_key plus the
  // invoice row lock make the receipt/notification strictly once-only even
  // when a webhook and a sweep race. Email dispatch happens after commit.
  await client.query(
    `INSERT INTO starlink_notifications
       (customer_id, category, event_key, title, body, link_url, meta, email_status)
     VALUES ($1, 'PAYMENT', $2, $3, $4, $5, $6::jsonb, 'PENDING')
     ON CONFLICT (event_key) DO NOTHING`,
    [
      inv.customer_id,
      receiptEventKey,
      `Payment received · ${inv.invoice_number}`,
      `Your payment of $${Number(inv.amount).toFixed(2)} for ${starlinkActionLabel(inv.kind)} was confirmed.`,
      `${portalBase}/starlink/portal`,
      JSON.stringify(noticeMeta),
    ]
  );

  return {
    invoiceNumber: inv.invoice_number,
    kind: inv.kind,
    amount: Number(inv.amount),
    currency: String(inv.currency || 'USD'),
    walletBalance: Number(customer.wallet_balance ?? 0),
    dataBalance: kitRow ? Number(kitRow.data_credit_gb ?? 0) : undefined,
    kitSerial: kitRow?.kit_number ?? kitNumber ?? null,
    kitNickname: (kitRow?.nickname ?? String(meta.nickname || '')) || null,
    alreadyPaid: false,
    receiptEventKey,
  };
}

// ---------------------------------------------------------------------------
// Notification feed + post-commit receipt claim
// ---------------------------------------------------------------------------

export interface StarlinkReceiptNotification extends StarlinkNotification {
  customer_email: string;
  customer_full_name: string;
}

const RECEIPT_NOTIFICATION_SELECT = `
  SELECT n.id, n.customer_id, n.category, n.event_key, n.title, n.body,
         n.link_url, n.meta, n.is_read, n.email_status, n.email_sent_at, n.created_at,
         c.email AS customer_email, c.full_name AS customer_full_name
    FROM starlink_notifications n
    JOIN starlink_customers c ON c.id = n.customer_id`;

/** Read a queued payment receipt after its settlement transaction committed. */
export async function getStarlinkReceiptNotification(
  eventKey: string
): Promise<StarlinkReceiptNotification | null> {
  const { rows } = await pool.query(
    `${RECEIPT_NOTIFICATION_SELECT} WHERE n.event_key = $1`,
    [eventKey]
  );
  return (rows[0] as StarlinkReceiptNotification) ?? null;
}

/**
 * Atomically take ownership of one PENDING email. Only the worker whose UPDATE
 * returns a row may send, so a webhook, a sweep and a manual verify can never
 * dispatch the same receipt twice.
 */
export async function claimStarlinkNotificationEmail(
  eventKey: string
): Promise<StarlinkReceiptNotification | null> {
  const { rows } = await pool.query(
    `UPDATE starlink_notifications
        SET email_status = 'SENDING', email_error = NULL
      WHERE event_key = $1 AND email_status = 'PENDING'
      RETURNING id, customer_id, category, event_key, title, body, link_url, meta,
                is_read, email_status, email_sent_at, created_at`,
    [eventKey]
  );
  if (!rows[0]) return null;
  const claimed = rows[0] as StarlinkNotification;
  const receipt = await getStarlinkReceiptNotification(eventKey);
  if (!receipt) return null;
  return { ...receipt, ...claimed };
}

export async function markStarlinkNotificationEmailSent(eventKey: string): Promise<void> {
  await pool.query(
    `UPDATE starlink_notifications
        SET email_status = 'SENT', email_sent_at = NOW(), email_error = NULL
      WHERE event_key = $1 AND email_status = 'SENDING'`,
    [eventKey]
  );
}

export async function markStarlinkNotificationEmailFailed(eventKey: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE starlink_notifications
        SET email_status = 'FAILED', email_error = $2
      WHERE event_key = $1 AND email_status = 'SENDING'`,
    [eventKey, String(error).slice(0, 500)]
  );
}

export async function listStarlinkNotifications(
  customerId: string,
  limit = 50
): Promise<StarlinkNotification[]> {
  const { rows } = await pool.query(
    `SELECT id, customer_id, category, event_key, title, body, link_url, meta,
            is_read, email_status, email_sent_at, created_at
       FROM starlink_notifications
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [customerId, Math.min(Math.max(Number(limit) || 50, 1), 100)]
  );
  return rows as StarlinkNotification[];
}

export async function getUnreadStarlinkNotificationCount(customerId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM starlink_notifications
      WHERE customer_id = $1 AND is_read = FALSE`,
    [customerId]
  );
  return Number(rows[0]?.n ?? 0);
}

export async function markStarlinkNotificationsRead(customerId: string, ids?: string[]): Promise<number> {
  const result = ids?.length
    ? await pool.query(
        `UPDATE starlink_notifications
            SET is_read = TRUE, read_at = NOW()
          WHERE customer_id = $1 AND is_read = FALSE AND id = ANY($2::uuid[])`,
        [customerId, ids]
      )
    : await pool.query(
        `UPDATE starlink_notifications
            SET is_read = TRUE, read_at = NOW()
          WHERE customer_id = $1 AND is_read = FALSE`,
        [customerId]
      );
  return result.rowCount ?? 0;
}

/** Pending Starlink intents still attached to an unpaid invoice (recovery UI). */
export async function listPendingStarlinkIntents(customerId: string): Promise<StarlinkPendingIntent[]> {
  const { rows } = await pool.query(
    `SELECT i.id AS intent_id, i.target_id AS invoice_id, inv.invoice_number,
            i.reference, i.amount, i.created_at
       FROM pesepay_intents i
       JOIN starlink_invoices inv ON inv.id = i.target_id
      WHERE i.target_type = 'starlink'
        AND LOWER(i.status) = 'pending'
        AND inv.customer_id = $1
        AND inv.status = 'PENDING'
      ORDER BY i.created_at DESC
      LIMIT 20`,
    [customerId]
  );
  return rows as StarlinkPendingIntent[];
}

// ---------------------------------------------------------------------------
// Email verification (the raw token only ever lives in the email; we store its SHA-256)
// ---------------------------------------------------------------------------

export async function setStarlinkVerificationToken(customerId: string, tokenHash: string, expiresAt: Date): Promise<void> {
  await pool.query(
    `UPDATE starlink_customers
        SET email_verify_token_hash = $2, email_verify_expires_at = $3
      WHERE id = $1`,
    [customerId, tokenHash, expiresAt]
  );
}

/** Marks the email verified when the token matches and has not expired. Returns the customer or null. */
export async function consumeStarlinkVerificationToken(tokenHash: string): Promise<{ id: string; email: string; full_name: string } | null> {
  const { rows } = await pool.query(
    `UPDATE starlink_customers
        SET email_verified_at = COALESCE(email_verified_at, NOW()),
            email_verify_token_hash = NULL,
            email_verify_expires_at = NULL
      WHERE email_verify_token_hash = $1
        AND email_verify_expires_at > NOW()
      RETURNING id, email, full_name`,
    [tokenHash]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Plan switch applications + seat capacity
// ---------------------------------------------------------------------------

export interface StarlinkPlanApplication {
  id: string;
  customer_id: string;
  from_plan_code: string | null;
  to_plan_code: string;
  requested_start: string;
  status: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
}

export const DEFAULT_PLAN_CAPACITY = 100;

/** Seats available for a package = configured capacity minus active subscribers on it. */
export async function getPlanCapacity(planCode: string, client?: PoolClient): Promise<{ capacity: number; active: number }> {
  const q = client ?? pool;
  const { rows } = await q.query(
    `SELECT COALESCE(
              (SELECT capacity FROM starlink_plan_capacity WHERE plan_code = $1),
              $2
            )::int AS capacity,
            (SELECT COUNT(*)::int FROM starlink_customers WHERE plan_code = $1) AS active`,
    [planCode, DEFAULT_PLAN_CAPACITY]
  );
  return { capacity: Number(rows[0].capacity), active: Number(rows[0].active) };
}

export async function getNextMonthStart(): Promise<string> {
  const { rows } = await pool.query(`SELECT (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date::text AS d`);
  return rows[0].d;
}

export async function getOpenPlanApplication(customerId: string): Promise<StarlinkPlanApplication | null> {
  const { rows } = await pool.query(
    `SELECT * FROM starlink_plan_applications WHERE customer_id = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  return rows[0] ?? null;
}

export async function listPlanApplications(customerId: string): Promise<StarlinkPlanApplication[]> {
  const { rows } = await pool.query(
    `SELECT * FROM starlink_plan_applications WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [customerId]
  );
  return rows;
}
