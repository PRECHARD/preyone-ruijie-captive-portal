import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { loadCompany, requireCompany } from '../src/middleware/company';
import { pool } from '../src/db/pool';

// The FK from admin_users.company_id pointed at transit_companies rather than
// companies, and every account was unassigned. requireCompany used to hard-403
// in that situation, which made the whole POS module unreachable. These tests
// pin the tenant-resolution contract that actually keeps it working.

vi.mock('../src/db/pool', () => ({ pool: { query: vi.fn() } }));

const COMPANY = '8def8d43-662b-4ab5-8a05-087a36005f4f';

function companyRow(id: string, name = 'Preyone') {
  return { id, name, plan_tier: null, modules: [] };
}

describe('requireCompany tenant resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function app(companyId: string | null | undefined) {
    const b = express();
    b.use((req: any, _res: any, next: any) => {
      req.adminUser = { id: 'u1', email: 'a@b.c', role: 'CEO', fullName: 'A', company_id: companyId };
      next();
    });
    b.get('/x', requireCompany, (_req, res) => {
      res.json({ ok: true, company: _req.company });
    });
    return b;
  }

  it('loads the assigned company when company_id is set', async () => {
    (pool.query as any).mockImplementation(async (sql: string) =>
      /FROM companies c/.test(sql) ? { rows: [companyRow(COMPANY)], rowCount: 1 } : { rows: [], rowCount: 0 }
    );

    const res = await request(app(COMPANY)).get('/x');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('falls back to the singleton company when company_id is null', async () => {
    // First call is the "is there exactly one company?" probe, second loads it.
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (/LIMIT 2/.test(sql)) return { rows: [{ id: COMPANY }], rowCount: 1 };
      if (/FROM companies c/.test(sql)) return { rows: [companyRow(COMPANY)], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app(null)).get('/x');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('treats undefined company_id the same as null', async () => {
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (/LIMIT 2/.test(sql)) return { rows: [{ id: COMPANY }], rowCount: 1 };
      if (/FROM companies c/.test(sql)) return { rows: [companyRow(COMPANY)], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app(undefined)).get('/x');
    expect(res.status).toBe(200);
  });

  it('403s an unassigned account once a second company exists', async () => {
    // Two companies means there is no unambiguous default, so denying is the
    // only safe answer -- granting the first company would leak its data.
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (/LIMIT 2/.test(sql)) {
        return { rows: [{ id: COMPANY }, { id: 'other-company' }], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app(null)).get('/x');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no company assigned/i);
  });

  it('403s when there are no companies at all', async () => {
    (pool.query as any).mockImplementation(async (sql: string) => {
      if (/LIMIT 2/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app(null)).get('/x');
    expect(res.status).toBe(403);
  });

  it('403s when an assigned company no longer exists', async () => {
    // company_id points at a deleted/foreign company: must not silently fall
    // back to the default tenant.
    (pool.query as any).mockImplementation(async (sql: string) =>
      /FROM companies c/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }
    );

    const res = await request(app(COMPANY)).get('/x');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('loadCompany', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects modules and plan tier for the assigned company', async () => {
    (pool.query as any).mockImplementation(async () => ({
      rows: [{ id: COMPANY, name: 'Preyone', plan_tier: 'Pro', modules: ['pos', 'invoice'] }],
      rowCount: 1,
    }));

    const company = await loadCompany(COMPANY, {} as any);
    expect(company?.id).toBe(COMPANY);
    expect(company?.modules).toEqual(['pos', 'invoice']);
    expect(company?.plan_tier).toBe('Pro');
  });

  it('returns null when the company does not exist', async () => {
    (pool.query as any).mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    expect(await loadCompany('missing', {} as any)).toBeNull();
  });
});