import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: (_req: any, _res: any, next: any) => next(),
}));

const session = vi.hoisted(() => ({ companyId: 'company-a', companyName: 'Acme Homes' }));

vi.mock('../src/middleware/company', () => ({
  requireCompany: (req: any, _res: any, next: any) => {
    req.company = { id: session.companyId, name: session.companyName };
    next();
  },
}));

const hub = vi.hoisted(() => ({
  broadcastToCompany: vi.fn(),
  iotHubStats: vi.fn(() => ({ companies: 1, sockets: 2 })),
}));

vi.mock('../src/services/iotHub', () => hub);

import { pool } from '../src/db/pool';
import { homeAutomateRouter } from '../src/routes/homeautomate';

const query = pool.query as unknown as ReturnType<typeof vi.fn>;
const connect = pool.connect as unknown as ReturnType<typeof vi.fn>;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.adminUser = { id: 'user-1', email: 'ops@acme.test', role: 'CEO', fullName: 'Ops' };
    next();
  });
  app.use('/api/homeautomate', homeAutomateRouter);
  return app;
}

/**
 * `vi.resetAllMocks()` also drops the hub mock's implementation, which would
 * make every summary render `hub: undefined`. Re-arm it after each reset.
 */
function resetMocks() {
  vi.resetAllMocks();
  hub.iotHubStats.mockReturnValue({ companies: 1, sockets: 2 });
}

/** A fake transactional client so ingest can BEGIN/INSERT/UPDATE/COMMIT. */
function fakeClient() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return client;
}

describe('GET /api/homeautomate/devices', () => {
  beforeEach(resetMocks);

  it('lists only the caller tenant and exposes rolling metrics', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'dev-1',
          company_id: 'company-a',
          name: 'Lounge Lights',
          kind: 'dimmer',
          room: 'Lounge',
          transport: 'mqtt',
          online: true,
          state: { on: true, level: 72 },
          metrics: { energy_kwh: 0.42 },
        },
      ],
    });

    const res = await request(createApp()).get('/api/homeautomate/devices');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'dev-1', kind: 'dimmer', online: true });
    expect(query.mock.calls[0][1]).toEqual(['company-a']);
    expect(String(query.mock.calls[0][0])).toContain('d.company_id = $1');
  });
});

describe('POST /api/homeautomate/devices', () => {
  beforeEach(resetMocks);

  it('rejects a device without a name', async () => {
    const res = await request(createApp()).post('/api/homeautomate/devices').send({ kind: 'switch' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/name is required/);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind or transport', async () => {
    const badKind = await request(createApp()).post('/api/homeautomate/devices').send({ name: 'X', kind: 'toaster' });
    expect(badKind.status).toBe(422);
    expect(badKind.body.error).toMatch(/kind must be one of/);

    const badTransport = await request(createApp())
      .post('/api/homeautomate/devices')
      .send({ name: 'X', transport: 'carrier-pigeon' });
    expect(badTransport.status).toBe(422);
    expect(badTransport.body.error).toMatch(/transport must be one of/);
  });

  it('defaults a switch to off and announces it on the hub', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 'dev-9', company_id: 'company-a', name: 'Kitchen Socket', kind: 'switch', state: { on: false } }],
      })
      .mockResolvedValueOnce({ rows: [] }); // audit

    const res = await request(createApp())
      .post('/api/homeautomate/devices')
      .send({ name: 'Kitchen Socket', kind: 'switch', room: 'Kitchen', transport: 'mqtt' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'dev-9', kind: 'switch' });
    const insertArgs = query.mock.calls[0][1];
    expect(insertArgs[0]).toBe('company-a');
    expect(JSON.parse(insertArgs[8])).toEqual({ on: false });
    expect(hub.broadcastToCompany).toHaveBeenCalledWith(
      'company-a',
      expect.objectContaining({ type: 'device_state' })
    );
  });
});

