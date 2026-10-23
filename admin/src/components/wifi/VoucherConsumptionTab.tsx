import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../../api/client';
import Spinner from '../Spinner';
import EmptyState from '../EmptyState';
import type { ConsumptionStatus, VoucherConsumptionResponse, VoucherConsumptionRow } from '../../types/wifi';
import ConsumptionDetailModal from './ConsumptionDetailModal';
import './voucherConsumption.css';

const POLL_MS = 30_000;

const STATUS_LABEL: Record<ConsumptionStatus, string> = {
  idle: 'IDLE',
  ok: 'OK',
  low: 'LOW 80%',
  critical: 'CRIT 95%',
  exhausted: 'DRAINED',
  unlimited: 'UNLIMITED',
  disabled: 'DISABLED',
};

/** Same badge vocabulary as the Vouchers list, plus crit/unlimited tones. */
const STATUS_BADGE: Record<ConsumptionStatus, string> = {
  idle: 'badge badge--idle',
  ok: 'badge badge--yes',
  low: 'badge badge--warn',
  critical: 'badge badge--crit',
  exhausted: 'badge badge--no',
  unlimited: 'badge badge--unl',
  disabled: 'badge badge--muted',
};

type FilterKey = 'all' | 'low' | 'critical' | 'exhausted' | 'unlimited' | 'ok';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ok', label: 'OK' },
  { key: 'low', label: 'Low 80%+' },
  { key: 'critical', label: 'Critical 95%+' },
  { key: 'exhausted', label: 'Drained' },
  { key: 'unlimited', label: 'Unlimited' },
];

