import crypto from 'crypto';

// Redis is optional: when REDIS_URL (or REDIS_HOST) is configured we use it so
// lockouts survive restarts and are shared across instances; otherwise we fall
// back to an in-process store so unit tests and dev boxes keep working.
let redisClient: any = null;
function getRedis(): any {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL
    ? process.env.REDIS_URL
    : process.env.REDIS_HOST
    ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`
    : process.env.NODE_ENV === 'production'
    ? 'redis://127.0.0.1:6379'
    : null;
  if (!url) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Redis = require('ioredis');
    const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    client.connect().catch(() => {
      redisClient = null;
    });
    redisClient = client;
    return client;
  } catch {
    return null;
  }
}

const MAX_FAILED = Number(process.env.AUTH_LOCKOUT_ATTEMPTS || 5);
const LOCKOUT_MS = Number(process.env.AUTH_LOCKOUT_MINUTES || 15) * 60 * 1000;

const memoryCounts = new Map<string, number>();
const memoryLocks = new Map<string, number>();
const memoryWindows = new Map<string, number[]>();

export async function isLocked(key: string): Promise<{ locked: boolean; retryAfterMs: number }> {
  const redis = getRedis();
  if (redis) {
    try {
      const ttl = await redis.pttl(`auth:lock:${key}`);
      if (ttl > 0) return { locked: true, retryAfterMs: ttl };
      return { locked: false, retryAfterMs: 0 };
    } catch {
      /* fall through to memory */
    }
  }
  const until = memoryLocks.get(key) || 0;
  if (until > Date.now()) return { locked: true, retryAfterMs: until - Date.now() };
  if (until) memoryLocks.delete(key);
  return { locked: false, retryAfterMs: 0 };
}

export async function recordFailure(key: string): Promise<{ locked: boolean; attempts: number }> {
  const redis = getRedis();
  if (redis) {
    try {
      const count = await redis.incr(`auth:fail:${key}`);
      await redis.pexpire(`auth:fail:${key}`, LOCKOUT_MS);
      if (count >= MAX_FAILED) {
        await redis.set(`auth:lock:${key}`, '1', 'PX', LOCKOUT_MS);
        await redis.del(`auth:fail:${key}`);
        return { locked: true, attempts: count };
      }
      return { locked: false, attempts: count };
    } catch {
      /* fall through */
    }
  }
  const attempts = (memoryCounts.get(key) || 0) + 1;
  memoryCounts.set(key, attempts);
  if (attempts >= MAX_FAILED) {
    memoryLocks.set(key, Date.now() + LOCKOUT_MS);
    memoryCounts.delete(key);
    return { locked: true, attempts };
  }
  return { locked: false, attempts };
}

export async function clearFailures(key: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`auth:fail:${key}`, `auth:lock:${key}`);
    } catch {
      /* fall through */
    }
  }
  memoryCounts.delete(key);
  memoryLocks.delete(key);
  memoryWindows.delete(key);
}

export async function checkRate(key: string, windowMs: number, max: number): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const now = Date.now();
  const redis = getRedis();
  if (redis) {
    try {
      const count = await redis.incr(`auth:rl:${key}`);
      if (count === 1) await redis.pexpire(`auth:rl:${key}`, windowMs);
      if (count > max) {
        const ttl = await redis.pttl(`auth:rl:${key}`);
        return { allowed: false, retryAfterMs: ttl > 0 ? ttl : windowMs };
      }
      return { allowed: true, retryAfterMs: 0 };
    } catch {
      /* fall through */
    }
  }
  const window = memoryWindows.get(key) || [];
  const recent = window.filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    const retry = windowMs - (now - recent[0]);
    memoryWindows.set(key, recent);
    return { allowed: false, retryAfterMs: retry > 0 ? retry : windowMs };
  }
  recent.push(now);
  memoryWindows.set(key, recent);
  return { allowed: true, retryAfterMs: 0 };
}

export function securityAudit(event: string, detail: Record<string, unknown>): void {
  // Structured security audit line — consumed by log aggregators.
  console.warn('[SECURITY]', JSON.stringify({ event, at: new Date().toISOString(), ...detail }));
}
