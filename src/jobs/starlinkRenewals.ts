import { pool } from '../db/pool';
import { createStarlinkInvoice } from '../db/starlink';
import { getStarlinkPlan } from '../plans/starlinkPlans';

// ── Starlink plan renewals ────────────────────────────────────────────────
//
// Runs daily. For every portal customer on a plan whose renewal date falls
// within 3 days, issue one PENDING `plan_renewal` invoice (USD, catalog price).
// Mobile-money rails cannot be charged automatically, so the customer pays it
// from the portal ("Pay renewal"). Settlement (applyStarlinkPayment) pushes
// plan_renews_at forward 30 days.
//
// The whole run holds a transaction-level advisory lock, so only one PM2
// worker issues invoices per run. The NOT EXISTS guard stops a second renewal
// invoice while one is still PENDING.

const MS_PER_DAY = 86_400_000;

export async function runStarlinkRenewals(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(`SELECT pg_try_advisory_xact_lock(hashtext('starlink_renewals')) AS ok`);
    if (!lock.rows[0]?.ok) {
      await client.query('ROLLBACK');
      return 0;
    }

    const { rows } = await client.query(
      `SELECT c.id, c.plan_code, c.plan_renews_at
         FROM starlink_customers c
        WHERE c.plan_code IS NOT NULL
          AND c.plan_renews_at IS NOT NULL
          AND c.plan_renews_at <= CURRENT_DATE + INTERVAL '3 days'
          AND NOT EXISTS (
            SELECT 1 FROM starlink_invoices i
             WHERE i.customer_id = c.id AND i.kind = 'plan_renewal' AND i.status = 'PENDING'
          )`
    );

    let issued = 0;
    for (const row of rows) {
      const plan = getStarlinkPlan(row.plan_code);
      if (!plan) continue;
      await createStarlinkInvoice({
        customerId: row.id,
        amount: plan.priceUsd,
        description: `Starlink ${plan.name} plan renewal (monthly)`,
        kind: 'plan_renewal',
        meta: { plan_code: plan.code, plan_name: plan.name },
        dueDate: new Date(row.plan_renews_at).toISOString().slice(0, 10),
        client,
      });
      issued += 1;
    }

    await client.query('COMMIT');
    return issued;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function scheduleStarlinkRenewals(): void {
  const run = async () => {
    try {
      const issued = await runStarlinkRenewals();
      if (issued) console.log(`Starlink renewals: ${issued} renewal invoice(s) issued.`);
    } catch (err) {
      console.error('Starlink renewals failed:', err);
    }
  };

  // Same jitter approach as the subscription dunning cron.
  const jitter = Math.floor(Math.random() * 120_000);
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  nextMidnight.setHours(0, 0, 0, 0);
  setTimeout(() => {
    run();
    setInterval(run, MS_PER_DAY);
  }, nextMidnight.getTime() - now.getTime() + jitter);
}
