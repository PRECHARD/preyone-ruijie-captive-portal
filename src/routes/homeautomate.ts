import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { requireAdminAuth } from '../middleware/adminAuth';
import { requireCompany } from '../middleware/company';
import { broadcastToCompany, iotHubStats } from '../services/iotHub';

/**
 * Home automation module (`homeautomate.preyone.com`).
 *
 * Additive: a company-scoped IoT inventory, rolling telemetry, simple threshold
 * triggers and the StarLink gateway uptime feed. No existing portal, voucher or
 * POS query is touched. Every statement carries company_id, so a second tenant
 * can never read or command another home.
 */
export const homeAutomateRouter = Router();

type DeviceRow = {
  id: string;
  name: string;
  kind: string;
  room: string | null;
  transport: string;
  online: boolean;
  state: Record<string, unknown>;
  last_seen_at: string | null;
};

const KINDS = ['switch', 'dimmer', 'sensor', 'thermostat', 'camera', 'gateway', 'meter', 'lock'] as const;
const TRANSPORTS = ['mqtt', 'http', 'starlink', 'manual'] as const;

const round = (n: unknown, dp = 2): number => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function companyId(req: Request): string {
  return req.company!.id;
}

// Ingest is deliberately the loosest surface (device bridges post here), so it
// gets its own ceiling; the read endpoints are cheap and poll every 5s.
const ingestLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  message: { error: 'Too many telemetry samples, slow down' },
});

homeAutomateRouter.use(requireAdminAuth, requireCompany);

// ── Devices ────────────────────────────────────────────────────────────────

homeAutomateRouter.get('/devices', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT d.*,
            (SELECT jsonb_object_agg(t.metric, t.value)
               FROM (SELECT DISTINCT ON (metric) metric, value
                       FROM iot_telemetry
                      WHERE device_id = d.id
                      ORDER BY metric, recorded_at DESC) t) AS metrics
       FROM iot_devices d
      WHERE d.company_id = $1
      ORDER BY d.room NULLS LAST, d.name`,
    [companyId(req)]
  );
  res.json(rows);
});

homeAutomateRouter.post('/devices', async (req: Request, res: Response) => {
  const name = str(req.body?.name);
  const kind = str(req.body?.kind) || 'switch';
  const transport = str(req.body?.transport) || 'http';
  if (!name) {
    res.status(422).json({ error: 'name is required' });
    return;
  }
  if (!(KINDS as readonly string[]).includes(kind)) {
    res.status(422).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    return;
  }
  if (!(TRANSPORTS as readonly string[]).includes(transport)) {
    res.status(422).json({ error: `transport must be one of ${TRANSPORTS.join(', ')}` });
    return;
  }
  const externalId = str(req.body?.externalId) || `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query(
    `INSERT INTO iot_devices (company_id, name, kind, room, transport, vendor, model, external_id, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     RETURNING *`,
    [
      companyId(req),
      name,
      kind,
      str(req.body?.room) || null,
      transport,
      str(req.body?.vendor) || null,
      str(req.body?.model) || null,
      externalId,
      JSON.stringify(req.body?.state ?? (kind === 'switch' ? { on: false } : {})),
    ]
  );
  await audit(req, rows[0].id, 'device_created', { name, kind, transport });
  broadcastToCompany(companyId(req), { type: 'device_state', payload: { device: rows[0] } });
  res.status(201).json(rows[0]);
});

homeAutomateRouter.patch('/devices/:id', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `UPDATE iot_devices
        SET name = COALESCE($3, name),
            room = COALESCE($4, room),
            state = COALESCE($5::jsonb, state),
            updated_at = NOW()
      WHERE id = $1 AND company_id = $2
      RETURNING *`,
    [
      req.params.id,
      companyId(req),
      str(req.body?.name) || null,
      str(req.body?.room) || null,
      req.body?.state === undefined ? null : JSON.stringify(req.body.state),
    ]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  broadcastToCompany(companyId(req), { type: 'device_state', payload: { device: rows[0] } });
  res.json(rows[0]);
});

homeAutomateRouter.delete('/devices/:id', async (req: Request, res: Response) => {
  const { rowCount } = await pool.query(`DELETE FROM iot_devices WHERE id = $1 AND company_id = $2`, [
    req.params.id,
    companyId(req),
  ]);
  if (!rowCount) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  res.json({ deleted: true });
});

