import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Signup must bind a new admin to a tenant server-side. Accepting company_id
// from the request body would let anyone self-assign into an arbitrary tenant.

const COMPANY = '8def8d43-662b-4ab5-8a05-087a36005f4f';

const queryMock = vi.fn();
const connectMock = vi.fn();

vi.mock('../src/db/pool', () => ({
  pool: {
    query: (...a: any[]) => queryMock(...a),
    connect: (...a: any[]) => connectMock(...a),
  },
}));

vi.mock('../src/services/auditLog', () => ({ recordAuditLog: vi.fn() }));
vi.mock('../src/services/notifications', () => ({
  sendAdminSignupConfirmation: vi.fn(),
  sendAdminSignupNotification: vi.fn(),
}));

vi.mock('bcryptjs', () => ({ default: { hash: async () => 'HASH' } }));

function loadRouter() {
  return import('../src/routes/adminAuth');
}

function insertedCompanyId(): unknown {
  const call = queryMock.mock.calls.find(
    (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO admin_users')
  );
  return call?.[1]?.[7];
}

function insertSql(): string {
  const call = queryMock.mock.calls.find(
    (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO admin_users')
  );
  return String(call?.[0] ?? '');
}

describe('admin signup tenant binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM companies ORDER BY created_at ASC LIMIT 2/.test(sql)) {
        return { rows: [{ id: COMPANY }], rowCount: 1 };
      }
      if (/SELECT COUNT\(\*\)::int AS cnt FROM admin_users WHERE role/.test(sql)) {
        return { rows: [{ cnt: 0 }], rowCount: 1 };
      }
      if (/INSERT INTO admin_users/.test(sql)) {
        return { rows: [{ id: 'new-user', full_name: 'X', email: 'x@y.z', role: 'Staff', approved: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    connectMock.mockImplementation(async () => ({
      query: queryMock,
      release: () => {},
    }));
  });

  async function signup(extra: Record<string, unknown> = {}) {
    const { adminAuthRouter } = await loadRouter();
    const app = express();
    app.use(express.json());
    app.use(adminAuthRouter);
    return request(app)
      .post('/signup')
      .send({
        fullName: 'New Admin',
        email: 'new@preyone.com',
        phone: '+263771234567',
        role: 'Staff',
        password: 'Str0ng!Passw0rd',
        ...extra,
      });
  }

  it('assigns the singleton company when exactly one exists', async () => {
    const res = await signup();
    expect(res.status).toBe(201);
    expect(insertedCompanyId()).toBe(COMPANY);
  });

  it('writes the portal tenant to portal_company_id, never to company_id', async () => {
    // The two realms have disjoint ID spaces and separate FKs. company_id points
    // at transit_companies, so writing a portal UUID there is not merely wrong,
    // it violates the foreign key and 500s the signup. Pin the column, not just
    // the value.
    const res = await signup();
    expect(res.status).toBe(201);
    const sql = insertSql();
    expect(sql).toMatch(/portal_company_id/);
    expect(sql).not.toMatch(/,\s*company_id\s*\)/);
    expect(sql).not.toMatch(/email_verification_token,\s*company_id/);
  });

  it('never claims a transit tenant on signup', async () => {
    // Signup resolves the PORTAL company only, so the column list must not
    // mention company_id at all -- otherwise a new admin silently joins a bus
    // operator's tenant.
    await signup();
    const columns = insertSql().slice(0, insertSql().toUpperCase().indexOf(') VALUES'));
    expect(columns).toMatch(/portal_company_id/);
    expect(columns).not.toMatch(/\bcompany_id\b/);
  });

  it('never lets the request body choose the company', async () => {
    // A hostile client tries to attach itself to an arbitrary tenant.
    const res = await signup({ company_id: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(201);
    expect(insertedCompanyId()).toBe(COMPANY);
    expect(insertedCompanyId()).not.toBe('11111111-1111-4111-8111-111111111111');
  });

  it('leaves the account unassigned when the tenant is ambiguous', async () => {
    // Two companies => no unambiguous default; requireCompany will then 403
    // rather than guess, and an existing admin must assign the tenant.
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM companies ORDER BY created_at ASC LIMIT 2/.test(sql)) {
        return { rows: [{ id: COMPANY }, { id: 'other' }], rowCount: 2 };
      }
      if (/SELECT COUNT\(\*\)::int AS cnt FROM admin_users WHERE role/.test(sql)) {
        return { rows: [{ cnt: 0 }], rowCount: 1 };
      }
      if (/INSERT INTO admin_users/.test(sql)) {
        return { rows: [{ id: 'new-user', full_name: 'X', email: 'x@y.z', role: 'Staff', approved: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await signup();
    expect(res.status).toBe(201);
    expect(insertedCompanyId()).toBeNull();
  });

  it('leaves the account unassigned when no company exists', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM companies ORDER BY created_at ASC LIMIT 2/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT COUNT\(\*\)::int AS cnt FROM admin_users WHERE role/.test(sql)) {
        return { rows: [{ cnt: 0 }], rowCount: 1 };
      }
      if (/INSERT INTO admin_users/.test(sql)) {
        return { rows: [{ id: 'new-user', full_name: 'X', email: 'x@y.z', role: 'Staff', approved: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await signup();
    expect(res.status).toBe(201);
    expect(insertedCompanyId()).toBeNull();
  });
});