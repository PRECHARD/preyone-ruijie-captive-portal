import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import type { PoolClient } from 'pg';
import {
  initiatePesepayPayment,
  isPesepayConfigured,
  isPesepayRail,
  listAvailableRails,
  resolveRail,
  normalizeGatewayCurrency,
} from '../services/pesepayService';
import type { PesepayCurrency, PesepayRail } from '../services/pesepayService';
import { signPesepayStatusToken } from './payments';

/**
 * Public Starlink checkout for the marketing site.
 *
 * The admin POS already issues numbered documents and settles them through the
 * Pesepay callback (applyDocumentPayment in ./payments.ts). This router only
 * supplies the missing public front door: it creates an `online` invoice for a
 * website visitor, then opens a Pesepay intent against that invoice so the
 * existing callback marks it paid. Nothing here re-implements settlement.
 *
 * Money safety rules enforced in this file:
 *   - the amount comes from SERVER_SIDE_PLANS, never from the request body;
 *   - the tenant comes from the companies table, never from the request body;
 *   - idempotency_key is unique, so a retried submit cannot raise two invoices.
 */
export const siteInvoicesRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Zimbabwe mobile in international form: 263 + 7 + 8 digits. */
const ZW_PHONE_RE = /^2637\d{8}$/;

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

interface Plan {
  id: string;
  label: string;
  description: string;
  /** Fixed price, or null when the customer types their own amount. */
  amount: number | null;
  min: number;
  max: number;
}

/**
 * The Starlink price list. The site renders from the public copy in
 * site/src/lib/payments.ts; this copy is the one that decides what is charged,
 * so a tampered or stale frontend can only ever be rejected.
 */
const SERVER_SIDE_PLANS: Plan[] = [
  {
    id: 'starlink-mini',
    label: 'Starlink Mini',
    description: 'Standard residential Starlink kit',
    amount: 350,
    min: 50,
    max: 2000,
  },
  {
    id: 'starlink-standard',
    label: 'Starlink Standard',
    description: 'Starlink kit with standard installation',
    amount: 480,
    min: 50,
    max: 2000,
  },
  {
    id: 'starlink-priority',
    label: 'Starlink Priority',
    description: 'Priority kit, quoted per installation',
    amount: null,
    min: 200,
    max: 5000,
  },
  {
    id: 'starlink-custom',
    label: 'Custom Installation',
    description: 'Bespoke installation quoted to fit the site',
    amount: null,
    min: 100,
    max: 10000,
  },
];

const WEB_CURRENCY: PesepayCurrency = 'USD';

/**
 * Where the gateway sends the customer once they have paid. Defaults to the
 * marketing site's payment page so the buyer returns to the page they started
 * from and sees their invoice number; override with SITE_PAYMENT_RETURN_URL.
 */
function getWebsiteReturnUrl(): string {
  const explicit = str(process.env.SITE_PAYMENT_RETURN_URL);
  if (explicit) return explicit;
  const site = (process.env.SITE_BASE_URL || 'https://www.preyone.com').replace(/\/$/, '');
  return `${site}/payment`;
}

/** Rate limit keyed by IP; this endpoint talks to the gateway and writes rows. */
const createLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please wait a few minutes and try again.' },
});

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Resolves the portal company. The website has no session, so this always uses
 * the singleton portal company -- the same fallback loadCompany() applies for
 * admin accounts with no company assignment.
 */
