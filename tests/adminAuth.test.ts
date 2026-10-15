import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  requireAdminAuth,
  requireAdminAuthAllowLocked,
  INACTIVITY_TIMEOUT_SEC,
  MAX_SESSION_LIFETIME_SEC,
} from '../src/middleware/adminAuth';

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
      { id: 'user-1', email: 'a@b', role: 'CEO', fullName: 'Test', companyId: 'stale-tenant' },
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
    expect(req.adminUser!.companyId).toBe('transit-9');
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

describe('session policy clocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sign = (claims: Record<string, unknown> = {}) =>
    jwt.sign({ id: 'user-1', email: 'a@b', role: 'CEO', fullName: 'Test', ...claims }, SECRET, { expiresIn: '1h' });

  const liveRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1',
    approved: true,
    role: 'CEO',
    company_id: null,
    portal_company_id: null,
    last_activity: new Date(),
    auth_time: new Date(),
    active_sid: null,
    ...overrides,
  });

  it('locks with 423 when last_activity is older than 15 minutes', async () => {
    const token = sign();
    (pool.query as any).mockResolvedValueOnce({
      rows: [liveRow({ last_activity: new Date(Date.now() - (INACTIVITY_TIMEOUT_SEC + 1) * 1000) })],
    });

    const res = makeRes();
    const next = vi.fn();
    await requireAdminAuth(makeReq(token), res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(423);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SESSION_LOCKED' })
    );
  });

  it('rejects with 401 SESSION_EXPIRED once auth_time is past 10 hours, even if recently active', async () => {
    const token = sign();
    // Fresh last_activity must NOT rescue a session past its absolute cap.
    (pool.query as any).mockResolvedValueOnce({
      rows: [liveRow({ auth_time: new Date(Date.now() - (MAX_SESSION_LIFETIME_SEC + 1) * 1000), last_activity: new Date() })],
    });

    const res = makeRes();
    const next = vi.fn();
    await requireAdminAuth(makeReq(token), res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SESSION_EXPIRED' })
    );
  });

  it('absolute expiry outranks the lock: an old session is never unlockable', async () => {
    const token = sign();
    (pool.query as any).mockResolvedValueOnce({
      rows: [liveRow({
        auth_time: new Date(Date.now() - (MAX_SESSION_LIFETIME_SEC + 1) * 1000),
        last_activity: new Date(Date.now() - (INACTIVITY_TIMEOUT_SEC + 1) * 1000),
      })],
    });

    const res = makeRes();
    await requireAdminAuthAllowLocked(makeReq(token), res as any, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SESSION_EXPIRED' })
    );
  });

  it('allow-locked variant lets a locked session through so the password can be checked', async () => {
    const token = sign();
    (pool.query as any).mockResolvedValueOnce({
      rows: [liveRow({ last_activity: new Date(Date.now() - (INACTIVITY_TIMEOUT_SEC + 1) * 1000) })],
    });

    const req = makeReq(token);
    const res = makeRes();
    const next = vi.fn();
    await requireAdminAuthAllowLocked(req, res as any, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(req.adminSession!.locked).toBe(true);
    // /unlock needs the account id to look up the password hash.
    expect(req.adminUser!.id).toBe('user-1');
  });

  it('rejects a token whose sid no longer matches active_sid (logout revoked it)', async () => {
    const token = sign({ sid: 'token-sid' });
    (pool.query as any).mockResolvedValueOnce({
      rows: [liveRow({ active_sid: '__revoked__' })],
    });

    const res = makeRes();
    const next = vi.fn();
    await requireAdminAuth(makeReq(token), res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SESSION_REVOKED' })
    );
  });

  it('accepts a token whose sid matches the rotated active_sid', async () => {
    const token = sign({ sid: 'matching-sid' });
    (pool.query as any)
      .mockResolvedValueOnce({ rows: [liveRow({ active_sid: 'matching-sid' })] })
      .mockResolvedValueOnce({ rows: [] });

    const next = vi.fn();
    await requireAdminAuth(makeReq(token), makeRes() as any, next);

    expect(next).toHaveBeenCalled();
  });

  it('never slides the clocks: /refresh is the only writer (guard is read-only)', async () => {
    // A plain authenticated request must not touch last_activity, or a
    // background poll would keep an abandoned session alive forever.
    const token = sign();
    (pool.query as any)
      .mockResolvedValueOnce({ rows: [liveRow()] })
      .mockResolvedValueOnce({ rows: [] });

    await requireAdminAuth(makeReq(token), makeRes() as any, vi.fn());

    const calls = (pool.query as any).mock.calls;
    expect(calls.every((c: any[]) => !/UPDATE/i.test(String(c[0])))).toBe(true);
  });

  it('exposes the 900s / 36000s constants', () => {
    expect(INACTIVITY_TIMEOUT_SEC).toBe(900);
    expect(MAX_SESSION_LIFETIME_SEC).toBe(36000);
  });

  it('keeps a second device alive: a session row wins over another device holding active_sid', async () => {
    // The phone signed in last (active_sid = device-a); the laptop's token
    // still has its own admin_user_sessions row, so it must NOT be revoked —
    // that cross-device revocation was what forced repeated email OTPs.
    const token = sign({ sid: 'device-b' });
    (pool.query as any)
      .mockResolvedValueOnce({
        rows: [liveRow({
          active_sid: 'device-a',
          session_sid: 'device-b',
          session_auth_time: new Date(),
          session_last_activity: new Date(),
          // The account mirror is young because device-a is active; the laptop
          // must be judged on ITS row, not on this.
          last_activity: new Date(),
          auth_time: new Date(),
        })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const req = makeReq(token);
    const next = vi.fn();
    await requireAdminAuth(req, makeRes() as any, next);

    expect(next).toHaveBeenCalled();
    // /refresh and /unlock slide the clock of THIS device's row, so the
    // binding must survive onto req.adminSession.
    expect(req.adminSession!.sid).toBe('device-b');
  });

  it('locks the idle device even while another device keeps the account clock warm', async () => {
    const token = sign({ sid: 'device-b' });
    (pool.query as any).mockResolvedValueOnce({
      rows: [liveRow({
        active_sid: 'device-a',
        session_sid: 'device-b',
        session_auth_time: new Date(),
        session_last_activity: new Date(Date.now() - (INACTIVITY_TIMEOUT_SEC + 1) * 1000),
        last_activity: new Date(), // device-a is active right now
        auth_time: new Date(),
      })],
    });

    const res = makeRes();
    const next = vi.fn();
    await requireAdminAuth(makeReq(token), res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(423);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_LOCKED' }));
  });

  it('expires this device at its own 10-hour cap even if another device signed in later', async () => {
    const token = sign({ sid: 'device-b' });
    (pool.query as any).mockResolvedValueOnce({
      rows: [liveRow({
        active_sid: 'device-a',
        session_sid: 'device-b',
        session_auth_time: new Date(Date.now() - (MAX_SESSION_LIFETIME_SEC + 1) * 1000),
        session_last_activity: new Date(),
        auth_time: new Date(), // device-a refreshed the mirror recently
        last_activity: new Date(),
      })],
    });

    const res = makeRes();
    const next = vi.fn();
    await requireAdminAuth(makeReq(token), res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_EXPIRED' }));
  });

  it('revokes a device whose session row was deleted (logout elsewhere)', async () => {
    // No row for device-b and the mirror now points at device-a: the row was
    // deleted by /logout or evicted by the concurrent-device cap.
    const token = sign({ sid: 'device-b' });
    (pool.query as any).mockResolvedValueOnce({
      rows: [liveRow({ active_sid: 'device-a', session_sid: null })],
    });

    const res = makeRes();
    const next = vi.fn();
    await requireAdminAuth(makeReq(token), res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_REVOKED' }));
  });
});
