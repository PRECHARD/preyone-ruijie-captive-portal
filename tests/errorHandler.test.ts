import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from '../src/middleware/errorHandler';

describe('errorHandler', () => {
  it('returns 500 with generic message', () => {
    const err = new Error('Something broke');
    const req = {} as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const next = vi.fn();

    errorHandler(err, req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });
});
