import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for PostgreSQL error 42P10 in the user INSERTs.
 *
 * `idx_users_email_unique` is a PARTIAL unique index:
 *   CREATE UNIQUE INDEX ... ON users (email) WHERE email IS NOT NULL AND email != ''
 *
 * A bare `ON CONFLICT (email)` cannot infer a partial index, so every signup and
 * every account registration aborted with:
 *   42P10  there is no unique or exclusion constraint matching the ON CONFLICT specification
 *
 * The fix is to restate the index predicate in the conflict target. These tests
 * assert the executed SQL, and also assert it still matches the predicate the
 * migration creates, so the two cannot drift apart again.
 */

vi.mock('../src/db/pool', () => {
  const q = vi.fn();
  const r = vi.fn();
  return {
    pool: {
      query: q,
      connect: vi.fn().mockResolvedValue({ query: q, release: r }),
    },
  };
});

vi.mock('../src/services/notificationService', () => ({
  sendPortalAccountCreated: vi.fn().mockResolvedValue(true),
  sendPortalSignupConfirmation: vi.fn().mockResolvedValue(true),
  sendPortalEmailVerification: vi.fn().mockResolvedValue(true),
  sendPortalForgotPassword: vi.fn().mockResolvedValue(true),
}));

import { authRouter } from '../src/routes/auth';
import { pool } from '../src/db/pool';

const EXPECTED_PREDICATE = "email IS NOT NULL AND email != ''";

const VOUCHER_ROW = {
  id: 'v-1',
  code: 'e7wj7w',
  duration_min: 60,
  max_uses: 3,
  used_count: 0,
  expires_at: null,
  data_limit_gb: 5,
  is_uncapped: false,
  bandwidth_mbps_up: 4,
  bandwidth_mbps_down: 8,
  package_tier: 'PreLite',
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRouter);
  return a;
}

function stubSignup(rows: unknown[] = [VOUCHER_ROW]) {
  (pool.query as any).mockImplementation(async (sql: string) => {
    const q = String(sql);
    if (q.includes('FROM vouchers') && q.includes('FOR UPDATE')) return { rows, rowCount: rows.length };
    if (q.includes('INSERT INTO users')) return { rows: [{ id: 'u-1' }], rowCount: 1 };
    if (q.includes('SELECT id FROM users WHERE email')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
}

const userInsertSql = (): string[] =>
  (pool.query as any).mock.calls
    .map((c: any[]) => String(c[0]))
    .filter((s: string) => s.includes('INSERT INTO users'));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('partial-index conflict target (42P10)', () => {
  it('voucher signup INSERT infers the partial email index', async () => {
    stubSignup();
    await request(app())
      .post('/api/auth/signup')
      .send({
        fullName: 'Jane Chinyama',
        phone: '+263771327202',
        email: 'jane@example.com',
        voucherCode: 'e7wj7w',
        acceptedTos: true,
      });

    const inserts = userInsertSql();
    expect(inserts.length).toBeGreaterThan(0);
    for (const sql of inserts) {
      expect(sql).toContain(`ON CONFLICT (email) WHERE ${EXPECTED_PREDICATE} DO NOTHING`);
    }
  });

  it('signup works without an email (phone-only quick voucher)', async () => {
    stubSignup();
    await request(app())
      .post('/api/auth/signup')
      .send({
        fullName: 'Jane Chinyama',
        phone: '+263771327202',
        voucherCode: 'e7wj7w',
        acceptedTos: true,
      });

    for (const sql of userInsertSql()) {
      expect(sql).toContain(`ON CONFLICT (email) WHERE ${EXPECTED_PREDICATE} DO NOTHING`);
    }
  });

  it('account registration INSERT infers the partial email index', async () => {
    stubSignup();
    const res = await request(app())
      .post('/api/auth/register')
      .send({
        fullName: 'Jane Chinyama',
        phone: '+263771327202',
        email: 'jane@example.com',
        password: 'Abcd1234!',
        acceptedTos: true,
      });

    expect(res.status).toBe(201);
    const inserts = userInsertSql();
    expect(inserts.length).toBeGreaterThan(0);
    for (const sql of inserts) {
      expect(sql).toContain(`ON CONFLICT (email) WHERE ${EXPECTED_PREDICATE} DO NOTHING`);
    }
  });

  it('matches the predicate the migration actually creates', () => {
    const migrate = readFileSync(resolve(__dirname, '../src/db/migrate.ts'), 'utf8');
    const match = migrate.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users \(email\) WHERE (.+?);/i
    );
    expect(match, 'idx_users_email_unique migration not found').toBeTruthy();
    expect(match![1].trim()).toBe(EXPECTED_PREDICATE);

    const authSrc = readFileSync(resolve(__dirname, '../src/routes/auth.ts'), 'utf8');
    expect(authSrc).not.toMatch(/ON CONFLICT \(email\)\s+DO NOTHING/);
  });
});