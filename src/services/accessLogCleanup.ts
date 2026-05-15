import { pool } from '../db/pool';

export async function cleanupOldAccessLogs(retentionDays: number): Promise<number> {
  const result = await pool.query(
    `DELETE FROM access_log
     WHERE created_at < NOW() - INTERVAL '${retentionDays} days'`
  );

  return result.rowCount ?? 0;
}

export function scheduleAccessLogCleanup(intervalMinutes: number, retentionDays: number): void {
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;

  setInterval(async () => {
    try {
      const count = await cleanupOldAccessLogs(retentionDays);
      if (count > 0) {
        console.log(`Access log cleanup: ${count} old entries removed.`);
      }
    } catch (err) {
      console.error('Access log cleanup failed:', err);
    }
  }, intervalMs);
}