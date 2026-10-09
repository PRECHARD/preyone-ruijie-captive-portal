import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockPoolQuery, mockClientQuery, mockClientRelease, mockPoolConnect } = vi.hoisted(() => {
  const mockPoolQuery = vi.fn();
  const mockClientQuery = vi.fn();
  const mockClientRelease = vi.fn();
  const mockPoolConnect = vi.fn().mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  });
  return { mockPoolQuery, mockClientQuery, mockClientRelease, mockPoolConnect };
});

vi.mock('../src/db/pool', () => ({
  pool: { query: mockPoolQuery, connect: mockPoolConnect },
}));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: vi.fn(),
}));

import { requireAdminAuth } from '../src/middleware/adminAuth';
import { systemAdminRouter } from '../src/routes/systemAdmin';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', systemAdminRouter);
  return app;
}

function mockAuth(user: { id: string; role: string; permissions: string[]; companyId?: string | null }) {
  (requireAdminAuth as any).mockImplementation((_req: any, _res: any, next: any) => {
    _req.adminUser = { id: user.id, email: `${user.role}@test`, role: user.role, fullName: 'Test', companyId: user.companyId ?? null, permissions: user.permissions };
    next();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockPoolConnect.mockReset();
  mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
});

describe('Level 0 vs Level 1 isolation (/api/v1/admin)', () => {
  it('rejects a Level 1 company admin creating a company (403)', async () => {
    mockAuth({ id: 'l1-1', role: 'Manager', permissions: ['company.admin', 'operations.manage', 'finance.view'], companyId: 'comp-1' });

    const res = await request(createApp())
      .post('/api/v1/admin/companies')
      .send({ name: 'Zim Shuttle', slug: 'zim-shuttle' });

    expect(res.status).toBe(403);
    expect(mockPoolConnect).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('rejects a Staff user reaching level-0 endpoints (403)', async () => {
    mockAuth({ id: 'staff-1', role: 'Staff', permissions: ['finance.view'] });

    const res = await request(createApp())
      .put('/api/v1/admin/feature-flags')
      .send({ transitV2: true });

    expect(res.status).toBe(403);
  });

  it('allows a company-bound system.developer to reach platform endpoints', async () => {
    mockAuth({ id: 'l1-ceo', role: 'CEO', permissions: ['system.developer', 'company.admin'], companyId: 'comp-1' });
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const res = await request(createApp()).get('/api/v1/admin/companies');

    // system.developer is authoritative: the platform owner holds a transit
    // company binding, so companyId alone must not block level-0 access.
    expect(res.status).toBe(200);
    expect(mockPoolQuery).toHaveBeenCalled();
  });

  it('allows a Level 0 developer to create a company and seed its SUPER_ADMIN', async () => {
    mockAuth({ id: 'l0-1', role: 'CEO', permissions: ['system.developer', 'company.admin'] });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })                       // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'new-comp' }] })      // INSERT company
      .mockResolvedValueOnce({ rows: [{ id: 'new-adm' }] })       // INSERT SUPER_ADMIN
      .mockResolvedValueOnce({ rows: [] });                       // COMMIT

    const res = await request(createApp())
      .post('/api/v1/admin/companies')
      .send({ name: 'Zim Shuttle', slug: 'zim-shuttle', adminUsername: 'zimadmin', adminPassword: 'StrongPass1!' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ companyId: 'new-comp', adminUser: { id: 'new-adm', username: 'zimadmin' }, webAdmin: null });
  });

  it('seeds a company-scoped web admin (admin_users) in the same transaction', async () => {
    mockAuth({ id: 'l0-1', role: 'CEO', permissions: ['system.developer', 'company.admin'] });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })                       // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'new-comp' }] })      // INSERT company
      .mockResolvedValueOnce({ rows: [{ id: 'new-adm' }] })       // INSERT SUPER_ADMIN
      .mockResolvedValueOnce({ rows: [{ id: 'new-web-admin' }] }) // INSERT admin_users (web admin)
      .mockResolvedValueOnce({ rows: [] });                       // COMMIT

    const res = await request(createApp())
      .post('/api/v1/admin/companies')
      .send({
        name: 'Mupota Bus Service',
        slug: 'mupota-bus-service',
        adminUsername: 'mupota-boss',
        adminPassword: 'StrongPass1!',
        adminName: 'Mupota Ops',
        adminEmail: 'ops@mupota.co.zw',
      });

    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe('new-comp');
    expect(res.body.adminUser).toEqual({ id: 'new-adm', username: 'mupota-boss' });
    expect(res.body.webAdmin).toEqual({ id: 'new-web-admin', email: 'ops@mupota.co.zw', role: 'CEO' });
    // The admin_users INSERT must be company-scoped to the new tenant
    const adminInsertCall = mockClientQuery.mock.calls.find(c => c[0].includes('INSERT INTO admin_users'));
    expect(adminInsertCall).toBeTruthy();
    expect(adminInsertCall![1]).toContain('new-comp');
  });

  it('rejects a web-admin seed with an email but no password (422)', async () => {
    mockAuth({ id: 'l0-1', role: 'CEO', permissions: ['system.developer'] });

    const res = await request(createApp())
      .post('/api/v1/admin/companies')
      .send({ name: 'Zim Shuttle', slug: 'zim-shuttle', adminEmail: 'ops@zsl.co.zw' });

    expect(res.status).toBe(422);
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it('rejects a weak web-admin password (422)', async () => {
    mockAuth({ id: 'l0-1', role: 'CEO', permissions: ['system.developer'] });

    const res = await request(createApp())
      .post('/api/v1/admin/companies')
      .send({ name: 'Zim Shuttle', slug: 'zim-shuttle', adminEmail: 'ops@zsl.co.zw', adminPassword: 'short' });

    expect(res.status).toBe(422);
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it('allows a Level 0 developer to list companies', async () => {
    mockAuth({ id: 'l0-1', role: 'CEO', permissions: ['system.developer'] });
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'c1', slug: 'preyone-transit' }] });

    const res = await request(createApp()).get('/api/v1/admin/companies');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'c1', slug: 'preyone-transit' }]);
  });

  it('redacts payment-key secrets from the GET response', async () => {
    mockAuth({ id: 'l0-1', role: 'CEO', permissions: ['system.developer'] });
    mockPoolQuery.mockResolvedValue({ rows: [{ value: JSON.stringify({ PESEPAY_INTEGRATION_KEY: 'sk_live_1234567890abcdef' }) }] });

    const res = await request(createApp()).get('/api/v1/admin/payment-keys');

    expect(res.status).toBe(200);
    expect(res.body.PESEPAY_INTEGRATION_KEY).toBe('sk_l****cdef');
    expect(res.body.PESEPAY_INTEGRATION_KEY).not.toContain('1234567890');
  });
});