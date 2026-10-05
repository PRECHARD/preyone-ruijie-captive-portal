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
    // Two queries now run: the admin_users row, then the effective permission
    // union. Answer them in order so the permission rows are not faked.
    (pool.query as any)
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', approved: true, role: 'CEO' }] })
      .mockResolvedValueOnce({ rows: [{ permission_code: 'system.developer' }] });

    const req = makeReq(token);
    const res = makeRes();
    const next = vi.fn();

    await requireAdminAuth(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.adminUser).toMatchObject({ id: 'user-1', email: 'a@b', role: 'CEO', fullName: 'Test' });
  });

  it('attaches effective permissions to req.adminUser', async () => {
    const token = jwt.sign({ id: 'user-1', email: 'a@b', role: 'CEO', fullName: 'Test' }, SECRET, { expiresIn: '1h' });
    (pool.query as any)
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', approved: true, role: 'CEO', company_id: 'transit-1', portal_company_id: 'portal-1' }],
      })
      .mockResolvedValueOnce({
        rows: [{ permission_code: 'company.admin' }, { permission_code: 'finance.view' }],
      });

    const req = makeReq(token);
    await requireAdminAuth(req, makeRes() as any, vi.fn());

    expect(req.adminUser!.permissions).toEqual(['company.admin', 'finance.view']);
  });

  it('resolves permissions from the current role and transit company, not the token', async () => {
    // A token minted while the user was a Staff member must not keep granting
    // whatever that role implied, and the company grant must be looked up
    // against the transit company (company_permissions is keyed by it).
    const token = jwt.sign(
      { id: 'user-1', email: 'a@b', role: 'CEO', fullName: 'Test', company_id: 'stale-tenant' },
      SECRET,
      { expiresIn: '1h' }
    );
    (pool.query as any)
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', approved: true, role: 'Staff', company_id: 'transit-9', portal_company_id: null }],
      })
      .mockResolvedValueOnce({ rows: [{ permission_code: 'transit.field_app' }] });

    const req = makeReq(token);
    await requireAdminAuth(req, makeRes() as any, vi.fn());

    expect(req.adminUser!.role).toBe('Staff');
    expect(req.adminUser!.company_id).toBe('transit-9');
    expect(req.adminUser!.permissions).toEqual(['transit.field_app']);

    const permCall = (pool.query as any).mock.calls[1];
    expect(permCall[0]).toContain('company_permissions');
    expect(permCall[1]).toEqual(['Staff', 'user-1', 'transit-9']);
  });

  it('does not fail the request when the permission lookup returns nothing', async () => {
    const token = jwt.sign({ id: 'user-1', email: 'a@b', role: 'Staff', fullName: 'Test' }, SECRET, { expiresIn: '1h' });
    (pool.query as any)
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', approved: true, role: 'Staff' }] })
      .mockResolvedValueOnce({ rows: [] });

    const req = makeReq(token);
    const next = vi.fn();
    await requireAdminAuth(req, makeRes() as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.adminUser!.permissions).toEqual([]);
  });
});
