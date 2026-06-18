const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const pool = new Pool({
  host: 'localhost', port: 5432, database: 'captive_portal',
  user: 'postgres', password: 'Precharddev'
});

async function main() {
  // Use existing portal user and PreLITE package
  const userId = '3f21ac26-8513-405f-95cf-0932d3d912de';
  const packageId = '63664ccc-7c8a-4dcd-a81c-85c0138dc776';

  // Get package details
  const { rows: pkgRows } = await pool.query(
    'SELECT tier_name, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, duration_min, price_amount FROM packages WHERE id = $1',
    [packageId]
  );
  const pkg = pkgRows[0];
  console.log('Package:', pkg.tier_name, '| $' + pkg.price_amount, '|', pkg.data_limit_gb + 'GB', '|', pkg.duration_min + 'min');

  // Get CEO
  const { rows: ceoRows } = await pool.query("SELECT id, full_name FROM admin_users WHERE role = 'CEO' LIMIT 1");
  const ceo = ceoRows[0];
  console.log('CEO:', ceo.full_name);

  // Generate records
  const paymentId = uuidv4();
  const merchantRef = 'SIM-' + Date.now();
  const sessionToken = uuidv4();
  const sessionExpires = new Date(Date.now() + pkg.duration_min * 60 * 1000);

  // Voucher code
  const slug = pkg.tier_name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(4);
  let rand = '';
  for (let j = 0; j < 4; j++) rand += chars[bytes[j] % chars.length];
  const voucherCode = (slug + '-' + rand).toUpperCase();

  console.log('Voucher:', voucherCode);
  console.log('Session Token:', sessionToken);

  // Insert payment
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert payment record
    await client.query(
      `INSERT INTO payments (id, user_id, phone_number, amount, package_id, merchant_reference, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', NOW())`,
      [paymentId, userId, '+263771327202', pkg.price_amount, packageId, merchantRef]
    );

    // 2. Insert transaction
    await client.query(
      `INSERT INTO transactions (payment_id, user_id, package_tier, amount, currency, payment_method, status, completed_at)
       VALUES ($1, $2, $3, $4, 'USD', 'EcoCash', 'completed', NOW())`,
      [paymentId, userId, pkg.tier_name, pkg.price_amount]
    );

    // 3. Insert voucher
    const { rows: vRows } = await client.query(
      `INSERT INTO vouchers (code, duration_min, max_uses, expires_at, data_limit_gb, is_uncapped, bandwidth_mbps_up, bandwidth_mbps_down, package_tier, sold_by, price_amount)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [voucherCode, pkg.duration_min, sessionExpires, pkg.data_limit_gb, pkg.is_uncapped,
       pkg.bandwidth_mbps_up, pkg.bandwidth_mbps_down, pkg.tier_name, ceo.id, pkg.price_amount]
    );
    console.log('Voucher DB id:', vRows[0].id);

    // 4. Insert sale (recorded under CEO)
    await client.query(
      `INSERT INTO sales (voucher_id, voucher_code, sold_by, sold_by_name, amount, currency)
       VALUES ($1, $2, $3, $4, $5, 'USD')`,
      [vRows[0].id, voucherCode, ceo.id, ceo.full_name, pkg.price_amount]
    );
    console.log('Sale recorded under:', ceo.full_name);

    // 5. Update user session
    await client.query(
      'UPDATE users SET session_token = $1, session_expires_at = $2, voucher_code = $3 WHERE id = $4',
      [sessionToken, sessionExpires, voucherCode, userId]
    );
    console.log('User session updated');

    await client.query('COMMIT');

    // Build success URL
    const params = new URLSearchParams({
      token: sessionToken,
      expires: sessionExpires.toISOString(),
      voucher: voucherCode,
      bwUp: String(pkg.bandwidth_mbps_up),
      bwDown: String(pkg.bandwidth_mbps_down),
      dataLimit: String(pkg.data_limit_gb),
      uncapped: String(pkg.is_uncapped),
      dur: String(pkg.duration_min),
      pkg: pkg.tier_name,
    });

    console.log('\n=== SUCCESS URL ===');
    console.log('http://localhost:3000/success.html?' + params.toString());
    console.log('===================\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
  } finally {
    client.release();
    pool.end();
  }
}

main();