/** Flip / dim / lock a device. Returns the merged state and pushes it live. */
homeAutomateRouter.post('/devices/:id/command', async (req: Request, res: Response) => {
  const action = str(req.body?.action) || 'toggle';
  const { rows } = await pool.query(`SELECT * FROM iot_devices WHERE id = $1 AND company_id = $2`, [
    req.params.id,
    companyId(req),
  ]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  const device = rows[0] as DeviceRow;
  const state: Record<string, unknown> = { ...(device.state || {}) };
  switch (action) {
    case 'on':
      state.on = true;
      break;
    case 'off':
      state.on = false;
      break;
    case 'toggle':
      state.on = !state.on;
      break;
    case 'set': {
      const value = req.body?.value;
      if (value === undefined) {
        res.status(422).json({ error: 'value is required for action=set' });
        return;
      }
      state.level = value;
      if (typeof value === 'number') state.on = value > 0;
      break;
    }
    case 'lock':
      state.locked = true;
      break;
    case 'unlock':
      state.locked = false;
      break;
    default:
      res.status(422).json({ error: 'action must be on|off|toggle|set|lock|unlock' });
      return;
  }
  const { rows: updated } = await pool.query(
    `UPDATE iot_devices SET state = $3::jsonb, online = TRUE, last_seen_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND company_id = $2
      RETURNING *`,
    [device.id, companyId(req), JSON.stringify(state)]
  );
  await audit(req, device.id, 'device_command', { action, state });
  broadcastToCompany(companyId(req), {
    type: 'device_state',
    payload: { device: updated[0], action },
  });
  res.json(updated[0]);
});

// ── Telemetry ──────────────────────────────────────────────────────────────

homeAutomateRouter.post('/devices/:id/telemetry', ingestLimiter, async (req: Request, res: Response) => {
  const samples = Array.isArray(req.body?.samples)
    ? req.body.samples
    : [{ metric: req.body?.metric, value: req.body?.value, unit: req.body?.unit }];
  const clean = samples
    .map((s: any) => ({
      metric: str(s?.metric),
      value: num(s?.value),
      unit: str(s?.unit) || null,
    }))
    .filter((s: any) => s.metric && Number.isFinite(s.value));
  if (clean.length === 0) {
    res.status(422).json({ error: 'At least one { metric, value } sample is required' });
    return;
  }

  const { rows: deviceRows } = await pool.query(
    `SELECT id, state FROM iot_devices WHERE id = $1 AND company_id = $2`,
    [req.params.id, companyId(req)]
  );
  if (deviceRows.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sample of clean) {
      await client.query(
        `INSERT INTO iot_telemetry (device_id, company_id, metric, value, unit)
         VALUES ($1,$2,$3,$4,$5)`,
        [deviceRows[0].id, companyId(req), sample.metric, sample.value, sample.unit]
      );
    }
    const mergedState = { ...(deviceRows[0].state || {}) };
    for (const sample of clean) mergedState[sample.metric] = sample.value;
    const { rows: updated } = await client.query(
      `UPDATE iot_devices
          SET online = TRUE, last_seen_at = NOW(), state = $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND company_id = $2
        RETURNING *`,
      [deviceRows[0].id, companyId(req), JSON.stringify(mergedState)]
    );
    await client.query('COMMIT');

    const fired = await evaluateTriggers(companyId(req), deviceRows[0].id, clean);

    broadcastToCompany(companyId(req), {
      type: 'telemetry',
      payload: { deviceId: deviceRows[0].id, samples: clean, device: updated[0], triggers: fired },
    });
    res.status(202).json({ accepted: clean.length, fired });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
});

homeAutomateRouter.get('/devices/:id/telemetry', async (req: Request, res: Response) => {
  const hours = Math.min(24 * 30, Math.max(1, num(req.query.hours) || 24));
  const metric = str(req.query.metric);
  const { rows } = await pool.query(
    `SELECT t.metric, t.value, t.unit, t.recorded_at
       FROM iot_telemetry t
       JOIN iot_devices d ON d.id = t.device_id
      WHERE t.device_id = $1 AND d.company_id = $2
        AND t.recorded_at > NOW() - ($3::int * INTERVAL '1 hour')
        AND ($4 = '' OR t.metric = $4)
      ORDER BY t.recorded_at ASC
      LIMIT 2000`,
    [req.params.id, companyId(req), hours, metric]
  );
  res.json(rows);
});

// ── Triggers ───────────────────────────────────────────────────────────────

homeAutomateRouter.get('/triggers', async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT t.*, d.name AS device_name
       FROM iot_triggers t
       JOIN iot_devices d ON d.id = t.device_id
      WHERE t.company_id = $1
      ORDER BY t.created_at DESC`,
    [companyId(req)]
  );
  res.json(rows);
});

homeAutomateRouter.post('/triggers', async (req: Request, res: Response) => {
  const deviceId = str(req.body?.deviceId);
  const name = str(req.body?.name);
  const metric = str(req.body?.metric);
  const operator = str(req.body?.operator) || '>';
  const action = str(req.body?.action) || 'notify';
  if (!deviceId || !name || !metric) {
    res.status(422).json({ error: 'deviceId, name and metric are required' });
    return;
  }
  if (!['>', '>=', '<', '<=', '==', '!='].includes(operator)) {
    res.status(422).json({ error: 'operator must be one of > >= < <= == !=' });
    return;
  }
  if (!['notify', 'webhook', 'set_state'].includes(action)) {
    res.status(422).json({ error: 'action must be notify|webhook|set_state' });
    return;
  }
  const { rows: owned } = await pool.query(`SELECT id FROM iot_devices WHERE id = $1 AND company_id = $2`, [
    deviceId,
    companyId(req),
  ]);
  if (owned.length === 0) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO iot_triggers (company_id, device_id, name, metric, operator, threshold, action, action_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     RETURNING *`,
    [
      companyId(req),
      deviceId,
      name,
      metric,
      operator,
      num(req.body?.threshold),
      action,
      JSON.stringify(req.body?.actionPayload ?? {}),
    ]
  );
  await audit(req, deviceId, 'trigger_created', { name, metric, operator, threshold: num(req.body?.threshold) });
  res.status(201).json(rows[0]);
});

