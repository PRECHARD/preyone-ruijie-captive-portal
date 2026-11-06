import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// payments/subscription snapshot JWT_SECRET at import time; Pesepay keys are
// read per request by isPesepayConfigured()-style checks.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.PESEPAY_INTEGRATION_KEY = 'test-integration-key';
  process.env.PESEPAY_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
});

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock('../src/services/pesepayService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/pesepayService')>();
  return {
    ...actual,
    initiatePesepayPayment: vi.fn(),
  };
});

// Stubbed so the guard still runs: no Bearer header still 401s, which keeps
// the "requires authentication" assertions honest.
const authState = vi.hoisted(() => ({ portalCompanyId: null as string | null }));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.adminUser = {
      id: 'admin-1',
      email: 'admin@preyone.com',
      role: 'CEO',
      fullName: 'Admin',
      portalCompanyId: authState.portalCompanyId,
    };
    next();
  },
}));

import { pool } from '../src/db/pool';
import { subscriptionRouter } from '../src/routes/subscription';
import { initiatePesepayPayment } from '../src/services/pesepayService';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LINKED = '22222222-2222-4222-8222-222222222222';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/subscription', subscriptionRouter);
  return app;
}

describe('Subscription checkout routes', () => {
  beforeEach(() => {
    authState.portalCompanyId = null;
    (pool.query as any).mockReset();
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (/SELECT plan_type, max_devices/.test(sql)) {
        return {
          rows: [
            {
              plan_type: 'standard_10',
              max_devices: 1,
              subscription_status: 'active',
              subscription_expires_at: null,
            },
          ],
        };
      }
      if (/FROM companies/.test(sql)) return { rows: [{ id: TENANT }] };
      return { rows: [], rowCount: 1 };
    });
    (initiatePesepayPayment as any).mockReset();
    (initiatePesepayPayment as any).mockResolvedValue({
      success: true,
      referenceNumber: 'PSE-9',
      redirectUrl: 'https://payments.pesepay.com/checkout?ref=abc',
      pollUrl: 'https://payments.pesepay.com/poll?ref=abc',
      instructions: 'Approve the payment on your phone',
    });
  });

  it('requires authentication before touching the gateway', async () => {
    const res = await request(createApp())
      .post('/api/subscription/checkout')
      .send({ tier: 'growth_20' });

    expect(res.status).toBe(401);
    expect(initiatePesepayPayment as any).not.toHaveBeenCalled();
    expect((pool.query as any).mock.calls.some((c: any[]) => /INTO pesepay_intents/.test(c[0]))).toBe(false);
  });

  it('rejects an unknown tier', async () => {
    const res = await request(createApp())
      .post('/api/subscription/checkout')
      .set('Authorization', 'Bearer test-token')
      .send({ tier: 'pro_99' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('standard_10');
    expect(initiatePesepayPayment as any).not.toHaveBeenCalled();
  });

  it('rejects an unsupported currency', async () => {
    const res = await request(createApp())
      .post('/api/subscription/checkout')
      .set('Authorization', 'Bearer test-token')
      .send({ tier: 'standard_10', currencyCode: 'GBP' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('USD or ZiG');
  });

  it('rejects an unsupported payment rail', async () => {
    const res = await request(createApp())
      .post('/api/subscription/checkout')
      .set('Authorization', 'Bearer test-token')
      .send({ tier: 'standard_10', paymentMethod: 'bitcoin' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/payment method/i);
  });

  it('starts a Pesepay checkout for the requested tier', async () => {
    const res = await request(createApp())
      .post('/api/subscription/checkout')
      .set('Authorization', 'Bearer test-token')
      .send({ tier: 'growth_20' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tier).toBe('growth_20');
    expect(res.body.amount).toBe(20);
    expect(res.body.currencyCode).toBe('USD');
    expect(res.body.redirectUrl).toContain('https://payments.pesepay.com/');

    const insert = (pool.query as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes('INTO pesepay_intents')
    );
    expect(insert).toBeTruthy();
    // reference, tenant, amount, currency, method, purpose, reason, plan_tier
    expect(insert![1][1]).toBe(TENANT);
    expect(insert![1][2]).toBe(20);
    expect(insert![1][7]).toBe('growth_20');
  });

  it('derives the tenant from the session company link when present', async () => {
    authState.portalCompanyId = LINKED;
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (/SELECT id FROM companies WHERE id = \$1/.test(sql)) {
        expect((pool.query as any).mock.calls.at(-1)![1]).toEqual([LINKED]);
        return { rows: [{ id: LINKED }] };
      }
      if (/FROM companies/.test(sql)) return { rows: [{ id: LINKED }] };
      return { rows: [], rowCount: 1 };
    });

    const res = await request(createApp())
      .post('/api/subscription/checkout')
      .set('Authorization', 'Bearer test-token')
      .send({ tier: 'unlimited_30' });

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(LINKED);
    const insert = (pool.query as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes('INTO pesepay_intents')
    );
    expect(insert![1][1]).toBe(LINKED);
    expect(insert![1][2]).toBe(30);
    expect(insert![1][7]).toBe('unlimited_30');
  });

  it('marks the intent failed when the gateway declines', async () => {
    (initiatePesepayPayment as any).mockResolvedValue({ success: false, error: 'Gateway down' });

    const res = await request(createApp())
      .post('/api/subscription/checkout')
      .set('Authorization', 'Bearer test-token')
      .send({ tier: 'standard_10' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Gateway down');
    const failed = (pool.query as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes(`status = 'failed'`)
    );
    expect(failed).toBeTruthy();
  });

  it('GET /plans returns the current plan and the tier catalog', async () => {
    const res = await request(createApp())
      .get('/api/subscription/plans')
      .set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(res.body.current.plan_type).toBe('standard_10');
    expect(res.body.current.max_devices).toBe(1);
    expect(res.body.tiers).toHaveLength(3);
    expect(res.body.tiers.map((t: any) => t.price)).toEqual([10, 20, 30]);
    expect(res.body.tiers.map((t: any) => t.id)).toEqual(['standard_10', 'growth_20', 'unlimited_30']);
  });
});
