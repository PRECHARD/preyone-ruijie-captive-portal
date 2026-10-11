/**
 * Runs the /shifts/close upsert directly against the local DB so Postgres
 * reports the real error instead of the app's opaque 500.
 */
import { Pool } from 'pg';
import 'dotenv/config';

const pool = new Pool();

const shiftId = '12341234-1234-1234-1234-123412341234';
const sql = `INSERT INTO transit_shifts
     (id, company_id, user_id, device_id, driver_id, driver_name, driver_phone,
      conductor_name, conductor_phone, vehicle_reg, status, closed_at)
   VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CLOSED', NOW())
   ON CONFLICT (id) DO UPDATE SET
     status = 'CLOSED',
     closed_at = NOW(),
     driver_id = COALESCE(transit_shifts.driver_id, EXCLUDED.driver_id),
     driver_name = COALESCE(NULLIF(transit_shifts.driver_name, ''), EXCLUDED.driver_name),
     driver_phone = COALESCE(NULLIF(transit_shifts.driver_phone, ''), EXCLUDED.driver_phone),
     conductor_name = COALESCE(NULLIF(transit_shifts.conductor_name, ''), EXCLUDED.conductor_name),
     conductor_phone = COALESCE(NULLIF(transit_shifts.conductor_phone, ''), EXCLUDED.conductor_phone),
     vehicle_reg = COALESCE(NULLIF(transit_shifts.vehicle_reg, ''), EXCLUDED.vehicle_reg)
   WHERE transit_shifts.company_id = EXCLUDED.company_id
   RETURNING *`;

const c = await pool.query(
  `SELECT id FROM transit_companies LIMIT 1`);
const u = await pool.query(`SELECT id FROM transit_users LIMIT 1`);
const d = await pool.query(`SELECT id FROM transit_devices LIMIT 1`);
const companyId = c.rows[0]?.id;
const userId = u.rows[0]?.id;
const deviceId = d.rows[0]?.id;
console.log({ companyId, userId, deviceId });

try {
  const res = await pool.query(sql, [
    shiftId, companyId, userId, deviceId,
    'driver-1', 'DANIEL', '+263771234567',
    'LESLIE', '+263777654321', 'AGJ 1234',
  ]);
  console.log('OK rows:', res.rows.length, res.rows[0]?.status);
  await pool.query('DELETE FROM transit_shifts WHERE id = $1', [shiftId]);
} catch (e: any) {
  console.error('SQL ERROR:', e.code, e.message, e.position, e.detail);
}
await pool.end();
