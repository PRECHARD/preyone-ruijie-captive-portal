import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  FiActivity,
  FiCheckCircle,
  FiChevronLeft,
  FiChevronRight,
  FiClock,
  FiLogIn,
  FiRefreshCw,
  FiSearch,
  FiShield,
  FiXCircle,
} from 'react-icons/fi';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import './AccessLog.css';

type EventFilter = 'all' | 'login' | 'radius_accept' | 'radius_reject' | 'radius_stop' | 'other';
type Range = 'today' | '7d' | '30d' | 'all';

interface AccessLogRow {
  id: number | string;
  event: string;
  mac_address: string | null;
  ip_address: string | null;
  detail: string | null;
  request_url: string | null;
  http_status: number | null;
  request_method: string | null;
  created_at: string;
  full_name: string | null;
}

interface AccessLogSummary {
  total: number;
  accepts: number;
  rejects: number;
  stops: number;
  signIns: number;
  devices: number;
}

interface AccessLogResponse {
  rows: AccessLogRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: AccessLogSummary;
}

const PAGE_SIZE = 50;
const EMPTY_SUMMARY: AccessLogSummary = { total: 0, accepts: 0, rejects: 0, stops: 0, signIns: 0, devices: 0 };

const EVENT_LABEL: Record<string, string> = {
  login: 'Portal sign-in',
  radius_accept: 'RADIUS accept',
  radius_reject: 'RADIUS reject',
  radius_stop: 'Session stop',
};

const EVENT_TONE: Record<string, string> = {
  login: 'info',
  radius_accept: 'ok',
  radius_reject: 'bad',
  radius_stop: 'muted',
};

const EVENT_ICON: Record<string, ReactNode> = {
  login: <FiLogIn />,
  radius_accept: <FiCheckCircle />,
  radius_reject: <FiXCircle />,
  radius_stop: <FiShield />,
};

function labelFor(event: string): string {
  return EVENT_LABEL[event] ?? event.replace(/_/g, ' ');
}

function toneFor(event: string): string {
  return EVENT_TONE[event] ?? 'muted';
}

function iconFor(event: string): ReactNode {
  return EVENT_ICON[event] ?? <FiActivity />;
}

function relativeTime(iso: string): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '—';
  const diff = Math.max(0, Date.now() - at);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function statusTone(status: number | null): string {
  if (status == null) return 'muted';
  if (status >= 500) return 'bad';
  if (status >= 400) return 'warn';
  if (status >= 200 && status < 300) return 'ok';
  return 'info';
}

