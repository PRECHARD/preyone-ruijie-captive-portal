/**
 * Local POS demo environment.
 *
 * Boots a throwaway PostgreSQL (port 5433, data in .pgdata-dev), runs the
 * schema migration, seeds demo stock + a till user (PIN 1234), then starts
 * the API on :3000. Pair with `npm run dev` inside pos/ (Vite on :5174).
 *
 *   node scripts/dev-pos.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_BIN = process.env.PREYONE_NODE || 'node';
const dataDir = process.env.PGDATA_DIR || path.join(root, '.pgdata-dev');
const DB = {
  host: 'localhost',
  port: Number(process.env.DBPORT || 5433),
  user: 'postgres',
  password: 'posdemo',
  database: 'preyone_pos',
};

const env = {
  ...process.env,
  PORT: '3000',
  NODE_ENV: 'development',
  JWT_SECRET: 'dev-secret-not-for-production',
  DB_HOST: DB.host,
  DB_PORT: String(DB.port),
  DB_NAME: DB.database,
  DB_USER: DB.user,
  DB_PASSWORD: DB.password,
};

const kids = [];
const die = (err) => {
  console.error(err);
  shutdown(1);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));

function shutdown(code) {
  for (const k of kids) {
    try { k.kill(); } catch { /* already gone */ }
  }
  if (globalThis.__epg) globalThis.__epg.initialisePromise?.then(() => globalThis.__epg.stop()).catch(() => {});
  process.exit(code);
}

async function waitForPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const net = await import('node:net');
    const ok = await new Promise((res) => {
      const s = net.default.connect({ host: '127.0.0.1', port }, () => { s.end(); res(true); });
      s.on('error', () => res(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Nothing listening on port ${port}`);
}

const epg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: DB.user,
  password: DB.password,
  port: DB.port,
  persistent: process.env.EPG_PERSISTENT !== 'false',
  initdbArgs: ['--encoding=UTF8', '--locale=C'],
});
globalThis.__epg = epg;

if (!existsSync(dataDir)) {
  console.log('[dev] initialising postgres data dir…');
  await epg.initialise();
}
console.log('[dev] starting postgres on :5433…');
await epg.start();
await epg.createDatabase(DB.database).catch(() => {}); // already exists on re-runs

// 1) schema
console.log('[dev] running migration…');
await new Promise((resolve, reject) => {
  const m = spawn(NODE_BIN, ['-r', 'ts-node/register', 'src/db/migrate.ts'], { cwd: root, env, shell: false });
  m.stdout.on('data', (d) => process.stdout.write(d));
  m.stderr.on('data', (d) => process.stderr.write(d));
  m.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('migrate failed'))));
});

// 2) seed
console.log('[dev] seeding…');
{
  const client = new pg.Client({ ...DB });
  await client.connect();

  const pinHash = bcrypt.hashSync('1234', 10);
  await client.query(
    `INSERT INTO admin_users (full_name, email, phone, role, password_hash, approved, pin_hash)
     VALUES ($1,$2,$3,'CEO',$4,TRUE,$5)
     ON CONFLICT (email) DO UPDATE SET
       pin_hash = EXCLUDED.pin_hash,
       company_id = (SELECT id FROM companies ORDER BY created_at LIMIT 1)`,
    ['Till Operator', 'till@preyone.com', '+263771327202', bcrypt.hashSync('not-used-local', 4), pinHash]
  );

  const products = [
    // name, sku, barcode, category, price, cost, stock, trackStock, lowThreshold
    ['WiFi Voucher - Day Pass', 'WIFI-DAY', null, 'Vouchers', 1.0, 0.4, 0, false, 0],
    ['WiFi Voucher - Weekly', 'WIFI-WEEK', null, 'Vouchers', 5.0, 2.0, 0, false, 0],
    ['Airtime $1', 'AIR-1', '600123000001', 'Airtime', 1.0, 1.0, 50, true, 20],
    ['Airtime $5', 'AIR-5', '600123000002', 'Airtime', 5.0, 5.0, 30, true, 12],
    ['Data Bundle 1GB', 'DATA-1GB', '600123000003', 'Airtime', 2.0, 1.4, 40, true, 15],
    ['20W USB-C Charger', 'CHG-20W', '600123000004', 'Accessories', 18.0, 11.0, 8, true, 3],
    ['Earphones Wired', 'EAR-01', '600123000005', 'Accessories', 8.0, 4.5, 15, true, 5],
    ['Phone Pouch', 'PCH-01', '600123000006', 'Accessories', 15.0, 9.0, 10, true, 4],
    ['HDMI Cable 2m', 'HDMI-2M', '600123000007', 'Accessories', 10.0, 6.0, 6, true, 2],
    ['Printing A4 B&W', 'PRN-A4', null, 'Printing', 0.5, 0.1, 0, false, 0],
    ['Lamination A4', 'LAM-A4', null, 'Printing', 1.0, 0.3, 0, false, 0],
    ['Passport Photo Set', 'PHOTO-PPT', null, 'Printing', 5.0, 1.0, 0, false, 0],
  ];
  for (const [name, sku, barcode, category, price, cost, stock, track, low] of products) {
    await client.query(
      `INSERT INTO pos_products (name, sku, barcode, category, price, cost_price, stock_qty, track_stock, low_stock_threshold)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
       WHERE NOT EXISTS (SELECT 1 FROM pos_products WHERE lower(name) = lower($1))`,
      [name, sku, barcode, category, price, cost, stock, track, low]
    );
  }
  await client.end();
}
console.log('[dev] seeded — PIN 1234 · till@preyone.com');

// 3) API
await new Promise((resolve, reject) => {
  const api = spawn(NODE_BIN, ['dist/index.js'], { cwd: root, env, shell: false });
  kids.push(api);
  api.stdout.on('data', (d) => process.stdout.write(d));
  api.stderr.on('data', (d) => process.stderr.write(d));
  api.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('api exited'))));
  api.on('error', reject);
});

await waitForPort(3000);
console.log('\n[dev] API ready on http://localhost:3000');
console.log('[dev] next: open a second terminal →  cd pos && npm run dev  →  http://localhost:5174');