function fmtMB(mb: number | null): string {
  if (mb == null) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtPct(pct: number | null): string {
  if (pct == null) return '∞';
  return `${Math.round(pct * 10) / 10}%`;
}

function fmtWhen(at: string | Date | null): string {
  if (!at) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function isUnlimited(row: VoucherConsumptionRow): boolean {
  return row.totalMB == null || row.totalMB <= 0;
}

/** Used / Bundle cell — unlimited bundles always read "used / Unlimited". */
function usedCell(row: VoucherConsumptionRow) {
  if (isUnlimited(row)) {
    return (
      <span className="un-consume__used">
        {fmtMB(row.usedMB)} <span className="un-consume__unl">/ Unlimited</span>
      </span>
    );
  }
  return (
    <span className="un-consume__used">
      {fmtMB(row.usedMB)} <span className="un-consume__muted">/ {fmtMB(row.totalMB)}</span>
    </span>
  );
}

function fillClass(row: VoucherConsumptionRow): string {
  return `un-consume__fill un-consume__fill--${row.status}`;
}

/** 'low' = low OR critical OR exhausted (everything ≥ 80%). */
function matchesFilter(row: VoucherConsumptionRow, filter: FilterKey): boolean {
  if (filter === 'all') return true;
  if (filter === 'low') return row.status === 'low' || row.status === 'critical' || row.status === 'exhausted';
  if (filter === 'critical') return row.status === 'critical' || row.status === 'exhausted';
  if (filter === 'ok') return row.status === 'ok' || row.status === 'idle';
  return row.status === filter;
}

export default function VoucherConsumptionTab() {
  const [data, setData] = useState<VoucherConsumptionResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<VoucherConsumptionRow | null>(null);

  const load = useCallback(() => {
    api.get<VoucherConsumptionResponse>('/voucher-analytics')
      .then((res) => {
        setData(res);
        setError('');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load consumption data.');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const summary = data?.summary;

  // Search runs first (PIN, package or client), status chips narrow the result.
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.code.toLowerCase().includes(q)
      || (r.packageName || '').toLowerCase().includes(q)
      || (r.holderName || '').toLowerCase().includes(q)
      || (r.holderPhone || '').toLowerCase().includes(q)
    );
  }, [rows, query]);

  const visible = useMemo(() => searched.filter((r) => matchesFilter(r, filter)), [searched, filter]);
  const atRiskValue = useMemo(
    () => rows
      .filter((r) => r.status === 'low' || r.status === 'critical')
      .reduce((sum, r) => sum + (Number(r.priceAmount) || 0), 0),
    [rows]
  );

  const openDetail = (row: VoucherConsumptionRow) => setDetail(row);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <EmptyState title="Could not load" message={error} />;

  return (
    <div className="un-consume">
      <div className="un-consume__head">
        <h2 className="section-head-title" style={{ margin: 0 }}>VOUCHER CONSUMPTION</h2>
        <div className="un-consume__headactions">
          {data && data.live ? (
            <span
              className="live-pill"
              title="Re-reads every 30 seconds, so consumption, online devices and alerts stay current."
            >
              <span className="live-dot" />
              <span className="live-pill__label">Live</span>
              <span className="live-pill__time">
                {data ? `synced ${new Date(data.generatedAt).toLocaleTimeString()}` : 'syncing…'}
              </span>
            </span>
          ) : (
            <span className="un-consume__pill-off">ROSTER OFFLINE</span>
          )}
          <button
            type="button"
            className="un-consume__refresh"
            onClick={() => { setLoading(true); void load(); }}
          >
            Refresh
          </button>
        </div>
      </div>
      <p className="un-consume__sub">
        Dual-threshold live view — 80% reminder / 95% critical · sweep every 5 min
      </p>

      {data && !data.live && (
        <p className="un-consume__banner">
          Ruijie Cloud keys are missing on this portal — consumption rows and alert history are unavailable.
        </p>
      )}
      {error && <p className="un-consume__banner">{error}</p>}

      {summary && (
        <div className="un-consume__stats">
          <div className="un-consume__stat un-consume__stat--total">
            <div className="un-consume__stat-num">{summary.total}</div>
            <div className="un-consume__stat-label">Vouchers</div>
          </div>
          <div className="un-consume__stat un-consume__stat--ok">
            <div className="un-consume__stat-num">{summary.ok + summary.idle}</div>
            <div className="un-consume__stat-label">Healthy</div>
          </div>
          <div className="un-consume__stat un-consume__stat--low">
            <div className="un-consume__stat-num">{summary.low}</div>
            <div className="un-consume__stat-label">Low 80%+</div>
          </div>
          <div className="un-consume__stat un-consume__stat--critical">
            <div className="un-consume__stat-num">{summary.critical}</div>
            <div className="un-consume__stat-label">Critical 95%+</div>
          </div>
          <div className="un-consume__stat un-consume__stat--exhausted">
            <div className="un-consume__stat-num">{summary.exhausted + summary.disabled}</div>
            <div className="un-consume__stat-label">Drained</div>
          </div>
          <div className="un-consume__stat un-consume__stat--unlimited">
            <div className="un-consume__stat-num">{summary.unlimited}</div>
            <div className="un-consume__stat-label">Unlimited</div>
          </div>
          <div className="un-consume__stat un-consume__stat--risk">
            <div className="un-consume__stat-num" style={{ fontSize: '1.35rem' }}>
              ${atRiskValue.toFixed(2)}
            </div>
            <div className="un-consume__stat-label">At-risk value</div>
          </div>
        </div>
      )}

      <div className="un-consume__toolbar">
        <div className="un-consume__searchwrap">
          <span className="un-consume__searchicon" aria-hidden="true">⌕</span>
          <input
            type="search"
            className="un-consume__search"
            placeholder="Search PIN, package or client…"
            aria-label="Search voucher PIN or package"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <span className="un-consume__count">
          Showing {visible.length} of {rows.length} vouchers
        </span>
      </div>

      <div className="un-consume__filters" role="group" aria-label="Filter vouchers by consumption">
        {FILTERS.map((f) => {
          const count = searched.filter((r) => matchesFilter(r, f.key)).length;
          return (
            <button
              key={f.key}
              type="button"
              className="un-consume__chip"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label} ({count})
            </button>
          );
        })}
      </div>

      <div className="card card-table">
        {visible.length === 0 ? (
          <div className="table-empty">
            <p>{data && !data.live ? 'Roster unavailable.' : 'No vouchers match your search.'}</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>PIN</th>
                <th>Package</th>
                <th>Client</th>
                <th>Used / Bundle</th>
                <th>Consumption</th>
                <th>Status</th>
                <th>Now</th>
                <th>Alerts</th>
                <th>Last Alert</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.code}>
                  <td>
                    <span
                      className="code-cell"
                      title="Click for voucher details"
                      onClick={() => openDetail(row)}
                    >
                      {row.code || '—'}
                    </span>
                  </td>
                  <td>{row.packageName || '—'}</td>
                  <td>
                    {row.holderName || row.holderPhone ? (
                      <div className="un-consume__client">
                        <span>{row.holderName || 'Unnamed'}</span>
                        {row.holderPhone && <em>{row.holderPhone}</em>}
                      </div>
                    ) : (
                      <span className="un-consume__muted">—</span>
                    )}
                  </td>
                  <td>{usedCell(row)}</td>
                  <td className="un-consume__barcell">
                    <div className="un-consume__bar" aria-hidden="true">
                      <div
                        className={fillClass(row)}
                        style={{ width: `${row.pct == null ? 100 : Math.min(row.pct, 100)}%` }}
                      />
                      {row.pct != null && (
                        <>
                          <span className="un-consume__tick" style={{ left: '80%' }} data-label="80" />
                          <span className="un-consume__tick" style={{ left: '95%' }} data-label="95" />
                        </>
                      )}
                    </div>
                    <div className="un-consume__pct">{fmtPct(row.pct)}</div>
                  </td>
                  <td>
                    <span className={STATUS_BADGE[row.status]}>{STATUS_LABEL[row.status]}</span>
                  </td>
                  <td>
                    {row.onlineNow
                      ? (
                        <span className="badge badge--live">
                          <span className="live-dot" />
                          {row.activeDevices ?? 1}
                          {row.maxDevices ? `/${row.maxDevices}` : ''} online
                        </span>
                      )
                      : <span className="un-consume__muted">—</span>}
                  </td>
                  <td>
                    <span className="un-consume__alerts">
                      <span data-tier="t80">80·{row.alertsSent.t80}</span>
                      <span data-tier="t95">95·{row.alertsSent.t95}</span>
                    </span>
                  </td>
                  <td className="un-consume__muted">{fmtWhen(row.lastAlertAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <ConsumptionDetailModal
          code={detail.code}
          row={detail}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}
