import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { requireAdminAuth } from '../src/middleware/adminAuth';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn() },
}));

import { pool } from '../src/db/pool';

const SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';

const makeReq = (token?: string): any => ({
  headers: token ? { authorization: 'Bearer ' + token } : {},
});

const makeRes = () => {
  const obj: any = {};
  obj.status = vi.fn().mockReturnValue(obj);
  obj.json = vi.fn().mockReturnValue(obj);
  return obj;
};

describe('requireAdminAuth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects requests without a Bearer token', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await requireAdminAuth(req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects requests with an invalid token', async () => {
    const req = makeReq('invalid-token');
    const res = makeRes();
    const next = vi.fn();

    await requireAdminAuth(req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects deactivated users', async () => {
    const token = jwt.sign({ id: 'user-1', email: 'a@b', role: 'Staff', fullName: 'Test' }, SECRET, { expiresIn: '1h' });
    (pool.query as any).mockResolvedValue({ rows: [{ id: 'user-1', approved: false }] });

    const req = makeReq(token);
    const res = makeRes();
    const next = vi.fn();

    await requireAdminAuth(req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Account deactivated or removed' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows requests with a valid token', async () => {
    const token = jwt.sign({ id: 'user-1', email: 'a@b', role: 'CEO', fullName: 'Test' }, SECRET, { expiresIn: '1h' });
    (pool.query as any).mockResolvedValue({ rows: [{ id: 'user-1', approved: true }] });

    const req = makeReq(token);
    const res = makeRes();
    const next = vi.fn();

    await requireAdminAuth(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.adminUser).toMatchObject({ id: 'user-1', email: 'a@b', role: 'CEO', fullName: 'Test' });
  });
});
