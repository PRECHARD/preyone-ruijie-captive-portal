/**
 * Starlink plan switch applications.
 *
 * Customer submits → both sides get an email. An admin then approves or
 * declines. Approval is capacity-checked inside a transaction, so two
 * approvals can never take the last seat on a package.
 */
import { pool } from '../db/pool';
import {
  getNextMonthStart,
  getOpenPlanApplication,
  getPlanCapacity,
  type StarlinkPlanApplication,
} from '../db/starlink';
import { getStarlinkPlan } from '../plans/starlinkPlans';
import { sendStarlinkEmail } from './notificationService';
import {
  planApplicationAdminEmail,
  planApplicationApprovedEmail,
  planApplicationReceivedEmail,
  planApplicationRejectedEmail,
} from './starlinkNoticeTemplates';

export class PlanApplicationError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function starlinkAdminEmail(): string {
  return process.env.STARLINK_ADMIN_EMAIL || 'support@preyone.com';
}

interface CustomerLite {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  plan_code: string | null;
}

export async function submitPlanApplication(customer: CustomerLite, toPlanCode: string): Promise<StarlinkPlanApplication> {
  const plan = getStarlinkPlan(toPlanCode);
  if (!plan) throw new PlanApplicationError(400, 'Choose a valid plan');
  if (customer.plan_code === plan.code) throw new PlanApplicationError(409, 'You are already on this plan');
  if (await getOpenPlanApplication(customer.id)) {
    throw new PlanApplicationError(409, 'You already have an application under review');
  }

  const startDate = await getNextMonthStart();
  const { rows } = await pool.query(
    `INSERT INTO starlink_plan_applications (customer_id, from_plan_code, to_plan_code, requested_start)
     VALUES ($1, $2, $3, $4::date)
     RETURNING *`,
    [customer.id, customer.plan_code, plan.code, startDate]
  );
  const app = rows[0] as StarlinkPlanApplication;

  const fromName = getStarlinkPlan(customer.plan_code)?.name ?? 'No package yet';
  sendStarlinkEmail(
    customer.email,
    planApplicationReceivedEmail({
      fullName: customer.full_name,
      email: customer.email,
      planName: plan.name,
      priceUsd: plan.priceUsd,
      startDate,
    })
  ).catch((err) => console.error('Plan application receipt email failed:', err));

  sendStarlinkEmail(
    starlinkAdminEmail(),
    planApplicationAdminEmail({
      applicationId: app.id,
      customerName: customer.full_name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      fromPlan: fromName,
      toPlan: plan.name,
      startDate,
    })
  ).catch((err) => console.error('Plan application admin email failed:', err));

  return app;
}

async function loadCustomerForApp(appId: string) {
  const { rows } = await pool.query(
    `SELECT a.*, c.email, c.full_name
       FROM starlink_plan_applications a
       JOIN starlink_customers c ON c.id = a.customer_id
      WHERE a.id = $1`,
    [appId]
  );
  return rows[0] ?? null;
}

export async function approvePlanApplication(appId: string, actor: string): Promise<void> {
  const client = await pool.connect();
  let approved: { email: string; full_name: string; plan: string; start: string } | null = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT a.*, to_char(a.requested_start, 'YYYY-MM-DD') AS start_text, c.email, c.full_name
         FROM starlink_plan_applications a
         JOIN starlink_customers c ON c.id = a.customer_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [appId]
    );
    const app = rows[0];
    if (!app) throw new PlanApplicationError(404, 'Application not found');
    if (app.status !== 'PENDING') throw new PlanApplicationError(409, `Application is already ${app.status.toLowerCase()}`);

    const plan = getStarlinkPlan(app.to_plan_code);
    if (!plan) throw new PlanApplicationError(400, 'Requested package no longer exists');

    const cap = await getPlanCapacity(plan.code, client);
    if (cap.active >= cap.capacity) {
      throw new PlanApplicationError(409, `No capacity left on ${plan.name} (${cap.active}/${cap.capacity})`);
    }

    await client.query(
      `UPDATE starlink_customers SET plan_code = $2, plan_renews_at = $3::date WHERE id = $1`,
      [app.customer_id, plan.code, app.requested_start]
    );
    await client.query(
      `UPDATE starlink_plan_applications
          SET status = 'APPROVED', decided_at = NOW(), decided_by = $2
        WHERE id = $1`,
      [appId, actor]
    );
    await client.query('COMMIT');
    approved = { email: app.email, full_name: app.full_name, plan: plan.name, start: app.start_text };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (approved) {
    sendStarlinkEmail(
      approved.email,
      planApplicationApprovedEmail({
        fullName: approved.full_name,
        email: approved.email,
        planName: approved.plan,
        startDate: approved.start,
      })
    ).catch((err) => console.error('Plan approval email failed:', err));
  }
}

export async function rejectPlanApplication(appId: string, actor: string, note: string): Promise<void> {
  const app = await loadCustomerForApp(appId);
  if (!app) throw new PlanApplicationError(404, 'Application not found');
  if (app.status !== 'PENDING') throw new PlanApplicationError(409, `Application is already ${app.status.toLowerCase()}`);

  await pool.query(
    `UPDATE starlink_plan_applications
        SET status = 'REJECTED', decided_at = NOW(), decided_by = $2, decision_note = $3
      WHERE id = $1`,
    [appId, actor, note.slice(0, 500)]
  );

  const plan = getStarlinkPlan(app.to_plan_code);
  sendStarlinkEmail(
    app.email,
    planApplicationRejectedEmail({
      fullName: app.full_name,
      email: app.email,
      planName: plan?.name ?? app.to_plan_code,
      note,
    })
  ).catch((err) => console.error('Plan rejection email failed:', err));
}
