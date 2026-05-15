import { pool } from '../db/pool';

export async function cleanupExpiredSessions(): Promise<number> {
  const result = await pool.query(
    `UPDATE users
     SET session_token = NULL,
         session_expires_at = NULL
     WHERE session_expires_at IS NOT NULL
       AND session_expires_at < NOW()`
  );

  return result.rowCount ?? 0;
}

export function scheduleSessionCleanup(intervalMinutes: number): void {
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;

  setInterval(async () => {
    try {
      const count = await cleanupExpiredSessions();
      if (count > 0) {
        console.log(`Expired session cleanup: ${count} sessions cleared.`);
      }
    } catch (err) {
      console.error('Expired session cleanup failed:', err);
    }
  }, intervalMs);
}
