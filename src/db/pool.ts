import { Pool, types } from 'pg';

// PostgreSQL DATE is a calendar day, not an instant. The default parser turns
// it into a JS Date at local midnight, and JSON.stringify then emits the UTC
// instant — which is the previous day for Harare (UTC+2). Return the raw
// YYYY-MM-DD text instead so every API response keeps the exact document date.
types.setTypeParser(1082, (value: string) => value);

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME ?? 'captive_portal',
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? '',
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
      // Server-side guard: any single statement (including a runaway sync batch
      // or a missed index) is killed after 15s instead of pinning a client.
      // Kept modest so slow-but-legit admin reports don't trip it.
      // The business timezone is Harare: CURRENT_DATE must be the local trading
      // day, not the UTC day, or documents issued just after midnight are dated
      // yesterday.
      options: '-c statement_timeout=15000 -c timezone=Africa/Harare',
    });
    // A dropped backend must NEVER take the whole service down: log it and let
    // the pool replace the client on next use. (process.exit here would flip
    // PM2 into restart loops under transient db/network hiccups.)
    _pool.on('error', (err) => {
      console.error('Unexpected error on idle pg client', err);
    });
  }
  return _pool;
}

export const pool = new Proxy<Pool>({} as Pool, {
  get(_, prop: keyof Pool) {
    return Reflect.get(getPool(), prop);
  },
  set(_, prop: keyof Pool, value) {
    Reflect.set(getPool(), prop, value);
    return true;
  },
});
