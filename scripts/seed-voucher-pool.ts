import 'dotenv/config';
import { pool } from '../src/db/pool';
import {
  getVoucherPoolStatus,
  refillVoucherPool,
  VOUCHER_POOL_LOW_WATERMARK,
  VOUCHER_POOL_TARGET,
} from '../src/services/voucherPool';

(async () => {
  const result = await refillVoucherPool({ force: true });
  console.log(
    JSON.stringify(
      {
        target: VOUCHER_POOL_TARGET,
        lowWatermark: VOUCHER_POOL_LOW_WATERMARK,
        refill: result,
        status: await getVoucherPoolStatus(),
      },
      null,
      2
    )
  );
  await pool.end();
})().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
