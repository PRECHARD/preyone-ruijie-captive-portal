import 'dotenv/config';
import { pool } from './db/pool';
import { cleanupExpiredSessions } from './services/sessionCleanup';

(async () => {
  try {
    const count = await cleanupExpiredSessions();
    console.log(`Expired sessions cleared: ${count}`);
  } catch (error) {
    console.error('Failed to cleanup expired sessions:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