async function loadPortalCompany(): Promise<{
  id: string;
  taxPct: number;
  invoicePrefix: string;
  currency: string;
} | null> {
  const { rows } = await pool.query(
    `SELECT id, tax_pct, invoice_prefix, currency FROM companies ORDER BY created_at LIMIT 1`
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const currency = normalizeGatewayCurrency(row.currency);
  return {
    id: row.id as string,
    taxPct: round2(row.tax_pct),
    invoicePrefix: str(row.invoice_prefix) || 'INV',
    currency: currency ?? WEB_CURRENCY,
  };
}

/**
 * Customer lookup for website checkout, matched on email first.
 *
 * pos.ts upsertCustomer() matches on lower(name) alone, which is wrong here:
 * two different Starlink buyers sharing a name would be merged into one POS
 * customer and their invoices would land on the wrong record. When no email
 * match exists we insert a distinct row; the unique index is on lower(name),
 * so a colliding name is disambiguated rather than merged.
 */
async function upsertWebsiteCustomer(
  client: PoolClient,
  input: { name: string; email: string; phone: string }
): Promise<string> {
  const existing = await client.query(
    `SELECT id FROM pos_customers WHERE lower(email) = lower($1) LIMIT 1`,
    [input.email]
  );
  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE pos_customers
          SET phone  = COALESCE(NULLIF($2,''), phone),
              name   = COALESCE(NULLIF($3,''), name),
              updated_at = NOW()
        WHERE id = $1`,
      [existing.rows[0].id, input.phone, input.name]
    );
    return existing.rows[0].id as string;
  }

  // lower(name) is globally unique, so try the plain name first and fall back
  // to an email-qualified name rather than aborting on a conflict.
  let candidateName = input.name;
  const clash = await client.query(
    `SELECT 1 FROM pos_customers WHERE lower(name) = lower($1) LIMIT 1`,
    [candidateName]
  );
  if (clash.rows.length > 0) {
    candidateName = `${input.name} (${input.email})`;
  }

  const inserted = await client.query(
    `INSERT INTO pos_customers (name, phone, email) VALUES ($1,$2,$3) RETURNING id`,
    [candidateName, input.phone || null, input.email]
  );
  return inserted.rows[0].id as string;
}

/** Rails the gateway can actually settle for the given amount, for the UI. */
siteInvoicesRouter.get('/payment-rails', async (_req: Request, res: Response) => {
  if (!isPesepayConfigured()) {
    res.status(503).json({ error: 'Online payments are temporarily unavailable' });
    return;
  }
  res.json({ currency: WEB_CURRENCY, rails: listAvailableRails(WEB_CURRENCY) });
});

siteInvoicesRouter.post('/invoices', createLimiter, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!isPesepayConfigured()) {
    res.status(503).json({ error: 'Online payments are temporarily unavailable' });
    return;
  }

  // Idempotency: the site generates one key per checkout attempt and reuses it
  // on retry, so a double-tap or a network retry returns the original invoice
  // instead of raising a second one.
  const idempotencyKey = str(body.idempotencyKey) || str(req.header('Idempotency-Key'));
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) {
    res.status(400).json({ error: 'A valid idempotencyKey is required' });
    return;
  }

  const fullName = str(body.fullName);
  const email = str(body.email).toLowerCase();
  const phone = str(body.phone);

  if (fullName.length < 2 || fullName.length > 120) {
    res.status(400).json({ error: 'Enter your full name' });
    return;
  }
  if (!EMAIL_RE.test(email) || email.length > 200) {
    res.status(400).json({ error: 'Enter a valid email address' });
    return;
  }
  if (phone && !ZW_PHONE_RE.test(phone)) {
    res.status(400).json({ error: 'Enter your number as 2637XXXXXXXX' });
    return;
  }

  const accountRef = str(body.accountRef);
  if (accountRef.length < 2 || accountRef.length > 80) {
    res.status(400).json({ error: 'Enter your account or installation reference' });
    return;
  }

  const planId = str(body.planId);
  const plan = SERVER_SIDE_PLANS.find((p) => p.id === planId);
  if (!plan) {
    res.status(400).json({ error: 'Choose a valid Starlink package' });
    return;
  }

  // The amount is derived, never trusted: fixed plans use their catalog price,
  // quoted plans use the customer's figure clamped to the plan's range.
  let amount: number;
  if (plan.amount !== null) {
    amount = round2(plan.amount);
  } else {
    amount = round2(Number(body.amount));
    if (!Number.isFinite(amount) || amount < plan.min || amount > plan.max) {
      res.status(400).json({
        error: `Enter an amount between $${plan.min} and $${plan.max} for ${plan.label}`,
      });
      return;
    }
  }

  const rail = str(body.paymentMethod).toLowerCase();
  if (!isPesepayRail(rail)) {
    res.status(400).json({ error: 'Choose a valid payment method' });
    return;
  }
  const railSpec = resolveRail(rail as PesepayRail, WEB_CURRENCY);
  if (!railSpec) {
    res.status(400).json({ error: 'That payment method is not available' });
    return;
  }
  if (amount < railSpec.min || amount > railSpec.max) {
    res.status(400).json({
      error: `${plan.label} payments via this method must be between $${railSpec.min} and $${railSpec.max}`,
    });
    return;
  }
  if (railSpec.requiresPhone && !phone) {
    res.status(400).json({ error: 'Your mobile number is required for this payment method' });
    return;
  }

  const company = await loadPortalCompany();
  if (!company) {
    res.status(503).json({ error: 'Online payments are temporarily unavailable' });
    return;
  }

  // Replay guard: an existing key returns the stored invoice untouched.
  const prior = await pool.query(
    `SELECT s.document_id, d.doc_number, s.status, s.amount
       FROM site_invoices s
       JOIN pos_documents d ON d.id = s.document_id
      WHERE s.idempotency_key = $1`,
    [idempotencyKey]
  );
  if (prior.rows.length > 0) {
    const row = prior.rows[0];
    res.json({
      success: true,
      replayed: true,
      invoiceId: row.document_id,
      invoiceNumber: row.doc_number,
      status: row.status,
      amount: Number(row.amount),
      currency: WEB_CURRENCY,
      accountRef,
    });
    return;
  }

  let invoiceId: string;
  let docNumber: string;
  let taxAmount: number;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = await upsertWebsiteCustomer(client, { name: fullName, email, phone });

    const seq = await client.query(`SELECT nextval('pos_doc_number_seq') AS v`);
    docNumber = `${company.invoicePrefix}-${String(seq.rows[0].v).padStart(4, '0')}`;

    // Totals are VAT-inclusive: subtotal and total are the amount charged, and
    // the tax component is subtotal x pct / (100 + pct). computeTotals() in
    // pos.ts uses the same convention, so POS and website invoices agree.
    taxAmount = round2((amount * company.taxPct) / (100 + company.taxPct));

    const docInsert = await client.query(
      `INSERT INTO pos_documents
         (doc_number, doc_type, channel, status, customer_id, company_id,
          issue_date, due_date, subtotal, discount_pct, tax_pct, total, amount_paid, notes)
       VALUES ($1,'invoice','online','unpaid',$2,$3,CURRENT_DATE,CURRENT_DATE,
               $4,0,$5,$6,0,$7)
       RETURNING id`,
      [
        docNumber,
        customerId,
        company.id,
        amount,
        company.taxPct,
        amount,
        `Starlink ${plan.label} for ${accountRef}. Reference: ${accountRef}. VAT component: $${taxAmount.toFixed(2)}. Paid online via ${rail}.`,
      ]
    );
    invoiceId = docInsert.rows[0].id;

    await client.query(
      `INSERT INTO pos_document_items (document_id, description, price, qty, line_total, position)
       VALUES ($1,$2,$3,1,$4,0)`,
      [invoiceId, `${plan.label} - ${plan.description}`, amount, amount]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Website invoice creation failed:', error);
    res.status(500).json({ error: 'Unable to start this payment. Please try again.' });
    return;
  } finally {
    client.release();
  }

  // The gateway call happens outside the transaction: it is slow and can fail
  // on its own, and holding a transaction open across it would needlessly lock
  // the document row.
  const reference = `PREYONE-${uuidv4().substring(0, 8).toUpperCase()}-${Date.now()}`;
  const reasonForPayment = `${plan.label} - ${accountRef}`;

  try {
    const intentInsert = await pool.query(
      `INSERT INTO pesepay_intents
         (reference, tenant_id, amount, currency, payment_method, purpose, reason_for_payment,
          target_type, target_id, plan_tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'invoice',$8,$9)
       RETURNING id`,
      [
        reference,
        company.id,
        amount,
        WEB_CURRENCY,
        rail,
        'starlink_invoice',
        reasonForPayment,
        invoiceId,
        plan.id,
      ]
    );
    const intentId = intentInsert.rows[0].id as string;

    const gateway = await initiatePesepayPayment({
      amount,
      currencyCode: WEB_CURRENCY,
      paymentMethod: rail,
      reasonForPayment,
      reference,
      phone: phone || undefined,
      email,
      fullName,
      returnUrl: getWebsiteReturnUrl(),
    });

    if (!gateway.success) {
      await pool.query(`UPDATE pesepay_intents SET status = 'failed' WHERE id = $1`, [intentId]);
      await pool.query(`UPDATE site_invoices SET status = 'failed', updated_at = NOW() WHERE idempotency_key = $1`, [
        idempotencyKey,
      ]);
      await pool.query(`UPDATE pos_documents SET status = 'void', updated_at = NOW() WHERE id = $1 AND amount_paid = 0`, [
        invoiceId,
      ]);
      res.status(502).json({ error: gateway.error || 'Unable to reach the payment provider', invoiceNumber: docNumber });
      return;
    }

    await pool.query(
      `UPDATE pesepay_intents
          SET provider_reference = $2, redirect_url = $3, poll_url = $4
        WHERE id = $1`,
      [intentId, gateway.referenceNumber || null, gateway.redirectUrl || null, gateway.pollUrl || null]
    );

    await pool.query(
      `INSERT INTO site_invoices
         (idempotency_key, company_id, document_id, intent_id, account_ref, plan_id, plan_label,
          full_name, email, phone, amount, currency, rail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        idempotencyKey,
        company.id,
        invoiceId,
        intentId,
        accountRef,
        plan.id,
        plan.label,
        fullName,
        email,
        phone || null,
        amount,
        WEB_CURRENCY,
        rail,
      ]
    );

    // v2 make-payment is Pesepay's SEAMLESS integration: the buyer approves on
    // their own handset (OTP/PIN) and there is no redirectUrl to send them to.
    // We therefore report which mode the gateway chose, and the site polls the
    // status endpoint while the buyer completes the payment. A redirectUrl is
    // still honoured if a future rail requires a hosted-page redirect.
    const mode: 'seamless' | 'redirect' = gateway.redirectUrl ? 'redirect' : 'seamless';

    res.status(201).json({
      success: true,
      invoiceId,
      invoiceNumber: docNumber,
      referenceNumber: reference,
      // Mints a token bound to this intent so the site can poll the public
      // status endpoint without authenticating as an admin.
      statusToken: signPesepayStatusToken(intentId, reference),
      intentId,
      mode,
      redirectUrl: gateway.redirectUrl || null,
      instructions: gateway.instructions || null,
      amount,
      currency: WEB_CURRENCY,
      taxPct: company.taxPct,
      taxAmount,
      paymentMethod: rail,
      accountRef,
      planId: plan.id,
      planLabel: plan.label,
    });
  } catch (error) {
    console.error('Website payment initiation failed:', error);
    res.status(500).json({ error: 'Unable to start this payment. Please try again.' });
  }
});