describe('POST /api/homeautomate/devices/:id/command', () => {
  beforeEach(resetMocks);

  it('404s for a device owned by another tenant', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp())
      .post('/api/homeautomate/devices/dev-other/command')
      .send({ action: 'on' });
    expect(res.status).toBe(404);
    expect(query.mock.calls[0][1]).toEqual(['dev-other', 'company-a']);
  });

  it('rejects an unsupported action', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'dev-1', state: { on: false } }] });
    const res = await request(createApp())
      .post('/api/homeautomate/devices/dev-1/command')
      .send({ action: 'explode' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/action must be/);
  });

  it('requires a value when dimming', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'dev-1', state: { on: true, level: 40 } }] });
    const res = await request(createApp())
      .post('/api/homeautomate/devices/dev-1/command')
      .send({ action: 'set' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/value is required/);
  });

  it('merges the new state, persists it and broadcasts', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'dev-1', company_id: 'company-a', state: { on: false, level: 10 } }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'dev-1', company_id: 'company-a', state: { on: true, level: 68 }, online: true }],
      })
      .mockResolvedValueOnce({ rows: [] }); // audit

    const res = await request(createApp())
      .post('/api/homeautomate/devices/dev-1/command')
      .send({ action: 'set', value: 68 });

    expect(res.status).toBe(200);
    expect(res.body.state).toEqual({ on: true, level: 68 });
    const updateArgs = query.mock.calls[1][1];
    expect(JSON.parse(updateArgs[2])).toEqual({ on: true, level: 68 });
    expect(hub.broadcastToCompany).toHaveBeenCalledWith(
      'company-a',
      expect.objectContaining({ type: 'device_state', payload: expect.objectContaining({ action: 'set' }) })
    );
  });

  it('toggles the existing boolean rather than assuming a type', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'dev-2', state: { on: true } }] })
      .mockResolvedValueOnce({ rows: [{ id: 'dev-2', state: { on: false } }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp())
      .post('/api/homeautomate/devices/dev-2/command')
      .send({ action: 'toggle' });

    expect(res.status).toBe(200);
    expect(JSON.parse(query.mock.calls[1][1][2])).toEqual({ on: false });
  });
});

describe('POST /api/homeautomate/devices/:id/telemetry', () => {
  beforeEach(resetMocks);

  it('rejects a sample without a metric', async () => {
    const res = await request(createApp())
      .post('/api/homeautomate/devices/dev-1/telemetry')
      .send({ value: 12 });
    expect(res.status).toBe(422);
    expect(connect).not.toHaveBeenCalled();
  });

  it('404s for a device owned by another tenant', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp())
      .post('/api/homeautomate/devices/dev-other/telemetry')
      .send({ metric: 'temp_c', value: 4 });
    expect(res.status).toBe(404);
  });

  it('stores samples, merges state and reports fired triggers', async () => {
    const client = fakeClient();
    connect.mockResolvedValueOnce(client);
    query
      .mockResolvedValueOnce({ rows: [{ id: 'dev-1', state: { temp_c: 4 } }] }) // device lookup
      .mockResolvedValueOnce({ rows: [{ id: 'trig-1', name: 'Too warm', metric: 'temp_c', operator: '>', threshold: '8', enabled: true }] }) // evaluate
      .mockResolvedValueOnce({ rows: [] }) // trigger last_fired_at
      .mockResolvedValueOnce({ rows: [] }); // iot_events
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // telemetry insert
      .mockResolvedValueOnce({ rows: [{ id: 'dev-1', state: { temp_c: 9.5 } }] }) // device update
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(createApp())
      .post('/api/homeautomate/devices/dev-1/telemetry')
      .send({ samples: [{ metric: 'temp_c', value: 9.5, unit: 'C' }] });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: 1 });
    expect(res.body.fired).toEqual([expect.objectContaining({ id: 'trig-1', metric: 'temp_c', value: 9.5 })]);
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
    expect(hub.broadcastToCompany).toHaveBeenCalledWith(
      'company-a',
      expect.objectContaining({ type: 'telemetry' })
    );
  });
});

describe('GET /api/homeautomate/starlink/uptime', () => {
  beforeEach(resetMocks);

  it('rounds aggregates and returns the series', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ samples: 96, uptime_pct: '98.95833', latency_ms: '42.4', down_mbps: '168.23', up_mbps: '21.6', last_sample_at: '2026-10-31T09:00:00.000Z' }],
      })
      .mockResolvedValueOnce({
        rows: [{ recorded_at: '2026-10-31T09:00:00.000Z', online: true, latency_ms: 42, down_mbps: 168, up_mbps: 21 }],
      });

    const res = await request(createApp()).get('/api/homeautomate/starlink/uptime?hours=24');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      samples: 96,
      uptimePct: 99,
      latencyMs: 42,
      downMbps: 168.2,
      upMbps: 21.6,
    });
    expect(res.body.series).toHaveLength(1);
    // Clamp guard: an absurd window is capped at 30 days, never passed through.
    expect(query.mock.calls[0][1][1]).toBe(24);
  });

  it('clamps the requested window to 30 days', async () => {
    query.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [] });
    await request(createApp()).get('/api/homeautomate/starlink/uptime?hours=9999');
    expect(query.mock.calls[0][1][1]).toBe(24 * 30);
  });
});