homeAutomateRouter.delete('/triggers/:id', async (req: Request, res: Response) => {
  const { rowCount } = await pool.query(`DELETE FROM iot_triggers WHERE id = $1 AND company_id = $2`, [
    req.params.id,
    companyId(req),
  ]);
  if (!rowCount) {
    res.status(404).json({ error: 'Trigger not found' });
    return;
  }
  res.json({ deleted: true });
});

async function evaluateTriggers(
  companyIdValue: string,
  deviceId: string,
  samples: { metric: string; value: number; unit: string | null }[]
): Promise<{ id: string; name: string; metric: string; value: number }[]> {
  const fired: { id: string; name: string; metric: string; value: number }[] = [];
  const { rows: triggers } = await pool.query(
    `SELECT * FROM iot_triggers WHERE company_id = $1 AND device_id = $2 AND enabled`,
    [companyIdValue, deviceId]
  );
  for (const trigger of triggers) {
    const sample = samples.find((s) => s.metric === trigger.metric);
    if (!sample) continue;
    const value = Number(sample.value);
    const threshold = Number(trigger.threshold);
    const hit =
      (trigger.operator === '>' && value > threshold) ||
      (trigger.operator === '>=' && value >= threshold) ||
      (trigger.operator === '<' && value < threshold) ||
      (trigger.operator === '<=' && value <= threshold) ||
      (trigger.operator === '==' && value === threshold) ||
      (trigger.operator === '!=' && value !== threshold);
    if (!hit) continue;
    await pool.query(`UPDATE iot_triggers SET last_fired_at = NOW() WHERE id = $1`, [trigger.id]);
    await pool.query(
      `INSERT INTO iot_events (company_id, device_id, event, detail) VALUES ($1,$2,'trigger_fired',$3::jsonb)`,
      [companyIdValue, deviceId, JSON.stringify({ triggerId: trigger.id, metric: trigger.metric, value, threshold })]
    );
    fired.push({ id: trigger.id, name: trigger.name, metric: trigger.metric, value });
  }
  return fired;
}

// ── StarLink gateway uptime ────────────────────────────────────────────────

