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
  requireRole: () => vi.fn((_req: any, _res: any, next: any) => next()),
}));

import { pool } from '../src/db/pool';
import { requireAdminAuth } from '../src/middleware/adminAuth';
import { adminRouter } from '../src/routes/admin';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

function mockAuth(user: { id: string; role: string; fullName: string; email?: string }) {
  (requireAdminAuth as any).mockImplementation((_req: any, _res: any, next: any) => {
    _req.adminUser = { id: user.id, email: user.email || `${user.role}@test`, role: user.role, fullName: user.fullName };
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

describe('Voucher approval routes', () => {
  describe('POST /api/admin/vouchers/request-approval', () => {
    it('returns 201 for Staff submitting a valid request', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff Jane' });
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ tier_name: 'PreMAX' }] }) // package check
        .mockResolvedValueOnce({ rows: [{ id: 'app-1', requested_by: 'staff-1', status: 'pending' }] }); // insert

      const res = await request(createApp())
        .post('/api/admin/vouchers/request-approval')
        .send({ requestType: 'single', packageTier: 'PreMAX', priceAmount: 34.99 });

      expect(res.status).toBe(201);
      expect(res.body.message).toContain('submitted');
      expect(res.body.approval).toBeDefined();
    });

    it('returns 403 for non-Staff users', async () => {
      mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'CEO' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ tier_name: 'PreMAX' }] }); // package check runs before role check

      const res = await request(createApp())
        .post('/api/admin/vouchers/request-approval')
        .send({ requestType: 'single', packageTier: 'PreMAX' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Only Staff need approval');
    });

    it('returns 422 when requestType is missing', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });

      const res = await request(createApp())
        .post('/api/admin/vouchers/request-approval')
        .send({ packageTier: 'PreMAX' });

      expect(res.status).toBe(422);
    });

    it('returns 422 when packageTier is missing', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });

      const res = await request(createApp())
        .post('/api/admin/vouchers/request-approval')
        .send({ requestType: 'single' });

      expect(res.status).toBe(422);
    });

    it('returns 422 for invalid requestType', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });

      const res = await request(createApp())
        .post('/api/admin/vouchers/request-approval')
        .send({ requestType: 'invalid', packageTier: 'PreMAX' });

      expect(res.status).toBe(422);
    });

    it('returns 422 when package does not exist', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // package not found

      const res = await request(createApp())
        .post('/api/admin/vouchers/request-approval')
        .send({ requestType: 'single', packageTier: 'NonExistent' });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain('not found');
    });

    it('accepts bulk request type', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ tier_name: 'PreLITE' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'app-2' }] });

      const res = await request(createApp())
        .post('/api/admin/vouchers/request-approval')
        .send({ requestType: 'bulk', packageTier: 'PreLITE', count: 10 });

      expect(res.status).toBe(201);
    });
  });

  describe('GET /api/admin/vouchers/pending-approvals', () => {
    it('returns pending approvals for Manager', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'app-1', status: 'pending' }] });

      const res = await request(createApp()).get('/api/admin/vouchers/pending-approvals');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].status).toBe('pending');
    });
  });

  describe('POST /api/admin/vouchers/approvals/:id/approve', () => {
    it('returns 404 when approval not found', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // not found

      const res = await request(createApp()).post('/api/admin/vouchers/approvals/nonexistent/approve');

      expect(res.status).toBe(404);
    });

    it('returns 400 when already processed', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'app-1', status: 'approved' }] });

      const res = await request(createApp()).post('/api/admin/vouchers/approvals/app-1/approve');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('already');
    });

    it('approves a single voucher request and creates voucher', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });

      // First query: fetch approval
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'app-1', status: 'pending', request_type: 'single', package_tier: 'PreMAX',
                 voucher_count: 1, max_uses: 1, requested_by: 'staff-1', requested_by_name: 'Staff Jane',
                 price_amount: 34.99, voucher_data: { code: 'VIP001' } }]
      });
      // Second query: fetch package
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ tier_name: 'PreMAX', duration_min: 1440, data_limit_gb: 10, is_uncapped: false,
                 bandwidth_mbps_up: 5, bandwidth_mbps_down: 10 }]
      });

      // Mock client queries (BEGIN, INSERT, sales INSERT, UPDATE, COMMIT)
      mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'VIP001' }] }) // INSERT voucher
        .mockResolvedValueOnce(undefined) // INSERT sale
        .mockResolvedValueOnce(undefined) // UPDATE voucher_approvals
        .mockResolvedValueOnce(undefined); // COMMIT

      const res = await request(createApp()).post('/api/admin/vouchers/approvals/app-1/approve');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('approved');
      expect(res.body.count).toBe(1);
      expect(res.body.vouchers).toHaveLength(1);
      expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it('approves a bulk voucher request and creates multiple vouchers', async () => {
      mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'CEO' });

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'app-2', status: 'pending', request_type: 'bulk', package_tier: 'PreLITE',
                 voucher_count: 3, max_uses: 1, requested_by: 'staff-1', requested_by_name: 'Staff Jane',
                 price_amount: null, voucher_data: null }]
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ tier_name: 'PreLITE', duration_min: 60, data_limit_gb: null, is_uncapped: true,
                 bandwidth_mbps_up: 2, bandwidth_mbps_down: 5 }]
      });

      mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'PRELITE-ABCD' }] }) // voucher 1
        .mockResolvedValueOnce({ rows: [{ id: 'v-2', code: 'PRELITE-EFGH' }] }) // voucher 2
        .mockResolvedValueOnce({ rows: [{ id: 'v-3', code: 'PRELITE-IJKL' }] }) // voucher 3
        .mockResolvedValueOnce(undefined) // UPDATE voucher_approvals
        .mockResolvedValueOnce(undefined); // COMMIT

      const res = await request(createApp()).post('/api/admin/vouchers/approvals/app-2/approve');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(res.body.vouchers).toHaveLength(3);
    });

    it('rolls back on DB error during approval', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'app-3', status: 'pending', request_type: 'single', package_tier: 'PreMAX',
                 voucher_count: 1, max_uses: 1, requested_by: 'staff-1', requested_by_name: 'Staff',
                 price_amount: null, voucher_data: null }]
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ tier_name: 'PreMAX', duration_min: 1440, data_limit_gb: 10, is_uncapped: false,
                 bandwidth_mbps_up: 5, bandwidth_mbps_down: 10 }]
      });

      mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')); // INSERT fails

      const res = await request(createApp()).post('/api/admin/vouchers/approvals/app-3/approve');

      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/admin/vouchers/approvals/:id/reject', () => {
    it('rejects a pending request', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'app-1', status: 'pending', request_type: 'single', package_tier: 'PreMAX',
                 requested_by: 'staff-1', requested_by_name: 'Staff Jane' }]
      });

      const res = await request(createApp()).post('/api/admin/vouchers/approvals/app-1/reject');

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Request rejected');
    });

    it('returns 404 when not found', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp()).post('/api/admin/vouchers/approvals/nonexistent/reject');

      expect(res.status).toBe(404);
    });

    it('returns 400 when already processed', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'app-1', status: 'approved' }] });

      const res = await request(createApp()).post('/api/admin/vouchers/approvals/app-1/reject');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/admin/vouchers/my-approvals', () => {
    it('returns the requesting staff approvals', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff Jane' });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'app-1', status: 'approved', requested_by: 'staff-1' },
               { id: 'app-2', status: 'rejected', requested_by: 'staff-1' }]
      });

      const res = await request(createApp()).get('/api/admin/vouchers/my-approvals');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('returns empty array when no approvals', async () => {
      mockAuth({ id: 'staff-2', role: 'Staff', fullName: 'Staff Bob' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp()).get('/api/admin/vouchers/my-approvals');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});

describe('Restricted tier & bulk guards', () => {
  describe('POST /api/admin/vouchers — Staff + restricted tier', () => {
    it('returns 403 with requiresApproval for PreMAX', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      // Mock clock-in check - return a row so check passes
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const res = await request(createApp())
        .post('/api/admin/vouchers')
        .send({ code: 'TEST123', packageTier: 'PreMAX', priceAmount: 34.99 });

      expect(res.status).toBe(403);
      expect(res.body.requiresApproval).toBe(true);
      expect(res.body.error).toContain('Restricted packages');
    });

    it('returns 403 with requiresApproval for PreULTRA', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const res = await request(createApp())
        .post('/api/admin/vouchers')
        .send({ code: 'TEST123', packageTier: 'PreULTRA' });

      expect(res.status).toBe(403);
      expect(res.body.requiresApproval).toBe(true);
    });

    it('returns 403 with requiresApproval for PreEXECUTIVE', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const res = await request(createApp())
        .post('/api/admin/vouchers')
        .send({ code: 'TEST123', packageTier: 'PreEXECUTIVE' });

      expect(res.status).toBe(403);
      expect(res.body.requiresApproval).toBe(true);
    });

    it('allows non-restricted tier for Staff', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // clock-in
        .mockResolvedValueOnce({ rows: [{ tier_name: 'PreLITE', duration_min: 60, data_limit_gb: null, is_uncapped: true, bandwidth_mbps_up: 2, bandwidth_mbps_down: 5 }] }) // package lookup
        .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'TEST123' }] }); // INSERT voucher

      const res = await request(createApp())
        .post('/api/admin/vouchers')
        .send({ code: 'TEST123', packageTier: 'PreLITE', priceAmount: 5.99 });

      expect(res.status).toBe(201);
    });

    it('skips the guard for CEO', async () => {
      mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'CEO' });
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ tier_name: 'PreMAX', duration_min: 1440, data_limit_gb: 10, is_uncapped: false, bandwidth_mbps_up: 5, bandwidth_mbps_down: 10 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'VIP001' }] })
        .mockResolvedValueOnce(undefined); // sales insert

      const res = await request(createApp())
        .post('/api/admin/vouchers')
        .send({ code: 'VIP001', packageTier: 'PreMAX', priceAmount: 34.99 });

      expect(res.status).toBe(201);
    });

    it('returns 403 if Staff not clocked in', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // not clocked in

      const res = await request(createApp())
        .post('/api/admin/vouchers')
        .send({ code: 'TEST123', priceAmount: 5.99 });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('clock in');
    });
  });

  describe('POST /api/admin/vouchers/bulk — Staff guard', () => {
    it('returns 403 with requiresApproval for Staff', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });

      const res = await request(createApp())
        .post('/api/admin/vouchers/bulk')
        .send({ packageTier: 'PreLITE', count: 10 });

      expect(res.status).toBe(403);
      expect(res.body.requiresApproval).toBe(true);
    });

    it('allows Manager to create bulk vouchers when clocked in', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // clock-in check
        .mockResolvedValueOnce({ rows: [{ tier_name: 'PreLITE', duration_min: 60, data_limit_gb: null, is_uncapped: true, bandwidth_mbps_up: 2, bandwidth_mbps_down: 5 }] });

      mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'v-1', code: 'PRELITE-AAAA' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'v-2', code: 'PRELITE-BBBB' }] })
        .mockResolvedValueOnce(undefined) // COMMIT
        .mockResolvedValueOnce(undefined); // sales insert... wait, priceAmount is null so no sales insert

      const res = await request(createApp())
        .post('/api/admin/vouchers/bulk')
        .send({ packageTier: 'PreLITE', count: 2 });

      expect(res.status).toBe(201);
      expect(res.body.count).toBe(2);
    });

    it('returns 403 if Manager not clocked in', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // not clocked in

      const res = await request(createApp())
        .post('/api/admin/vouchers/bulk')
        .send({ packageTier: 'PreLITE', count: 5 });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('clock in');
    });

    it('returns 422 when packageTier is missing', async () => {
      mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'CEO' });

      const res = await request(createApp())
        .post('/api/admin/vouchers/bulk')
        .send({ count: 5 });

      expect(res.status).toBe(422);
    });

    it('returns 422 when count is out of range', async () => {
      mockAuth({ id: 'ceo-1', role: 'CEO', fullName: 'CEO' });

      const res = await request(createApp())
        .post('/api/admin/vouchers/bulk')
        .send({ packageTier: 'PreLITE', count: 0 });

      expect(res.status).toBe(422);
    });
  });
});

