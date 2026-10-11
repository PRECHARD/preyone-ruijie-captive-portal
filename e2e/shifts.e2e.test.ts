/**
 * End-to-end spec for shift start/close against the REAL database.
 *
 * Run with: npm run test:e2e  (needs `npm run migrate` to have created the
 * schema).
 *
 * Why this exists: end-of-shift must reach the admin trip schedule. Ending a
 * shift while offline previously closed only the local SQLite row — the server
 * was never told, so it kept reporting the shift OPEN and admin saw a driver
 * still on duty hours after the bus finished. Worse, the next sync re-pushed the
 * shift via /shifts/start, whose ON CONFLICT clause resets status to OPEN.
 *
 * The app now replays every unpushed close with the real finish time, so the
 * server must accept a caller-supplied closedAt. These tests pin:
 *   * crew details are persisted (driver + conductor name and phone)
 *   * a supplied closedAt is honoured, not replaced with NOW()
 *   * a garbage timestamp is ignored rather than failing the close
 *   * replaying an already-closed shift is idempotent, not a 404
 *   * a company cannot close another company's shift
 */
import 'dotenv/config';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import 'express-async-errors';
import request from 'supertest';
import { pool } from '../src/db/pool';

vi.mock('../src/middleware/transitAuth', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
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
import { errorHandler } from '../src/middleware/errorHandler';

const SLUG = 'e2e-shifts-check';

type Actor = { id: string; companyId: string; role: string };

let granted: Actor;
let rival: Actor;
const createdShiftIds: string[] = [];
// transit_shifts.device_id is a UUID FK onto transit_devices, so each company
// needs a real device row rather than a made-up string like 'e2e-device'.
const deviceIds = new Map<string, string>();

async function as(user: Actor) {
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
        permissions: [],
      },
      device: { id: deviceIds.get(user.companyId)!, companyId: user.companyId, userId: user.id },
    };
    next();
  });
  app.use('/api/transit', transitRouter);
  // Without the real error handler, a thrown query error becomes Express's
  // default HTML 500 and the failure reason is invisible. Registering it means
  // a broken route reports the actual message in this suite.
  app.use(errorHandler);
  return app;
}

const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  const c1 = await pool.query(
    `INSERT INTO transit_companies (name, slug, currency) VALUES ('E2E Shifts', $1, 'USD') RETURNING id`,
    [SLUG],
  );
  const c2 = await pool.query(
    `INSERT INTO transit_companies (name, slug, currency) VALUES ('E2E Shifts Rival', $1, 'USD') RETURNING id`,
    [`${SLUG}-rival`],
  );
  const u1 = await pool.query(
    `INSERT INTO transit_users (company_id, username, password_hash, full_name, role)
     VALUES ($1, 'e2e_shift_conductor', 'x', 'Shift Conductor', 'CONDUCTOR') RETURNING id`,
    [c1.rows[0].id],
  );
  const u2 = await pool.query(
    `INSERT INTO transit_users (company_id, username, password_hash, full_name, role)
     VALUES ($1, 'e2e_shift_rival', 'x', 'Rival Conductor', 'CONDUCTOR') RETURNING id`,
    [c2.rows[0].id],
  );
  granted = { id: u1.rows[0].id, companyId: c1.rows[0].id, role: 'CONDUCTOR' };
  rival = { id: u2.rows[0].id, companyId: c2.rows[0].id, role: 'CONDUCTOR' };
  for (const [companyId, userId] of [
    [c1.rows[0].id, u1.rows[0].id],
    [c2.rows[0].id, u2.rows[0].id],
  ]) {
    const dev = await pool.query(
      `INSERT INTO transit_devices (company_id, user_id, device_uuid, device_key)
       VALUES ($1, $2, $3, 'e2e-key') RETURNING id`,
      [companyId, userId, crypto.randomUUID()],
    );
    deviceIds.set(companyId, dev.rows[0].id);
  }
});

