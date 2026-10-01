import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requirePermission, scopeUserVoucherCodeCondition, scopeVoucherCondition, loadPermissions } from '../src/middleware/rbac';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn() },
}));

import { pool } from '../src/db/pool';

function makeReq(permissions: string[] | undefined, role = 'CEO', companyId: string | null = null, id = 'u1') {
  return { adminUser: { id, email: 'a@b', role, fullName: 'Test', companyId, permissions } } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('requirePermission middleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows when the user holds any of the required permissions', () => {
    const next = vi.fn();
    requirePermission('operations.manage', 'finance.view')(makeReq(['finance.view']), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects a Level 1 company admin attempting a system-developer action', () => {
    const next = vi.fn();
    const res = makeRes();
    requirePermission('system.developer')(makeReq(['company.admin', 'operations.manage'], 'Manager', 'comp-1'), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a Staff user attempting a company-admin action', () => {
    const next = vi.fn();
    const res = makeRes();
    requirePermission('company.admin')(makeReq(['finance.view'], 'Staff'), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when no permissions are resolved (empty list)', () => {
    const next = vi.fn();
    const res = makeRes();
    requirePermission('company.admin')(makeReq([]), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 401 when no authenticated user is present', () => {
    const next = vi.fn();
    const res = makeRes();
    requirePermission('company.admin')({ adminUser: undefined } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a Level 0 developer to reach system-developer routes', () => {
    const next = vi.fn();
    requirePermission('system.developer')(makeReq(['system.developer', 'company.admin'], 'CEO', null), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('scopeVoucherCondition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes Staff to only their own sold vouchers', () => {
    const params: any[] = [];
    const frag = scopeVoucherCondition(makeReq(['finance.view'], 'Staff', null, 'staff-1'), params);
    expect(frag).toBe('v.sold_by = $1');
    expect(params).toEqual(['staff-1']);
  });

  it('scopes a Level 1 company admin to vouchers sold by their company', () => {
    const params: any[] = [];
    const frag = scopeVoucherCondition(makeReq(['company.admin'], 'Manager', 'comp-1'), params);
    expect(frag).toContain('company_id = $1');
    expect(frag).toContain('admin_users');
    expect(params).toEqual(['comp-1']);
  });

  it('leaves Level 0 platform admins unscoped (admin sees everything)', () => {
    const params: any[] = [];
    const frag = scopeVoucherCondition(makeReq(['system.developer'], 'CEO', null), params);
    expect(frag).toBeNull();
    expect(params).toEqual([]);
  });
});

describe('scopeUserVoucherCodeCondition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes Staff by own sold voucher codes with the requested alias', () => {
    const params: any[] = [];
    const frag = scopeUserVoucherCodeCondition(makeReq([], 'Staff', null, 'staff-1'), params, 'u');
    expect(frag).toBe('u.voucher_code IN (SELECT code FROM vouchers WHERE sold_by = $1)');
    expect(params).toEqual(['staff-1']);
  });

  it('scopes company admins by company voucher codes', () => {
    const params: any[] = [];
    const frag = scopeUserVoucherCodeCondition(makeReq([], 'Manager', 'comp-1'), params, 'users');
    expect(frag).toContain('SELECT code FROM vouchers WHERE sold_by IN (SELECT id FROM admin_users WHERE company_id = $1 AND deleted_at IS NULL)');
    expect(params).toEqual(['comp-1']);
  });

  it('leaves Level 0 unscoped', () => {
    const params: any[] = [];
    const frag = scopeUserVoucherCodeCondition(makeReq([], 'CEO', null), params, 'u');
    expect(frag).toBeNull();
    expect(params).toEqual([]);
  });
});

describe('loadPermissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns permission codes across role and user grants', async () => {
    (pool.query as any).mockResolvedValue({ rows: [{ permission_code: 'finance.view' }, { permission_code: 'operations.manage' }] });
    const perms = await loadPermissions('Manager', 'u1');
    expect(perms).toContain('finance.view');
    expect(perms).toContain('operations.manage');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UNION'),
      ['Manager', 'u1']
    );
  });

  it('queries only the role when no user id is provided', async () => {
    (pool.query as any).mockResolvedValue({ rows: [] });
    await loadPermissions('CEO');
    expect(pool.query).toHaveBeenCalledWith(expect.not.stringContaining('UNION'), ['CEO']);
  });
});