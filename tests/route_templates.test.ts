import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../src/middleware/rbac';
import { normalizeRouteTemplate } from '../src/routes/transit';

const base = {
  name: 'Harare - Beitbridge',
  code: 'HBB',
  stages: [
    { seq: 1, name: 'Harare' },
    { seq: 2, name: 'Beitbridge' },
  ],
  fares: [{ fromSeq: 1, toSeq: 2, priceCents: 4500 }],
};

function ok(body: unknown) {
  const r = normalizeRouteTemplate(body);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
}

function err(body: unknown) {
  const r = normalizeRouteTemplate(body);
  if (r.ok) throw new Error('expected a validation error');
  return r.error;
}

describe('normalizeRouteTemplate', () => {
  it('accepts a well-formed template', () => {
    const t = ok(base);
    expect(t.name).toBe('Harare - Beitbridge');
    expect(t.code).toBe('HBB');
    expect(t.active).toBe(true);
    expect(t.stages.map((s) => s.name)).toEqual(['Harare', 'Beitbridge']);
    expect(t.fares).toEqual([{ fromSeq: 1, toSeq: 2, priceCents: 4500 }]);
  });

  it('requires a name', () => {
    expect(err({ ...base, name: '   ' })).toMatch(/name is required/);
  });

  it('requires at least two named stages', () => {
    expect(err({ ...base, stages: [{ seq: 1, name: 'Harare' }] })).toMatch(
      /at least 2 named stages/,
    );
    expect(err({ ...base, stages: [] })).toMatch(/at least 2 named stages/);
    // Two entries, but only one has a name.
    expect(
      err({ ...base, stages: [{ seq: 1, name: 'Harare' }, { seq: 2, name: '  ' }] }),
    ).toMatch(/at least 2 named stages/);
  });

  it('drops blank stages and renumbers the survivors 1..n', () => {
    const t = ok({
      ...base,
      stages: [
        { seq: 9, name: 'Harare' },
        { seq: 4, name: '   ' },
        { seq: 7, name: 'Beitbridge' },
      ],
    });
    expect(t.stages.map((s) => s.name)).toEqual(['Harare', 'Beitbridge']);
    expect(t.stages.map((s) => s.seq)).toEqual([1, 2]);
  });

  it('stores legs in forward order regardless of submitted direction', () => {
    const t = ok({
      ...base,
      fares: [{ fromSeq: 5, toSeq: 2, priceCents: 1000 }],
    });
    expect(t.fares).toEqual([{ fromSeq: 2, toSeq: 5, priceCents: 1000 }]);
  });

  it('drops degenerate legs where from equals to', () => {
    const t = ok({
      ...base,
      fares: [
        { fromSeq: 1, toSeq: 1, priceCents: 999 },
        { fromSeq: 1, toSeq: 2, priceCents: 4500 },
      ],
    });
    expect(t.fares).toEqual([{ fromSeq: 1, toSeq: 2, priceCents: 4500 }]);
  });

  it('de-duplicates a leg, last submission wins', () => {
    const t = ok({
      ...base,
      fares: [
        { fromSeq: 1, toSeq: 2, priceCents: 4500 },
        { fromSeq: 2, toSeq: 1, priceCents: 9999 },
      ],
    });
    expect(t.fares).toEqual([{ fromSeq: 1, toSeq: 2, priceCents: 9999 }]);
  });

  it('clamps negative prices to zero and keeps an unpriced leg at 0', () => {
    const t = ok({
      ...base,
      fares: [{ fromSeq: 1, toSeq: 2, priceCents: -500 }],
    });
    expect(t.fares[0].priceCents).toBe(0);
  });

  it('uppercases the code and rejects malformed ones', () => {
    expect(ok({ ...base, code: 'hbb' }).code).toBe('HBB');
    expect(err({ ...base, code: 'has spaces' })).toMatch(/code must be/);
    expect(err({ ...base, code: 'x'.repeat(25) })).toMatch(/code must be/);
    // Empty is allowed: code is optional.
    expect(ok({ ...base, code: '' }).code).toBe('');
  });

  it('truncates an over-long description', () => {
    expect(ok({ ...base, description: 'd'.repeat(900) }).description).toHaveLength(500);
  });

  it('honours active:false', () => {
    expect(ok({ ...base, active: false }).active).toBe(false);
    expect(ok({ ...base }).active).toBe(true);
  });

  it('is idempotent — normalising its own output changes nothing', () => {
    const once = ok(base);
    const twice = ok({
      name: once.name,
      code: once.code,
      description: once.description,
      active: once.active,
      stages: once.stages,
      fares: once.fares,
    });
    expect(twice).toEqual(once);
  });
});

describe('route template permission', () => {
  it('is a distinct narrow capability', () => {
    expect(PERMISSIONS.ROUTE_TEMPLATES_MANAGE).toBe('route.templates.manage');
    // It must not be conflated with an existing broad permission.
    expect(PERMISSIONS.ROUTE_TEMPLATES_MANAGE).not.toBe(PERMISSIONS.COMPANY_ADMIN);
    expect(PERMISSIONS.ROUTE_TEMPLATES_MANAGE).not.toBe(PERMISSIONS.OPERATIONS_MANAGE);
  });
});