// idx_one_open_shift_per_user permits only one OPEN shift per user, so each test
// must start from a clean slate or the next startShift would legitimately 409.
afterEach(async () => {
  for (const id of createdShiftIds.splice(0)) {
    await pool.query('DELETE FROM transit_shifts WHERE id = $1', [id]);
  }
});

afterAll(async () => {
  for (const id of createdShiftIds) {
    await pool.query('DELETE FROM transit_shifts WHERE id = $1', [id]);
  }
  for (const a of [granted, rival]) {
    if (a?.id) await pool.query('DELETE FROM transit_users WHERE id = $1', [a.id]);
  }
  await pool.query('DELETE FROM transit_companies WHERE slug LIKE $1', [`${SLUG}%`]);
  await pool.end();
});

async function startShift(app: any, over: Record<string, unknown> = {}) {
  const shiftId = uuid();
  createdShiftIds.push(shiftId);
  const res = await request(app)
    .post('/api/transit/shifts/start')
    .send({
      shiftId,
      driverId: 'driver-1',
      driverName: 'DANIEL MUVIRIMI',
      driverPhone: '0771234567',
      conductorName: 'LESLIE MUVIRIMI',
      conductorPhone: '0777654321',
      vehicleReg: 'AGJ 1234',
      ...over,
    });
  return { res, shiftId };
}

describe('shift start: crew details reach the admin schedule', () => {
  it('persists the driver and conductor with their phone numbers', async () => {
    const app = await as(granted);
    const { res, shiftId } = await startShift(app);

        expect(res.status).toBe(201);
    expect(res.body.shift.driverName).toBe('DANIEL MUVIRIMI');
    expect(res.body.shift.driverPhone).toBe('+263771234567');
    expect(res.body.shift.conductorName).toBe('LESLIE MUVIRIMI');
    expect(res.body.shift.conductorPhone).toBe('+263777654321');
    expect(res.body.shift.vehicleReg).toBe('AGJ 1234');

    const { rows } = await pool.query(
      'SELECT driver_name, driver_phone, conductor_name, conductor_phone FROM transit_shifts WHERE id = $1',
      [shiftId],
    );
    expect(rows[0].driver_name).toBe('DANIEL MUVIRIMI');
    expect(rows[0].driver_phone).toBe('+263771234567');
    expect(rows[0].conductor_name).toBe('LESLIE MUVIRIMI');
    expect(rows[0].conductor_phone).toBe('+263777654321');
  });

  it('normalises a local phone number into E.164 on the way in', async () => {
    // formatZimPhone stores contacts internationally so admin can dial them from
    // anywhere; a local 071... is rewritten to +26371..., which the app's
    // zimPhoneOrEmpty understands when rendering.
    const app = await as(granted);
    const { res } = await startShift(app, { driverPhone: '0771234567' });
    expect(res.status).toBe(201);
    expect(res.body.shift.driverPhone).toBe('+263771234567');
  });

  it('tolerates a shift with no crew details at all', async () => {
    const app = await as(granted);
    const shiftId = uuid();
    createdShiftIds.push(shiftId);
    const res = await request(app)
      .post('/api/transit/shifts/start')
      .send({ shiftId });
        expect(res.status).toBe(201);
    expect(res.body.shift.driverName).toBe('');
  });
});

