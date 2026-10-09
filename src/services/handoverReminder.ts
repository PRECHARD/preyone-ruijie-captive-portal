import { pool } from '../db/pool';

// Targeted reminder for staff who are still clocked in with pending CASH
// sales. Deduped per staff member: only inserts when no unacknowledged
// cash_handover_reminder exists, so repeated runs never stack alerts.
// The same insert is used by the clock-out 409 handler in routes/admin.ts.
export async function sendHandoverReminders(): Promise<number> {
  const result = await pool.query(
    `INSERT INTO alerts (type, severity, title, message, target_type, target_id, admin_id)
     SELECT 'cash_handover_reminder', 'warning', 'Cash Handover Required',
            'You have ' || cnt || ' pending cash sale(s) totalling $' || TO_CHAR(total, 'FM999990.00') ||
            '. Submit your handover in My Sales before clocking out.',
            'cash_handover', NULL, s.sold_by
     FROM (
       SELECT sold_by, COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0)::numeric AS total
       FROM sales
       WHERE (handover_status IS NULL OR handover_status = 'pending')
         AND (payment_method IS NULL OR payment_method = 'Cash')
         AND sold_by IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM staff_time_logs t
           WHERE t.admin_user_id = sales.sold_by AND t.clock_out IS NULL
         )
       GROUP BY sold_by
     ) s
     WHERE NOT EXISTS (
       SELECT 1 FROM alerts a
       WHERE a.type = 'cash_handover_reminder' AND a.admin_id = s.sold_by AND a.acknowledged = FALSE
     )
     RETURNING admin_id`
  );
  return result.rowCount ?? 0;
}

export function scheduleHandoverReminders(intervalMinutes: number): void {
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;

  const run = async () => {
    try {
      const count = await sendHandoverReminders();
      if (count > 0) {
        console.log(`Handover reminders: ${count} staff member(s) notified.`);
      }
    } catch (err) {
      console.error('Handover reminders failed:', err);
    }
  };

  // Random initial delay: PM2 runs 4 cluster workers, and a fixed first tick
  // would have all 4 racing the dedupe query in the same millisecond window.
  const initialDelay = Math.floor(Math.random() * Math.min(intervalMs, 60_000));
  setTimeout(run, initialDelay);
  setInterval(run, intervalMs);
}