homeAutomateRouter.post('/starlink/sample', ingestLimiter, async (req: Request, res: Response) => {
  const online = req.body?.online === undefined ? true : Boolean(req.body.online);
  const { rows } = await pool.query(
    `INSERT INTO starlink_uptime_samples (company_id, device_id, online, latency_ms, down_mbps, up_mbps)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      companyId(req),
      str(req.body?.deviceId) || null,
      online,
      Number.isFinite(Number(req.body?.latencyMs)) ? Number(req.body.latencyMs) : null,
      Number.isFinite(Number(req.body?.downMbps)) ? Number(req.body.downMbps) : null,
      Number.isFinite(Number(req.body?.upMbps)) ? Number(req.body.upMbps) : null,
    ]
  );
  broadcastToCompany(companyId(req), { type: 'alert', payload: { kind: 'starlink_sample', sample: rows[0] } });
  res.status(201).json(rows[0]);
});

homeAutomateRouter.get('/starlink/uptime', async (req: Request, res: Response) => {
  const hours = Math.min(24 * 30, Math.max(1, num(req.query.hours) || 24));
  const { rows } = await pool.query(
    `SELECT
        COUNT(*)::int AS samples,
        COALESCE(AVG(CASE WHEN online THEN 1 ELSE 0 END) * 100, 0) AS uptime_pct,
        COALESCE(AVG(latency_ms), 0) AS latency_ms,
        COALESCE(AVG(down_mbps), 0) AS down_mbps,
        COALESCE(AVG(up_mbps), 0) AS up_mbps,
        MAX(recorded_at) AS last_sample_at
       FROM starlink_uptime_samples
      WHERE company_id = $1 AND recorded_at > NOW() - ($2::int * INTERVAL '1 hour')`,
    [companyId(req), hours]
  );
  const { rows: series } = await pool.query(
    `SELECT recorded_at, online, latency_ms, down_mbps, up_mbps
       FROM starlink_uptime_samples
      WHERE company_id = $1 AND recorded_at > NOW() - ($2::int * INTERVAL '1 hour')
      ORDER BY recorded_at ASC LIMIT 500`,
    [companyId(req), hours]
  );
  const summary = rows[0] ?? {};
  res.json({
    samples: Number(summary.samples) || 0,
    uptimePct: round(summary.uptime_pct, 1),
    latencyMs: round(summary.latency_ms, 0),
    downMbps: round(summary.down_mbps, 1),
    upMbps: round(summary.up_mbps, 1),
    lastSampleAt: summary.last_sample_at ?? null,
    series,
  });
});

// ── Dashboard summary + audit ──────────────────────────────────────────────

homeAutomateRouter.get('/summary', async (req: Request, res: Response) => {
  const cid = companyId(req);
  const [devices, energy, starlink, triggers, events] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE online)::int AS online,
              COUNT(*) FILTER (WHERE kind = 'gateway')::int AS gateways
         FROM iot_devices WHERE company_id = $1`,
      [cid]
    ),
    pool.query(
      `SELECT COALESCE(SUM(value), 0) AS kwh
         FROM iot_telemetry
        WHERE company_id = $1 AND metric = 'energy_kwh' AND recorded_at > CURRENT_DATE`,
      [cid]
    ),
    pool.query(
      `SELECT COALESCE(AVG(CASE WHEN online THEN 1 ELSE 0 END) * 100, 0) AS uptime_pct,
              COALESCE(AVG(latency_ms), 0) AS latency_ms,
              MAX(recorded_at) AS last_sample_at
         FROM starlink_uptime_samples
        WHERE company_id = $1 AND recorded_at > NOW() - INTERVAL '24 hours'`,
      [cid]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE enabled)::int AS active,
              COUNT(*) FILTER (WHERE last_fired_at > NOW() - INTERVAL '24 hours')::int AS fired_today
         FROM iot_triggers WHERE company_id = $1`,
      [cid]
    ),
    pool.query(
      `SELECT id, device_id, event, detail, created_at
         FROM iot_events WHERE company_id = $1 ORDER BY created_at DESC LIMIT 8`,
      [cid]
    ),
  ]);

  const deviceCounts = devices.rows[0] ?? { total: 0, online: 0, gateways: 0 };
  const total = Number(deviceCounts.total) || 0;
  const online = Number(deviceCounts.online) || 0;
  res.json({
    company: { id: cid, name: req.company!.name },
    devices: {
      total,
      online,
      offline: Math.max(0, total - online),
      gateways: Number(deviceCounts.gateways) || 0,
      healthPct: total ? Math.round((online / total) * 100) : 0,
    },
    energy: { kwhToday: round(energy.rows[0]?.kwh, 3), currency: 'USD', ratePerKwh: 0.14 },
    starlink: {
      uptimePct: round(starlink.rows[0]?.uptime_pct, 1),
      latencyMs: round(starlink.rows[0]?.latency_ms, 0),
      lastSampleAt: starlink.rows[0]?.last_sample_at ?? null,
    },
    triggers: {
      active: Number(triggers.rows[0]?.active) || 0,
      firedToday: Number(triggers.rows[0]?.fired_today) || 0,
    },
    events: events.rows,
    hub: iotHubStats(),
    updatedAt: new Date().toISOString(),
  });
});

homeAutomateRouter.get('/events', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, num(req.query.limit) || 50));
  const { rows } = await pool.query(
    `SELECT e.*, d.name AS device_name
       FROM iot_events e
       LEFT JOIN iot_devices d ON d.id = e.device_id
      WHERE e.company_id = $1
      ORDER BY e.created_at DESC LIMIT $2`,
    [companyId(req), limit]
  );
  res.json(rows);
});

/**
 * Idempotent demo home: a handful of realistic devices so a new tenant can see
 * the dashboard working before any hardware is bridged. Names carry the
 * `(demo)` suffix so they are obvious in the device list; nothing is created if
 * the company already has devices.
 */
homeAutomateRouter.post('/seed', async (req: Request, res: Response) => {
  const cid = companyId(req);
  const { rows: existing } = await pool.query(`SELECT COUNT(*)::int AS n FROM iot_devices WHERE company_id = $1`, [cid]);
  if (Number(existing[0]?.n) > 0) {
    res.json({ seeded: false, reason: 'company already has devices' });
    return;
  }
  const seedDevices = [
    { name: 'StarLink Gateway (demo)', kind: 'gateway', room: 'Roof', transport: 'starlink', state: { online: 1, latency_ms: 42 } },
    { name: 'Lounge Lights (demo)', kind: 'dimmer', room: 'Lounge', transport: 'mqtt', state: { on: true, level: 72 } },
    { name: 'Kitchen Socket (demo)', kind: 'switch', room: 'Kitchen', transport: 'mqtt', state: { on: false } },
    { name: 'Main Meter (demo)', kind: 'meter', room: 'Utility', transport: 'http', state: { energy_kwh: 0 } },
    { name: 'Cold Room Sensor (demo)', kind: 'sensor', room: 'Store', transport: 'http', state: { temp_c: 4.2 } },
    { name: 'Front Door Lock (demo)', kind: 'lock', room: 'Entrance', transport: 'mqtt', state: { locked: true } },
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const d of seedDevices) {
      const { rows } = await client.query(
        `INSERT INTO iot_devices (company_id, name, kind, room, transport, external_id, online, state, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7::jsonb,NOW()) RETURNING id`,
        [cid, d.name, d.kind, d.room, d.transport, `demo-${d.kind}-${Math.random().toString(36).slice(2, 8)}`, JSON.stringify(d.state)]
      );
      if (d.kind === 'meter') {
        for (let h = 23; h >= 0; h--) {
          await client.query(
            `INSERT INTO iot_telemetry (device_id, company_id, metric, value, unit, recorded_at)
             VALUES ($1,$2,'energy_kwh',$3,'kWh', NOW() - ($4::int * INTERVAL '1 hour'))`,
            [rows[0].id, cid, round(0.4 + Math.random() * 0.8, 3), h]
          );
        }
      }
      if (d.kind === 'gateway') {
        for (let i = 0; i < 24; i++) {
          await client.query(
            `INSERT INTO starlink_uptime_samples (company_id, device_id, online, latency_ms, down_mbps, up_mbps, recorded_at)
             VALUES ($1,$2,$3,$4,$5,$6, NOW() - ($7::int * INTERVAL '1 hour'))`,
            [cid, rows[0].id, i !== 7, 35 + Math.random() * 25, 120 + Math.random() * 60, 18 + Math.random() * 8, i]
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  broadcastToCompany(cid, { type: 'alert', payload: { kind: 'demo_seeded' } });
  res.status(201).json({ seeded: true, devices: seedDevices.length });
});

// Minimal audit helper (best-effort: a pre-migration database just skips it).
async function audit(
  req: Request,
  deviceId: string | null,
  event: string,
  detail: Record<string, unknown>
): Promise<void> {
  await pool
    .query(
      `INSERT INTO iot_events (company_id, device_id, event, detail, actor_id)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [companyId(req), deviceId, event, JSON.stringify(detail), req.adminUser?.id ?? null]
    )
    .catch(() => undefined);
}
