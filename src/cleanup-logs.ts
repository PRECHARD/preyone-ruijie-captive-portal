import 'dotenv/config';
import { pool } from './db/pool';
import { cleanupOldAccessLogs } from './services/accessLogCleanup';

(async () => {
  const retentionDays = Number(process.env.ACCESS_LOG_RETENTION_DAYS ?? 30);
  try {
    const count = await cleanupOldAccessLogs(retentionDays);
    console.log(`Old access logs cleared: ${count} entries removed.`);
  } catch (error) {
    console.error('Failed to cleanup old access logs:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();