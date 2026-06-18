import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';

export default function TimeAttendance() {
  const { user } = useAuth();
  const isMgmt = user?.role === 'CEO' || user?.role === 'Manager';
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [clockStatus, setClockStatus] = useState<any>(null);

  const fetch = useCallback(async () => {
    try { setData(await api.get('/time-logs')); } catch { /* ignore */ }
    try { setClockStatus(await api.get('/clock-status')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); const t = setInterval(fetch, 30000); return () => clearInterval(t); }, [fetch]);

  const toggleClock = async () => {
    if (clockStatus?.clockedIn) await api.post('/clock-out');
    else await api.post('/clock-in');
    fetch();
  };

  if (loading) return <Spinner />;

  const logs = data?.logs || [];
  const summary = data?.summary || [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Time & Attendance</h2>
          <p className="page-desc">{logs.length} log entries</p>
        </div>
        <button
          className={clockStatus?.clockedIn ? 'btn-secondary btn-danger' : 'btn-primary'}
          onClick={toggleClock}
          style={{ minWidth: 130 }}
        >
          {clockStatus?.clockedIn ? 'Clock Out' : 'Clock In'}
        </button>
      </div>

      {clockStatus?.clockedIn && (
        <div className="clock-banner clocked-in" style={{ marginBottom: 16 }}>
          <span className="clock-status-icon">✓</span>
          <span>Clocked in since {clockStatus.log?.clock_in ? new Date(clockStatus.log.clock_in).toLocaleTimeString() : 'earlier'}</span>
        </div>
      )}
      {!clockStatus?.clockedIn && clockStatus?.log !== undefined && (
        <div className="clock-banner clocked-out" style={{ marginBottom: 16 }}>
          <span className="clock-status-icon">✕</span>
          <span>Not clocked in</span>
        </div>
      )}

      {isMgmt && summary.length > 0 && (
        <div className="stats-grid stats-grid--compact" style={{ marginBottom: 20 }}>
          {summary.map((s: any) => (
            <div key={s.id} className="stat-card">
              <span className="stat-label">{s.full_name || s.admin_name || 'Staff'}</span>
              <span className="stat-number" style={{ color: 'var(--cyan)', fontSize: '0.9rem' }}>
                {s.total_hours ? `${Number(s.total_hours).toFixed(1)}h` : '—'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.log_count} shift(s)</span>
            </div>
          ))}
        </div>
      )}

      {logs.length === 0 ? (
        <EmptyState icon="⏰" title="No Time Logs" message="No clock-in/out records found." />
      ) : (
        <div className="card">
          <Table
            columns={[
              ...(isMgmt ? [{ key: 'admin_name', label: 'Staff', render: (r: any) => r.admin_name || r.full_name || '—' }] : []),
              { key: 'clock_in', label: 'Clock In', width: '170px', render: (r: any) => r.clock_in ? new Date(r.clock_in).toLocaleString() : '—' },
              { key: 'clock_out', label: 'Clock Out', width: '170px', render: (r: any) => {
                if (r.clock_out) return new Date(r.clock_out).toLocaleString();
                if (!r.clock_in) return '—';
                const hrs = (Date.now() - new Date(r.clock_in).getTime()) / 3600000;
                return hrs > 12 ? <Badge variant="rejected">Active ({hrs.toFixed(1)}h)</Badge> : <Badge variant="active">Active</Badge>;
              }},
              { key: 'duration', label: 'Duration', width: '100px', render: (r: any) => {
                if (!r.clock_in) return '—';
                const end = r.clock_out ? new Date(r.clock_out).getTime() : Date.now();
                const hrs = (end - new Date(r.clock_in).getTime()) / 3600000;
                return `${hrs.toFixed(1)}h`;
              }},
            ].filter(Boolean)}
            data={logs}
          />
        </div>
      )}
    </div>
  );
}
