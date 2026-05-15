import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requireApiKey } from '../src/middleware/adminAuth';

const makeReq = (header?: string): any => ({
  headers: { 'x-admin-key': header },
});

const makeRes = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn().mockReturnThis(),
});

describe('requireApiKey middleware', () => {
  const originalEnv = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = 'secret-key';
  });

  afterEach(() => {
    process.env.ADMIN_API_KEY = originalEnv;
  });

  it('rejects requests without the header', () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    requireApiKey(req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects requests with the wrong key', () => {
    const req = makeReq('wrong-key');
    const res = makeRes();
    const next = vi.fn();

    requireApiKey(req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows requests with the correct header', () => {
    const req = makeReq('secret-key');
    const res = makeRes();
    const next = vi.fn();

    requireApiKey(req, res as any, next);

    expect(next).toHaveBeenCalled();
  });
});
