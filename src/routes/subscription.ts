import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { requireAdminAuth } from '../middleware/adminAuth';
import {
  initiatePesepayPayment,
  isPesepayCurrency,
  isPesepayRail,
  normalizeGatewayCurrency,
} from '../services/pesepayService';
import type { PesepayCurrency, PesepayRail } from '../services/pesepayService';
import { PLAN_TIERS, TIER_CATALOG, canonicalPlanId, planNameFor, type PlanTier } from '../plans/entitlements';

export const subscriptionRouter = Router();

// Re-exported so admin catalogues and the Pesepay webhook keep a single import.
export { PLAN_TIERS, TIER_CATALOG, type PlanTier };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// Mirrors the tenant resolution in POST /api/payments/pesepay/initiate: the
// company always comes from the authenticated session (portal company link,
// else the singleton portal company) and is never taken from the body, so a
// caller can only ever start a checkout for their own company.
async function resolveTenant(req: Request): Promise<string | null> {
  const sessionCompanyId =
    (req.adminUser as { portalCompanyId?: string | null } | undefined)?.portalCompanyId ?? null;
  const { rows } = await pool.query(
    sessionCompanyId
      ? 'SELECT id FROM companies WHERE id = $1'
      : 'SELECT id FROM companies ORDER BY created_at LIMIT 1',
    sessionCompanyId ? [sessionCompanyId] : []
  );
  let tenantId = rows[0]?.id ?? null;
  if (!tenantId) {
    const { rows: fallbackRows } = await pool.query('SELECT id FROM companies ORDER BY created_at LIMIT 1');
    tenantId = fallbackRows[0]?.id ?? null;
  }
  return tenantId ?? null;
}

// GET /api/subscription/plans — current company plan + tier catalog, everything
// the Settings > Billing pane and the Upgrade modal need in one call.
subscriptionRouter.get('/plans', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await resolveTenant(req);
    if (!tenantId) {
      res.status(403).json({ error: 'No company is configured' });
      return;
    }
    const { rows } = await pool.query(
      `SELECT plan_type, max_devices, subscription_status, subscription_expires_at, account_number
         FROM companies
        WHERE id = $1`,
      [tenantId]
    );
    const company = rows[0] ?? null;
    res.json({
      tenantId,
      current: company
        ? {
            plan_type: company.plan_type,
            plan_name: planNameFor(company.plan_type),
            max_devices: Number(company.max_devices),
            subscription_status: company.subscription_status,
            subscription_expires_at: company.subscription_expires_at,
            account_number: company.account_number,
          }
        : null,
      tiers: TIER_CATALOG,
      currency: 'USD',
    });
  } catch (e) {
    console.error('Subscription plans lookup failed:', e);
    res.status(500).json({ error: 'Could not load subscription plans' });
  }
});

// POST /api/subscription/checkout — start a Pesepay hosted checkout for a tier.
// The resulting redirectUrl is what the Upgrade modal hands to the operator;
// fulfilment happens server-to-server in /api/payments/pesepay/webhook, which
// applies plan_tier to companies.plan_type (device cap follows via trigger).
subscriptionRouter.post('/checkout', requireAdminAuth, async (req: Request, res: Response) => {
  const tierId = canonicalPlanId(str(req.body?.tier));
  if (!tierId) {
    res.status(400).json({ error: `tier must be one of: ${PLAN_TIERS.join(', ')}` });
    return;
  }
  const tier = TIER_CATALOG.find((t) => t.id === tierId);
  if (!tier) {
    res.status(400).json({ error: 'Unknown tier' });
    return;
  }

  const rawCurrency = req.body?.currencyCode ?? 'USD';
  if (!isPesepayCurrency(rawCurrency)) {
    res.status(400).json({ error: 'currencyCode must be USD or ZiG' });
    return;
  }
  const currencyCode = normalizeGatewayCurrency(rawCurrency) as PesepayCurrency;

  const rawMethod = str(req.body?.paymentMethod) || 'ecocash';
  if (!isPesepayRail(rawMethod.toLowerCase())) {
    res.status(400).json({ error: 'Unsupported Pesepay payment method' });
    return;
  }
  const paymentMethod = rawMethod.toLowerCase() as PesepayRail;

  // The client's contact details are captured *before* the gateway hand-off.
  // They are stored on the intent so the settlement webhook can email the
  // receipt + invoice to the client even if the till/browser is closed.
  const clientName = str(req.body?.fullName);
  const clientEmail = str(req.body?.email).toLowerCase();
  const clientPhone = str(req.body?.phone);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    res.status(400).json({ error: 'A valid client email address is required' });
    return;
  }
  if (!/^\+?\d{9,15}$/.test(clientPhone.replace(/[\s-]/g, ''))) {
    res.status(400).json({ error: 'A valid client phone number is required' });
    return;
  }

  try {
    const tenantId = await resolveTenant(req);
    if (!tenantId) {
      res.status(403).json({ error: 'No company is configured for online payments' });
      return;
    }

    const deviceLabel =
      tier.devices >= 9999 ? 'unlimited devices' : `${tier.devices} device${tier.devices === 1 ? '' : 's'}`;
    const reasonForPayment = `${tier.name} plan — $${tier.price}/mo — ${deviceLabel}`;
    const reference = `PREYONE-SUB-${uuidv4().substring(0, 8).toUpperCase()}-${Date.now()}`;
    const invoiceNumber = `PINV-${Date.now().toString(36).toUpperCase()}-${uuidv4().substring(0, 4).toUpperCase()}`;

    await pool.query(
      `INSERT INTO pesepay_intents
         (reference, tenant_id, amount, currency, payment_method, purpose, reason_for_payment,
          target_type, subscription_module, plan_tier, client_name, client_email, client_phone, invoice_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'subscription',NULL,$8,$9,$10,$11,$12)`,
      [
        reference,
        tenantId,
        tier.price,
        currencyCode,
        paymentMethod,
        'subscription',
        reasonForPayment,
        tier.id,
        clientName || null,
        clientEmail,
        clientPhone,
        invoiceNumber,
      ]
    );

    const admin = req.adminUser as { email?: string; fullName?: string } | undefined;

    const pesepayResponse = await initiatePesepayPayment({
      amount: tier.price,
      currencyCode,
      paymentMethod,
      reasonForPayment,
      reference,
      email: clientEmail || admin?.email,
      fullName: clientName || admin?.fullName,
      phone: clientPhone || undefined,
    });

    if (!pesepayResponse.success) {
      await pool.query(`UPDATE pesepay_intents SET status = 'failed' WHERE reference = $1`, [reference]);
      res.status(400).json({ error: pesepayResponse.error || 'Failed to start checkout', reference });
      return;
    }

    await pool.query(
      `UPDATE pesepay_intents
          SET provider_reference = $2, redirect_url = $3, poll_url = $4
        WHERE reference = $1`,
      [
        reference,
        pesepayResponse.referenceNumber || null,
        pesepayResponse.redirectUrl || null,
        pesepayResponse.pollUrl || null,
      ]
    );

    res.json({
      success: true,
      tier: tier.id,
      name: tier.name,
      amount: tier.price,
      currencyCode,
      paymentMethod,
      reference,
      invoiceNumber,
      clientEmail,
      redirectUrl: pesepayResponse.redirectUrl,
      pollUrl: pesepayResponse.pollUrl,
      instructions: pesepayResponse.instructions,
      tenantId,
    });
  } catch (error) {
    console.error('Subscription checkout error:', error);
    res.status(500).json({ error: 'Checkout initiation failed' });
  }
});
