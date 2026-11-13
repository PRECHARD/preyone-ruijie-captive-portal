import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const connectMock = vi.fn();

vi.mock('../src/db/pool', () => ({
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
    connect: (...args: unknown[]) => connectMock(...args),
  },
}));

vi.mock('bcryptjs', () => ({
  default: { compare: async () => true, hash: async () => 'hash' },
}));

vi.mock('../src/services/notificationService', () => ({
  sendAdminSignupConfirmation: vi.fn(),
  sendAdminSignupNotification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendAdminLoginCode: vi.fn(async () => true),
  sendAdminPasswordChangedEmail: vi.fn(),
}));

function loadRouter() {
  return import('../src/routes/adminAuth');
}

describe('POST /api/admin/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM admin_users WHERE email/.test(sql)) {
        return {
          rows: [{
            id: 'user-1',
            full_name: 'Ada',
            email: 'ada@preyone.com',
            role: 'CEO',
            approved: true,
            password_hash: 'hash',
            email_verified: true,
            two_factor_enabled: false,
          }],
        };
      }
      if (/SELECT id FROM admin_2fa_challenges/.test(sql)) {
        return { rows: [{ id: 'challenge-1' }] };
      }
      return { rows: [] };
    });
    connectMock.mockResolvedValue({ query: queryMock, release: () => undefined });
  });

  it('still emails a code when the body claims to be the invoice or POS client', async () => {
    const { adminAuthRouter } = await loadRouter();
    const app = express();
    app.use(express.json());
    app.use('/api/admin/auth', adminAuthRouter);

    for (const client of ['invoice', 'pos']) {
      const res = await request(app)
        .post('/api/admin/auth/login')
        .send({ email: 'ada@preyone.com', password: 'secret', client });
      expect(res.status).toBe(200);
      expect(res.body.requires2fa).toBe(true);
      expect(res.body.token).toBeUndefined();
    }
  });
});
