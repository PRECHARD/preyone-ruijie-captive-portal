require('dotenv').config();
const { pool } = require('./dist/db/pool.js');
const withTimeout = (p, ms, label) => Promise.race([
  p.then((r) => ({ label, ok: true, rows: (r && r.rowCount != null ? r.rowCount : (r && r.rows ? r.rows.length : -1)) })),
  new Promise((res) => setTimeout(() => res({ label, ok: false }), ms)),
]);
const STMTS = [
  ['aps', "SELECT name, model, mac_address, ip_address, location, status, firmware_version, uptime_seconds, clients_count, last_seen FROM ap_devices ORDER BY name"],
  ['gateways', "SELECT dev_model, COUNT(*) FILTER (WHERE last_seen >= NOW() - interval '3 minutes')::int AS online, COUNT(*)::int AS total FROM gateway_heartbeats GROUP BY dev_model ORDER BY total DESC"],
  ['clients', "SELECT u.id AS user_id, u.full_name, u.mac_address, u.ip_address, u.created_at AS connected_at, u.session_expires_at, u.voucher_code, u.user_agent, v.package_tier FROM users u LEFT JOIN vouchers v ON UPPER(u.voucher_code) = UPPER(v.code) WHERE u.session_expires_at > NOW() LIMIT 1"],
  ['voucherCounters', "SELECT (SELECT COUNT(*)::int FROM users WHERE session_expires_at > NOW()) AS active_sessions"],
  ['access_log', "SELECT al.id, al.event, al.mac_address, al.ip_address, al.detail, al.created_at, u.voucher_code FROM access_log al LEFT JOIN users u ON u.id = al.user_id ORDER BY al.created_at DESC LIMIT 25"],
  ['voucherUsage', "SELECT vr.voucher_code, vr.full_name AS redeemed_by, vr.mac_address, vr.ip_address, vr.created_at AS redeemed_at, u.full_name AS holder_name, u.alias, u.phone, u.user_agent, v.package_tier, v.price_amount FROM voucher_redemptions vr LEFT JOIN users u ON u.id = vr.user_id LEFT JOIN vouchers v ON v.id = vr.voucher_id ORDER BY vr.created_at DESC LIMIT 50"],
];
(async () => {
  for (const [label, sql] of STMTS) {
    const r = await withTimeout(pool.query(sql), 6000, label);
    console.log((r.ok ? 'OK ' : 'HANG ') + label + ' -> ' + JSON.stringify(r.rows));
  }
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });