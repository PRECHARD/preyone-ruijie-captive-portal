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

vi.mock('../src/services/transitAudit', () => ({
  transitAudit: vi.fn().mockResolvedValue(undefined),
  transitSecurityEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/routes/adminAuth', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { requireAdminAuth } from '../src/middleware/adminAuth';
import { transitWebRouter } from '../src/routes/transitWeb';
import { transitAudit, transitSecurityEvent } from '../src/services/transitAudit';
import { recordAuditLog } from '../src/routes/adminAuth';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transit', transitWebRouter);
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

const l1 = { id: 'mgr-1', role: 'Manager', permissions: ['company.admin', 'operations.manage', 'finance.view'], companyId: 'comp-1' };
const l0 = { id: 'ceo-1', role: 'CEO', permissions: ['system.developer', 'company.admin'], companyId: null };

describe('Web-portal device management (/api/v1/transit/devices)', () => {
  it('requires company.admin permission (403 for read-only staff)', async () => {
    mockAuth({ id: 'staff-1', role: 'Staff', permissions: ['finance.view'], companyId: 'comp-1' });

    const res = await request(createApp()).get('/api/v1/transit/devices');

    expect(res.status).toBe(403);
  });

  it('lists devices scoped to the Level 1 company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ device_id: 'd1', device_uuid: 'AGT-0001', device_model: 'A6 POS', app_version: '2.4.0', status: 'ACTIVE', bound_name: 'Tendai Moyo' }],
    });

    const res = await request(createApp()).get('/api/v1/transit/devices');

    expect(res.status).toBe(200);
    expect(res.body.devices[0].bound_name).toBe('Tendai Moyo');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['comp-1']);
  });

  it('lists devices across all companies for Level 0 (no company scope param)', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).get('/api/v1/transit/devices');

    expect(res.status).toBe(200);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([]);
  });

  it('revokes a device by deviceUuid, clears its signing key and writes audit + security events', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'dev-1', device_uuid: 'AGT-0001', company_id: 'comp-1', user_id: 'u-1' }],
    });

    const res = await request(createApp())
      .post('/api/v1/transit/devices/AGT-0001/revoke');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REVOKED');
    const updateSql = mockPoolQuery.mock.calls[0][0];
    expect(updateSql).toContain("device_key = ''");
    expect(updateSql).toContain('revoked_at = NOW()');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['AGT-0001', 'REVOKED', 'comp-1']);
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'DEVICE_REVOKED', entityId: 'AGT-0001' }));
    expect(transitSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'DEVICE_REVOKED' }));
  });

  it('404s when revoking a device outside the Level 1 company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).post('/api/v1/transit/devices/other-0001/revoke');

    expect(res.status).toBe(404);
    expect(transitAudit).not.toHaveBeenCalled();
  });

  it('disables a device without clearing the signing key', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'dev-1', device_uuid: 'AGT-0001', company_id: 'comp-1', user_id: 'u-1' }] });

    const res = await request(createApp()).post('/api/v1/transit/devices/AGT-0001/disable');

    expect(res.status).toBe(200);
    const updateSql = mockPoolQuery.mock.calls[0][0];
    expect(updateSql).not.toContain('device_key');
  });
});

describe('Web-portal staff management (/api/v1/transit/staff)', () => {
  it('creates a staff member with autogenerated secure credentials', async () => {
    mockAuth(l1);
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })                        // BEGIN
      .mockResolvedValueOnce({ rows: [] })                        // existing lookup
      .mockResolvedValueOnce({ rows: [{ id: 'tu-1', username: 'tendai1234', role: 'CONDUCTOR', status: 'ACTIVE' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] });                        // COMMIT

    const res = await request(createApp())
      .post('/api/v1/transit/staff')
      .send({ fullName: 'Tendai Moyo', role: 'CONDUCTOR' });

    expect(res.status).toBe(201);
    expect(res.body.staff.username).toMatch(/^tendai\d{4}$/);
    expect(res.body.generatedPassword.length).toBeGreaterThanOrEqual(8);
  });

  it('rejects staff creation outside a company context', async () => {
    mockAuth(l0);

    const res = await request(createApp())
      .post('/api/v1/transit/staff')
      .send({ fullName: 'Solo', role: 'DRIVER' });

    expect(res.status).toBe(422);
  });

  it('rejects unsupported staff roles', async () => {
    mockAuth(l1);

    const res = await request(createApp())
      .post('/api/v1/transit/staff')
      .send({ fullName: 'Solo', role: 'CEO' });

    expect(res.status).toBe(422);
  });

  it('creates staff for a Level-0 selected company via body companyId', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'comp-9' }] });   // company exists check
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })                        // BEGIN
      .mockResolvedValueOnce({ rows: [] })                        // existing lookup
      .mockResolvedValueOnce({ rows: [{ id: 'tu-9', username: 'tendai1234', role: 'DRIVER', status: 'ACTIVE' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] });                       // COMMIT

    const res = await request(createApp())
      .post('/api/v1/transit/staff')
      .send({ fullName: 'Tendai Moyo', role: 'DRIVER', companyId: 'comp-9' });

    expect(res.status).toBe(201);
    const insertCall = mockClientQuery.mock.calls.find(c => c[0].includes('INSERT INTO transit_users'));
    expect(insertCall).toBeTruthy();
    expect(insertCall![1][0]).toBe('comp-9');
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'comp-9', action: 'STAFF_CREATED' }));
  });

  it('creates staff for a Level-0 selected company via X-Company-Id header', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'comp-9' }] });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })                        // BEGIN
      .mockResolvedValueOnce({ rows: [] })                        // existing lookup
      .mockResolvedValueOnce({ rows: [{ id: 'tu-10', username: 'solo1234', role: 'CONDUCTOR', status: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [] });                       // COMMIT

    const res = await request(createApp())
      .post('/api/v1/transit/staff')
      .set('X-Company-Id', 'comp-9')
      .send({ fullName: 'Solo Ncube', role: 'CONDUCTOR' });

    expect(res.status).toBe(201);
    const insertCall = mockClientQuery.mock.calls.find(c => c[0].includes('INSERT INTO transit_users'));
    expect(insertCall![1][0]).toBe('comp-9');
  });

  it('rejects a company-scoped admin targeting another company (403)', async () => {
    mockAuth(l1);

    const res = await request(createApp())
      .post('/api/v1/transit/staff')
      .send({ fullName: 'Tendai', role: 'DRIVER', companyId: 'other-c1' });

    expect(res.status).toBe(403);
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it('404s when a Level-0 targets a company that does not exist', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // company exists check -> not found

    const res = await request(createApp())
      .post('/api/v1/transit/staff')
      .send({ fullName: 'Tendai', role: 'DRIVER', companyId: 'ghost-c1' });

    expect(res.status).toBe(404);
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it('lists staff scoped to a Level-0 selected company via query param', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).get('/api/v1/transit/staff?companyId=comp-9');

    expect(res.status).toBe(200);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['comp-9']);
  });

  it('filters staff by role case-insensitively (UPPER)', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).get('/api/v1/transit/staff?role=driver');

    expect(res.status).toBe(200);
    const sql = mockPoolQuery.mock.calls[0][0];
    expect(sql).toContain('UPPER(u.role) = UPPER($2)');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['comp-1', 'driver']);
  });

  it('persists the phone number on staff creation', async () => {
    mockAuth(l1);
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })                        // BEGIN
      .mockResolvedValueOnce({ rows: [] })                        // existing lookup
      .mockResolvedValueOnce({ rows: [{ id: 'tu-1', username: 'tendai1234', role: 'CONDUCTOR', status: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [] });                       // COMMIT

    const res = await request(createApp())
      .post('/api/v1/transit/staff')
      .send({ fullName: 'Tendai Moyo', role: 'CONDUCTOR', phone: '+263712345678' });

    expect(res.status).toBe(201);
    const insertCall = mockClientQuery.mock.calls.find(c => c[0].includes('INSERT INTO transit_users'));
    expect(insertCall![0]).toContain('phone');
    expect(insertCall![1]).toHaveLength(6);
    expect(insertCall![1][5]).toBe('+263712345678');
  });

  it('updates a staff member name, phone and role via PATCH', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'tu-1', username: 'tendai1234', full_name: 'Tendai Moyo', phone: '+263712345678', role: 'DRIVER', company_id: 'comp-1' }] });

    const res = await request(createApp())
      .patch('/api/v1/transit/staff/tu-1')
      .send({ fullName: 'Tendai Moyo', phone: '+263712345678', role: 'DRIVER' });

    expect(res.status).toBe(200);
    expect(res.body.staff.phone).toBe('+263712345678');
    expect(res.body.staff.role).toBe('DRIVER');
    const sql = mockPoolQuery.mock.calls[0][0];
    expect(sql).toContain('full_name = $1');
    expect(sql).toContain('phone = $2');
    expect(sql).toContain('role = $3');
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_UPDATED', entityId: 'tu-1' }));
  });

  it('rejects a PATCH with no updatable fields', async () => {
    mockAuth(l1);

    const res = await request(createApp())
      .patch('/api/v1/transit/staff/tu-1')
      .send({});

    expect(res.status).toBe(422);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('rejects a PATCH with an invalid role', async () => {
    mockAuth(l1);

    const res = await request(createApp())
      .patch('/api/v1/transit/staff/tu-1')
      .send({ fullName: 'X', role: 'CEO' });

    expect(res.status).toBe(422);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('404s a PATCH for a staff member outside the Level 1 company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp())
      .patch('/api/v1/transit/staff/ghost-99')
      .send({ fullName: 'Ghost' });

    expect(res.status).toBe(404);
    expect(transitAudit).not.toHaveBeenCalled();
  });

  it('resets a staff member password to a fresh generated one (PATCH)', async () => {
    mockAuth(l1);
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'tu-1', username: 'tendai1234', company_id: 'comp-1' }] }) // user lookup
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const res = await request(createApp()).patch('/api/v1/transit/staff/tu-1/reset-password');

    expect(res.status).toBe(200);
    expect(res.body.staff.username).toBe('tendai1234');
    expect(res.body.generatedPassword.length).toBeGreaterThanOrEqual(8);
    // The UPDATE must store a bcrypt hash, never the plaintext.
    const updateSql = mockPoolQuery.mock.calls[1][0];
    const updateArgs = mockPoolQuery.mock.calls[1][1];
    expect(updateSql).toContain('password_hash');
    expect(updateArgs[0]).toContain('$2');
    expect(updateArgs[0]).not.toBe(res.body.generatedPassword);
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_PASSWORD_RESET', entityId: 'tu-1' }));
  });

  it('404s when resetting a password for a staff member outside the Level 1 company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // user lookup → none

    const res = await request(createApp()).patch('/api/v1/transit/staff/other-tu/reset-password');

    expect(res.status).toBe(404);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(transitAudit).not.toHaveBeenCalled();
  });

  it('unbinds a staff member company-scoped devices (clears binding + signing key, audits)', async () => {
    mockAuth(l1);
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'tu-1', username: 'tendai1234', company_id: 'comp-1' }] }) // user lookup
      .mockResolvedValueOnce({ rows: [                                                              // device update
        { id: 'd-1', device_uuid: 'AGT-0001' },
        { id: 'd-2', device_uuid: 'AGT-0002' },
      ] });

    const res = await request(createApp()).post('/api/v1/transit/staff/tu-1/unbind-device');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Device unbound successfully');
    expect(res.body.devicesUnbound).toBe(2);
    expect(res.body.deviceUuids).toEqual(['AGT-0001', 'AGT-0002']);
    const updateSql = mockPoolQuery.mock.calls[1][0];
    expect(updateSql).toContain('user_id = NULL');
    expect(updateSql).toContain("device_key = ''");
    expect(updateSql).toContain("status = 'UNBOUND'");
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_DEVICE_UNBOUND', entityId: 'tu-1', metadata: expect.objectContaining({ devicesUnbound: 2 }) }));
  });

  it('404s when unbinding a staff member outside the Level 1 company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // user lookup → none

    const res = await request(createApp()).post('/api/v1/transit/staff/other-tu/unbind-device');

    expect(res.status).toBe(404);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(transitAudit).not.toHaveBeenCalled();
  });

  it('deactivating a staff member auto-unbinds their bound devices', async () => {
    mockAuth(l1);
    mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'tu-1', username: 'tendai1234', role: 'CONDUCTOR' }] })  // status UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [{ id: 'd-1', device_uuid: 'AGT-0001' }] })  // auto-unbind devices
      .mockResolvedValueOnce({ rows: [] });    // COMMIT

    const res = await request(createApp()).post('/api/v1/transit/staff/tu-1/status').send({ status: 'DISABLED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISABLED');
    expect(res.body.devicesUnbound).toBe(1);
    const unbindSql = mockClientQuery.mock.calls.find(c => c[0].includes('UPDATE transit_devices'))?.[0];
    expect(unbindSql).toContain('user_id = NULL');
    expect(unbindSql).toContain("status = 'UNBOUND'");
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_DEVICE_AUTO_UNBOUND', entityId: 'tu-1', metadata: expect.objectContaining({ devicesUnbound: 1 }) }));
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_DISABLED', entityId: 'tu-1' }));
  });

  it('reactivating a staff member does not touch device bindings', async () => {
    mockAuth(l1);
    mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'tu-1', username: 'tendai1234', role: 'CONDUCTOR' }] })  // status UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] });    // COMMIT

    const res = await request(createApp()).post('/api/v1/transit/staff/tu-1/status').send({ status: 'ACTIVE' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.devicesUnbound).toBe(0);
    expect(mockClientQuery.mock.calls.some(c => c[0].includes('UPDATE transit_devices'))).toBe(false);
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_ACTIVATED', entityId: 'tu-1' }));
  });

  it('moves a staff member off a field role and auto-unbinds their devices', async () => {
    mockAuth(l1);
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'tu-1', username: 'tendai1234', full_name: 'Tendai Moyo', phone: '+263712345678', role: 'ACCOUNTANT', company_id: 'comp-1' }] })  // PATCH UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [{ id: 'd-1', device_uuid: 'AGT-0001' }] });  // auto-unbind devices

    const res = await request(createApp())
      .patch('/api/v1/transit/staff/tu-1')
      .send({ role: 'ACCOUNTANT' });

    expect(res.status).toBe(200);
    expect(res.body.staff.role).toBe('ACCOUNTANT');
    expect(res.body.devicesUnbound).toBe(1);
    const unbindSql = mockPoolQuery.mock.calls[1][0];
    expect(unbindSql).toContain('user_id = NULL');
    expect(unbindSql).toContain("status = 'UNBOUND'");
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_DEVICE_AUTO_UNBOUND', entityId: 'tu-1', metadata: expect.objectContaining({ devicesUnbound: 1 }) }));
  });

  it('keeps device bindings when a field role switches to another field role', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'tu-1', username: 'tendai1234', full_name: 'Tendai Moyo', phone: '+263712345678', role: 'CONDUCTOR', company_id: 'comp-1' }] });

    const res = await request(createApp())
      .patch('/api/v1/transit/staff/tu-1')
      .send({ role: 'CONDUCTOR' });

    expect(res.status).toBe(200);
    expect(res.body.staff.role).toBe('CONDUCTOR');
    expect(res.body.devicesUnbound).toBe(0);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('hard-deletes a staff member with zero linked activity (releasing bound devices first)', async () => {
    mockAuth(l1);
    mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'tu-test', username: 'test0001', full_name: 'Test', company_id: 'comp-1', shifts: 0, tickets: 0, trips: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'd-1', device_uuid: 'AGT-0099' }] })  // UNBIND devices
      .mockResolvedValueOnce({ rowCount: 1 })  // DELETE
      .mockResolvedValueOnce({ rows: [] });    // COMMIT

    const res = await request(createApp()).delete('/api/v1/transit/staff/tu-test');

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.id).toBe('tu-test');
    expect(res.body.devicesUnbound).toBe(1);
    const unbindSql = mockClientQuery.mock.calls.find(c => c[0].includes('UPDATE transit_devices'))?.[0];
    expect(unbindSql).toContain('user_id = NULL');
    const deleteSql = mockClientQuery.mock.calls.find(c => c[0].includes('DELETE FROM transit_users'))?.[0];
    expect(deleteSql).toBeTruthy();
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_DEVICE_AUTO_UNBOUND', entityId: 'tu-test', metadata: expect.objectContaining({ devicesUnbound: 1 }) }));
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_DELETED', entityId: 'tu-test' }));
  });

  it('refuses to hard-delete a staff member with linked tickets or trips (409)', async () => {
    mockAuth(l1);
    mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'tu-act', username: 'act0001', full_name: 'Active', company_id: 'comp-1', shifts: 1, tickets: 2, trips: 3 }] })
      .mockResolvedValueOnce({ rows: [] });  // ROLLBACK

    const res = await request(createApp()).delete('/api/v1/transit/staff/tu-act');

    expect(res.status).toBe(409);
    expect(res.body.shifts).toBe(1);
    expect(res.body.tickets).toBe(2);
    expect(res.body.trips).toBe(3);
    expect(res.body.error).toContain('linked shifts, tickets or trips');
    expect(transitAudit).not.toHaveBeenCalled();
  });

  it('404s when hard-deleting a staff member not found', async () => {
    mockAuth(l1);
    mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [] })  // lookup+counts → not found
      .mockResolvedValueOnce({ rows: [] });  // ROLLBACK

    const res = await request(createApp()).delete('/api/v1/transit/staff/ghost-999');

    expect(res.status).toBe(404);
    expect(transitAudit).not.toHaveBeenCalled();
  });
});

