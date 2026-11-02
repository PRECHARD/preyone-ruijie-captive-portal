import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  getToken,
  streamUrl,
  type IotDevice,
  type IotEvent,
  type StreamEvent,
  type Summary,
  type ThemeResponse,
  type Trigger,
  type UptimeSummary,
} from './api';
import { applyCssVars } from './theme';

/* ────────────────────────────── helpers ────────────────────────────── */

const KIND_ICON: Record<string, string> = {
  switch: '⏻',
  dimmer: '◐',
  sensor: '🌡',
  thermostat: '♨',
  camera: '◉',
  gateway: '📡',
  meter: '⚡',
  lock: '🔒',
};

const OPERATORS = ['>', '>=', '<', '<=', '==', '!='];

function timeAgo(value?: string | null): string {
  if (!value) return 'never';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

function isSwitchable(kind: string): boolean {
  return kind === 'switch' || kind === 'dimmer';
}

/** Format a device state value for the metric chips. */
function stateChips(device: IotDevice): Array<{ label: string; value: string }> {
  const state = { ...(device.metrics || {}), ...(device.state || {}) } as Record<string, unknown>;
  const chips: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: unknown, unit = '') => {
    if (value === undefined || value === null || value === '') return;
    chips.push({ label, value: `${typeof value === 'number' ? Math.round(value * 100) / 100 : String(value)}${unit}` });
  };
  if (typeof state.on === 'boolean') push('power', state.on ? 'on' : 'off');
  if (typeof state.locked === 'boolean') push('lock', state.locked ? 'locked' : 'open');
  if (state.level !== undefined) push('level', state.level, '%');
  if (state.temp_c !== undefined) push('temp', state.temp_c, '°C');
  if (state.latency_ms !== undefined) push('latency', state.latency_ms, ' ms');
  if (state.energy_kwh !== undefined) push('energy', state.energy_kwh, ' kWh');
  if (state.uptime_pct !== undefined) push('uptime', state.uptime_pct, '%');
  return chips.slice(0, 4);
}

/* ────────────────────────────── login ──────────────────────────────── */

function LoginPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [masked, setMasked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = challenge ? '/api/admin/auth/verify-2fa' : '/api/admin/auth/login';
      const body = challenge ? { challengeToken: challenge, code } : { email, password };
      const res = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign-in failed');
      if (data.requires2fa) {
        setChallenge(data.challengeToken);
        setMasked(data.maskedEmail || '');
        return;
      }
      if (data.token) localStorage.setItem('gateway_token', data.token);
      onSignedIn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="glass auth-card" onSubmit={submit}>
        <h1>{challenge ? 'Two-factor code' : 'Home Automation'}</h1>
        <p>{challenge ? `Code sent to ${masked || 'your email'}.` : 'Sign in with your Preyone console account.'}</p>
        {error && <div className="banner error">{error}</div>}
        {challenge ? (
          <label className="field">
            <span>6-digit code</span>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoFocus required />
          </label>
        ) : (
          <>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
            </label>
            <label className="field">
              <span>Password</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </label>
          </>
        )}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : challenge ? 'Verify' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

/* ──────────────────────────── device card ──────────────────────────── */

function DeviceCard({
  device,
  busy,
  onCommand,
}: {
  device: IotDevice;
  busy: boolean;
  onCommand: (action: string, value?: number) => void;
}) {
  const chips = stateChips(device);
  const on = Boolean(device.state?.on) || Boolean(device.state?.locked);
  const level = Number(device.state?.level ?? 0);

  return (
    <div className={`glass device ${device.online ? '' : 'offline'}`}>
      <div className="device-top">
        <div style={{ display: 'flex', gap: 11 }}>
          <div className="device-icon">{KIND_ICON[device.kind] ?? '◈'}</div>
          <div>
            <div className="device-name">{device.name}</div>
            <div className="device-room">
              {device.room || 'Unassigned'} · {device.transport}
            </div>
          </div>
        </div>
        <span className={`dot ${device.online ? 'on' : ''}`} title={device.online ? 'online' : 'offline'} />
      </div>

      {chips.length > 0 && (
        <div className="device-metrics">
          {chips.map((chip) => (
            <span className="metric" key={chip.label}>
              {chip.label} <strong>{chip.value}</strong>
            </span>
          ))}
        </div>
      )}

      {device.kind === 'dimmer' && (
        <input
          className="range"
          type="range"
          min={0}
          max={100}
          value={Number.isFinite(level) ? level : 0}
          disabled={busy}
          onChange={(e) => onCommand('set', Number(e.target.value))}
        />
      )}

      <div className="device-actions">
        {isSwitchable(device.kind) && (
          <button className="btn ghost" type="button" disabled={busy || !device.online} onClick={() => onCommand(on ? 'off' : 'on')}>
            {on ? 'Turn off' : 'Turn on'}
          </button>
        )}
        {device.kind === 'lock' && (
          <button className="btn ghost" type="button" disabled={busy || !device.online} onClick={() => onCommand(on ? 'unlock' : 'lock')}>
            {on ? 'Unlock' : 'Lock'}
          </button>
        )}
        {!isSwitchable(device.kind) && device.kind !== 'lock' && (
          <span className="muted small" style={{ margin: 'auto 0' }}>
            monitoring · seen {timeAgo(device.last_seen_at)}
          </span>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────── app ──────────────────────────────── */

export default function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [devices, setDevices] = useState<IotDevice[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [events, setEvents] = useState<IotEvent[]>([]);
  const [uptime, setUptime] = useState<UptimeSummary | null>(null);
  const [energySeries, setEnergySeries] = useState<number[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showTriggerForm, setShowTriggerForm] = useState(false);
  const [showDeviceForm, setShowDeviceForm] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const handleRef = useRef<(event: StreamEvent) => void>(() => {});
  const meter = useMemo(() => devices.find((d) => d.kind === 'meter'), [devices]);

  const refreshAll = useCallback(async () => {
    const [sum, devs, trg, evt, up] = await Promise.all([
      api.get<Summary>('/api/homeautomate/summary'),
      api.get<IotDevice[]>('/api/homeautomate/devices'),
      api.get<Trigger[]>('/api/homeautomate/triggers'),
      api.get<IotEvent[]>('/api/homeautomate/events?limit=12'),
      api.get<UptimeSummary>('/api/homeautomate/starlink/uptime?hours=24'),
    ]);
    setSummary(sum);
    setDevices(devs);
    setTriggers(trg);
    setEvents(evt);
    setUptime(up);
  }, []);

  const boot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const theme = await api.get<ThemeResponse>('/api/pos/theme');
      applyCssVars(theme.css);
      await refreshAll();
      setAuthError(false);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setAuthError(true);
      } else {
        setError(errorText(err));
      }
    } finally {
      setLoading(false);
    }
  }, [refreshAll]);

  /** Merge a device payload pushed over the socket into local state. */
  const upsertDevice = useCallback((device: IotDevice) => {
    setDevices((prev) => {
      const index = prev.findIndex((d) => d.id === device.id);
      if (index === -1) return [...prev, device];
      const next = [...prev];
      next[index] = { ...prev[index], ...device };
      return next;
    });
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      api.get<Summary>('/api/homeautomate/summary').then(setSummary).catch(() => undefined);
      api.get<IotEvent[]>('/api/homeautomate/events?limit=12').then(setEvents).catch(() => undefined);
    }, 700);
  }, []);

  const handleStreamEvent = useCallback(
    (event: StreamEvent) => {
      if (event.type === 'hello') {
        setConnected(true);
        return;
      }
      if (event.type === 'device_state' || event.type === 'telemetry') {
        const device = event.payload.device as IotDevice | undefined;
        if (device) upsertDevice(device);
        scheduleRefresh();
        return;
      }
      if (event.type === 'trigger') {
        scheduleRefresh();
        return;
      }
      if (event.type === 'alert') {
        const kind = event.payload.kind as string | undefined;
        if (kind === 'starlink_sample') {
          api.get<UptimeSummary>('/api/homeautomate/starlink/uptime?hours=24').then(setUptime).catch(() => undefined);
        }
        if (kind === 'demo_seeded') void refreshAll();
        scheduleRefresh();
      }
    },
    [refreshAll, scheduleRefresh, upsertDevice]
  );

  handleRef.current = handleStreamEvent;

  const connect = useCallback(() => {
    if (reconnectTimer.current) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(streamUrl());
    } catch {
      setConnected(false);
      return;
    }
    socketRef.current = socket;
    let retries = 0;

    socket.onopen = () => {
      retries = 0;
      setConnected(true);
    };
    socket.onmessage = (message) => {
      try {
        handleRef.current(JSON.parse(String(message.data)) as StreamEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      setConnected(false);
      if (socketRef.current !== socket) return;
      retries = Math.min(retries + 1, 6);
      const delay = Math.min(15000, 1000 * 2 ** retries);
      reconnectTimer.current = window.setTimeout(connect, delay);
    };
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (authError) return;
    connect();
    const poll = window.setInterval(() => {
      if (socketRef.current?.readyState !== WebSocket.OPEN) {
        api.get<Summary>('/api/homeautomate/summary').then(setSummary).catch(() => undefined);
      }
    }, 15000);
    return () => {
      window.clearInterval(poll);
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [authError, connect]);

  useEffect(() => {
    if (!meter) {
      setEnergySeries([]);
      return;
    }
    api
      .get<Array<{ value: number | string }>>(`/api/homeautomate/devices/${meter.id}/telemetry?metric=energy_kwh&hours=24`)
      .then((rows) => setEnergySeries(rows.map((r) => Number(r.value))))
      .catch(() => setEnergySeries([]));
  }, [meter]);

  const runCommand = useCallback(
    async (device: IotDevice, action: string, value?: number) => {
      setBusyId(device.id);
      setNotice(null);
      try {
        const updated = await api.post<IotDevice>(`/api/homeautomate/devices/${device.id}/command`, { action, value });
        upsertDevice(updated);
        scheduleRefresh();
        setNotice(`${device.name}: ${action} sent.`);
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusyId(null);
      }
    },
    [scheduleRefresh, upsertDevice]
  );

  const seedDemo = async () => {
    setNotice(null);
    try {
      const res = await api.post<{ seeded: boolean; devices?: number; reason?: string }>('/api/homeautomate/seed', {});
      setNotice(res.seeded ? `Demo home created (${res.devices} devices).` : res.reason || 'Demo already present.');
      await refreshAll();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const maxEnergy = Math.max(1, ...energySeries);
  const energyCost = (summary?.energy.kwhToday ?? 0) * (summary?.energy.ratePerKwh ?? 0);

  if (authError) return <LoginPanel onSignedIn={() => void boot()} />;

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <div className="brand-mark">⌂</div>
          <div>
            <h1>Home Automation</h1>
            <p>{summary?.company.name || 'Preyone'} · live device telemetry & Starlink gateway</p>
          </div>
        </div>
        <div className="top-actions">
          <span className={`live ${connected ? 'on' : 'off'}`}>
            <span className="live-dot" />
            {connected ? 'Live' : 'Reconnecting'}
          </span>
          <button className="btn ghost" type="button" onClick={() => void refreshAll()}>
            Refresh
          </button>
          <button className="btn accent" type="button" onClick={() => void seedDemo()}>
            Seed demo home
          </button>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      {loading && !summary ? (
        <div className="summary">
          {[0, 1, 2, 3, 4].map((i) => (
            <div className="glass stat" key={i}>
              <div className="skeleton" style={{ width: '50%', height: 10 }} />
              <div className="skeleton" style={{ width: '70%', height: 26, marginTop: 14 }} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <section className="summary">
            <div className="glass stat">
              <div className="stat-label">Devices online</div>
              <div className="stat-value">
                {summary?.devices.online ?? 0}
                <small>/ {summary?.devices.total ?? 0}</small>
              </div>
              <div className="stat-foot">{summary?.devices.offline ?? 0} offline · {summary?.devices.gateways ?? 0} gateways</div>
            </div>
            <div className="glass stat">
              <div className="stat-label">Fleet health</div>
              <div className={`stat-value ${(summary?.devices.healthPct ?? 0) < 80 ? 'warn' : ''}`}>
                {summary?.devices.healthPct ?? 0}
                <small>%</small>
              </div>
              <div className="stat-foot">online devices right now</div>
            </div>
            <div className="glass stat">
              <div className="stat-label">Energy today</div>
              <div className="stat-value">
                {(summary?.energy.kwhToday ?? 0).toFixed(2)}
                <small>kWh</small>
              </div>
              <div className="spark" aria-hidden>
                {(energySeries.length ? energySeries.slice(-24) : Array.from({ length: 12 }, () => 0.3)).map((v, i) => (
                  <i key={i} style={{ height: `${Math.max(8, (v / maxEnergy) * 100)}%` }} />
                ))}
              </div>
            </div>
            <div className="glass stat">
              <div className="stat-label">Estimated cost</div>
              <div className="stat-value">
                ${energyCost.toFixed(2)}
                <small>{summary?.energy.currency ?? 'USD'}</small>
              </div>
              <div className="stat-foot">@ ${summary?.energy.ratePerKwh ?? 0}/kWh</div>
            </div>
            <div className="glass stat">
              <div className="stat-label">Triggers</div>
              <div className="stat-value">{summary?.triggers.active ?? 0}</div>
              <div className="stat-foot">{summary?.triggers.firedToday ?? 0} fired in 24h</div>
            </div>
          </section>

          <div className="grid two">
            <div>
              <section className="glass section">
                <div className="section-head">
                  <div>
                    <div className="section-title">Devices</div>
                    <p className="section-sub">Commands are pushed to open dashboards instantly over WebSocket.</p>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn ghost" type="button" onClick={() => setShowDeviceForm((v) => !v)}>
                      {showDeviceForm ? 'Close' : '+ Device'}
                    </button>
                    <button className="btn ghost" type="button" onClick={() => setShowTriggerForm((v) => !v)}>
                      {showTriggerForm ? 'Close' : '+ Trigger'}
                    </button>
                  </div>
                </div>

                {showDeviceForm && <AddDevice onDone={() => void refreshAll()} onCancel={() => setShowDeviceForm(false)} />}
                {showTriggerForm && (
                  <AddTrigger
                    devices={devices}
                    onDone={() => {
                      setShowTriggerForm(false);
                      void refreshAll();
                    }}
                    onCancel={() => setShowTriggerForm(false)}
                  />
                )}

                {devices.length === 0 ? (
                  <div className="empty">
                    No devices yet. <button className="btn" type="button" onClick={() => void seedDemo()}>Create a demo home</button>
                  </div>
                ) : (
                  <div className="grid devices">
                    {devices.map((device) => (
                      <DeviceCard
                        key={device.id}
                        device={device}
                        busy={busyId === device.id}
                        onCommand={(action, value) => void runCommand(device, action, value)}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section className="glass section">
                <div className="section-head">
                  <div>
                    <div className="section-title">Automation triggers</div>
                    <p className="section-sub">Threshold rules evaluated on every telemetry sample.</p>
                  </div>
                </div>
                {triggers.length === 0 ? (
                  <div className="empty">No triggers configured.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Rule</th>
                          <th>Device</th>
                          <th>Condition</th>
                          <th>Action</th>
                          <th>Last fired</th>
                        </tr>
                      </thead>
                      <tbody>
                        {triggers.map((trigger) => (
                          <tr key={trigger.id}>
                            <td>{trigger.name}</td>
                            <td className="muted">{trigger.device_name || '—'}</td>
                            <td className="muted">
                              {trigger.metric} {trigger.operator} {Number(trigger.threshold)}
                            </td>
                            <td>
                              <span className={`pill ${trigger.enabled ? 'ok' : 'off'}`}>{trigger.action}</span>
                            </td>
                            <td className="muted">{timeAgo(trigger.last_fired_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>

            <div>
              <section className="glass section">
                <div className="section-head">
                  <div>
                    <div className="section-title">Starlink gateway</div>
                    <p className="section-sub">24-hour uptime, latency and throughput.</p>
                  </div>
                  <span className={`pill ${(uptime?.uptimePct ?? 0) >= 99 ? 'ok' : (uptime?.uptimePct ?? 0) >= 95 ? 'warn' : 'off'}`}>
                    {uptime?.samples ?? 0} samples
                  </span>
                </div>
                <div className="gauge-wrap">
                  <div className="gauge" style={{ '--pct': uptime?.uptimePct ?? 0 } as React.CSSProperties}>
                    <div className="gauge-inner">
                      <div className="gauge-value">{(uptime?.uptimePct ?? 0).toFixed(1)}%</div>
                      <div className="gauge-label">uptime</div>
                    </div>
                  </div>
                  <div className="meter-list">
                    <div className="meter">
                      <div className="meter-top">
                        <span>Latency</span>
                        <span>{(uptime?.latencyMs ?? 0).toFixed(0)} ms</span>
                      </div>
                      <div className="meter-track">
                        <div className="meter-fill" style={{ width: `${Math.min(100, ((uptime?.latencyMs ?? 0) / 120) * 100)}%` }} />
                      </div>
                    </div>
                    <div className="meter">
                      <div className="meter-top">
                        <span>Download</span>
                        <span>{(uptime?.downMbps ?? 0).toFixed(1)} Mbps</span>
                      </div>
                      <div className="meter-track">
                        <div className="meter-fill" style={{ width: `${Math.min(100, ((uptime?.downMbps ?? 0) / 250) * 100)}%` }} />
                      </div>
                    </div>
                    <div className="meter">
                      <div className="meter-top">
                        <span>Upload</span>
                        <span>{(uptime?.upMbps ?? 0).toFixed(1)} Mbps</span>
                      </div>
                      <div className="meter-track">
                        <div className="meter-fill" style={{ width: `${Math.min(100, ((uptime?.upMbps ?? 0) / 40) * 100)}%` }} />
                      </div>
                    </div>
                    <div className="muted small">Last sample {timeAgo(uptime?.lastSampleAt)}</div>
                  </div>
                </div>
              </section>

              <section className="glass section">
                <div className="section-head">
                  <div>
                    <div className="section-title">Activity</div>
                    <p className="section-sub">Commands, triggers and enrolments.</p>
                  </div>
                </div>
                {events.length === 0 ? (
                  <div className="empty">Nothing has happened yet.</div>
                ) : (
                  <div className="feed">
                    {events.map((event) => (
                      <div className="feed-item" key={event.id}>
                        <span className="feed-dot" />
                        <div>
                          <div>
                            <strong>{event.event.replace(/_/g, ' ')}</strong>
                            {event.device_name ? <span className="muted"> · {event.device_name}</span> : null}
                          </div>
                          <div className="feed-time">{timeAgo(event.created_at)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="glass section">
                <div className="section-title" style={{ marginBottom: 10 }}>Realtime hub</div>
                <div className="muted small" style={{ lineHeight: 1.9 }}>
                  Transport: WebSocket <span className="mono">/api/homeautomate/stream</span>
                  <br />
                  Sockets: {summary?.hub.sockets ?? 0} · Companies: {summary?.hub.companies ?? 0}
                  <br />
                  Auth: {getToken() ? 'bearer token + wildcard cookie' : 'wildcard SSO cookie'}
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ───────────────────────────── add forms ───────────────────────────── */

function AddDevice({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('switch');
  const [room, setRoom] = useState('');
  const [transport, setTransport] = useState('http');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/homeautomate/devices', { name, kind, room, transport });
      setName('');
      setRoom('');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="glass" style={{ padding: 16, marginBottom: 16 }} onSubmit={submit}>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>Kind</span>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.keys(KIND_ICON).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Room</span>
          <input className="input" value={room} onChange={(e) => setRoom(e.target.value)} />
        </label>
        <label className="field">
          <span>Transport</span>
          <select className="select" value={transport} onChange={(e) => setTransport(e.target.value)}>
            {['http', 'mqtt', 'starlink', 'manual'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add device'}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function AddTrigger({
  devices,
  onDone,
  onCancel,
}: {
  devices: IotDevice[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? '');
  const [name, setName] = useState('');
  const [metric, setMetric] = useState('energy_kwh');
  const [operator, setOperator] = useState('>');
  const [threshold, setThreshold] = useState('1');
  const [action, setAction] = useState('notify');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/homeautomate/triggers', {
        deviceId,
        name,
        metric,
        operator,
        threshold: Number(threshold),
        action,
      });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="glass" style={{ padding: 16, marginBottom: 16 }} onSubmit={submit}>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <label className="field">
          <span>Device</span>
          <select className="select" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} required>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Rule name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>Metric</span>
          <input className="input" value={metric} onChange={(e) => setMetric(e.target.value)} required />
        </label>
        <label className="field">
          <span>Operator</span>
          <select className="select" value={operator} onChange={(e) => setOperator(e.target.value)}>
            {OPERATORS.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Threshold</span>
          <input className="input" type="number" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} required />
        </label>
        <label className="field">
          <span>Action</span>
          <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
            {['notify', 'webhook', 'set_state'].map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Create trigger'}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
