import './wifiSessions.css';

/**
 * Dynamic top metrics row — the three numbers an operator checks before
 * anything else. Each card carries a soft glow in its accent colour and the
 * live count pulses while the figure is newer than the last poll.
 */
export interface SessionMetrics {
  /** Portal sessions currently authorised (from /admin/active-sessions). */
  activeSessions: number | null;
  /** Clients the Ruijie Cloud controller reports online right now. */
  cloudClients: number | null;
  /** Vouchers ever redeemed (all-time audit figure). */
  totalRedeemed: number | null;
}

interface Props {
  metrics: SessionMetrics;
  loading?: boolean;
}

const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US'));

export default function SessionMetricCards({ metrics, loading }: Props) {
  return (
    <div className="wf-metrics" data-loading={loading ? 'true' : undefined}>
      <div className="wf-metric wf-metric--green">
        <span className="wf-metric-top">
          <span className="wf-metric-dot" aria-hidden="true" />
          <span className="wf-metric-label">Active Sessions</span>
        </span>
        <b>{fmt(metrics.activeSessions)}</b>
        <em>portal-authorized right now</em>
      </div>

      <div className="wf-metric wf-metric--cyan">
        <span className="wf-metric-top">
          <span className="wf-metric-label">Cloud Clients</span>
        </span>
        <b>{fmt(metrics.cloudClients)}</b>
        <em>reported by the Ruijie controller</em>
      </div>

      <div className="wf-metric wf-metric--gold">
        <span className="wf-metric-top">
          <span className="wf-metric-label">Total Redeemed</span>
        </span>
        <b>{fmt(metrics.totalRedeemed)}</b>
        <em>vouchers redeemed to date</em>
      </div>
    </div>
  );
}