describe('Web-portal financials (/api/v1/transit/financials)', () => {
  it('returns summary, daily, route, staff and commission data for the company', async () => {
    mockAuth(l1);
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ total_tickets: 10, total_cents: 5000, today_cents: 0, week_cents: 5000, month_cents: 5000, conflicts: 1, cancelled: 0 }] })
      .mockResolvedValueOnce({ rows: [{ day: '2026-09-16', count: 10, total_cents: 5000 }] })
      .mockResolvedValueOnce({ rows: [{ route_name: 'Chinhoyi', count: 10, total_cents: 5000 }] })
      .mockResolvedValueOnce({ rows: [{ staff: 'Tendai', count: 10, total_cents: 5000 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'comp-1', name: 'Preyone Transit', currency: 'USD', commission_rate: 5, gross_cents: 5000, ticket_count: 10 }] });

    const res = await request(createApp()).get('/api/v1/transit/financials');

    expect(res.status).toBe(200);
    expect(res.body.summary.totalCents).toBe(5000);
    expect(res.body.byCompany[0].commissionRate).toBe(5);
  });
});

describe('Web-portal company profile (/api/v1/transit/company)', () => {
  const profileRow = {
    id: 'comp-1',
    name: 'Preyone Transit',
    slug: 'preyone-transit',
    tagline: 'Famba Nyore Nyore',
    reg_no: 'REG-001',
    tax_id: 'TAX-001',
    contact_phone: '+263712345678',
    email: '',
    address: '',
    website: '',
    customer_care: '',
    contact_email: '',
    currency: 'USD',
    logo_url: 'https://cdn.example.com/logo.png',
    receipt_header: 'PREYONE TRANSIT',
    receipt_footer: 'Thanks for riding',
    default_receipt_prefix: 'AGJ',
    company_code: 'PT-1',
    min_app_version: '',
    commission_rate: 5,
    status: 'ACTIVE',
  };

  it('403s users without company.admin / operations.manage / finance.view', async () => {
    mockAuth({ id: 'staff-x', role: 'Staff', permissions: [], companyId: 'comp-1' });

    const res = await request(createApp()).get('/api/v1/transit/company');

    expect(res.status).toBe(403);
  });

  it('returns the company profile scoped to the Level 1 company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [profileRow] });

    const res = await request(createApp()).get('/api/v1/transit/company');

    expect(res.status).toBe(200);
    expect(res.body.company.name).toBe('Preyone Transit');
    expect(res.body.company.regNo).toBe('REG-001');
    expect(res.body.company.receiptHeader).toBe('PREYONE TRANSIT');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['comp-1']);
  });

  it('requires a companyId for Level 0 platform operators', async () => {
    mockAuth(l0);

    const res = await request(createApp()).get('/api/v1/transit/company');

    expect(res.status).toBe(422);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('lets Level 0 target another company via query param', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [profileRow] });

    const res = await request(createApp()).get('/api/v1/transit/company?companyId=other-c1');

    expect(res.status).toBe(200);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['other-c1']);
  });

  it('updates the company profile and writes an audit entry', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...profileRow, name: 'Preyone Transit (New)', receipt_header: 'PREYONE NEW HEADER' }] });

    const res = await request(createApp())
      .put('/api/v1/transit/company')
      .send({
        name: 'Preyone Transit (New)',
        tagline: 'Travel well',
        phone: '+263712345678',
        taxId: 'TAX-002',
        regNo: 'REG-002',
        logoUrl: 'https://cdn.example.com/logo2.png',
        receiptHeader: 'PREYONE NEW HEADER',
        receiptFooter: 'Safe travels',
      });

    expect(res.status).toBe(200);
    expect(res.body.company.name).toBe('Preyone Transit (New)');
    const sql = mockPoolQuery.mock.calls[0][0];
    expect(sql).toContain('receipt_header');
    expect(sql).toContain('contact_phone');
    expect(sql).toContain('tax_id');
    expect(mockPoolQuery.mock.calls[0][1]).toContain('PREYONE NEW HEADER');
    expect(mockPoolQuery.mock.calls[0][1][mockPoolQuery.mock.calls[0][1].length - 1]).toBe('comp-1');
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'COMPANY_PROFILE_UPDATED', entityId: 'comp-1' }));
  });

  it('422s when no updatable fields are provided', async () => {
    mockAuth(l1);

    const res = await request(createApp()).put('/api/v1/transit/company').send({});

    expect(res.status).toBe(422);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('422s on an empty company name', async () => {
    mockAuth(l1);

    const res = await request(createApp()).put('/api/v1/transit/company').send({ name: '  ' });

    expect(res.status).toBe(422);
  });
});