describe('GET /api/homeautomate/summary', () => {
  beforeEach(resetMocks);

  it('derives fleet health, energy and trigger counters', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ total: 4, online: 3, gateways: 1 }] })
      .mockResolvedValueOnce({ rows: [{ kwh: '7.12345' }] })
      .mockResolvedValueOnce({ rows: [{ uptime_pct: '99.55', latency_ms: '40.2', last_sample_at: '2026-10-31T10:00:00.000Z' }] })
      .mockResolvedValueOnce({ rows: [{ active: 2, fired_today: 5 }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, event: 'device_command' }] });

    const res = await request(createApp()).get('/api/homeautomate/summary');

    expect(res.status).toBe(200);
    expect(res.body.devices).toEqual({ total: 4, online: 3, offline: 1, gateways: 1, healthPct: 75 });
    expect(res.body.energy).toMatchObject({ kwhToday: 7.123, currency: 'USD' });
    expect(res.body.starlink).toMatchObject({ uptimePct: 99.6, latencyMs: 40 });
    expect(res.body.triggers).toEqual({ active: 2, firedToday: 5 });
    expect(res.body.hub).toEqual({ companies: 1, sockets: 2 });
    expect(res.body.company).toEqual({ id: 'company-a', name: 'Acme Homes' });
  });

  it('reports 0% health for an empty fleet instead of dividing by zero', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ total: 0, online: 0, gateways: 0 }] })
      .mockResolvedValueOnce({ rows: [{ kwh: 0 }] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ active: 0, fired_today: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp()).get('/api/homeautomate/summary');
    expect(res.body.devices.healthPct).toBe(0);
    expect(res.body.devices.offline).toBe(0);
  });
});

describe('POST /api/homeautomate/triggers', () => {
  beforeEach(resetMocks);

  it('requires the device, name and metric', async () => {
    const res = await request(createApp()).post('/api/homeautomate/triggers').send({ name: 'Too warm' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/deviceId, name and metric/);
  });

  it('rejects an operator or action outside the allow-list', async () => {
    const badOperator = await request(createApp())
      .post('/api/homeautomate/triggers')
      .send({ deviceId: 'dev-1', name: 'Rule', metric: 'temp_c', operator: '~=' });
    expect(badOperator.status).toBe(422);
    expect(badOperator.body.error).toMatch(/operator must be/);

    const badAction = await request(createApp())
      .post('/api/homeautomate/triggers')
      .send({ deviceId: 'dev-1', name: 'Rule', metric: 'temp_c', action: 'launch-missiles' });
    expect(badAction.status).toBe(422);
    expect(badAction.body.error).toMatch(/action must be/);
  });

  it('refuses to attach a trigger to another tenant device', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(createApp())
      .post('/api/homeautomate/triggers')
      .send({ deviceId: 'dev-other', name: 'Rule', metric: 'temp_c', operator: '>', threshold: 8 });
    expect(res.status).toBe(404);
    expect(query.mock.calls[0][1]).toEqual(['dev-other', 'company-a']);
  });

  it('creates the rule under the caller tenant', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'dev-1' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'trig-1', company_id: 'company-a', name: 'Too warm', metric: 'temp_c', operator: '>', threshold: '8' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp())
      .post('/api/homeautomate/triggers')
      .send({ deviceId: 'dev-1', name: 'Too warm', metric: 'temp_c', operator: '>', threshold: 8, action: 'notify' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'trig-1', name: 'Too warm' });
    const insertArgs = query.mock.calls[1][1];
    expect(insertArgs[0]).toBe('company-a');
    expect(insertArgs[5]).toBe(8);
  });
});

describe('POST /api/homeautomate/seed', () => {
  beforeEach(resetMocks);

  it('is idempotent once the tenant owns devices', async () => {
    query.mockResolvedValueOnce({ rows: [{ n: 3 }] });
    const res = await request(createApp()).post('/api/homeautomate/seed').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seeded: false, reason: 'company already has devices' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('seeds a demo home, telemetry and StarLink samples in one transaction', async () => {
    const client = fakeClient();
    connect.mockResolvedValueOnce(client);
    client.query.mockResolvedValue({ rows: [{ id: 'dev-new' }] });
    query.mockResolvedValueOnce({ rows: [{ n: 0 }] });

    const res = await request(createApp()).post('/api/homeautomate/seed').send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ seeded: true, devices: 6 });
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.query.mock.calls.filter(([sql]) => String(sql).includes('iot_telemetry')).length).toBe(24);
    expect(client.query.mock.calls.filter(([sql]) => String(sql).includes('starlink_uptime_samples')).length).toBe(24);
    expect(hub.broadcastToCompany).toHaveBeenCalledWith(
      'company-a',
      expect.objectContaining({ type: 'alert', payload: { kind: 'demo_seeded' } })
    );
    expect(client.release).toHaveBeenCalled();
  });
});
