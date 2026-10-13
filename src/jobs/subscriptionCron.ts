import { pool } from '../db/pool';
import {
  sendSubscriptionExpiryWarningEmail,
  sendSubscriptionExpiryUrgentEmail,
} from '../services/notificationService';

// ── Subscription dunning (3-tier SaaS engine) ─────────────────────────────
//
// Runs daily at midnight. For every company with a recorded
// subscription_expires_at:
//
//   1. expires within 3 days, not yet warned  -> reminder_3day_sent = TRUE
//      + a warning email (renewal link in the plans block)
//   2. expires within 1 day, not yet warned   -> reminder_1day_sent = TRUE
//      (and reminder_3day_sent, so a stale "3 days" mail can never follow)
//      + an urgent "expires tomorrow" notice
//   3. already elapsed, not yet suspended     -> subscription_status = 'suspended'
//
// Each step is UPDATE ... RETURNING, so the row lock + reminder flag makes
// exactly one of the 4 PM2 cluster workers own a given company for a given
// notice; the others simply see no rows. The Pesepay renewal webhook clears
// both flags and pushes the expiry date forward, which re-arms the next cycle.
export interface SubscriptionDunningResult {
  warned3Day: number;
  warned1Day: number;
  suspended: number;
  emailFailures: number;
}

function daysLeft(expiresAt: Date | string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

export async function runSubscriptionDunning(): Promise<SubscriptionDunningResult> {
  const result: SubscriptionDunningResult = {
    warned3Day: 0,
    warned1Day: 0,
    suspended: 0,
    emailFailures: 0,
  };

  // 1. Three-day warning.
  const threeDay = await pool.query(
    `UPDATE companies
        SET reminder_3day_sent = TRUE,
            updated_at = NOW()
      WHERE subscription_expires_at IS NOT NULL
        AND subscription_expires_at > NOW()
        AND subscription_expires_at <= NOW() + INTERVAL '3 days'
        AND subscription_status NOT IN ('suspended', 'expired')
        AND reminder_3day_sent = FALSE
      RETURNING id, name, email, subscription_expires_at`
  );
  for (const row of threeDay.rows) {
    result.warned3Day += 1;
    if (!row.email) continue;
    const sent = await sendSubscriptionExpiryWarningEmail(
      row.email,
      row.name,
      row.subscription_expires_at,
      daysLeft(row.subscription_expires_at)
    );
    if (!sent) result.emailFailures += 1;
  }

  // 2. One-day urgent notice. Also re-arms the 3-day flag: whatever happens
  // next, an "expires in 3 days" email must never arrive after this one.
  const oneDay = await pool.query(
    `UPDATE companies
        SET reminder_1day_sent = TRUE,
            reminder_3day_sent = TRUE,
            updated_at = NOW()
      WHERE subscription_expires_at IS NOT NULL
        AND subscription_expires_at > NOW()
        AND subscription_expires_at <= NOW() + INTERVAL '1 day'
        AND subscription_status NOT IN ('suspended', 'expired')
        AND reminder_1day_sent = FALSE
      RETURNING id, name, email, subscription_expires_at`
  );
  for (const row of oneDay.rows) {
    result.warned1Day += 1;
    if (!row.email) continue;
    const sent = await sendSubscriptionExpiryUrgentEmail(
      row.email,
      row.name,
      row.subscription_expires_at
    );
    if (!sent) result.emailFailures += 1;
  }

  // 3. Suspend companies whose subscription has elapsed. Idempotent:
  // IS DISTINCT FROM 'suspended' means an already-suspended row is untouched,
  // so re-running (or two workers racing) cannot cascade.
  const expired = await pool.query(
    `UPDATE companies
        SET subscription_status = 'suspended',
            updated_at = NOW()
      WHERE subscription_expires_at IS NOT NULL
        AND subscription_expires_at <= NOW()
        AND subscription_status IS DISTINCT FROM 'suspended'
      RETURNING id, name, email, subscription_expires_at`
  );
  result.suspended = expired.rowCount ?? 0;

  return result;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Exported for tests: milliseconds from `now` to the next local midnight.
export function msUntilNextMidnight(now: Date = new Date()): number {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

export function scheduleSubscriptionCron(): void {
  const run = async () => {
    try {
      const r = await runSubscriptionDunning();
      if (r.warned3Day || r.warned1Day || r.suspended || r.emailFailures) {
        console.log(
          `Subscription dunning: ${r.warned3Day} 3-day warning(s), ` +
            `${r.warned1Day} urgent notice(s), ${r.suspended} suspended, ` +
            `${r.emailFailures} email failure(s).`
        );
      }
    } catch (err) {
      console.error('Subscription dunning failed:', err);
    }
  };

  // First fire at the next midnight plus a random offset: PM2 runs 4 cluster
  // workers and a fixed first tick would have all 4 racing the same
  // UPDATE ... RETURNING in the same millisecond. The reminder flags keep the
  // duplicates harmless regardless. After that, every 24h.
  const jitter = Math.floor(Math.random() * 120_000);
  setTimeout(() => {
    run();
    setInterval(run, MS_PER_DAY);
  }, msUntilNextMidnight() + jitter);
}
