import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.PESEPAY_INTEGRATION_KEY = 'test-integration-key';
  process.env.PESEPAY_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
});

vi.mock('../src/db/pool', () => {
  const mockClientQuery = vi.fn();
  const mockRelease = vi.fn();
  const mockClient = { query: mockClientQuery, release: mockRelease };
  return {
    pool: {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(mockClient),
    },
  };
});

vi.mock('../src/services/pesepayService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/pesepayService')>();
  return {
    ...actual,
    initiateEcoCashPayment: vi.fn(),
    initiatePesepayPayment: vi.fn(),
    decryptResponse: vi.fn(),
    verifyPaymentStatus: vi.fn(),
  };
});

vi.mock('../src/services/ruijieMint', () => ({
  isRuijieCloudConfigured: vi.fn(() => true),
  findRuijieProfile: vi.fn(),
  mintRuijieVoucherForTier: vi.fn(),
}));

vi.mock('../src/services/voucherPool', () => ({
  claimPooledVoucher: vi.fn(),
}));

vi.mock('../src/db/accounting', () => ({
  syncSaleToLedgerAndStock: vi.fn().mockResolvedValue({ ledgerId: 'led-1', stockApplied: true }),
  markStockApplied: vi.fn().mockResolvedValue(undefined),
  ensureStockDecremented: vi.fn().mockResolvedValue({ applied: false, lines: 0 }),
  recordLedgerEntry: vi.fn().mockResolvedValue({ id: 'led-1', created: true }),
}));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: (_req: any, _res: any, next: any) => next(),
}));

import { pool } from '../src/db/pool';
import { paymentsRouter } from '../src/routes/payments';
import { decryptResponse } from '../src/services/pesepayService';
import { claimPooledVoucher } from '../src/services/voucherPool';
import { mintRuijieVoucherForTier, isRuijieCloudConfigured } from '../src/services/ruijieMint';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentsRouter);
  return app;
}

const PAY_ROW = {
  id: 'pay-pool',
  user_id: 'user-1',
  tier_name: 'PreLite',
  amount: 1,
  currency: 'USD',
  payment_method: 'EcoCash (Pesepay)',
  status: 'pending',
  duration_min: 1440,
  data_limit_gb: 5,
  is_uncapped: false,
  bandwidth_mbps_up: 5,
  bandwidth_mbps_down: 5,
  max_devices: 1,
  customer_name: 'Tendai Moyo',
  phone_number: '263771234567',
};

describe('payments voucher pool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isRuijieCloudConfigured as any).mockReturnValue(true);
  });

  it('claims a pre-minted pool voucher instead of calling Ruijie', async () => {
    (decryptResponse as any).mockReturnValue({
      merchantReference: 'REF-POOL',
      transactionStatus: 'SUCCESS',
      amount: 1,
    });
    (claimPooledVoucher as any).mockResolvedValue({
      code_no: 'POOL123',
      tier_name: 'PreLite',
      user_group_id: 'ug-1',
      profile_uuid: 'pf-1',
      ruijie_expiry: null,
    });
    (pool.query as any).mockResolvedValueOnce({
      rows: [{ id: 'pay-pool', status: 'pending', voucher_code: null, amount: 1, webhook_token: null }],
    });

    const client = await (pool as any).connect();
    (client.query as any).mockReset();
    client.query
      .mockResolvedValueOnce(undefined)                                     // BEGIN
      .mockResolvedValueOnce({ rows: [PAY_ROW] })                           // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ completed_at: new Date('2026-11-17T10:20:00Z') }] }) // UPDATE payments
      .mockResolvedValueOnce(undefined)                                     // INSERT transactions
      .mockResolvedValueOnce({ rows: [] })                                  // resolveOnlineSaleOwner
      .mockResolvedValueOnce({ rows: [] })                                  // INSERT vouchers
      .mockResolvedValueOnce({ rows: [] })                                  // UPDATE vouchers sold_by
      .mockResolvedValueOnce({ rows: [] })                                  // INSERT sales
      .mockResolvedValueOnce(undefined);                                    // COMMIT

    const res = await request(createApp())
      .post('/api/payments/webhook')
      .send({ payload: 'encrypted-string' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('completed');
    expect(res.body.voucherCode).toBe('POOL123');
    expect(claimPooledVoucher).toHaveBeenCalledWith(client, 'PreLite', 'pay-pool');
    expect(mintRuijieVoucherForTier).not.toHaveBeenCalled();
    const voucherInsert = (client.query as any).mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO vouchers')
    );
    expect(voucherInsert).toBeTruthy();
    expect(voucherInsert![0]).toContain('holder_name');
    expect(voucherInsert![0]).toContain('holder_phone');
    expect(voucherInsert![1]).toContain('Tendai Moyo');
    expect(voucherInsert![1]).toContain('263771234567');
  });

  it('falls back to a Ruijie mint only when the pool is empty', async () => {
    (decryptResponse as any).mockReturnValue({
      merchantReference: 'REF-MINT',
      transactionStatus: 'SUCCESS',
      amount: 1,
    });
    (claimPooledVoucher as any).mockResolvedValue(null);
    (mintRuijieVoucherForTier as any).mockResolvedValue({
      codeNo: 'MINT456',
      userGroupId: 'ug-1',
      profile: 'pf-1',
      comment: 'Payment pay-pool',
      expiryTime: null,
    });
    (pool.query as any).mockResolvedValueOnce({
      rows: [{ id: 'pay-pool', status: 'pending', voucher_code: null, amount: 1, webhook_token: null }],
    });

    const client = await (pool as any).connect();
    (client.query as any).mockReset();
    client.query
      .mockResolvedValueOnce(undefined)                                     // BEGIN
      .mockResolvedValueOnce({ rows: [PAY_ROW] })                           // SELECT FOR UPDATE
      .mockResolvedValueOnce(undefined)                                     // INSERT ruijie_vouchers
      .mockResolvedValueOnce({ rows: [{ completed_at: new Date('2026-11-17T10:20:00Z') }] }) // UPDATE payments
      .mockResolvedValueOnce(undefined)                                     // INSERT transactions
      .mockResolvedValueOnce({ rows: [] })                                  // resolveOnlineSaleOwner
      .mockResolvedValueOnce({ rows: [] })                                  // INSERT vouchers
      .mockResolvedValueOnce({ rows: [] })                                  // UPDATE vouchers sold_by
      .mockResolvedValueOnce({ rows: [] })                                  // INSERT sales
      .mockResolvedValueOnce(undefined);                                    // COMMIT

    const res = await request(createApp())
      .post('/api/payments/webhook')
      .send({ payload: 'encrypted-string' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('completed');
    expect(res.body.voucherCode).toBe('MINT456');
    expect(claimPooledVoucher).toHaveBeenCalled();
    expect(mintRuijieVoucherForTier).toHaveBeenCalledWith('PreLite', 'Payment pay-pool');
  });
});
