import 'dotenv/config';
import { pool } from '../src/db/pool';
import { syncRuijieVoucherStatuses } from '../src/services/ruijieVoucherStatusSync';

(async () => {
  const result = await syncRuijieVoucherStatuses({ force: true });
  console.log(JSON.stringify(result, null, 2));
  await pool.end();
})().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
