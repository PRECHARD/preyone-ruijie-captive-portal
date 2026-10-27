import { useState } from 'react';
import type { ViewMode, WifiSession } from '../../types/wifi';
import { formatMac, formatRate, fmtBytes } from '../../utils/format';
import { getDeviceIcon } from './deviceIcons';
import {
  authMethodOf,
  displayNameOf,
  formatConnectedAt,
  formatTraffic,
} from './sessionMeta';
import './wifiSessions.css';

interface Props {
  sessions: WifiSession[];
  kickingMac: string | null;
  onKick: (s: WifiSession) => void;
  emptyHint?: string;
  /** Online = live telemetry columns + Kick; Historical = audit-trail columns. */
  mode?: ViewMode;
}

interface Pop {
  mac: string;
  x: number;
  y: number;
}

const SOURCES: Record<string, string> = {
  access_log: 'Access log',
  users: 'Signups',
  voucher_redemptions: 'Redemptions',
  voucher_devices: 'MAC bindings',
  wispr_profiles: 'WISPr session',
  ruijie_user_name: 'Ruijie PIN',
  ip_session: 'Portal IP session',
};

/**
 * Unified client table — the lower two thirds of the Ruijie console layout.
 *
 * The telemetry popover is `position: fixed` rather than absolutely placed
 * inside the row: the table lives in a horizontal-scroll container, and an
 * in-row popover would be clipped by `overflow-x: auto` for bottom rows.
 */
