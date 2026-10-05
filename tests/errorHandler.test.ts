import { describe, it, expect, vi, afterEach } from 'vitest';
import { errorHandler } from '../src/middleware/errorHandler';

const originalEnv = process.env;

function callWith(env: string) {
  process.env = { ...originalEnv, NODE_ENV: env };
  const err = new Error('Something broke');
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  errorHandler(err, {} as any, res as any, vi.fn());
  return res;
}

describe('errorHandler', () => {
  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns a generic 500 in production, so internals are not leaked', () => {
    const res = callWith('production');
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });

  it('surfaces the real message outside production', () => {
    // A bare "Internal server error" in development or in the e2e suite is
    // unactionable: a bad query reports nothing about what actually failed.
    for (const env of ['development', 'test']) {
      const res = callWith(env);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Something broke' });
    }
  });

  it('respects an explicit status code', () => {
    process.env = { ...originalEnv, NODE_ENV: 'production' };
    const err = Object.assign(new Error('Payload too large'), { status: 413 });
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    errorHandler(err, {} as any, res as any, vi.fn());

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: 'Payload too large' });
  });
});
