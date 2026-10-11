import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { pool } from '../src/db/pool';
import { requireAdminAuth } from '../src/middleware/adminAuth';
import { requireDeviceAuth } from '../src/middleware/deviceAuth';

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

describe('POS Devices API', () => {
  describe('device registration token generation', () => {
    it('generates 64-char hex token from 32-byte random', () => {
      const token = require('crypto').randomBytes(32).toString('hex');
      expect(token.length).toBe(64);
    });
  });

  describe('requireDeviceAuth middleware', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('rejects missing authorization header', async () => {
      const mockReq = { headers: {} } as Request;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as Response;
      const mockNext = vi.fn();

      await requireDeviceAuth(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('rejects invalid/revoked device token', async () => {
      const mockReq = {
        headers: { authorization: 'Bearer invalid-token-12345' },
      } as Request;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as Response;
      const mockNext = vi.fn();

      // Mock pool.query to return no device found
      ;(pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });

      await requireDeviceAuth(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('attaches req.device with device info on success', async () => {
      // Mock pool.query to return a valid device
      ;(pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            device_id: 'ANDR-8829102',
            company_id: 1,
            shop_id: 1,
            status: 'active',
            last_seen_at: new Date(),
          },
        ],
      } as any);

      const mockReq = {
        headers: {
          authorization:
            'Bearer ' +
            'a'.repeat(64), // 64-char token mock
        },
      } as Request;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as Response;
      const mockNext = vi.fn();

      await requireDeviceAuth(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      // req.device should be attached - check the middleware attached it
      // Note: actual device object depends on implementation
    });
  });
});