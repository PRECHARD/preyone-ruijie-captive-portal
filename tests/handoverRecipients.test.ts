import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPoolQuery } = vi.hoisted(() => ({ mockPoolQuery: vi.fn() }));

vi.mock('../src/db/pool', () => ({
  pool: { query: mockPoolQuery, connect: vi.fn() },
}));

// The helper lives beside the admin router, so keep the router's middleware
// imports inert — these tests only exercise recipient selection.
vi.mock('../src/middleware/adminAuth', () => ({
  requireAdminAuth: vi.fn(),
  requireAdminAuthAllowLocked: vi.fn(),
  requireRole: () => vi.fn(),
}));
vi.mock('../src/middleware/rbac', () => ({
  PERMISSIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  requirePermission: () => vi.fn(),
  requireTransitPermission: () => vi.fn(),
  loadPermissions: vi.fn(async () => []),
  scopeVoucherCondition: () => null,
  scopeUserVoucherCodeCondition: () => null,
  FIELD_STAFF_ROLES: [],
}));

import { cashHandoverRecipients } from '../src/routes/admin';

const MANAGERS = [{ email: 'ceo@preyone.com' }, { email: 'manager@preyone.com' }];

describe('cashHandoverRecipients', () => {
  const original = process.env.CASH_HANDOVER_RECIPIENTS;

  beforeEach(() => {
    mockPoolQuery.mockReset();
    delete process.env.CASH_HANDOVER_RECIPIENTS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CASH_HANDOVER_RECIPIENTS;
    else process.env.CASH_HANDOVER_RECIPIENTS = original;
  });

  it('targets reviewers plus only the staff member the handover belongs to', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: MANAGERS });

    const recipients = await cashHandoverRecipients('Emmanuel@Preyone.com');

    expect(recipients).toEqual(['ceo@preyone.com', 'manager@preyone.com', 'emmanuel@preyone.com']);
    expect(recipients).not.toContain('praise@preyone.com');
    expect(recipients.filter((e) => e.endsWith('@preyone.com'))).toHaveLength(3);
  });

  it('does not add any staff member when the handover has no owner email', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: MANAGERS });

    const recipients = await cashHandoverRecipients(null);

    expect(recipients).toEqual(['ceo@preyone.com', 'manager@preyone.com']);
  });

  it('keeps CASH_HANDOVER_RECIPIENTS additive rather than replacing reviewers', async () => {
    process.env.CASH_HANDOVER_RECIPIENTS = 'accounts@preyone.com; other@preyone.com';
    mockPoolQuery.mockResolvedValueOnce({ rows: MANAGERS });

    const recipients = await cashHandoverRecipients('staff@preyone.com');

    expect(recipients).toEqual([
      'ceo@preyone.com',
      'manager@preyone.com',
      'accounts@preyone.com',
      'other@preyone.com',
      'staff@preyone.com',
    ]);
  });

  it('falls back to admin@preyone.com when no reviewers exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const recipients = await cashHandoverRecipients(undefined);

    expect(recipients).toEqual(['admin@preyone.com']);
  });

  it('ignores invalid staff email values instead of mailing them', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: MANAGERS });

    const recipients = await cashHandoverRecipients('not-an-email');

    expect(recipients).toEqual(['ceo@preyone.com', 'manager@preyone.com']);
  });

  it('still mails the staff member if the reviewer lookup throws', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('db down'));

    const recipients = await cashHandoverRecipients('staff@preyone.com');

    expect(recipients).toEqual(['staff@preyone.com']);
  });

  it('falls back to admin@preyone.com if the lookup throws and no staff email exists', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('db down'));

    const recipients = await cashHandoverRecipients(null);

    expect(recipients).toEqual(['admin@preyone.com']);
  });
});