describe('shift close: end-of-shift reaches admin', () => {
  it('closes an open shift', async () => {
    const app = await as(granted);
    const { shiftId } = await startShift(app);
    const res = await request(app)
      .post('/api/transit/shifts/close')
      .send({ shiftId });
    expect(res.status).toBe(200);
    expect(res.body.shift.status).toBe('CLOSED');
    expect(res.body.shift.closedAt).toBeTruthy();
  });

  it('honours the finish time the conductor actually recorded', async () => {
    // The core of the fix: a close replayed after coming back online must carry
    // the real end-of-shift time, not the reconnection time. Without this, admin
    // shows a bus that worked a six-hour afternoon as a twelve-hour shift.
    const app = await as(granted);
    const { shiftId } = await startShift(app);
    const finished = '2026-09-28T14:35:00.000Z';

    const res = await request(app)
      .post('/api/transit/shifts/close')
      .send({ shiftId, closedAt: finished });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT closed_at FROM transit_shifts WHERE id = $1',
      [shiftId],
    );
    expect(new Date(rows[0].closed_at).toISOString()).toBe(finished);
  });

  it('does not re-stamp an existing close on replay', async () => {
    const app = await as(granted);
    const { shiftId } = await startShift(app);
    const finished = '2026-09-28T14:35:00.000Z';
    await request(app).post('/api/transit/shifts/close').send({ shiftId, closedAt: finished });

    // A late duplicate with a different timestamp must NOT overwrite the first
    // authoritative close.
    const res = await request(app)
      .post('/api/transit/shifts/close')
      .send({ shiftId, closedAt: '2026-09-28T23:59:00.000Z' });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT closed_at FROM transit_shifts WHERE id = $1',
      [shiftId],
    );
    expect(new Date(rows[0].closed_at).toISOString()).toBe(finished);
  });

  it('treats replaying an already-closed shift as success, not an error', async () => {
    // If a repeated close returned 404 the handset would retry forever, so the
    // close must be idempotent.
    const app = await as(granted);
    const { shiftId } = await startShift(app);
    const first = await request(app).post('/api/transit/shifts/close').send({ shiftId });
    const second = await request(app).post('/api/transit/shifts/close').send({ shiftId });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.shift.status).toBe('CLOSED');
  });

  it('ignores a garbage closedAt instead of failing the close', async () => {
    // A handset with a wrong clock must not be able to block a driver from
    // going off duty.
    const app = await as(granted);
    const { shiftId } = await startShift(app);
    const res = await request(app)
      .post('/api/transit/shifts/close')
      .send({ shiftId, closedAt: 'not-a-timestamp' });
    expect(res.status).toBe(200);
    expect(res.body.shift.status).toBe('CLOSED');
    expect(res.body.shift.closedAt).toBeTruthy();
  });

  it('falls back to the server clock when no closedAt is supplied', async () => {
    const app = await as(granted);
    const { shiftId } = await startShift(app);
    const res = await request(app).post('/api/transit/shifts/close').send({ shiftId });
    expect(res.status).toBe(200);
    expect(res.body.shift.closedAt).toBeTruthy();
  });

  it('rejects a close with no shiftId', async () => {
    const app = await as(granted);
    const res = await request(app).post('/api/transit/shifts/close').send({});
    expect(res.status).toBe(422);
  });

  it('will not let one company close another company shift', async () => {
    const owner = await as(granted);
    const { shiftId } = await startShift(owner);
    const attacker = await as(rival);
    const res = await request(attacker)
      .post('/api/transit/shifts/close')
      .send({ shiftId, closedAt: '2026-09-28T14:35:00.000Z' });
    expect(res.status).toBe(404);

    const { rows } = await pool.query(
      'SELECT status FROM transit_shifts WHERE id = $1',
      [shiftId],
    );
    expect(rows[0].status).toBe('OPEN');
  });
});

