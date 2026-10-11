/**
 * End-to-end spec for the master route template API against the REAL database.
 *
 * Run with: npx vitest run --config vitest.e2e.config.ts
 * (needs `npm run migrate` to have created the schema).
 *
 * The pool is real; only the device-JWT guard is stubbed, because minting a
 * signed token adds nothing here. The actor's permission list is resolved by
 * the REAL loadPermissions against the REAL company_permissions row, so the
 * authorization decision under test is the production one.
 *
 * This is the case the design exists for: the product owner is a CONDUCTOR, so
 * their company — not their role — carries the capability.
 */
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import 'express-async-errors';
import request from 'supertest';
import { pool } from '../src/db/pool';
import { loadPermissions, PERMISSIONS } from '../src/middleware/rbac';

const CAP = PERMISSIONS.ROUTE_TEMPLATES_MANAGE;
const SLUG = 'e2e-templates-check';

vi.mock('../src/middleware/transitAuth', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    // The actor is injected by the harness below; the signed-JWT check has
    // nothing to do with whether this user may manage templates.
    requireTransitDevice: (_req: any, _res: any, next: any) => next(),
    requireTransitSession: (_req: any, _res: any, next: any) => next(),
    requireTransitRoles: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock('../src/services/transitAudit', () => ({
  transitAudit: vi.fn(),
  transitSecurityEvent: vi.fn(),
}));

// Imported AFTER the mocks so the router captures the stubbed guards.
import { transitRouter } from '../src/routes/transit';

type Actor = { id: string; companyId: string; role: string };

let granted: Actor;
let other: Actor;
let rivalGranted: Actor;
const createdIds: string[] = [];

/** Build an app whose req.transit is populated from REAL resolved permissions. */
async function as(user: Actor) {
  const permissions = await loadPermissions(user.role, user.id, user.companyId);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.transit = {
      user: {
        id: user.id,
        companyId: user.companyId,
        username: 'e2e',
        fullName: 'E2E',
        role: user.role,
        permissions,
      },
      device: { id: 'e2e-device', companyId: user.companyId, userId: user.id },
    };
    next();
  });
  app.use('/api/transit', transitRouter);
  return { app, permissions };
}

const body = {
  name: 'Harare - Beitbridge',
  code: 'hbb',
  stages: [{ seq: 1, name: 'Harare' }, { seq: 2, name: 'Beitbridge' }],
  // Duplicate leg submitted backwards, plus a degenerate one.
  fares: [
    { fromSeq: 1, toSeq: 2, priceCents: 4500 },
    { fromSeq: 2, toSeq: 1, priceCents: 9999 },
    { fromSeq: 1, toSeq: 1, priceCents: 500 },
  ],
};

beforeAll(async () => {
  const c1 = await pool.query(
    `INSERT INTO transit_companies (name, slug, currency) VALUES ('E2E Granted', $1, 'USD') RETURNING id`,
    [SLUG],
  );
  const c2 = await pool.query(
    `INSERT INTO transit_companies (name, slug, currency) VALUES ('E2E Ungranted', $1, 'USD') RETURNING id`,
    [`${SLUG}-other`],
  );
  // A third company, ALSO granted — used to prove the tenant boundary itself
  // (a capable operator still cannot touch another company's template).
  const c3 = await pool.query(
    `INSERT INTO transit_companies (name, slug, currency) VALUES ('E2E Rival', $1, 'USD') RETURNING id`,
    [`${SLUG}-rival`],
  );
  // Exactly what `npm run migrate` does for the seeded company: a company-level
  // grant, deliberately NOT a role change for the CONDUCTOR.
  await pool.query(
    'INSERT INTO company_permissions (company_id, permission_code) VALUES ($1, $2)',
    [c1.rows[0].id, CAP],
  );
  await pool.query(
    'INSERT INTO company_permissions (company_id, permission_code) VALUES ($1, $2)',
    [c3.rows[0].id, CAP],
  );
  const u1 = await pool.query(
    `INSERT INTO transit_users (company_id, username, password_hash, full_name, role)
     VALUES ($1, 'e2e_conductor_granted', 'x', 'Owner Conductor', 'CONDUCTOR') RETURNING id`,
    [c1.rows[0].id],
  );
  const u2 = await pool.query(
    `INSERT INTO transit_users (company_id, username, password_hash, full_name, role)
     VALUES ($1, 'e2e_conductor_other', 'x', 'Other Conductor', 'CONDUCTOR') RETURNING id`,
    [c2.rows[0].id],
  );
  const u3 = await pool.query(
    `INSERT INTO transit_users (company_id, username, password_hash, full_name, role)
     VALUES ($1, 'e2e_conductor_rival', 'x', 'Rival Conductor', 'CONDUCTOR') RETURNING id`,
    [c3.rows[0].id],
  );
  granted = { id: u1.rows[0].id, companyId: c1.rows[0].id, role: 'CONDUCTOR' };
  other = { id: u2.rows[0].id, companyId: c2.rows[0].id, role: 'CONDUCTOR' };
  rivalGranted = { id: u3.rows[0].id, companyId: c3.rows[0].id, role: 'CONDUCTOR' };
});