describe('Web-portal staff registry (/api/v1/transit/drivers)', () => {
  const staffRow = {
    id: 'st-1',
    role: 'DRIVER',
    full_name: 'Tendai Moyo',
    phone: '+263710000000',
    license_no: 'DL-88123',
    status: 'ACTIVE',
    created_at: null,
    updated_at: null,
  };

  it('lists driver/conductor profiles scoped to the Level 1 company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [staffRow] });

    const res = await request(createApp()).get('/api/v1/transit/drivers');

    expect(res.status).toBe(200);
    expect(res.body.staff[0].fullName).toBe('Tendai Moyo');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['comp-1']);
  });

  it('filters by role', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).get('/api/v1/transit/drivers?role=CONDUCTOR');

    expect(res.status).toBe(200);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['comp-1', 'CONDUCTOR']);
  });

  it('rejects unknown roles', async () => {
    mockAuth(l1);

    const res = await request(createApp()).get('/api/v1/transit/drivers?role=CEO');

    expect(res.status).toBe(422);
  });

  it('creates a driver profile and writes an audit entry', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [staffRow] });

    const res = await request(createApp())
      .post('/api/v1/transit/drivers')
      .send({ role: 'DRIVER', fullName: 'Tendai Moyo', phone: '+263710000000', licenseNo: 'DL-88123', status: 'ACTIVE' });

    expect(res.status).toBe(201);
    expect(res.body.staff.role).toBe('DRIVER');
    expect(mockPoolQuery.mock.calls[0][1][0]).toBe('comp-1');
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_REGISTERED', entity: 'transit_staff' }));
  });

  it('rejects staff registry creation outside a company context', async () => {
    mockAuth(l0);

    const res = await request(createApp())
      .post('/api/v1/transit/drivers')
      .send({ role: 'DRIVER', fullName: 'Solo' });

    expect(res.status).toBe(422);
  });

  it('rejects invalid status values', async () => {
    mockAuth(l1);

    const res = await request(createApp())
      .post('/api/v1/transit/drivers')
      .send({ role: 'DRIVER', fullName: 'Tendai', status: 'FIRED' });

    expect(res.status).toBe(422);
  });

  it('updates a profile (status toggle) scoped to the company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...staffRow, status: 'ON_LEAVE' }] });

    const res = await request(createApp())
      .put('/api/v1/transit/drivers/st-1')
      .send({ status: 'ON_LEAVE' });

    expect(res.status).toBe(200);
    expect(res.body.staff.status).toBe('ON_LEAVE');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['st-1', 'comp-1', 'ON_LEAVE']);
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_UPDATED', entityId: 'st-1' }));
  });

  it('404s when updating a profile outside the company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp())
      .put('/api/v1/transit/drivers/other-1')
      .send({ status: 'ACTIVE' });

    expect(res.status).toBe(404);
  });

  it('creates a driver profile for a Level-0 selected company via body companyId', async () => {
    mockAuth(l0);
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'comp-9' }] })               // company exists check
      .mockResolvedValueOnce({ rows: [staffRow] });                      // INSERT

    const res = await request(createApp())
      .post('/api/v1/transit/drivers')
      .send({ role: 'DRIVER', fullName: 'Tendai Moyo', licenseNo: 'DL-88123', companyId: 'comp-9' });

    expect(res.status).toBe(201);
    expect(res.body.staff.role).toBe('DRIVER');
    expect(mockPoolQuery.mock.calls[1][1][0]).toBe('comp-9');
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'comp-9', action: 'STAFF_REGISTERED' }));
  });

  it('lists driver profiles scoped to a Level-0 selected company via header', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [staffRow] });

    const res = await request(createApp())
      .get('/api/v1/transit/drivers')
      .set('X-Company-Id', 'comp-9');

    expect(res.status).toBe(200);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['comp-9']);
  });

  it('rejects a company-scoped admin targeting another company in the registry (403)', async () => {
    mockAuth(l1);

    const res = await request(createApp())
      .post('/api/v1/transit/drivers')
      .send({ role: 'DRIVER', fullName: 'Solo', companyId: 'other-c1' });

    expect(res.status).toBe(403);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('Web-portal live shifts (/api/v1/transit/shifts)', () => {
  it('returns shifts with live ticket + revenue aggregates', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: 'sh-1', driver_id: '', driver_name: 'Tendai Moyo', vehicle_reg: 'AGH-1234',
        status: 'OPEN', notes: '', started_at: '2026-09-17T08:00:00.000Z', closed_at: null,
        user_id: 'u-1', device_id: 'd-1', conductor_name: 'Blessing', conductor_username: 'blessing',
        device_uuid: 'POS-0001', company_name: 'Preyone Transit', currency: 'USD',
        ticket_count: 5, total_cents: 2500,
      }],
    });

    const res = await request(createApp()).get('/api/v1/transit/shifts');

    expect(res.status).toBe(200);
    expect(res.body.shifts[0].driverName).toBe('Tendai Moyo');
    expect(res.body.shifts[0].conductorName).toBe('Blessing');
    expect(res.body.shifts[0].ticketCount).toBe(5);
    expect(res.body.shifts[0].totalCents).toBe(2500);
    expect(res.body.shifts[0].currency).toBe('USD');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['comp-1', 200]);
  });

  it('403s users without company.admin / operations.manage / finance.view', async () => {
    mockAuth({ id: 'staff-y', role: 'Staff', permissions: [], companyId: 'comp-1' });

    const res = await request(createApp()).get('/api/v1/transit/shifts');

    expect(res.status).toBe(403);
  });
});

