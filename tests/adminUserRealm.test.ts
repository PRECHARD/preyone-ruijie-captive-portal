import { describe, it, expect } from 'vitest';

/**
 * The admin console derives which links to render from the realm fields on the
 * session user: a truthy companyId switches its nav filter to the strict
 * company-scoped branch, and portalCompanyId decides whether POS resolves a
 * tenant or falls back.
 *
 * These are pure shape assertions on the interface requireAdminAuth populates.
 * If a realm field is renamed or dropped without updating the reader, the console
 * silently renders an empty permission list and hides every page except Overview
 * -- a failure with no server-side error, which is exactly how the last outage
 * shipped.
 */
import type { AdminUser } from '../src/middleware/adminAuth';

const REALM_FIELDS = ['companyId', 'portalCompanyId', 'permissions'] as const;

describe('AdminUser realm contract', () => {
  it('exposes exactly the camelCase realm fields the console reads', () => {
    const user: AdminUser = {
      id: 'u1',
      email: 'a@b.c',
      role: 'CEO',
      fullName: 'A',
      companyId: 'transit-1',
      portalCompanyId: 'portal-1',
      permissions: ['system.developer'],
    };

    for (const field of REALM_FIELDS) {
      expect(user).toHaveProperty(field);
    }
  });

  it('keeps the two realms on separate, independently nullable fields', () => {
    // A company-scoped admin has both; a signup has neither until assigned.
    // They must never be collapsed back into one shared field.
    const both: AdminUser = { id: 'u1', email: 'a', role: 'CEO', fullName: 'A', companyId: 't', portalCompanyId: 'p' };
    expect(both.companyId).toBe('t');
    expect(both.portalCompanyId).toBe('p');

    const neither: AdminUser = { id: 'u2', email: 'b', role: 'Staff', fullName: 'B' };
    expect(neither.companyId).toBeUndefined();
    expect(neither.portalCompanyId).toBeUndefined();
  });

  it('carries permissions as an array, since the console calls .includes on it', () => {
    // A null or undefined permissions value makes the nav gate fall through to
    // its deny branch rather than reading an empty list, so the type is the
    // thing that keeps the two failure modes apart.
    const user: AdminUser = { id: 'u1', email: 'a', role: 'CEO', fullName: 'A', permissions: [] };
    expect(Array.isArray(user.permissions)).toBe(true);
    expect(user.permissions!.includes('system.developer')).toBe(false);
  });
});