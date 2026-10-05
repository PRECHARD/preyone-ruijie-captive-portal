import { describe, it, expect } from 'vitest';
import { parseHash, buildHash } from '../routes';

describe('parseHash', () => {
  it('reads a workspace + section pair', () => {
    expect(parseHash('#/transit/tenants')).toEqual({ workspace: 'transit', section: 'tenants' });
  });

  it('defaults a workspace-only fragment to overview', () => {
    expect(parseHash('#/pos')).toEqual({ workspace: 'pos', section: 'overview' });
  });

  it('accepts a fragment without the leading slash', () => {
    expect(parseHash('#transit/fleet')).toEqual({ workspace: 'transit', section: 'fleet' });
  });

  it('treats a bare section as having no workspace', () => {
    expect(parseHash('#/tenants')).toEqual({ workspace: null, section: 'tenants' });
  });

  it('returns nulls for an empty fragment so callers fall back to storage', () => {
    expect(parseHash('')).toEqual({ workspace: null, section: null });
    expect(parseHash('#')).toEqual({ workspace: null, section: null });
    expect(parseHash('#/')).toEqual({ workspace: null, section: null });
  });

  it('ignores trailing empty segments', () => {
    expect(parseHash('#/transit/tenants/')).toEqual({ workspace: 'transit', section: 'tenants' });
  });

  it('does not treat an unknown prefix as a workspace', () => {
    expect(parseHash('#/bogus/thing')).toEqual({ workspace: null, section: 'bogus' });
  });
});

describe('buildHash', () => {
  it('routes a section to the workspace that owns it', () => {
    expect(buildHash('ultranet', 'tenants')).toBe('#/transit/tenants');
    expect(buildHash('transit', 'vouchers')).toBe('#/ultranet/vouchers');
    expect(buildHash('ultranet', 'pos-sales')).toBe('#/pos/pos-sales');
  });

  it('uses the given workspace for global sections', () => {
    expect(buildHash('transit', 'overview')).toBe('#/transit/overview');
    expect(buildHash('pos', 'overview')).toBe('#/pos/overview');
  });

  it('round-trips through parseHash', () => {
    const hash = buildHash('transit', 'tenants');
    expect(parseHash(hash)).toEqual({ workspace: 'transit', section: 'tenants' });
  });
});
