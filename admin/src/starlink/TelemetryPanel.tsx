import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  FiActivity, FiArrowDown, FiArrowUp, FiClock, FiRefreshCw, FiWifi, FiWifiOff,
} from 'react-icons/fi';
import type { IconType } from 'react-icons';
import {
  ApiError, fmtDate, slTelemetry, slUpdateAlertPreferences,
  type SlAlertPreferenceUpdate, type SlAlertPreferences, type SlKit, type SlTelemetryResponse,
} from './api';

type Props = { kit: SlKit | null; readOnly?: boolean };

type PrefSwitchProps = {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
};

function PrefSwitch({ checked, label, disabled, onChange }: PrefSwitchProps) {
  return (
    <button
      type="button"
      className="sp-switch sp-switch--sm"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

const THRESHOLDS = [75, 90, 100] as const;

const THRESHOLD_FIELDS = {
  75: { email: 'alert_75_email_enabled', portal: 'alert_75_portal_enabled', sent: 'alert_75_sent_cycle' },
  90: { email: 'alert_90_email_enabled', portal: 'alert_90_portal_enabled', sent: 'alert_90_sent_cycle' },
  100: { email: 'alert_100_email_enabled', portal: 'alert_100_portal_enabled', sent: 'alert_100_sent_cycle' },
} as const;

function num(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

function dayLabel(value: string): string {
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(value).slice(5, 10);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

/** Additive dark-neon telemetry suite for the selected customer kit. */
export default function TelemetryPanel({ kit, readOnly = false }: Props) {
  const kitId = kit?.id || '';
  const [telemetry, setTelemetry] = useState<SlTelemetryResponse | null>(null);
  const [prefs, setPrefs] = useState<SlAlertPreferences | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [autoGb, setAutoGb] = useState('10');
  const [autoMin, setAutoMin] = useState('2');

  const load = useCallback(async (silent = false) => {
    if (!kitId) {
      setTelemetry(null);
      setPrefs(null);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const next = await slTelemetry(kitId);
      setTelemetry(next);
      setPrefs(next.preferences);
      setError('');
    } catch (err) {
      if (!silent) setError(err instanceof ApiError ? err.message : 'Could not load telemetry.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [kitId]);

  useEffect(() => {
    setTelemetry(null);
    setPrefs(null);
    setNotice(null);
    if (kitId) void load(true);
  }, [kitId, load]);

  useEffect(() => {
    if (!prefs) return;
    setAutoGb(String(prefs.auto_topup_gb));
    setAutoMin(String(prefs.auto_topup_min_gb));
  }, [prefs?.auto_topup_gb, prefs?.auto_topup_min_gb]);

  const snapshots = useMemo(
    () => [...(telemetry?.snapshots ?? [])].sort(
      (a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
    ),
    [telemetry]
  );
  const latest = snapshots[0] ?? null;
  const metrics = telemetry?.metrics ?? null;
  const daily = telemetry?.daily ?? [];
  const cycle = telemetry?.cycle ?? '';

  const updatePref = useCallback(async (patch: SlAlertPreferenceUpdate, label: string) => {
    if (!kitId || !prefs) return;
    const previous = prefs;
    setPrefs({ ...previous, ...patch } as SlAlertPreferences);
    setSavingKey(label);
    setNotice(null);
    try {
      const result = await slUpdateAlertPreferences({ ...patch, kitId });
      setPrefs(result.preferences);
      setNotice({ kind: 'ok', text: `${label} updated.` });
    } catch (err) {
      setPrefs(previous);
      setNotice({
        kind: 'err',
        text: err instanceof ApiError ? err.message : `Could not update ${label.toLowerCase()}.`,
      });
    } finally {
      setSavingKey(null);
    }
  }, [kitId, prefs]);

  const healthCards: Array<{ label: string; value: string; icon: IconType; tone?: string }> = [
    {
      label: 'Terminal',
      value: latest ? (latest.online_status ? 'Online' : 'Offline') : '—',
      icon: latest?.online_status === false ? FiWifiOff : FiWifi,
      tone: latest ? (latest.online_status ? 'ok' : 'bad') : undefined,
    },
    { label: 'Downlink', value: latest ? `${num(latest.download_mbps)} Mbps` : '—', icon: FiArrowDown, tone: 'cyan' },
    { label: 'Uplink', value: latest ? `${num(latest.upload_mbps)} Mbps` : '—', icon: FiArrowUp, tone: 'cyan' },
    { label: 'Latency', value: latest ? `${num(latest.latency_ms, 0)} ms` : '—', icon: FiActivity },
    {
      label: 'Ping success',
      value: latest && latest.ping_drop_rate !== null
        ? `${num(Math.max(0, 100 - Number(latest.ping_drop_rate)))}%`
        : '—',
      icon: FiActivity,
      tone: latest && Number(latest.ping_drop_rate) > 5 ? 'bad' : 'ok',
    },
    { label: 'Obstruction', value: latest ? `${num(latest.obstruction_percent)}%` : '—', icon: FiWifi },
  ];

  if (!kitId) {
    return (
      <section className="sp-panel sp-telemetry">
        <div className="sp-panel-head">
          <div>
            <h3 className="sp-panel-title">Telemetry &amp; Forecast</h3>
            <p className="sp-panel-sub">Register a kit to see live health and usage forecasts.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="sp-panel sp-telemetry">
      <div className="sp-panel-head">
        <div>
          <h3 className="sp-panel-title">Telemetry &amp; Forecast</h3>
          <p className="sp-panel-sub">
            Last 30 days · priority vs standard/credit data · burn-rate projection
          </p>
        </div>
        <div className="sp-telemetry-head-actions">
          {metrics?.projected_exhaustion_date && (
            <span className="sp-forecast-badge" title={`${num(metrics.days_remaining)} days remaining`}>
              <FiClock /> Exhausted {fmtDate(metrics.projected_exhaustion_date)}
            </span>
          )}
          <button type="button" className="sp-icon-btn" disabled={loading} onClick={() => void load(false)} title="Refresh telemetry">
            <FiRefreshCw className={loading ? 'sp-spin' : ''} />
          </button>
        </div>
      </div>

      {error && <div className="sp-inline-error">{error}</div>}
      {notice && <div className={`sp-inline-${notice.kind}`}>{notice.text}</div>}

      <div className="sp-health-grid">
        {healthCards.map(({ label, value, icon: Icon, tone }) => (
          <div className="sp-health-card" key={label}>
            <span className={`sp-health-icon${tone ? ` is-${tone}` : ''}`}><Icon /></span>
            <span className="sp-health-label">{label}</span>
            <strong className="sp-health-value">{value}</strong>
          </div>
        ))}
      </div>

      <div className="sp-telemetry-chart-wrap">
        <div className="sp-telemetry-chart-head">
          <span className="sp-telemetry-legend"><i className="is-priority" /> Priority</span>
          <span className="sp-telemetry-legend"><i className="is-standard" /> Standard / Credit</span>
          <span className="sp-telemetry-rate">Burn rate <b>{num(metrics?.daily_burn_rate_gb, 2)} GB/day</b></span>
        </div>
        <div className="sp-telemetry-chart">
          {daily.length === 0 ? (
            <div className="sp-empty">
              <FiActivity size={30} />
              <p>No snapshots yet — telemetry will appear after the first sync.</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={daily} margin={{ top: 12, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="slPriorityFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#00F0FF" stopOpacity={0.55} />
                    <stop offset="100%" stopColor="#00F0FF" stopOpacity={0.04} />
                  </linearGradient>
                  <linearGradient id="slStandardFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a855f7" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#a855f7" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,.08)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={dayLabel} stroke="rgba(255,255,255,.45)" fontSize={11} />
                <YAxis tickFormatter={(v: unknown) => `${Number(v)} GB`} stroke="rgba(255,255,255,.45)" fontSize={11} />
                <Tooltip
                  labelFormatter={(label: unknown) => fmtDate(String(label))}
                  formatter={(value: unknown, name: unknown) => [
                    `${num(Number(value), 2)} GB`,
                    name === 'priority_gb' ? 'Priority' : 'Standard / Credit',
                  ]}
                  contentStyle={{
                    background: '#0D0F18',
                    border: '1px solid rgba(0,240,255,.35)',
                    borderRadius: 12,
                    color: '#e8edf6',
                    boxShadow: '0 12px 32px rgba(0,0,0,.55)',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="priority_gb"
                  stackId="data"
                  stroke="#00F0FF"
                  fill="url(#slPriorityFill)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="standard_gb"
                  stackId="data"
                  stroke="#a855f7"
                  fill="url(#slStandardFill)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="sp-telemetry-summary">
          <span>Priority used <b>{num(metrics?.priority_used_gb)} GB</b></span>
          <span>Standard / credit <b>{num(metrics?.standard_used_gb)} GB</b></span>
          <span>Remaining <b>{num(metrics?.remaining_gb)} GB</b></span>
          <span>Days left <b>{metrics?.days_remaining === null || metrics?.days_remaining === undefined ? '—' : num(metrics.days_remaining)}</b></span>
        </div>
      </div>

      {!readOnly && (
      <div className="sp-alert-settings">
        <div className="sp-alert-settings-head">
          <div>
            <h4>Usage alerts</h4>
            <p>One email and one portal notification per threshold, per billing cycle.</p>
          </div>
          <span className="sp-cycle-chip">Cycle {cycle || '—'}</span>
        </div>

        {THRESHOLDS.map((threshold) => {
          const fields = THRESHOLD_FIELDS[threshold];
          const sent = prefs?.[fields.sent] === cycle && Boolean(cycle);
          return (
            <div className="sp-alert-row" key={threshold}>
              <div className="sp-alert-row-copy">
                <b>{threshold}% consumption</b>
                <small>
                  {sent ? 'Sent this cycle' : 'Not sent yet this cycle'}
                  {' · '}Warn me when this kit reaches {threshold}% of its allowance.
                </small>
              </div>
              <div className="sp-alert-toggles">
                <span>Email</span>
                <PrefSwitch
                  label={`${threshold}% email alerts`}
                  checked={Boolean(prefs?.[fields.email])}
                  disabled={!prefs || savingKey !== null}
                  onChange={(v) => void updatePref({ [fields.email]: v }, `${threshold}% email alerts`)}
                />
                <span>Portal</span>
                <PrefSwitch
                  label={`${threshold}% portal alerts`}
                  checked={Boolean(prefs?.[fields.portal])}
                  disabled={!prefs || savingKey !== null}
                  onChange={(v) => void updatePref({ [fields.portal]: v }, `${threshold}% portal alerts`)}
                />
              </div>
            </div>
          );
        })}

        <div className="sp-auto-topup">
          <div className="sp-alert-row-copy">
            <b>Auto top-up from wallet</b>
            <small>Buy more data automatically when the kit drops below your minimum.</small>
          </div>
          <PrefSwitch
            label="Auto top-up from wallet"
            checked={Boolean(prefs?.auto_topup_enabled)}
            disabled={!prefs || savingKey !== null}
            onChange={(v) => void updatePref({ auto_topup_enabled: v }, 'Auto top-up')}
          />
          <div className="sp-auto-topup-fields">
            <label>
              Top up
              <input
                type="number"
                min="1"
                max="1000"
                step="1"
                value={autoGb}
                onChange={(e) => setAutoGb(e.target.value)}
                aria-label="Auto top-up GB"
              />
              GB
            </label>
            <label>
              When below
              <input
                type="number"
                min="0.5"
                max="100"
                step="0.5"
                value={autoMin}
                onChange={(e) => setAutoMin(e.target.value)}
                aria-label="Auto top-up minimum GB"
              />
              GB
            </label>
            <button
              type="button"
              className="sp-btn sp-btn--small"
              disabled={!prefs || savingKey !== null}
              onClick={() => void updatePref({
                auto_topup_gb: Math.max(1, Number(autoGb) || 10),
                auto_topup_min_gb: Math.max(0.5, Number(autoMin) || 2),
              }, 'Auto top-up amounts')}
            >
              Save amounts
            </button>
          </div>
        </div>
      </div>
      )}
    </section>
  );
}
