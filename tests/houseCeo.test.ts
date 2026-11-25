import { describe, expect, it } from 'vitest';
import { isHouseCeo } from '../src/middleware/houseCeo';

describe('isHouseCeo', () => {
  const HOUSE = 'house-company';

  it('accepts only a CEO bound to the house company', () => {
    expect(isHouseCeo({ role: 'CEO', portalCompanyId: HOUSE }, HOUSE)).toBe(true);
  });

  it('rejects a client CEO even when the role is CEO', () => {
    expect(isHouseCeo({ role: 'CEO', portalCompanyId: 'client-company' }, HOUSE)).toBe(false);
  });

  it('rejects a house Manager', () => {
    expect(isHouseCeo({ role: 'Manager', portalCompanyId: HOUSE }, HOUSE)).toBe(false);
  });

  it('rejects an unbound account instead of treating absence as platform admin', () => {
    expect(isHouseCeo({ role: 'CEO', portalCompanyId: null }, HOUSE)).toBe(false);
  });

  it('rejects every account when no house company exists', () => {
    expect(isHouseCeo({ role: 'CEO', portalCompanyId: HOUSE }, null)).toBe(false);
  });
});
