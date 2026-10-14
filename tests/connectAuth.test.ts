import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

import { pool } from '../src/db/pool';
import { connectAuthRouter } from '../src/routes/gateway';

/**
 * Mirrors src/index.ts: the router is mounted at /connectAuth and must sit
 * ABOVE the SPA catch-all, which is what the firmware has been hitting for
 * every request since the gateway's auth-server base path was set to
 * /connectAuth rather than /api/gateway.
 */
function createApp() {
  const app = express();
  app.use('/connectAuth', connectAuthRouter);
  app.get('*', (_req, res) => res.status(200).send('SPA-FALLBACK'));
  return app;
}

let infoSpy: ReturnType<typeof vi.spyOn>;
const loggedLine = () => String(infoSpy.mock.calls[0]?.[0] ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  (pool.query as any).mockResolvedValue({ rows: [], rowCount: 1 });
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
});

describe('GET /connectAuth/ping/', () => {
  it('answers the heartbeat in plain text and records it', async () => {
    const res = await request(createApp()).get(
      '/connectAuth/ping/?gw_sn=H1U73LA005928&gw_id=4c496801056d&dev_model=wwww&dev_softversion=OW2.0&sys_uptime=1787131535'
    );

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
    expect(res.headers['content-type']).toContain('text/plain');

    const [sql, params] = (pool.query as any).mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO gateway_heartbeats');
    expect(params).toContain('H1U73LA005928');
    expect(params).toContain('4c496801056d');
  });

  it('still responds when the heartbeat write fails', async () => {
    (pool.query as any).mockRejectedValue(new Error('db down'));

    const res = await request(createApp()).get('/connectAuth/ping/?gw_sn=ABC');

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
  });
});

describe('observational logging of unimplemented paths', () => {
  it('logs a path we do not implement and lets it fall through untouched', async () => {
    const res = await request(createApp()).get(
      '/connectAuth/auth?token=supersecret&gw_sn=ABC123&mac=AA:BB:CC:DD:EE:FF'
    );

    // Falls through to the SPA catch-all — no auth answer is invented here.
    expect(res.status).toBe(200);
    expect(res.text).toBe('SPA-FALLBACK');

    const line = loggedLine();
    expect(line).toContain('[connectAuth] GET /connectAuth/auth');
    expect(line).toContain('gw_sn=ABC123');
    expect(line).toContain('mac=AA:BB:CC:DD:EE:FF');
    // Session material never reaches the log.
    expect(line).toContain('token=[redacted]');
    expect(line).not.toContain('supersecret');

    // Observing must not write anything.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('logs the bare /connectAuth poll the firmware makes every ~30s', async () => {
    const res = await request(createApp()).get('/connectAuth');

    expect(res.status).toBe(200);
    expect(res.text).toBe('SPA-FALLBACK');
    expect(loggedLine()).toContain('[connectAuth] GET /connectAuth from');
  });

  it('logs the client IP and user agent so calls can be attributed', async () => {
    await request(createApp())
      .get('/connectAuth/portal')
      .set('User-Agent', 'MCFi 1.0.0');

    const line = loggedLine();
    expect(line).toContain('ua=MCFi 1.0.0');
    expect(line).toMatch(/from \S+/);
  });
});
