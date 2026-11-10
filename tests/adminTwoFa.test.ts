import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { sendAdminLoginCode, sendAdminPasswordChangedEmail } from '../src/services/notificationService';

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
    connect: async () => ({
      query: (...a: any[]) => queryMock(...a),
      release: vi.fn(),
    }),
  },
}));

vi.mock('../src/services/notificationService', () => ({
  sendAdminSignupConfirmation: vi.fn(),
  sendAdminSignupNotification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendAdminPasswordChangedEmail: vi.fn(async () => true),
  // The login route now awaits this and refuses to start a challenge when the
  // code could not be handed to the relay, so default the mock to "sent".
  sendAdminLoginCode: vi.fn(async () => true),
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
function serveChallenge(
  codeHash: string | null,
  attempts = 0,
  createdAt = new Date(Date.now() - 61_000)
) {
  queryMock.mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.includes('FROM admin_users WHERE email =')) return { rows: [USER], rowCount: 1 };
    if (sql.includes('FROM admin_users WHERE id =')) return { rows: [USER], rowCount: 1 };
    if (sql.includes('INSERT INTO admin_2fa_challenges')) {
      return { rows: [{ id: 'challenge-1' }], rowCount: 1 };
    }
    if (sql.includes('FROM admin_2fa_challenges')) {
      const recentQuery = sql.includes('created_at > NOW()');
      const isRecent = Date.now() - createdAt.getTime() < 60_000;
      const hasMatch = !!codeHash && (!recentQuery || isRecent);
      return {
        rows: hasMatch ? [{ id: 'challenge-1', code_hash: codeHash, attempts, created_at: createdAt }] : [],
        rowCount: hasMatch ? 1 : 0,
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

  it('reuses a recent CEO challenge instead of sending another OTP on a repeated login', async () => {
    serveChallenge(hash('999999'), 0, new Date());
    const server = await app();

    const res = await request(server)
      .post('/api/admin/auth/login')
      .send({ email: USER.email, password: 'pw' });

    expect(res.status).toBe(200);
    expect(res.body.requires2fa).toBe(true);
    expect(sendAdminLoginCode).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some((c: any[]) => String(c[0]).includes('INSERT INTO admin_2fa_challenges'))).toBe(false);
    expect(queryMock.mock.calls.some((c: any[]) => String(c[0]).includes('DELETE FROM admin_2fa_challenges'))).toBe(false);
  });

  it('does not send another OTP when resend is repeated within the cooldown', async () => {
    serveChallenge(hash('999999'), 0, new Date());
    const server = await app();

    const res = await request(server)
      .post('/api/admin/auth/resend-2fa')
      .send({
        challengeToken: jwt.sign({ id: USER.id, purpose: '2fa' }, SECRET, { expiresIn: '15m' }),
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/sent recently/i);
    expect(sendAdminLoginCode).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some((c: any[]) => String(c[0]).includes('INSERT INTO admin_2fa_challenges'))).toBe(false);
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

  it('refuses to issue a challenge when the code email cannot be sent', async () => {
    serveChallenge(hash('999999'));
    vi.mocked(sendAdminLoginCode).mockResolvedValueOnce(false);
    const server = await app();

    const res = await request(server)
      .post('/api/admin/auth/login')
      .send({ email: USER.email, password: 'pw' });

    // Showing the code screen with no code on the way would strand the user.
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EMAIL_DELIVERY_FAILED');
    expect(res.body.challengeToken).toBeUndefined();
    expect(
      queryMock.mock.calls.some((c: any[]) => String(c[0]).includes('INSERT INTO admin_2fa_challenges'))
    ).toBe(true);
  });

  it('notifies the account email after a successful password reset', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, full_name, email FROM admin_users')) {
        return { rows: [{ id: USER.id, full_name: USER.full_name, email: USER.email }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const server = await app();

    const res = await request(server)
      .post('/api/admin/auth/reset-password')
      .send({ token: 'valid-reset-token', password: 'new-password' });

    expect(res.status).toBe(200);
    expect(sendAdminPasswordChangedEmail).toHaveBeenCalledWith(USER.email, USER.full_name);
  });
});