describe('Cash handover routes', () => {
  describe('GET /api/admin/cash-handovers/available-sales', () => {
    it('returns available sales for Staff', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 's-1', amount: '10.00', voucher_code: 'ABC', package_tier: 'PreLITE' },
               { id: 's-2', amount: '20.00', voucher_code: 'DEF', package_tier: 'PreLITE' }]
      });

      const res = await request(createApp()).get('/api/admin/cash-handovers/available-sales');

      expect(res.status).toBe(200);
      expect(res.body.sales).toHaveLength(2);
      expect(res.body.totalAvailable).toBe(30);
      expect(res.body.count).toBe(2);
    });

    it('returns empty sales array for Staff with no sales', async () => {
      mockAuth({ id: 'staff-2', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp()).get('/api/admin/cash-handovers/available-sales');

      expect(res.status).toBe(200);
      expect(res.body.sales).toEqual([]);
      expect(res.body.totalAvailable).toBe(0);
    });
  });

  describe('POST /api/admin/cash-handovers', () => {
    it('creates a handover for valid sale IDs', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff Jane' });

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 's-1', amount: '15.00' }, { id: 's-2', amount: '25.00' }] }) // verify sales
        .mockResolvedValueOnce({ rows: [{ id: 'h-1', total_amount: '40.00', sale_count: 2 }] }); // INSERT cash_handover (via client)

      mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'h-1', total_amount: '40.00', sale_count: 2 }] }) // INSERT cash_handover
        .mockResolvedValueOnce(undefined) // UPDATE sales
        .mockResolvedValueOnce(undefined); // COMMIT

      const res = await request(createApp())
        .post('/api/admin/cash-handovers')
        .send({ saleIds: ['s-1', 's-2'] });

      expect(res.status).toBe(201);
      expect(res.body.message).toContain('Handover');
      expect(res.body.handover).toBeDefined();
    });

    it('returns 422 when saleIds is empty', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });

      const res = await request(createApp())
        .post('/api/admin/cash-handovers')
        .send({ saleIds: [] });

      expect(res.status).toBe(422);
    });

    it('returns 422 when saleIds is missing', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });

      const res = await request(createApp())
        .post('/api/admin/cash-handovers')
        .send({});

      expect(res.status).toBe(422);
    });

    it('returns 422 when sales do not belong to this staff', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 's-1', amount: '15.00' }] }); // only 1 of 2 found

      const res = await request(createApp())
        .post('/api/admin/cash-handovers')
        .send({ saleIds: ['s-1', 's-2'] });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain('not found');
    });

    it('rolls back on DB error', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 's-1', amount: '15.00' }] });

      mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')); // fails

      const res = await request(createApp())
        .post('/api/admin/cash-handovers')
        .send({ saleIds: ['s-1'] });

      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/admin/cash-handovers/pending', () => {
    it('returns pending handovers for Manager', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'h-1', status: 'pending', staff_name: 'Staff Jane', total_amount: '40.00' }] })
        .mockResolvedValueOnce({ rows: [{ id: 's-1', amount: '15.00', voucher_code: 'ABC' }] }); // sales for handover

      const res = await request(createApp()).get('/api/admin/cash-handovers/pending');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].sales).toHaveLength(1);
    });
  });

  describe('POST /api/admin/cash-handovers/:id/approve', () => {
    it('approves a pending handover', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'h-1', status: 'pending', staff_name: 'Staff Jane', total_amount: '40.00' }]
      });

      const res = await request(createApp()).post('/api/admin/cash-handovers/h-1/approve');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('approved');
    });

    it('returns 404 when handover not found', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp()).post('/api/admin/cash-handovers/nonexistent/approve');

      expect(res.status).toBe(404);
    });

    it('returns 400 when already processed', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'h-1', status: 'approved' }] });

      const res = await request(createApp()).post('/api/admin/cash-handovers/h-1/approve');

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/admin/cash-handovers/:id/reject', () => {
    it('rejects a pending handover and returns sales to pending', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'h-1', status: 'pending', staff_name: 'Staff Jane', total_amount: '40.00' }]
      });

      mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // UPDATE cash_handovers
        .mockResolvedValueOnce(undefined) // UPDATE sales
        .mockResolvedValueOnce(undefined); // COMMIT

      const res = await request(createApp()).post('/api/admin/cash-handovers/h-1/reject');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('rejected');
      expect(res.body.message).toContain('pending');
    });

    it('returns 404 when not found', async () => {
      mockAuth({ id: 'mgr-1', role: 'Manager', fullName: 'Manager' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(createApp()).post('/api/admin/cash-handovers/nonexistent/reject');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/admin/cash-handovers/my', () => {
    it('returns Staff handover history', async () => {
      mockAuth({ id: 'staff-1', role: 'Staff', fullName: 'Staff' });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'h-1', status: 'approved', staff_id: 'staff-1' },
               { id: 'h-2', status: 'rejected', staff_id: 'staff-1' }]
      });

      const res = await request(createApp()).get('/api/admin/cash-handovers/my');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });
});