export default function AccessLog() {
  const [logs, setLogs] = useState<AccessLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [event, setEvent] = useState<EventFilter>('all');
  const [range, setRange] = useState<Range>('7d');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<AccessLogSummary>(EMPTY_SUMMARY);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setPage(1);
  }, [range, event]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        range,
        event,
      });
      if (debouncedQuery) params.set('q', debouncedQuery);
      const res = await api.get<AccessLogResponse>(`/access-logs?${params.toString()}`);
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      setLogs(rows);
      setTotal(Number(res?.total ?? 0));
      setSummary({
        total: Number(res?.summary?.total ?? 0),
        accepts: Number(res?.summary?.accepts ?? 0),
        rejects: Number(res?.summary?.rejects ?? 0),
        stops: Number(res?.summary?.stops ?? 0),
        signIns: Number(res?.summary?.signIns ?? 0),
        devices: Number(res?.summary?.devices ?? 0),
      });
      setError('');
      setLastSync(new Date());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load access events.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, range, event, debouncedQuery]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  if (loading) return <Spinner />;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, total);
  const otherCount = Math.max(
    0,
    summary.total - summary.signIns - summary.accepts - summary.rejects - summary.stops
  );

  return (
    <div className="page al-page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Access Log</h2>
          <p className="page-desc">
            Portal sign-ins, RADIUS decisions and session stops for the captive network.
          </p>
        </div>
        <div className="page-header-extra al-sync">
          {lastSync && (
            <span className="al-sync__stamp">
              <FiClock />
              synced {lastSync.toLocaleTimeString()}
            </span>
          )}
          <button className="btn-secondary" onClick={() => { void load(); }} disabled={refreshing}>
            <FiRefreshCw className={refreshing ? 'al-spin' : ''} />
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="al-stats">
        <div className="al-stat al-stat--cyan">
          <span className="al-stat__icon"><FiActivity /></span>
          <span className="al-stat__value">{summary.total.toLocaleString()}</span>
          <span className="al-stat__label">Events in range</span>
        </div>
        <div className="al-stat al-stat--green">
          <span className="al-stat__icon"><FiLogIn /></span>
          <span className="al-stat__value">{summary.signIns.toLocaleString()}</span>
          <span className="al-stat__label">Portal sign-ins</span>
        </div>
        <div className="al-stat al-stat--amber">
          <span className="al-stat__icon"><FiShield /></span>
          <span className="al-stat__value">{summary.accepts.toLocaleString()}</span>
          <span className="al-stat__label">RADIUS accepts</span>
        </div>
        <div className="al-stat al-stat--red">
          <span className="al-stat__icon"><FiXCircle /></span>
          <span className="al-stat__value">{summary.rejects.toLocaleString()}</span>
          <span className="al-stat__label">RADIUS rejects</span>
        </div>
        <div className="al-stat al-stat--violet">
          <span className="al-stat__icon"><FiShield /></span>
          <span className="al-stat__value">{summary.devices.toLocaleString()}</span>
          <span className="al-stat__label">Unique devices</span>
        </div>
      </div>

      <div className="card al-toolbar">
        <div className="al-toolbar__row">
          <div className="al-search">
            <FiSearch aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search account, MAC, IP, URL or detail"
              aria-label="Search access log"
            />
          </div>
          <div className="al-ranges" role="group" aria-label="Time range">
            {(['today', '7d', '30d', 'all'] as Range[]).map((value) => (
              <button
                key={value}
                type="button"
                className="al-chip"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {value === 'today' ? 'Today' : value === 'all' ? 'All time' : `Last ${value}`}
              </button>
            ))}
          </div>
        </div>
        <div className="al-events" role="group" aria-label="Event type">
          {(['all', 'login', 'radius_accept', 'radius_reject', 'radius_stop', 'other'] as EventFilter[]).map((value) => (
            <button
              key={value}
              type="button"
              className={`al-chip al-chip--event al-chip--${value === 'all' ? 'all' : toneFor(value)}`}
              aria-pressed={event === value}
              onClick={() => setEvent(value)}
            >
              {value === 'all' ? 'All events' : value === 'other' ? 'Other' : labelFor(value)}
              <span className="al-chip__count">
                {value === 'all'
                  ? summary.total
                  : value === 'other'
                    ? otherCount
                    : value === 'login'
                      ? summary.signIns
                      : value === 'radius_accept'
                        ? summary.accepts
                        : value === 'radius_reject'
                          ? summary.rejects
                          : summary.stops}
              </span>
            </button>
          ))}
        </div>
      </div>

      {logs.length === 0 ? (
        <EmptyState
          icon="—"
          title={summary.total === 0 ? 'No Access Log Entries' : 'No Events Match'}
          message={summary.total === 0
            ? 'Portal sign-ins and RADIUS decisions will appear here as clients connect.'
            : 'Try a wider time range or clear the search and event filters.'}
        />
      ) : (
        <div className="card card-table al-card">
          <div className="al-card__head">
            <span>Event stream</span>
            <span>{pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {total.toLocaleString()}</span>
          </div>
          <div className="table-scroll">
            <table className="data-table al-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Account</th>
                  <th>MAC</th>
                  <th>IP</th>
                  <th>Request</th>
                  <th>HTTP</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((row) => (
                  <tr key={row.id}>
                    <td className="al-when">
                      <span>{new Date(row.created_at).toLocaleString()}</span>
                      <em>{relativeTime(row.created_at)}</em>
                    </td>
                    <td>
                      <span className={`al-event al-event--${toneFor(row.event)}`}>
                        {iconFor(row.event)}
                        {labelFor(row.event)}
                      </span>
                    </td>
                    <td className="al-account">{row.full_name || '—'}</td>
                    <td><code className="al-mac">{row.mac_address || '—'}</code></td>
                    <td><code className="al-ip">{row.ip_address || '—'}</code></td>
                    <td className="al-request">
                      {row.request_method && <span className="al-method">{row.request_method}</span>}
                      <code>{row.request_url || '—'}</code>
                    </td>
                    <td>
                      <span className={`al-status al-status--${statusTone(row.http_status)}`}>
                        {row.http_status ?? '—'}
                      </span>
                    </td>
                    <td className="al-detail">{row.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="al-pager">
            <span>{total.toLocaleString()} matching event{total === 1 ? '' : 's'}</span>
            <div className="al-pager__controls">
              <button
                type="button"
                className="al-pager__btn"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                aria-label="Previous page"
              >
                <FiChevronLeft />
              </button>
              <span className="al-pager__page">Page {page} of {totalPages}</span>
              <button
                type="button"
                className="al-pager__btn"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                aria-label="Next page"
              >
                <FiChevronRight />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