export default function SessionTable({
  sessions,
  kickingMac,
  onKick,
  emptyHint,
  mode = 'online',
}: Props) {
  const [pop, setPop] = useState<Pop | null>(null);

  if (sessions.length === 0) {
    return (
      <div className="wf-empty">
        <p>{emptyHint ?? 'No clients match the current filters.'}</p>
      </div>
    );
  }

  const historical = mode === 'historical';
  const active = pop ? sessions.find((s) => s.mac === pop.mac) ?? null : null;
  const flipUp = pop != null && pop.y > window.innerHeight - 240;

  return (
    <>
      <div className="table-scroll wf-scroll">
        <table className="data-table un-table wf-table">
          <thead>
            <tr>
              <th>Name / Device</th>
              <th>IP / MAC</th>
              <th>Accounts</th>
              <th>Auth</th>
              {historical ? (
                <>
                  <th>Sources</th>
                  <th>First Seen</th>
                  <th>Last Seen</th>
                  <th>Events</th>
                </>
              ) : (
                <>
                  <th>Total Traffic</th>
                  <th>Terminal Model</th>
                  <th>OS</th>
                  <th>Connected At</th>
                  <th>Action</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={s.mac}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setPop({ mac: s.mac, x: Math.min(r.left + 24, window.innerWidth - 300), y: r.bottom });
                }}
                onMouseLeave={() => setPop(null)}
              >
                <td>
                  <div className="wf-name">
                    <span className="wf-avatar" aria-hidden="true">
                      {getDeviceIcon(s.staModel, s.manufacturer, s.staLabelName ?? s.history?.userAgent)}
                    </span>
                    <span className="wf-name-text">
                      <b>{displayNameOf(s)}</b>
                      <em>{s.manufacturer || s.history?.userAgent || ''}</em>
                    </span>
                  </div>
                </td>
                <td className="wf-mono">
                  <div className="wf-stack">
                    <span>{s.ip || '—'}</span>
                    <span className="wf-mono-sub">{formatMac(s.mac)}</span>
                  </div>
                </td>
                <td>
                  <div className="wf-stack">
                    {s.code ? (
                      <span className="wf-pin" title={s.holderName ?? undefined}>{s.code}</span>
                    ) : (
                      <span className="wf-pin wf-pin--none">—</span>
                    )}
                    {(s.accountName || s.holderName) && (
                      <span className="wf-holder">
                        {s.accountName || s.holderName}
                        {(s.accountPhone || s.holderPhone) ? ` · ${s.accountPhone || s.holderPhone}` : ''}
                      </span>
                    )}
                    {s.isUncapped ? (
                      <span className="wf-data-left">Unlimited data</span>
                    ) : s.dataLeftBytes != null ? (
                      <span className="wf-data-left">{fmtBytes(s.dataLeftBytes)} left</span>
                    ) : null}
                    {(s.activeDeviceCount ?? 0) > 0 && (
                      <span
                        className="wf-devices"
                        title={(s.deviceMacs ?? []).map((mac) => formatMac(mac)).join(', ') || undefined}
                      >
                        {s.activeDeviceCount} {s.activeDeviceCount === 1 ? 'device' : 'devices'}
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <span
                    className={`wf-auth wf-auth--${authMethodOf(s) === 'VOUCHER' ? 'voucher' : 'mac'}`}
                    title={s.macWhitelisted ? 'MAC whitelist / bypass' : undefined}
                  >
                    {authMethodOf(s)}
                  </span>
                </td>
                {historical ? (
                  <>
                    <td>
                      <span className="wf-sources">
                        {(s.history?.sources ?? []).map((src) => SOURCES[src] ?? src).join(' · ') || '—'}
                      </span>
                    </td>
                    <td className="wf-mono wf-when">{formatConnectedAt(s.history?.firstSeen ?? null)}</td>
                    <td className="wf-mono wf-when">{formatConnectedAt(s.history?.lastSeen ?? null)}</td>
                    <td className="wf-mono">{s.history?.events ?? '—'}</td>
                  </>
                ) : (
                  <>
                    <td className="wf-traffic">{formatTraffic(s.usedMb)}</td>
                    <td>{s.staModel || '—'}</td>
                    <td>{s.staOs || '—'}</td>
                    <td className="wf-mono wf-when">{formatConnectedAt(s.connectedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="wf-kick"
                        disabled={kickingMac === s.mac}
                        onClick={() => onKick(s)}
                        aria-label={`Disconnect client ${displayNameOf(s)}`}
                      >
                        {kickingMac === s.mac ? '…' : 'Kick'}
                      </button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pop && active && (
        <div
          className="wf-pop"
          role="tooltip"
          style={
            flipUp
              ? { left: pop.x, bottom: window.innerHeight - pop.y + 8 }
              : { left: pop.x, top: pop.y + 8 }
          }
        >
          <header>
            <span aria-hidden="true">
              {getDeviceIcon(active.staModel, active.manufacturer, active.staLabelName ?? active.history?.userAgent)}
            </span>
            <b>{displayNameOf(active)}</b>
            <code>{formatMac(active.mac)}</code>
          </header>
          <dl>
            {historical ? (
              <>
                <div>
                  <dt>First Seen</dt>
                  <dd>{formatConnectedAt(active.history?.firstSeen ?? null)}</dd>
                </div>
                <div>
                  <dt>Last Seen</dt>
                  <dd>{formatConnectedAt(active.history?.lastSeen ?? null)}</dd>
                </div>
                <div>
                  <dt>Events</dt>
                  <dd>{active.history?.events ?? '—'}</dd>
                </div>
                <div>
                  <dt>Logs</dt>
                  <dd>
                    {(active.history?.sources ?? [])
                      .map((src) => SOURCES[src] ?? src)
                      .join(', ') || '—'}
                  </dd>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <dt>User Agent</dt>
                  <dd>{active.history?.userAgent || '—'}</dd>
                </div>
              </>
            ) : (
              <>
                <div>
                  <dt>Signal</dt>
                  <dd className={active.rssi != null && active.rssi >= -60 ? 'wf-good' : active.rssi != null && active.rssi < -75 ? 'wf-bad' : ''}>
                    {active.rssi != null ? `${active.rssi} dBm` : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Latency</dt>
                  <dd>{active.timeDelayMs != null ? `${active.timeDelayMs} ms` : '—'}</dd>
                </div>
                <div>
                  <dt>Loss Rate</dt>
                  <dd>{active.pktLoseRate != null ? `${active.pktLoseRate}%` : '—'}</dd>
                </div>
                <div>
                  <dt>Channel</dt>
                  <dd>{active.channel || '—'}</dd>
                </div>
                <div>
                  <dt>Speed ↓/↑</dt>
                  <dd>{formatRate(active.downRate)} ↓ {formatRate(active.upRate)} ↑</dd>
                </div>
                <div>
                  <dt>Access Point</dt>
                  <dd>{active.deviceName || active.apName || '—'}</dd>
                </div>
                <div>
                  <dt>Health</dt>
                  <dd>
                    {active.score != null ? `${active.score}/100` : '—'}
                    {active.scoreReason ? <em className="wf-reason">{active.scoreReason}</em> : null}
                  </dd>
                </div>
                <div>
                  <dt>Uptime</dt>
                  <dd>{active.onlineTimeSec != null ? `${Math.floor(active.onlineTimeSec / 60)}m` : '—'}</dd>
                </div>
                <div>
                  <dt>Auth</dt>
                  <dd>
                    {authMethodOf(active)}
                    {active.macWhitelisted ? ' · whitelist' : ''}
                  </dd>
                </div>
                <div>
                  <dt>Data Left</dt>
                  <dd>
                    {active.isUncapped
                      ? 'Unlimited'
                      : active.dataLeftBytes != null
                        ? fmtBytes(active.dataLeftBytes)
                        : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Bound Devices</dt>
                  <dd>{active.activeDeviceCount ? String(active.activeDeviceCount) : '—'}</dd>
                </div>
              </>
            )}
          </dl>
        </div>
      )}
    </>
  );
}
