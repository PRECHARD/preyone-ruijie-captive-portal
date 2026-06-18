import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/db/pool', () => {
  const q = vi.fn();
  const r = vi.fn();
  return {
    pool: {
      query: q,
      connect: vi.fn().mockResolvedValue({ query: q, release: r }),
    },
  };
});

import { authRouter } from '../src/routes/auth';
import { pool } from '../src/db/pool';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

describe('POST /api/auth/signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 422 for missing required fields', async () => {
    const res = await request(createApp())
      .post('/api/auth/signup')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.errors).toBeDefined();
  });

  it('returns 400 for invalid voucher code', async () => {
    (pool.query as any)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp())
      .post('/api/auth/signup')
      .send({
        fullName: 'John Doe',
        phone: '+263771327202',
        email: 'john@example.com',
        voucherCode: 'INVALID',
        acceptedTos: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid Voucher code.');
  });

  it('returns 400 for expired voucher', async () => {
    (pool.query as any)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{ id: 'v1', duration_min: 60, max_uses: 1, used_count: 0, expires_at: '2020-01-01T00:00:00Z' }],
      });

    const res = await request(createApp())
      .post('/api/auth/signup')
      .send({
        fullName: 'John Doe',
        phone: '+263771327202',
        email: 'john@example.com',
        voucherCode: 'EXPIRED',
        acceptedTos: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Voucher has expired.');
  });

  it('returns 400 for fully used voucher', async () => {
    (pool.query as any)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{ id: 'v1', duration_min: 60, max_uses: 1, used_count: 1, expires_at: null }],
      });

    const res = await request(createApp())
      .post('/api/auth/signup')
      .send({
        fullName: 'John Doe',
        phone: '+263771327202',
        email: 'john@example.com',
        voucherCode: 'USED',
        acceptedTos: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Voucher has already reached maximum allocations.');
  });

  it('creates session for valid voucher', async () => {
    (pool.query as any)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{ id: 'v1', duration_min: 120, max_uses: 5, used_count: 2, expires_at: null }],
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const res = await request(createApp())
      .post('/api/auth/signup')
      .query({ mac: 'AA:BB:CC:DD:EE:FF', ip: '10.0.0.5' })
      .send({
        fullName: 'John Doe',
        phone: '+263771327202',
        email: 'john@example.com',
        voucherCode: 'FREE120',
        acceptedTos: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 422 for missing required fields', async () => {
    const res = await request(createApp())
      .post('/api/auth/register')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.errors).toBeDefined();
  });

  it('returns 422 for weak password', async () => {
    const res = await request(createApp())
      .post('/api/auth/register')
      .send({
        fullName: 'Jane Doe',
        phone: '+263771327202',
        email: 'jane@example.com',
        password: 'weak',
        acceptedTos: true,
      });

    expect(res.status).toBe(422);
  });

  it('returns 409 for duplicate email', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: 'existing-user' }] });

    const res = await request(createApp())
      .post('/api/auth/register')
      .send({
        fullName: 'Jane Doe',
        phone: '+263771327202',
        email: 'existing@example.com',
        password: 'StrongP@ss1',
        acceptedTos: true,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already exists');
  });

  it('creates account for valid request', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);

    const res = await request(createApp())
      .post('/api/auth/register')
      .send({
        fullName: 'Jane Doe',
        phone: '+263771327202',
        email: 'jane@example.com',
        password: 'StrongP@ss1!',
        acceptedTos: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.email).toBe('jane@example.com');
  });
});

describe('GET /api/auth/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when token is missing', async () => {
    const res = await request(createApp())
      .get('/api/auth/status');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing token');
  });

  it('returns active false for unknown token', async () => {
    (pool.query as any).mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp())
      .get('/api/auth/status?token=unknown');

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it('returns active true for valid token', async () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    (pool.query as any).mockResolvedValueOnce({ rows: [{ session_expires_at: future }] });

    const res = await request(createApp())
      .get('/api/auth/status?token=valid-token');

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
  });
});
