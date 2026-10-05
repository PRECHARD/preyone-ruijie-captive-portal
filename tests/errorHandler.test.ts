import { describe, it, expect, vi, afterEach } from 'vitest';
import { errorHandler } from '../src/middleware/errorHandler';

describe('errorHandler', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  const makeRes = () => ({
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  });

  it('returns 500 with generic message in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('Something broke');
    const res = makeRes();

    errorHandler(err, {} as any, res as any, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });

  it('surfaces the message outside production so failures are diagnosable', () => {
    process.env.NODE_ENV = 'development';
    const err = new Error('Something broke');
    const res = makeRes();

    errorHandler(err, {} as any, res as any, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Something broke' });
  });

  it('respects an explicit status instead of reporting 500', () => {
    process.env.NODE_ENV = 'production';
    const err = Object.assign(new Error('too big'), { status: 413 });
    const res = makeRes();

    errorHandler(err, {} as any, res as any, vi.fn());

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: 'too big' });
  });
});