describe('a replayed start cannot resurrect a closed shift', () => {
  it('leaves a closed shift closed when its start is replayed later', async () => {
    // The sync service used to push start-then-close because /shifts/start
    // unconditionally forced status = 'OPEN'. That was a double defect: it
    // resurrected a finished shift, and it hit idx_one_open_shift (409) if the
    // conductor had already started their next shift, stranding the queue.
    // The app now sends the close alone and the server refuses to reopen.
    const app = await as(granted);
    const { res, shiftId } = await startShift(app);
    expect(res.status).toBe(201);

    await request(app)
      .post('/api/transit/shifts/close')
      .send({ shiftId, closedAt: '2026-09-28T14:35:00.000Z' });

    const replay = await request(app)
      .post('/api/transit/shifts/start')
      .send({ shiftId, driverName: 'REPLAYED', vehicleReg: 'ABC 123' });
    expect(replay.status).toBe(201);

    const { rows } = await pool.query(
      'SELECT status, closed_at FROM transit_shifts WHERE id = $1', [shiftId]);
    expect(rows[0].status).toBe('CLOSED');
    // The close time must survive the replay, not be nulled out.
    expect(rows[0].closed_at).toBeTruthy();
  });

  it('still refreshes crew details on a closed shift without reopening it', async () => {
    const app = await as(granted);
    const { shiftId } = await startShift(app);
    await request(app).post('/api/transit/shifts/close').send({ shiftId });

    await request(app)
      .post('/api/transit/shifts/start')
      .send({ shiftId, driverName: 'LATE EDIT', vehicleReg: 'ABC 999' });

    const { rows } = await pool.query(
      'SELECT status, driver_name, vehicle_reg FROM transit_shifts WHERE id = $1', [shiftId]);
    expect(rows[0].status).toBe('CLOSED');
    expect(rows[0].driver_name).toBe('LATE EDIT');
    expect(rows[0].vehicle_reg).toBe('ABC 999');
  });
});

