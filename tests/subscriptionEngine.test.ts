import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// payments.ts snapshots JWT_SECRET at import time and the webhook reads the
// Pesepay keys per request, so both must exist before the route modules load.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.PESEPAY_INTEGRATION_KEY = 'test-integration-key';
  process.env.PESEPAY_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
});

const clientState = vi.hoisted(() => {
  const query = vi.fn();
  const release = vi.fn();
  return { query, release };
});

vi.mock('../src/db/pool', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue({ query: clientState.query, release: clientState.release }),
  },
}));

// Stubbed the way pos.test.ts stubs it: the guard still runs, auth is just
// bypassed so each test can drive the handlers directly.
vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const session = vi.hoisted(() => ({ companyId: 'company-1' }));

vi.mock('../src/middleware/company', () => ({
  requireCompany: (req: { company?: unknown }, _res: unknown, next: () => void) => {
    req.company = { id: session.companyId, name: 'Test Co', modules: ['pos'] };
    next();
  },
}));

vi.mock('../src/services/notificationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/notificationService')>();
  return {
    ...actual,
    sendSubscriptionExpiryWarningEmail: vi.fn().mockResolvedValue(true),
    sendSubscriptionExpiryUrgentEmail: vi.fn().mockResolvedValue(true),
  };
});

import { pool } from '../src/db/pool';
import { posRouter } from '../src/routes/pos';
import { paymentsRouter } from '../src/routes/payments';
import { runSubscriptionDunning, msUntilNextMidnight } from '../src/jobs/subscriptionCron';
import {
  sendSubscriptionExpiryWarningEmail,
  sendSubscriptionExpiryUrgentEmail,
} from '../src/services/notificationService';

// ── Controllable query state ────────────────────────────────────────────────
// Every handler is driven by routing SQL text to a small state object, so no
// test depends on the exact order in which a handler issues its queries.

const posState = {
  companyRows: [] as any[],
  existingRows: [] as any[],
  activeCount: 0,
  insertRows: [] as any[],
  quotaCount: 0,
};

function routePosQuery(sql: string): { rows: any[] } {
  if (/SELECT max_devices, subscription_status, subscription_expires_at/.test(sql)) {
    return { rows: posState.companyRows };
  }
  if (/WHERE device_uuid = \$1 OR device_id = \$2/.test(sql)) return { rows: posState.existingRows };
  if (/SELECT id FROM pos_devices WHERE device_id = \$1/.test(sql)) return { rows: posState.existingRows };
  if (/COUNT\(\*\)::int AS n FROM pos_devices/.test(sql)) return { rows: [{ n: posState.activeCount }] };
  if (/AS cnt FROM pos_devices/.test(sql)) return { rows: [{ cnt: posState.quotaCount }] };
  if (/INSERT INTO pos_devices/.test(sql)) return { rows: posState.insertRows };
  return { rows: [] };
}

const cronState = {
  threeDay: [] as any[],
  oneDay: [] as any[],
  suspendCount: 0,
  lastSql: [] as string[],
};

function routeCronQuery(sql: string): { rows: any[]; rowCount: number } {
  cronState.lastSql.push(sql);
  if (/reminder_3day_sent = FALSE/.test(sql)) {
    return { rows: cronState.threeDay, rowCount: cronState.threeDay.length };
  }
  if (/reminder_1day_sent = FALSE/.test(sql)) {
    return { rows: cronState.oneDay, rowCount: cronState.oneDay.length };
  }
  if (/subscription_status = 'suspended'/.test(sql)) {
    return { rows: [], rowCount: cronState.suspendCount };
  }
  return { rows: [], rowCount: 0 };
}

const webhookState = {
  intents: [] as any[],
  companyRows: [] as any[],
};

function routeWebhookQuery(sql: string): { rows: any[] } {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
  if (/FROM pesepay_intents/.test(sql)) return { rows: webhookState.intents };
  if (/UPDATE companies/.test(sql)) return { rows: webhookState.companyRows };
  if (/UPDATE pesepay_intents/.test(sql)) return { rows: [] };
  return { rows: [] };
}

function createPosApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: unknown, next: () => void) => {
    req.adminUser = {
      id: 'admin-1',
      email: 'admin@test',
      role: 'CEO',
      fullName: 'Test Admin',
      // Deliberately null: the subscription guard must key off req.company,
      // never the (transit-linked) admin column.
      company_id: null,
      portalCompanyId: session.companyId,
    };
    next();
  });
  app.use('/api/pos', posRouter);
  return app;
}

function createPaymentsApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentsRouter);
  return app;
}

const activeCompany = {
  max_devices: 6,
  subscription_status: 'active',
  subscription_expires_at: null,
};

const registeredDevice = {
  id: 'dev-1',
  device_id: 'HW-100',
  device_type: 'tablet',
  name: 'Till Tablet',
  shop_id: null,
  device_token: 'token-abc',
  status: 'active',
  company_id: 'company-1',
  paired_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();

  (pool.connect as any).mockResolvedValue({ query: clientState.query, release: clientState.release });

  // POS / device guard defaults: healthy subscription, brand-new device.
  posState.companyRows = [{ ...activeCompany }];
  posState.existingRows = [];
  posState.activeCount = 0;
  posState.quotaCount = 0;
  posState.insertRows = [{ ...registeredDevice }];
  (pool.query as any).mockImplementation(async (sql: string) => routePosQuery(sql));

  // Cron defaults: nothing due.
  cronState.threeDay = [];
  cronState.oneDay = [];
  cronState.suspendCount = 0;
  cronState.lastSql = [];

  // Webhook defaults: no intent, company resolvable from payload only.
  webhookState.intents = [];
  webhookState.companyRows = [];
  clientState.query.mockReset();
  clientState.query.mockImplementation(async (sql: string) => routeWebhookQuery(sql));

  (sendSubscriptionExpiryWarningEmail as any).mockResolvedValue(true);
  (sendSubscriptionExpiryUrgentEmail as any).mockResolvedValue(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Device registration guard — POST /api/pos/devices/register
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/pos/devices/register — subscription guard', () => {
  it('rejects a new device once the plan cap is reached (DEVICE_LIMIT_EXCEEDED)', async () => {
    posState.companyRows = [{ max_devices: 1, subscription_status: 'active', subscription_expires_at: null }];
    posState.activeCount = 1;

    const res = await request(createPosApp()).post('/api/pos/devices/register').send({
      hardware_serial: 'HW-200',
      device_type: 'tablet',
      device_name: 'Second Till',
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEVICE_LIMIT_EXCEEDED');
    expect(res.body.max_devices).toBe(1);
    expect(res.body.active_devices).toBe(1);

    const inserts = (pool.query as any).mock.calls.filter((c: any[]) => /INSERT INTO pos_devices/.test(c[0]));
    expect(inserts).toHaveLength(0);
  });

  it('rejects registration once the subscription has expired (SUBSCRIPTION_EXPIRED)', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    posState.companyRows = [{ max_devices: 6, subscription_status: 'active', subscription_expires_at: past }];
    posState.activeCount = 0;

    const res = await request(createPosApp()).post('/api/pos/devices/register').send({
      hardware_serial: 'HW-300',
      device_type: 'phone',
      device_name: 'Courier Phone',
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUBSCRIPTION_EXPIRED');
    expect(res.body.subscription_expires_at).toBeTruthy();

    const inserts = (pool.query as any).mock.calls.filter((c: any[]) => /INSERT INTO pos_devices/.test(c[0]));
    expect(inserts).toHaveLength(0);
  });

  it('rejects registration while the account is suspended (SUBSCRIPTION_SUSPENDED)', async () => {
    posState.companyRows = [{ max_devices: 6, subscription_status: 'suspended', subscription_expires_at: null }];
    posState.activeCount = 0;

    const res = await request(createPosApp()).post('/api/pos/devices/register').send({
      hardware_serial: 'HW-400',
      device_type: 'desktop',
      device_name: 'Back Office',
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUBSCRIPTION_SUSPENDED');
  });

  it('registers a device under the plan cap and scopes the row to req.company', async () => {
    posState.companyRows = [{ max_devices: 6, subscription_status: 'active', subscription_expires_at: null }];
    posState.activeCount = 3;

    const res = await request(createPosApp()).post('/api/pos/devices/register').send({
      hardware_serial: 'HW-500',
      device_type: 'tablet',
      device_name: 'Till Tablet',
      shop_id: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.device_token).toBe('token-abc');

    const insertCall = (pool.query as any).mock.calls.find((c: any[]) => /INSERT INTO pos_devices/.test(c[0]));
    expect(insertCall).toBeTruthy();
    // $6 is company_id: it must be the portal tenant, not the admin's
    // transit-linked column.
    expect(insertCall![1][5]).toBe('company-1');
  });

  it('lets an already-registered device re-register even when the cap is full', async () => {
    posState.companyRows = [{ max_devices: 1, subscription_status: 'active', subscription_expires_at: null }];
    posState.existingRows = [{ id: 'dev-1' }];
    posState.activeCount = 1;

    const res = await request(createPosApp()).post('/api/pos/devices/register').send({
      hardware_serial: 'HW-100',
      device_type: 'tablet',
      device_name: 'Till Tablet',
    });

    expect(res.status).toBe(200);
    const countQueries = (pool.query as any).mock.calls.filter((c: any[]) => /AS n FROM pos_devices/.test(c[0]));
    expect(countQueries).toHaveLength(0);
    const inserts = (pool.query as any).mock.calls.filter((c: any[]) => /INSERT INTO pos_devices/.test(c[0]));
    expect(inserts).toHaveLength(1);
  });

  it('grandfathers a company with no plan columns (guard passes)', async () => {
    posState.companyRows = [{ max_devices: null, subscription_status: null, subscription_expires_at: null }];

    const res = await request(createPosApp()).post('/api/pos/devices/register').send({
      hardware_serial: 'HW-600',
      device_type: 'phone',
      device_name: 'No Plan Phone',
    });

    expect(res.status).toBe(200);
    const countQueries = (pool.query as any).mock.calls.filter((c: any[]) => /AS n FROM pos_devices/.test(c[0]));
    expect(countQueries).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Device registration guard — POST /api/pos/devices/auto-register
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/pos/devices/auto-register — subscription guard', () => {
  it('blocks auto-registration on an expired subscription before the quota logic', async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    posState.companyRows = [{ max_devices: 6, subscription_status: 'active', subscription_expires_at: past }];
    posState.existingRows = [];

    const res = await request(createPosApp()).post('/api/pos/devices/auto-register').send({
      device_uuid: 'auto-uuid-12345678',
      device_type: 'phone',
      device_name: 'Field Phone',
      device_public_key: 'a'.repeat(44),
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUBSCRIPTION_EXPIRED');

    const inserts = (pool.query as any).mock.calls.filter((c: any[]) => /INSERT INTO pos_devices/.test(c[0]));
    expect(inserts).toHaveLength(0);
  });

  it('enforces the plan cap ahead of the per-type quota', async () => {
    posState.companyRows = [{ max_devices: 1, subscription_status: 'active', subscription_expires_at: null }];
    posState.existingRows = [];
    posState.activeCount = 1;

    const res = await request(createPosApp()).post('/api/pos/devices/auto-register').send({
      device_uuid: 'auto-uuid-99999999',
      device_type: 'phone',
      device_name: 'Field Phone 2',
      device_public_key: 'a'.repeat(44),
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEVICE_LIMIT_EXCEEDED');
    expect(res.body.max_devices).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Pesepay subscription renewal webhook
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/payments/pesepay/webhook', () => {
  const KEY = 'test-integration-key';

  it('rejects a missing or wrong integration key', async () => {
    const app = createPaymentsApp();

    const missing = await request(app)
      .post('/api/payments/pesepay/webhook')
      .send({ transactionStatus: 'SUCCESS' });
    expect(missing.status).toBe(401);

    const wrong = await request(app)
      .post('/api/payments/pesepay/webhook')
      .set('authorization', 'not-the-key')
      .send({ transactionStatus: 'SUCCESS' });
    expect(wrong.status).toBe(401);
    expect(clientState.query).not.toHaveBeenCalled();
  });

  it('ignores a non-successful transaction status', async () => {
    const res = await request(createPaymentsApp())
      .post('/api/payments/pesepay/webhook')
      .set('authorization', KEY)
      .send({ reference: 'SUB-1', transactionStatus: 'PENDING' });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.message).toBe('Ignored non-success status');
    expect(clientState.query).not.toHaveBeenCalled();
  });

  it('extends subscription_expires_at by 30 days, reactivates and clears dunning flags', async () => {
    webhookState.intents = [
      { id: 'intent-1', reference: 'SUB-1', tenant_id: 'company-1', target_type: 'subscription', status: 'pending' },
    ];
    webhookState.companyRows = [
      {
        id: 'company-1',
        plan_type: 'growth_20',
        subscription_expires_at: '2026-12-12T10:00:00.000Z',
        subscription_status: 'active',
      },
    ];

    const res = await request(createPaymentsApp())
      .post('/api/payments/pesepay/webhook')
      .set('authorization', KEY)
      .send({ reference: 'SUB-1', transactionStatus: 'SUCCESS' });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.extended_days).toBe(30);
    expect(res.body.subscription_status).toBe('active');
    expect(res.body.plan_type).toBe('growth_20');

    const calls = clientState.query.mock.calls;
    const companyUpdate = calls.find((c: any[]) => /UPDATE companies/.test(c[0]));
    expect(companyUpdate).toBeTruthy();
    expect(companyUpdate![0]).toContain(`INTERVAL '30 days'`);
    expect(companyUpdate![0]).toContain(`subscription_status = 'active'`);
    expect(companyUpdate![0]).toContain('reminder_3day_sent = FALSE');
    expect(companyUpdate![0]).toContain('reminder_1day_sent = FALSE');
    expect(companyUpdate![0]).toContain('GREATEST(COALESCE(subscription_expires_at, NOW()), NOW())');
    expect(companyUpdate![1]).toEqual(['company-1']);

    const intentUpdate = calls.find((c: any[]) => /UPDATE pesepay_intents/.test(c[0]));
    expect(intentUpdate).toBeTruthy();
    expect(calls.some((c: any[]) => /^\s*COMMIT/.test(c[0]))).toBe(true);
  });

  it('is idempotent: a replayed delivery of a completed intent applies nothing', async () => {
    webhookState.intents = [
      { id: 'intent-1', reference: 'SUB-1', tenant_id: 'company-1', target_type: 'subscription', status: 'completed' },
    ];

    const res = await request(createPaymentsApp())
      .post('/api/payments/pesepay/webhook')
      .set('authorization', KEY)
      .send({ reference: 'SUB-1', transactionStatus: 'SUCCESS' });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.message).toBe('Already processed');
    expect(clientState.query.mock.calls.some((c: any[]) => /UPDATE companies/.test(c[0]))).toBe(false);
  });

  it('ignores a successful payment that is not a subscription intent', async () => {
    webhookState.intents = [
      { id: 'intent-2', reference: 'INV-1', tenant_id: 'company-1', target_type: 'invoice', status: 'pending' },
    ];

    const res = await request(createPaymentsApp())
      .post('/api/payments/pesepay/webhook')
      .set('authorization', KEY)
      .send({ reference: 'INV-1', transactionStatus: 'SUCCESS' });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.message).toBe('Ignored non-subscription payment');
    expect(clientState.query.mock.calls.some((c: any[]) => /UPDATE companies/.test(c[0]))).toBe(false);
  });

  it('extends the company given directly in the payload when no intent exists', async () => {
    const payloadCompany = '99999999-9999-4999-8999-999999999999';
    webhookState.companyRows = [
      {
        id: payloadCompany,
        plan_type: 'unlimited_30',
        subscription_expires_at: '2027-01-01T00:00:00.000Z',
        subscription_status: 'active',
      },
    ];

    const res = await request(createPaymentsApp())
      .post('/api/payments/pesepay/webhook')
      .set('authorization', KEY)
      .send({ reference: 'EXT-9', transactionStatus: 'SUCCESS', company_id: payloadCompany });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    const companyUpdate = clientState.query.mock.calls.find((c: any[]) => /UPDATE companies/.test(c[0]));
    expect(companyUpdate![1]).toEqual([payloadCompany]);
  });

  it('applies a purchased plan_tier to the company without extra bind params', async () => {
    webhookState.intents = [
      {
        id: 'intent-9',
        reference: 'SUB-9',
        tenant_id: 'company-1',
        target_type: 'subscription',
        status: 'pending',
        plan_tier: 'growth_20',
      },
    ];
    webhookState.companyRows = [
      {
        id: 'company-1',
        plan_type: 'standard_10',
        subscription_expires_at: '2026-12-12T10:00:00.000Z',
        subscription_status: 'active',
      },
    ];

    const res = await request(createPaymentsApp())
      .post('/api/payments/pesepay/webhook')
      .set('authorization', KEY)
      .send({ reference: 'SUB-9', transactionStatus: 'SUCCESS' });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);

    const companyUpdate = clientState.query.mock.calls.find((c: any[]) => /UPDATE companies/.test(c[0]));
    expect(companyUpdate).toBeTruthy();
    // The tier rides in as a validated SQL literal so the bind parameters stay
    // exactly [$1 companyId] — the invariants asserted above still hold.
    expect(companyUpdate![0]).toContain(`plan_type = 'growth_20'`);
    expect(companyUpdate![1]).toEqual(['company-1']);
  });

  it('ignores an unknown plan_tier from a legacy intent', async () => {
    webhookState.intents = [
      {
        id: 'intent-10',
        reference: 'SUB-10',
        tenant_id: 'company-1',
        target_type: 'subscription',
        status: 'pending',
        plan_tier: 'pro_99',
      },
    ];
    webhookState.companyRows = [
      {
        id: 'company-1',
        plan_type: 'standard_10',
        subscription_expires_at: '2026-12-12T10:00:00.000Z',
        subscription_status: 'active',
      },
    ];

    const res = await request(createPaymentsApp())
      .post('/api/payments/pesepay/webhook')
      .set('authorization', KEY)
      .send({ reference: 'SUB-10', transactionStatus: 'SUCCESS' });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    // Still extends the subscription, but never writes an unvalidated tier.
    const companyUpdate = clientState.query.mock.calls.find((c: any[]) => /UPDATE companies/.test(c[0]));
    expect(companyUpdate![0]).not.toContain('plan_type = ');
    expect(companyUpdate![1]).toEqual(['company-1']);
  });

  it('400s when neither the payload nor an intent names a company', async () => {
    const res = await request(createPaymentsApp())
      .post('/api/payments/pesepay/webhook')
      .set('authorization', KEY)
      .send({ transactionStatus: 'SUCCESS' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('company');
    expect(clientState.query.mock.calls.some((c: any[]) => /UPDATE companies/.test(c[0]))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Daily dunning cron
// ═══════════════════════════════════════════════════════════════════════════

describe('subscription dunning cron', () => {
  beforeEach(() => {
    // The cron reads through pool.query; the POS guard's router above would
    // misroute these UPDATE ... RETURNING statements.
    (pool.query as any).mockImplementation(async (sql: string) => routeCronQuery(sql));
  });

  it('warns companies expiring within 3 days and marks the 3-day flag', async () => {
    const expiry = new Date(Date.now() + 2.5 * 86_400_000).toISOString();
    cronState.threeDay = [
      { id: 'comp-1', name: 'Acme Traders', email: 'ops@acme.test', subscription_expires_at: expiry },
    ];

    const result = await runSubscriptionDunning();

    expect(result).toEqual({ warned3Day: 1, warned1Day: 0, suspended: 0, emailFailures: 0 });
    expect(sendSubscriptionExpiryWarningEmail).toHaveBeenCalledTimes(1);
    expect(sendSubscriptionExpiryWarningEmail).toHaveBeenCalledWith(
      'ops@acme.test',
      'Acme Traders',
      expiry,
      3
    );
    expect(sendSubscriptionExpiryUrgentEmail).not.toHaveBeenCalled();

    const flagUpdate = cronState.lastSql.find((s) => /reminder_3day_sent = FALSE/.test(s));
    expect(flagUpdate).toBeTruthy();
    expect(flagUpdate).toContain('SET');
    expect(flagUpdate).toContain(`reminder_3day_sent = TRUE`);
    expect(flagUpdate).toContain(`INTERVAL '3 days'`);
  });

  it('sends the urgent one-day notice and re-arms both flags', async () => {
    const expiry = new Date(Date.now() + 12 * 3_600_000).toISOString();
    cronState.oneDay = [
      { id: 'comp-2', name: 'Grocers Ltd', email: 'boss@grocers.test', subscription_expires_at: expiry },
    ];

    const result = await runSubscriptionDunning();

    expect(result.warned1Day).toBe(1);
    expect(result.warned3Day).toBe(0);
    expect(sendSubscriptionExpiryUrgentEmail).toHaveBeenCalledTimes(1);
    expect(sendSubscriptionExpiryUrgentEmail).toHaveBeenCalledWith('boss@grocers.test', 'Grocers Ltd', expiry);
    expect(sendSubscriptionExpiryWarningEmail).not.toHaveBeenCalled();

    const flagUpdate = cronState.lastSql.find((s) => /reminder_1day_sent = FALSE/.test(s));
    expect(flagUpdate).toContain(`reminder_1day_sent = TRUE`);
    expect(flagUpdate).toContain(`reminder_3day_sent = TRUE`);
    expect(flagUpdate).toContain(`INTERVAL '1 day'`);
  });

  it('suspends companies whose subscription has elapsed', async () => {
    cronState.suspendCount = 3;

    const result = await runSubscriptionDunning();

    expect(result.suspended).toBe(3);
    const suspendSql = cronState.lastSql.find((s) => /subscription_status = 'suspended'/.test(s));
    expect(suspendSql).toBeTruthy();
    expect(suspendSql).toContain(`subscription_expires_at <= NOW()`);
    expect(suspendSql).toContain(`IS DISTINCT FROM 'suspended'`);
  });

  it('counts SMTP failures without aborting the run', async () => {
    cronState.threeDay = [
      { id: 'comp-1', name: 'Acme Traders', email: 'ops@acme.test', subscription_expires_at: new Date(Date.now() + 86_400_000).toISOString() },
      { id: 'comp-2', name: 'No Mail Co', email: null, subscription_expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    ];
    (sendSubscriptionExpiryWarningEmail as any).mockResolvedValue(false);

    const result = await runSubscriptionDunning();

    expect(result.warned3Day).toBe(2);
    expect(result.emailFailures).toBe(1);
    // Rows without an email still consume their flag: no retry loop, no crash.
    expect(sendSubscriptionExpiryWarningEmail).toHaveBeenCalledTimes(1);
  });

  it('schedules the first run for the next midnight', () => {
    const noon = new Date('2026-06-15T12:00:00');
    expect(msUntilNextMidnight(noon)).toBe(12 * 60 * 60 * 1000);

    const midnight = new Date('2026-06-16T00:00:00');
    expect(msUntilNextMidnight(midnight)).toBe(24 * 60 * 60 * 1000);
  });
});