afterAll(async () => {
  for (const id of createdIds) {
    await pool.query('DELETE FROM transit_route_templates WHERE id = $1', [id]);
  }
  for (const a of [granted, other, rivalGranted]) {
    if (a?.id) await pool.query('DELETE FROM transit_users WHERE id = $1', [a.id]);
  }
  await pool.query('DELETE FROM transit_companies WHERE slug LIKE $1', [`${SLUG}%`]);
  await pool.end();
});

describe('master route templates: a field-staff owner via a company grant', () => {
  it('resolves the capability for a CONDUCTOR purely from the company grant', async () => {
    const grantedApi = await as(granted);
    const otherApi = await as(other);
    expect(grantedApi.permissions).toContain(CAP);
    expect(otherApi.permissions).not.toContain(CAP);
  });

  it('lets the granted CONDUCTOR create a template, normalising the payload', async () => {
    const { app } = await as(granted);
    const res = await request(app).post('/api/transit/route-templates').send(body);
    expect(res.status).toBe(201);
    const t = res.body.routeTemplate;
    createdIds.push(t.id);

    expect(t.code).toBe('HBB');
    // Duplicate leg collapses (last wins) and the degenerate leg is dropped.
    expect(t.fares).toHaveLength(1);
    expect(t.fares[0]).toMatchObject({ fromSeq: 1, toSeq: 2, priceCents: 9999 });
    expect(t.stages.map((s: any) => s.name)).toEqual(['Harare', 'Beitbridge']);
  });

  it('persists stages and the matrix in their own tables', async () => {
    const id = createdIds[0];
    const r = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM transit_route_template_stages WHERE template_id = $1) AS stages,
              (SELECT COUNT(*)::int FROM transit_route_template_fares  WHERE template_id = $1) AS fares`,
      [id],
    );
    expect(r.rows[0]).toMatchObject({ stages: 2, fares: 1 });
  });

  it('lets any device read, but never across a tenant boundary', async () => {
    const mine = await as(granted);
    const theirs = await as(other);

    const own = await request(mine.app).get('/api/transit/route-templates');
    expect(own.status).toBe(200);
    expect(own.body.routeTemplates).toHaveLength(1);

    // Read is open to a conductor whose company is NOT granted...
    const otherRes = await request(theirs.app).get('/api/transit/route-templates');
    expect(otherRes.status).toBe(200);
    // ...but they see only their own (empty) company.
    expect(otherRes.body.routeTemplates).toHaveLength(0);
  });

  it('denies writes to a conductor whose company is not granted', async () => {
    const { app } = await as(other);
    const id = createdIds[0];
    await request(app).post('/api/transit/route-templates').send(body).expect(403);
    await request(app).put(`/api/transit/route-templates/${id}`).send(body).expect(403);
    await request(app).delete(`/api/transit/route-templates/${id}`).expect(403);
  });

  it('answers a cross-tenant write with 404, never 403', async () => {
    // The actor must HOLD the capability to reach the tenant check at all —
    // an ungranted conductor is stopped earlier, by 403. So this uses a second
    // company that is also granted, pointed at the first company's template.
    const rival = await as(rivalGranted);
    const res = await request(rival.app)
      .put(`/api/transit/route-templates/${createdIds[0]}`)
      .send(body);
    // 404, not 403: a granted operator must not be able to learn that another
    // company's template exists.
    expect(res.status).toBe(404);
  });

  it('validates on update as well as create', async () => {
    const { app } = await as(granted);
    const id = createdIds[0];
    await request(app)
      .put(`/api/transit/route-templates/${id}`)
      .send({ ...body, stages: [{ seq: 1, name: 'Only one' }] })
      .expect(422);
    await request(app)
      .post('/api/transit/route-templates')
      .send({ ...body, name: '   ' })
      .expect(422);
  });

  it('replaces the stage list and matrix wholesale on update', async () => {
    const { app } = await as(granted);
    const res = await request(app)
      .put(`/api/transit/route-templates/${createdIds[0]}`)
      .send({
        ...body,
        name: 'Harare - Beitbridge (express)',
        stages: [
          { seq: 1, name: 'Harare' },
          { seq: 2, name: 'Beitbridge' },
          { seq: 3, name: 'Zvishavane' },
        ],
        fares: [
          { fromSeq: 1, toSeq: 2, priceCents: 5000 },
          { fromSeq: 2, toSeq: 3, priceCents: 1500 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.routeTemplate.fares).toHaveLength(2);

    const r = await pool.query(
      'SELECT COUNT(*)::int AS n FROM transit_route_template_stages WHERE template_id = $1',
      [createdIds[0]],
    );
    expect(r.rows[0].n).toBe(3);
  });

  it('cascades delete to stages and matrix', async () => {
    const { app } = await as(granted);
    const id = createdIds[0];
    await request(app).delete(`/api/transit/route-templates/${id}`).expect(200);

    const r = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM transit_route_template_stages WHERE template_id = $1) AS s,
              (SELECT COUNT(*)::int FROM transit_route_template_fares  WHERE template_id = $1) AS f`,
      [id],
    );
    expect(r.rows[0]).toMatchObject({ s: 0, f: 0 });

    await request(app).delete(`/api/transit/route-templates/${id}`).expect(404);
  });
});