describe('a shift that began and ended offline still reaches the server', () => {
  it('accepts a close for a shift the server has never seen', async () => {
    // Closing an unknown shift used to 404, so a conductor who worked a whole
    // shift with no signal could never record it: the start never arrived, and
    // the close was rejected. The close is now an upsert.
    const app = await as(granted);
    const neverSeen = '11111111-2222-3333-4444-555555555555';
    createdShiftIds.push(neverSeen);

    const res = await request(app).post('/api/transit/shifts/close').send({
      shiftId: neverSeen,
      closedAt: '2026-09-28T11:00:00.000Z',
      driverName: 'TAPERA',
      driverPhone: '0771234567',
      conductorName: 'LESLIE',
      vehicleReg: 'ABC 123',
    });

    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT status, closed_at, driver_name, conductor_name, vehicle_reg, driver_phone
       FROM transit_shifts WHERE id = $1`, [neverSeen]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('CLOSED');
    expect(rows[0].driver_name).toBe('TAPERA');
    expect(rows[0].conductor_name).toBe('LESLIE');
    expect(rows[0].vehicle_reg).toBe('ABC 123');
    // A local number is normalised on the way in, as it is on the start path.
    expect(rows[0].driver_phone).toBe('+263771234567');
    expect(new Date(rows[0].closed_at).toISOString()).toBe('2026-09-28T11:00:00.000Z');
  });

  it('does not trip the one-open-shift index, because it never opens one', async () => {
    // The old replay order (start, then close) returned 409 here whenever the
    // conductor had already begun their next shift. Closing directly cannot.
    const app = await as(granted);
    const { shiftId: first } = await startShift(app);
    await request(app).post('/api/transit/shifts/close').send({ shiftId: first });

    const second = await startShift(app);
    expect(second.res.status).toBe(201);

    const offlineShift = '99999999-8888-7777-6666-555555555555';
    createdShiftIds.push(offlineShift);
    const res = await request(app).post('/api/transit/shifts/close').send({
      shiftId: offlineShift,
      closedAt: '2026-09-28T16:00:00.000Z',
    });
    expect(res.status).toBe(200);

    // The in-progress shift is untouched by the replayed close.
    const { rows } = await pool.query(
      'SELECT status FROM transit_shifts WHERE id = $1', [second.shiftId]);
    expect(rows[0].status).toBe('OPEN');
  });

  it('does not overwrite crew details the server already holds', async () => {
    // The interesting case is a shift the server has never seen: the first
    // replay records the crew, and a second replay must not clobber it.
    const app = await as(granted);
    const offlineShift = '33333333-2222-1111-0000-999999999999';
    createdShiftIds.push(offlineShift);

    await request(app).post('/api/transit/shifts/close').send({
      shiftId: offlineShift,
      driverName: 'ORIGINAL DRIVER',
      vehicleReg: 'ORIG 1',
      conductorName: 'ORIGINAL CONDUCTOR',
    });
    await request(app).post('/api/transit/shifts/close').send({
      shiftId: offlineShift,
      driverName: 'REPLACEMENT',
      vehicleReg: 'REPL 2',
      conductorName: 'REPLACEMENT CONDUCTOR',
    });

    const { rows } = await pool.query(
      'SELECT driver_name, vehicle_reg, conductor_name FROM transit_shifts WHERE id = $1',
      [offlineShift]);
    expect(rows[0].driver_name).toBe('ORIGINAL DRIVER');
    expect(rows[0].vehicle_reg).toBe('ORIG 1');
    expect(rows[0].conductor_name).toBe('ORIGINAL CONDUCTOR');
  });

  it('keeps the first close time across repeated offline replays', async () => {
    const app = await as(granted);
    const offlineShift = '77777777-6666-5555-4444-333333333333';
    createdShiftIds.push(offlineShift);

    await request(app).post('/api/transit/shifts/close')
      .send({ shiftId: offlineShift, closedAt: '2026-09-28T09:00:00.000Z' });
    await request(app).post('/api/transit/shifts/close')
      .send({ shiftId: offlineShift, closedAt: '2026-09-28T17:30:00.000Z' });

    const { rows } = await pool.query(
      'SELECT closed_at FROM transit_shifts WHERE id = $1', [offlineShift]);
    expect(new Date(rows[0].closed_at).toISOString()).toBe('2026-09-28T09:00:00.000Z');
  });

  it('falls back to the server clock when the offline close has no timestamp', async () => {
    const app = await as(granted);
    const offlineShift = '66666666-5555-4444-3333-222222222222';
    createdShiftIds.push(offlineShift);
    const before = Date.now();

    const res = await request(app).post('/api/transit/shifts/close')
      .send({ shiftId: offlineShift });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT closed_at FROM transit_shifts WHERE id = $1', [offlineShift]);
    const closed = new Date(rows[0].closed_at).getTime();
    expect(closed).toBeGreaterThanOrEqual(before - 60_000);
  });

  it('will not let one company close a shift id owned by another', async () => {
    // The upsert matches ON CONFLICT (id) — the primary key alone — so without
    // an explicit company guard it would be a cross-tenant write: a rival
    // company that learned a shift UUID could close somebody else's shift.
    const app = await as(granted);
    const rivalApp = await as(rival);
    const victimId = '44444444-3333-2222-1111-999999999999';

    // An OPEN shift owned by the rival company.
    await pool.query(
      `INSERT INTO transit_shifts (id, company_id, user_id, device_id, driver_name, status)
       VALUES ($1, $2, $3, $4, 'VICTIM DRIVER', 'OPEN')`,
      [victimId, rival.companyId, rival.id, deviceIds.get(rival.companyId)]);

    try {
      const res = await request(app).post('/api/transit/shifts/close')
        .send({ shiftId: victimId, driverName: 'INTRUDER' });
      expect(res.status).toBe(404);
      // And the victim's shift is untouched.
      const { rows } = await pool.query(
        'SELECT status, driver_name FROM transit_shifts WHERE id = $1', [victimId]);
      expect(rows[0].status).toBe('OPEN');
      expect(rows[0].driver_name).toBe('VICTIM DRIVER');

      // The owning company can still close it, so this is scoping and not a
      // blanket refusal.
      const owner = await request(rivalApp).post('/api/transit/shifts/close')
        .send({ shiftId: victimId });
      expect(owner.status).toBe(200);
    } finally {
      await pool.query('DELETE FROM transit_shifts WHERE id = $1', [victimId]);
    }
  });
});
