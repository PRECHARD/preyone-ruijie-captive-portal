import 'dotenv/config';
import { pool } from './pool';

const SQL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name     TEXT NOT NULL,
    phone         TEXT NOT NULL,
    voucher_code  TEXT,
    accepted_tos  BOOLEAN NOT NULL DEFAULT FALSE,
    mac_address   TEXT,
    ip_address    INET,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_token TEXT UNIQUE,
    session_expires_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_users_voucher_code  ON users (voucher_code);
  CREATE INDEX IF NOT EXISTS idx_users_session_token ON users (session_token);

  CREATE TABLE IF NOT EXISTS vouchers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code         TEXT UNIQUE NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 60,
    max_uses     INTEGER NOT NULL DEFAULT 1,
    used_count   INTEGER NOT NULL DEFAULT 0,
    expires_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS access_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    event       TEXT NOT NULL,
    mac_address TEXT,
    ip_address  INET,
    detail      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

(async () => {
  const client = await pool.connect();
  try {
    // Drop tables if they exist to ensure clean state
    await client.query('DROP TABLE IF EXISTS access_log CASCADE');
    await client.query('DROP TABLE IF EXISTS vouchers CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    
    await client.query(SQL);
    console.log('Migration complete.');
  } finally {
    client.release();
    await pool.end();
  }
})();