describe('Web-portal trip scheduling (/api/v1/transit/routes,/fleet,/trips)', () => {
  it('lists distinct routes scoped to the Level 1 company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { routeCode: 'R1', routeFrom: 'Harare', routeTo: 'Bulawayo', routeName: 'Harare - Bulawayo' },
      ],
    });

    const res = await request(createApp()).get('/api/v1/transit/routes');

    expect(res.status).toBe(200);
    expect(res.body.routes[0].routeFrom).toBe('Harare');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['comp-1']);
  });

  it('lists routes across all companies for Level 0 (no company scope)', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).get('/api/v1/transit/routes');

    expect(res.status).toBe(200);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([]);
  });

  it('lists fleet vehicles scoped to a Level-0 selected company via query param', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ registration: 'AGH-1234', tripCount: 4 }] });

    const res = await request(createApp()).get('/api/v1/transit/fleet?companyId=comp-9');

    expect(res.status).toBe(200);
    expect(res.body.vehicles[0].registration).toBe('AGH-1234');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['comp-9']);
  });

  it('403s users without company.admin / operations.manage on route/fleet endpoints', async () => {
    mockAuth({ id: 'staff-z', role: 'Staff', permissions: ['finance.view'], companyId: 'comp-1' });

    const routesRes = await request(createApp()).get('/api/v1/transit/routes');
    expect(routesRes.status).toBe(403);

    const fleetRes = await request(createApp()).get('/api/v1/transit/fleet');
    expect(fleetRes.status).toBe(403);
  });

  it('requires a company context for Level 0 when scheduling a trip', async () => {
    mockAuth(l0);

    const res = await request(createApp())
      .post('/api/v1/transit/trips')
      .send({ routeFrom: 'Harare', routeTo: 'Bulawayo' });

    expect(res.status).toBe(422);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('rejects a company-scoped admin targeting another company (403)', async () => {
    mockAuth(l1);

    const res = await request(createApp())
      .post('/api/v1/transit/trips')
      .send({ routeFrom: 'Harare', routeTo: 'Bulawayo', companyId: 'other-c1' });

    expect(res.status).toBe(403);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('schedules a trip for the Level 1 company with an assigned driver', async () => {
    mockAuth(l1);
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'drv-1', full_name: 'Tendai Moyo' }] }) // driver lookup
      .mockResolvedValueOnce({
        rows: [{
          id: 'tr-1', trip_no: 'R1-20260918', bus_reg: 'AGH-1234', route_code: 'R1',
          route_from: 'Harare', route_to: 'Bulawayo', route_name: 'Harare - Bulawayo',
          departure_time: '2026-09-18T06:00:00.000Z', driver: 'Tendai Moyo', driver_id: 'drv-1',
          total_seats: 62, base_fare_cents: 500, status: 'SCHEDULED', opened_at: '2026-09-18T00:00:00.000Z',
        }],
      });

    const res = await request(createApp())
      .post('/api/v1/transit/trips')
      .send({
        routeCode: 'R1', routeFrom: 'Harare', routeTo: 'Bulawayo',
        busReg: 'AGH-1234', driverId: 'drv-1',
        departureTime: '2026-09-18T06:00:00Z', baseFareCents: 500, totalSeats: 62,
      });

    expect(res.status).toBe(201);
    expect(res.body.trip.status).toBe('SCHEDULED');
    expect(res.body.trip.driver).toBe('Tendai Moyo');
    expect(res.body.trip.base_fare_cents).toBe(500);
    expect(mockPoolQuery.mock.calls[1][0]).toContain('INSERT INTO transit_trips');
    expect(mockPoolQuery.mock.calls[1][1][1]).toBe('R1-20260918');
    expect(mockPoolQuery.mock.calls[1][1][2]).toBe('AGH-1234');
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'comp-1', action: 'TRIP_SCHEDULED' }));
  });

  it('schedules a trip via body companyId for Level 0 with NULL user/device binding', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        id: 'tr-9', trip_no: 'TRIP-20260918', bus_reg: '', route_code: '',
        route_from: 'Harare', route_to: 'Bulawayo', route_name: 'Harare - Bulawayo',
        departure_time: '2026-09-18T06:00:00.000Z', driver: '', driver_id: '',
        total_seats: 0, base_fare_cents: 300, status: 'SCHEDULED', opened_at: '2026-09-18T00:00:00.000Z',
      }],
    });

    const res = await request(createApp())
      .post('/api/v1/transit/trips')
      .send({
        routeFrom: 'Harare', routeTo: 'Bulawayo',
        departureTime: '2026-09-18T06:00:00Z', baseFareCents: 300,
        companyId: 'comp-9',
      });

    expect(res.status).toBe(201);
    expect(res.body.trip.status).toBe('SCHEDULED');
    expect(res.body.trip.trip_no).toMatch(/^TRIP-\d{8}$/);
    const insertSql = mockPoolQuery.mock.calls[0][0];
    expect(insertSql).toContain('VALUES ($1, NULL, NULL, $2');
    expect(transitAudit).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'comp-9', action: 'TRIP_SCHEDULED' }));
  });

  it('rejects an explicit trip number that already exists (409)', async () => {
    mockAuth(l1);
    mockPoolQuery.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));

    const res = await request(createApp())
      .post('/api/v1/transit/trips')
      .send({
        tripNo: 'R1-20260918', routeCode: 'R1',
        routeFrom: 'Harare', routeTo: 'Bulawayo',
        departureTime: '2026-09-18T06:00:00Z',
      });

    expect(res.status).toBe(409);
    expect(transitAudit).not.toHaveBeenCalled();
  });

  it('422s when the assigned driver does not belong to the company', async () => {
    mockAuth(l1);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp())
      .post('/api/v1/transit/trips')
      .send({
        routeFrom: 'Harare', routeTo: 'Bulawayo', driverId: 'ghost-drv',
        departureTime: '2026-09-18T06:00:00Z',
      });

    expect(res.status).toBe(422);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['ghost-drv', 'comp-1']);
    expect(transitAudit).not.toHaveBeenCalled();
  });
});

