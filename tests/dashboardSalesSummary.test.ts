import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockPoolQuery, mockPoolConnect, mockAuthUser } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(async () => ({ rows: [] })),
  mockPoolConnect: vi.fn(),
  mockAuthUser: { current: null as any },
}));

vi.mock('../src/db/pool', () => ({
  pool: { query: mockPoolQuery, connect: mockPoolConnect },
}));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: vi.fn((_req: any, _res: any, next: any) => {
    _req.adminUser = mockAuthUser.current;
    next();
  }),
  requireAdminAuthAllowLocked: vi.fn(),
  requireRole: () => vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../src/middleware/rbac', () => ({
  PERMISSIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  requirePermission: () => vi.fn((_req: any, _res: any, next: any) => next()),
  requireTransitPermission: () => vi.fn(),
  loadPermissions: vi.fn(async () => []),
  scopeVoucherCondition: () => null,
  scopeUserVoucherCodeCondition: () => null,
  FIELD_STAFF_ROLES: [],
}));

const { mockStaffRevenue } = vi.hoisted(() => ({ mockStaffRevenue: vi.fn(async () => 42.5) }));

vi.mock('../src/db/sales', () => ({
  getStaffDailyRevenue: mockStaffRevenue,
  getStaffDailySalesItemized: vi.fn(async () => []),
  getPlatformDailySalesItemized: vi.fn(async () => []),
  getPlatformDailyRevenue: vi.fn(async () => 100),
  getPlatformYesterdayRevenue: vi.fn(async () => 50),
  getPlatformWeeklyRevenue: vi.fn(async () => []),
  getPlatformMonthlyRevenue: vi.fn(async () => 300),
  getPlatformMonthlyTarget: vi.fn(async () => 1000),
  getStaffSalesMatrix: vi.fn(async () => []),
  getHourlySalesVelocity: vi.fn(async () => []),
  getRecentActivity: vi.fn(async () => []),
}));

import { adminRouter } from '../src/routes/admin';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

describe('GET /api/admin/dashboard/ultranet/sales-summary', () => {
  beforeEach(() => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockStaffRevenue.mockClear();
  });

  it.each([
    ['Staff', 'staff-1'],
    ['Manager', 'mgr-1'],
    ['CEO', 'ceo-1'],
  ])('reports personal today sales for %s', async (role, id) => {
    mockAuthUser.current = { id, email: `${role}@preyone.com`, role, fullName: `${role} User` };

    const res = await request(createApp()).get('/api/admin/dashboard/ultranet/sales-summary');

    expect(res.status).toBe(200);
    expect(mockStaffRevenue).toHaveBeenCalledWith(id);
    expect(res.body.mySales).toBe(42.5);
    expect(res.body.platformDaily).toBe(100);
  });
});
