import 'dotenv/config';
import { pool } from '../src/db/pool';
import { getAllRuijieVouchers, isRuijieCloudConfigured } from '../src/services/ruijieCloud';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const paymentId = String(argValue('--payment-id') || process.env.RETRY_PURGE_PAYMENT_ID || '').trim();
const apply = process.argv.includes('--apply');
const retireRemote = process.argv.includes('--retire-remote');

(async () => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId)) {
    throw new Error('Usage: purge-retry-vouchers.ts --payment-id <uuid> [--apply] [--retire-remote]');
  }

  const payment = await pool.query(
    'SELECT id, status, voucher_code, pesepay_reference FROM payments WHERE id = $1',
    [paymentId]
  );
  if (payment.rows.length === 0) throw new Error(`Payment ${paymentId} not found`);
  if (payment.rows[0].status !== 'completed' || !payment.rows[0].voucher_code) {
    throw new Error(`Payment ${paymentId} is not completed with a voucher`);
  }

  const keepCode = String(payment.rows[0].voucher_code).toLowerCase();
  let remoteRetryCodes: string[] = [];
  let remoteError: string | null = null;
  if (isRuijieCloudConfigured()) {
    try {
      const remote = await getAllRuijieVouchers();
      remoteRetryCodes = remote
        .filter((voucher) => voucher.comment === `Payment ${paymentId}`)
        .map((voucher) => String(voucher.voucherCode || voucher.codeNo || '').trim().toLowerCase())
        .filter((code) => code && code !== keepCode);
    } catch (err) {
      remoteError = err instanceof Error ? err.message : String(err);
    }
  } else {
    remoteError = 'Ruijie Cloud is not configured';
  }

  const localOrphans = await pool.query(
    `SELECT rv.code_no
       FROM ruijie_vouchers rv
      WHERE rv.payment_id = $1
        AND lower(rv.code_no) <> $2
        AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE lower(v.code) = lower(rv.code_no))
        AND NOT EXISTS (SELECT 1 FROM sales s WHERE lower(s.voucher_code) = lower(rv.code_no))
        AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.voucher_code) = lower(rv.code_no))`,
    [paymentId, keepCode]
  );

  const usedRemoteCodes = remoteRetryCodes.length
    ? await pool.query(
        `SELECT lower(code) AS code FROM vouchers WHERE lower(code) = ANY($1::text[])
         UNION
         SELECT lower(voucher_code) AS code FROM sales WHERE lower(voucher_code) = ANY($1::text[])
         UNION
         SELECT lower(voucher_code) AS code FROM users WHERE lower(voucher_code) = ANY($1::text[])`,
        [remoteRetryCodes]
      )
    : { rows: [] as { code: string }[] };
  const used = new Set(usedRemoteCodes.rows.map((row) => String(row.code)));

  const alertCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM alerts
      WHERE type = 'orphaned_voucher'
        AND (target_id = $1 OR message LIKE '%Payment ' || $1 || '%')`,
    [paymentId]
  );

  const report = {
    paymentId,
    keepCode,
    apply,
    localOrphanRows: localOrphans.rows.length,
    localOrphanCodes: localOrphans.rows.map((row) => row.code_no),
    remoteRetryCodes: remoteRetryCodes.length,
    remoteCodes: remoteRetryCodes,
    remoteUsedElsewhere: [...used],
    orphanedVoucherAlerts: Number(alertCount.rows[0]?.count ?? 0),
    remoteError,
    remoteRetireRequested: retireRemote,
  };

  if (!apply) {
    console.log(JSON.stringify({ ...report, mode: 'dry-run' }, null, 2));
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const deletedAlerts = await client.query(
      `DELETE FROM alerts
        WHERE type = 'orphaned_voucher'
          AND (target_id = $1 OR message LIKE '%Payment ' || $1 || '%')
        RETURNING id`,
      [paymentId]
    );

    const deletedLocal = await client.query(
      `DELETE FROM ruijie_vouchers rv
        WHERE rv.payment_id = $1
          AND lower(rv.code_no) <> $2
          AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE lower(v.code) = lower(rv.code_no))
          AND NOT EXISTS (SELECT 1 FROM sales s WHERE lower(s.voucher_code) = lower(rv.code_no))
          AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.voucher_code) = lower(rv.code_no))
        RETURNING rv.code_no`,
      [paymentId, keepCode]
    );

    let retired = 0;
    if (retireRemote) {
      for (const code of remoteRetryCodes) {
        if (used.has(code)) continue;
        const inserted = await client.query(
          `INSERT INTO ruijie_vouchers
             (code_no, tier_name, payment_id, source, comment, pool_status, assigned_at)
           VALUES ($1, NULL, NULL, 'manual', $2, 'retired', NOW())
           ON CONFLICT (code_no) DO UPDATE
             SET pool_status = 'retired'
           WHERE ruijie_vouchers.pool_status IS NULL
              OR ruijie_vouchers.pool_status = 'available'`,
          [code, `Retired orphan retry mint for payment ${paymentId}`]
        );
        retired += inserted.rowCount ?? 0;
      }
    }

    await client.query('COMMIT');
    console.log(
      JSON.stringify(
        {
          ...report,
          mode: 'applied',
          deletedAlerts: deletedAlerts.rowCount,
          deletedLocal: deletedLocal.rows.map((row) => row.code_no),
          retiredRemoteLocally: retired,
          remainingRemoteRetryCodes: retireRemote
            ? remoteRetryCodes.filter((code) => !used.has(code)).length
            : remoteRetryCodes.length,
        },
        null,
        2
      )
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
})().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
