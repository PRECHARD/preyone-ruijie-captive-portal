require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  const client = await pool.connect();
  try {
    const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    console.log('Tables:', tables.rows.map(r => r.table_name));

    const vouchers = await client.query('SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 50');
    console.log('Vouchers:', vouchers.rows);

    const users = await client.query('SELECT * FROM users ORDER BY created_at DESC LIMIT 50');
    console.log('Users (latest 50):', users.rows);

    const userCount = await client.query('SELECT COUNT(*)::int AS c FROM users');
    console.log('Users count:', userCount.rows[0].c);

    const logs = await client.query('SELECT * FROM access_log ORDER BY created_at DESC LIMIT 20');
    console.log('Recent access_log:', logs.rows);
  } catch (e) {
    console.error('DB error:', e);
  } finally {
    try { client.release(); } catch (e) {}
    await pool.end();
  }
})();
