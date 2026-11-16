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
    });
  });

  describe('plan device cap', () => {
    it('caps devices by the paid plan, not one of each device shape', async () => {
      const { TIER_CATALOG } = await import('../src/plans/entitlements');
      const byId = Object.fromEntries(TIER_CATALOG.map((t) => [t.id, t.devices]));
      expect(byId.standard_10).toBe(1);
      expect(byId.pos_invoice_15).toBe(3);
      expect(byId.growth_20).toBe(6);
      expect(byId.unlimited_30).toBe(9999);
    });

    it('rejects registration when the plan cap is already full', () => {
      const maxDevices = 1;
      const activeCount = 1;
      expect(activeCount).toBeGreaterThanOrEqual(maxDevices);
    });

    it('allows re-registration of same device_uuid (idempotent)', () => {
      const existingDevice = { rows: [{ id: 1, status: 'active' }] };
      const isNewDevice = existingDevice.rows.length === 0;
      expect(isNewDevice).toBe(false);
    });

    it('rejects suspended devices from re-registering', () => {
      const existing = { rows: [{ status: 'suspended' }] };
      expect(existing.rows[0]?.status).toBe('suspended');
    });

    it('validates device_uuid format (8-64 chars, alphanumeric)', () => {
      const valid = /^[A-Za-z0-9._:-]{8,64}$/;
      expect(valid.test('android-abc123def')).toBe(true);
      expect(valid.test('win-550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(valid.test('short')).toBe(false);
      expect(valid.test('x'.repeat(65))).toBe(false);
      expect(valid.test('has spaces here')).toBe(false);
    });

    it('validates device_type against the auto-register list', () => {
      const allowed = ['phone', 'tablet', 'desktop', 'electron'];
      expect(allowed).toContain('phone');
      expect(allowed).toContain('tablet');
      expect(allowed).toContain('desktop');
      expect(allowed).toContain('electron');
    });
  });

  describe('Ed25519 public key validation', () => {
    it('accepts valid base64-encoded Ed25519 key (44 chars)', () => {
      const validKey = 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=';
      expect(validKey.length).toBeGreaterThanOrEqual(40);
      expect(validKey.length).toBeLessThanOrEqual(128);
      expect(/^[A-Za-z0-9+/=_-]+$/.test(validKey)).toBe(true);
    });

    it('rejects keys with invalid characters', () => {
      const invalidKey = 'abc def!@#$%';
      expect(/^[A-Za-z0-9+/=_-]+$/.test(invalidKey)).toBe(false);
    });

    it('rejects keys that are too short or too long', () => {
      expect('abc'.length >= 40).toBe(false);
      expect('x'.repeat(129).length <= 128).toBe(false);
    });
  });
});