describe('Blocked devices (/api/v1/transit/blocked-devices)', () => {
  it('rejects non-super-admin users with 403', async () => {
    mockAuth(l1);

    const res = await request(createApp()).get('/api/v1/transit/blocked-devices');

    expect(res.status).toBe(403);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('lists blocked devices for super-admins with optional search', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'b1', hardware_id: 'AGT-BAD-1', hardware_type: 'UUID', device_name: 'A6 POS', reason: 'Stolen', blocked_at: '2026-09-01T00:00:00Z', blocked_by_name: 'CEO Test', bound_uuid: null }],
    });

    const res = await request(createApp()).get('/api/v1/transit/blocked-devices?q=AGT-BAD');

    expect(res.status).toBe(200);
    expect(res.body.devices[0].hardware_id).toBe('AGT-BAD-1');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['AGT-BAD']);
  });

  it('blocks a device (POST) and writes an admin audit log', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'b1', hardware_id: 'AGT-BAD-1', hardware_type: 'UUID', device_name: 'A6 POS', reason: 'Stolen', blocked_at: '2026-09-01T00:00:00Z' }],
    });

    const res = await request(createApp())
      .post('/api/v1/transit/blocked-devices')
      .send({ hardwareId: 'agt-bad-1', hardwareType: 'UUID', deviceName: 'A6 POS', reason: 'Stolen' });

    expect(res.status).toBe(201);
    expect(res.body.device.hardware_id).toBe('AGT-BAD-1');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['AGT-BAD-1', 'UUID', 'A6 POS', 'Stolen', 'ceo-1']);
    expect(recordAuditLog).toHaveBeenCalledWith('ceo-1', 'Test', 'blocked_devices_add', 'hardware', 'AGT-BAD-1', expect.stringContaining('Stolen'));
  });

  it('422s when blocking an invalid MAC address', async () => {
    mockAuth(l0);

    const res = await request(createApp())
      .post('/api/v1/transit/blocked-devices')
      .send({ hardwareId: 'not-a-mac', hardwareType: 'MAC' });

    expect(res.status).toBe(422);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('normalizes hardwareId and unblocks via DELETE, writing an audit log', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'b1', hardware_id: 'AGT-BAD-1', hardware_type: 'UUID' }] });

    const res = await request(createApp()).delete('/api/v1/transit/blocked-devices/agt-bad-1');

    expect(res.status).toBe(200);
    expect(res.body.hardwareId).toBe('AGT-BAD-1');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['AGT-BAD-1']);
    expect(recordAuditLog).toHaveBeenCalledWith('ceo-1', 'Test', 'blocked_devices_unblock', 'hardware', 'AGT-BAD-1', expect.stringContaining('AGT-BAD-1'));
  });

  it('404s when unblocking an identifier that is not blocked', async () => {
    mockAuth(l0);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).delete('/api/v1/transit/blocked-devices/AGT-UNKNOWN');

    expect(res.status).toBe(404);
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});