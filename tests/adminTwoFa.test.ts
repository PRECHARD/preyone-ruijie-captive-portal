import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

/**
 * 2FA login contract.
 *
 * The emailed code used to expire in the database after 5 minutes while the
 * challenge token lived 10, so a code that arrived (or was typed) late was
 * rejected as "expired" even though the form was still on screen. These tests
 * pin the DB window, the token lifetime and the resend path to one TTL.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-2fa-secret';
const SECRET = process.env.JWT_SECRET;
const CODE = '123456';

const queryMock = vi.fn();

vi.mock('../src/db/pool', () => ({
  pool: {
    query: (...a: any[]) => queryMock(...a),
  },
}));

vi.mock('../src/services/notificationService', () => ({
  sendAdminSignupConfirmation: vi.fn(),
  sendAdminSignupNotification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendAdminLoginCode: vi.fn(),
}));

vi.mock('../src/middleware/rbac', () => ({ loadPermissions: vi.fn(async () => ({})) }));
vi.mock('../src/utils/ssoCookie', () => ({
  setPreyoneCookie: vi.fn(),
  clearPreyoneCookie: vi.fn(),
  resolveAuthToken: vi.fn(() => null),
}));
vi.mock('bcryptjs', () => ({ default: { compare: vi.fn(async () => true), hash: vi.fn(async () => 'HASH') } }));

const hash = (code: string) => crypto.createHash('sha256').update(`${code}:${SECRET}`).digest('hex');

const USER = {
  id: 'user-1',
  full_name: 'Test Admin',
  email: 'admin@example.com',
  phone: null,
  role: 'CEO',
  approved: true,
  company_id: 'company-1',
  password_hash: 'HASH',
  email_verified: true,
};

function app() {
  return import('../src/routes/adminAuth').then(({ adminAuthRouter }) => {
    const a = express();
    a.use(express.json());
    a.use('/api/admin/auth', adminAuthRouter);
    return a;
  });
}

// Challenge row served by the mocked pool. `expires_at` is only inspected via
// the SQL predicate, so a marker is enough.
function serveChallenge(codeHash: string | null, attempts = 0) {
  queryMock.mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.includes('FROM admin_users WHERE email =')) return { rows: [USER], rowCount: 1 };
    if (sql.includes('FROM admin_users WHERE id =')) return { rows: [USER], rowCount: 1 };
    if (sql.includes('INSERT INTO admin_2fa_challenges')) {
      return { rows: [{ id: 'challenge-1' }], rowCount: 1 };
    }
    if (sql.includes('FROM admin_2fa_challenges')) {
      return {
        rows: codeHash ? [{ id: 'challenge-1', code_hash: codeHash, attempts }] : [],
        rowCount: codeHash ? 1 : 0,
      };
    }
    if (sql.includes('UPDATE admin_users')) {
      return { rows: [{ auth_time: new Date(), last_activity: new Date() }], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM admin_user_sessions')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
}

function tokenLifetimeMinutes(token: string): number {
  const decoded = jwt.decode(token) as { iat: number; exp: number };
  return Math.round((decoded.exp - decoded.iat) / 60);
}

describe('2FA login flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issues a 15-minute code and a challenge token with the same lifetime', async () => {
    serveChallenge(hash('999999'));
    const server = await app();

    const res = await request(server)
      .post('/api/admin/auth/login')
      .send({ email: USER.email, password: 'pw' });

    expect(res.status).toBe(200);
    expect(res.body.requires2fa).toBe(true);
    expect(res.body.expiresInMinutes).toBe(15);
    expect(tokenLifetimeMinutes(res.body.challengeToken)).toBe(15);

    // The database row must use the same minutes, not a hard-coded interval.
    const insert = queryMock.mock.calls.find((c: any[]) =>
      String(c[0]).includes('INSERT INTO admin_2fa_challenges')
    );
    expect(String(insert?.[0])).toContain('make_interval(mins => $3)');
    expect(insert?.[1]?.[2]).toBe(15);
  });

  it('accepts the emailed code and returns an authenticated session', async () => {
    serveChallenge(hash(CODE));
    const server = await app();

    const login = await request(server)
      .post('/api/admin/auth/login')
      .send({ email: USER.email, password: 'pw' });

    const verify = await request(server)
      .post('/api/admin/auth/verify-2fa')
      .send({ challengeToken: login.body.challengeToken, code: CODE });

    expect(verify.status).toBe(200);
    expect(verify.body.token).toBeTruthy();
    expect(verify.body.user.email).toBe(USER.email);
  });

  it('reports an expired challenge with a code the SPA can act on', async () => {
    serveChallenge(null);
    const server = await app();

    const res = await request(server)
      .post('/api/admin/auth/verify-2fa')
      .send({
        challengeToken: jwt.sign({ id: USER.id, purpose: '2fa' }, SECRET, { expiresIn: '15m' }),
        code: CODE,
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('CODE_EXPIRED');
  });

  it('counts a wrong code without burning the login rate-limit budget', async () => {
    serveChallenge(hash('999999'));
    const server = await app();

    const res = await request(server)
      .post('/api/admin/auth/verify-2fa')
      .send({
        challengeToken: jwt.sign({ id: USER.id, purpose: '2fa' }, SECRET, { expiresIn: '15m' }),
        code: CODE,
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INCORRECT_CODE');
    expect(res.body.attemptsRemaining).toBe(4);
  });

  it('resend returns a fresh 15-minute challenge token', async () => {
    serveChallenge(hash('999999'));
    const server = await app();

    const login = await request(server)
      .post('/api/admin/auth/login')
      .send({ email: USER.email, password: 'pw' });

    const resend = await request(server)
      .post('/api/admin/auth/resend-2fa')
      .send({ challengeToken: login.body.challengeToken });

    expect(resend.status).toBe(200);
    expect(resend.body.challengeToken).toBeTruthy();
    expect(tokenLifetimeMinutes(resend.body.challengeToken)).toBe(15);
  });
});
